import { mkdtemp, readFile, rm, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { safeAssetUrl } from './platforms/bilibili.ts';
import { MAX_STORYBOARD_CELLS, MAX_VIDEO_FRAMES } from './resource-policy.ts';

export function sampleTimes(
  durationSec: number,
  maxFrames: number,
  requested?: unknown,
  range: { fromSec?: unknown; toSec?: unknown; automatic?: boolean } = {},
): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error('视频时长无效');
  const max = Math.max(1, Math.min(MAX_VIDEO_FRAMES, Math.trunc(maxFrames)));
  const from = range.fromSec ?? 0, to = range.toSec ?? durationSec;
  if (typeof from !== 'number' || typeof to !== 'number' || !Number.isFinite(from) ||
      !Number.isFinite(to) || from < 0 || to > durationSec || to <= from)
    throw new Error('观察范围应在视频时长内，且结束晚于开始。');
  if (requested !== undefined && (range.fromSec !== undefined || range.toSec !== undefined))
    throw new Error('指定采样时刻与指定观察范围，请选择一种。');
  const span = to - from;
  const recommended = span <= 15 && max <= 2 ? 1
    : span <= 30 ? 3
    : span <= 90 ? 4
    : span <= 180 ? 6
    : span >= 240 && max === MAX_VIDEO_FRAMES ? MAX_VIDEO_FRAMES
    : 9;
  const count = range.automatic ? Math.min(max, recommended) : max;
  const values = requested === undefined
    ? Array.from({ length: count }, (_, i) => from + ((to - from) * (i + 1)) / (count + 1))
    : requested;
  if (!Array.isArray(values) || !values.length || values.length > max ||
      values.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < from || v >= to))
    throw new Error(`请提供最多 ${max} 个视频范围内的采样时刻（秒）。`);
  return [...new Set(values.map((v) => {
    const rounded = Math.round(v * 100) / 100;
    return rounded >= from && rounded < to ? rounded : v;
  }))].sort((a, b) => a - b);
}

/** Bound the result before serializing; never cut JSON or silently split a subtitle segment. */
export function serializeObservation(payload: Record<string, unknown>, offset = 0, textBudget = Infinity) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000) throw new Error('字幕游标无效。');
  const maxChars = 24000;
  const data = payload.subtitles as {
    segments?: Array<{ from: number; to: number; text: string }>;
    truncated?: boolean;
  } | undefined;
  if (!Array.isArray(data?.segments)) {
    const serialized = JSON.stringify(payload);
    if (serialized.length > maxChars) throw new Error('观察结果超过文字预算。');
    return serialized;
  }
  const all = data.segments, segments: typeof all = [];
  if (offset > all.length) throw new Error('字幕游标超出当前字幕范围。');
  const page = { ...data, segments, offset, nextOffset: null as number | null, truncated: false, sourceTruncated: !!data.truncated };
  const result = { ...payload, subtitles: page };
  let chars = JSON.stringify(result).length + 24, remaining = textBudget;
  for (let i = offset; i < all.length; i++) {
    const entry = all[i], size = JSON.stringify(entry).length + 1;
    if (chars + size > maxChars || entry.text.length > remaining) break;
    segments.push(entry);
    chars += size;
    remaining -= entry.text.length;
  }
  const end = offset + segments.length;
  page.truncated = end < all.length || !!data.truncated;
  page.nextOffset = segments.length && end < all.length ? end : null;
  const serialized = JSON.stringify(result);
  if (serialized.length > maxChars) throw new Error('观察结果超过文字预算。');
  return serialized;
}

export async function composeStoryboard(
  frames: Array<{ atSec: number; bytes: Uint8Array }>, ffmpegFile: string, dir: string,
  signal?: AbortSignal,
) {
  if (frames.length < 2 || frames.length > MAX_STORYBOARD_CELLS)
    throw new Error('每张分镜支持 2 到 ' + MAX_STORYBOARD_CELLS + ' 帧。');
  const cols = frames.length > 6 ? 3 : 2, rows = Math.ceil(frames.length / cols);
  const width = cols === 3 ? 266 : 480;
  const height = Math.min(320, Math.floor(640000 / (cols * rows * width) / 2) * 2);
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-filter_complex_threads', '1'];
  const cells = frames.map((frame, i) => ({
    atSec: frame.atSec, row: Math.floor(i / cols) + 1, column: i % cols + 1,
  }));
  for (let i = 0; i < frames.length; i++) {
    signal?.throwIfAborted();
    const input = join(dir, `cell-${i}.jpg`);
    await writeFile(input, frames[i].bytes, { flag: 'wx', mode: 0o600 });
    args.push('-protocol_whitelist', 'file,pipe', '-i', input);
  }
  const filters = cells.map((_, i) =>
    `[${i}:v]scale=${width - 4}:${height - 4}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x17212e,setsar=1[v${i}]`);
  const layout = cells.map((c) => `${(c.column - 1) * width}_${(c.row - 1) * height}`).join('|');
  filters.push(cells.map((_, i) => `[v${i}]`).join('') +
    `xstack=inputs=${cells.length}:layout=${layout}:fill=0x17212e[out]`);
  const output = join(dir, 'storyboard.jpg');
  await runFfmpeg(ffmpegFile, [...args, '-filter_complex', filters.join(';'), '-map', '[out]',
    '-frames:v', '1', '-threads', '1', '-q:v', '5', output], signal);
  return { cells, bytes: await readFile(output) };
}

export async function fitCommentPhotos(
  frames: Array<{ atSec: number; bytes: Buffer }>, maxBytes: number, ffmpegFile: string, dir: string, signal?: AbortSignal,
) {
  const result = [];
  for (const frame of frames) {
    signal?.throwIfAborted();
    if (frame.bytes.length <= maxBytes) {
      result.push(frame);
      continue;
    }
    if (!ffmpegFile.trim()) continue;
    const input = join(dir, 'photo-' + frame.atSec);
    const output = input + '.jpg';
    try {
      await writeFile(input, frame.bytes);
      await runFfmpeg(ffmpegFile, ['-y', '-v', 'error', '-protocol_whitelist', 'file,pipe',
        '-i', input, '-frames:v', '1', '-vf', 'scale=960:960:force_original_aspect_ratio=decrease',
        '-q:v', '5', output], signal);
      const bytes = await readFile(output);
      if (bytes.length && bytes.length <= maxBytes) result.push({ atSec: frame.atSec, bytes });
    } catch {
      signal?.throwIfAborted();
    }
  }
  return result;
}

export function runFfmpeg(file: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!file.trim()) {
      reject(new Error('尚未配置 FFmpeg，未采样画面。'));
      return;
    }
    if (signal?.aborted) {
      reject(new Error('操作已取消'));
      return;
    }
    const child = spawn(file, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false });
    let diagnostic = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      diagnostic = (diagnostic + chunk).slice(-4096);
    });
    let error: Error | undefined;
    const cancel = () => {
      error = new Error('视频采样已取消或超时');
      child.kill();
    };
    const timer = setTimeout(cancel, 20000);
    signal?.addEventListener('abort', cancel, { once: true });
    child.once('error', () => {
      error = new Error('无法启动 FFmpeg，请在设置中填写可执行文件路径。');
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (error) reject(error);
      else if (code !== 0) {
        const reason = /Decoder .*not found|Unknown decoder/i.test(diagnostic) ? '当前 FFmpeg 缺少解码器'
          : /invalid data|moov atom not found/i.test(diagnostic) ? '媒体容器无效或数据不完整'
          : /Permission denied|No space left/i.test(diagnostic) ? '本机临时目录无法读写或空间不足'
          : '媒体解码或图片处理失败';
        reject(new Error('FFmpeg 未能完成处理：' + reason + '（退出码 ' + code + '）。'));
      }
      else resolve();
    });
  });
}
/** Download only an authorized media URL, decode a local file, then remove all intermediate files. */
export async function sampleVideo(
  url: string,
  times: number[],
  ffmpegFile: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  workspace?: string,
) {
  if (!ffmpegFile.trim()) throw new Error('尚未配置 FFmpeg，未采样画面。');
  const dir = workspace ?? (await mkdtemp(join(tmpdir(), 'cortico-socialmedia-')));
  try {
    const timeout = AbortSignal.timeout(30000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetcher(safeAssetUrl(url), {
      headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0' },
      redirect: 'error',
      signal: combined,
    });
    if (!response.ok) throw new Error(`视频流读取失败（HTTP ${response.status}）`);
    const cap = 64 * 1024 * 1024;
    if (Number(response.headers.get('content-length') || 0) > cap) {
      await response.body?.cancel();
      throw new Error('视频流超过 64MB，请通过浏览器观看。');
    }
    if (/^(?:text\/|application\/(?:json|xhtml\+xml))/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel();
      throw new Error('平台返回了文字页面而非视频流，未交给 FFmpeg 解码。');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('视频流为空');
    const input = join(dir, 'video.media');
    const file = await open(input, 'wx', 0o600);
    let length = 0;
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        length += r.value.length;
        if (length > cap) throw new Error('视频流超过 64MB，请通过浏览器观看。');
        await file.writeFile(r.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      await file.close();
    }
    const frames: Array<{ atSec: number; bytes: Uint8Array }> = [];
    for (let i = 0; i < times.length; i++) {
      const output = join(dir, `${i}.jpg`);
      await runFfmpeg(
        ffmpegFile,
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-protocol_whitelist',
          'file,pipe',
          '-ss',
          String(times[i]),
          '-i',
          input,
          '-frames:v',
          '1',
          '-vf',
          'scale=960:960:force_original_aspect_ratio=decrease:force_divisible_by=2',
          '-threads',
          '2',
          '-q:v',
          '4',
          '-y',
          output,
        ],
        signal,
      );
      const bytes = await readFile(output);
      if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw new Error('采样画面无效');
      frames.push({ atSec: times[i], bytes });
    }
    return frames;
  } finally {
    if (!workspace) await rm(dir, { recursive: true, force: true });
  }
}

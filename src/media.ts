import { mkdtemp, readFile, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { safeAssetUrl } from './platforms/bilibili.ts';

export function sampleTimes(durationSec: number, maxFrames: number, requested?: unknown): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error('视频时长无效');
  const max = Math.max(1, Math.min(6, Math.trunc(maxFrames)));
  const values =
    requested === undefined
      ? Array.from({ length: max }, (_, i) => (durationSec * (i + 1)) / (max + 1))
      : requested;
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.length > max ||
    values.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v >= durationSec)
  )
    throw new Error(`请提供最多 ${max} 个视频范围内的采样时刻（秒）。`);
  return [...new Set(values.map((n) => Math.round(n * 100) / 100))];
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
    const child = spawn(file, args, { stdio: 'ignore', windowsHide: true, shell: false });
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
      else if (code !== 0) reject(new Error('FFmpeg 未能解码该视频。'));
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
          'scale=960:-2',
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

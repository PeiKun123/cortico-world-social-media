import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  lstatSync,
  readdirSync,
  rmSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { RESOURCE_DEFAULTS, type ResourceConfig } from './resource-policy.ts';
export { RESOURCE_DEFAULTS, type ResourceConfig } from './resource-policy.ts';
export type SampleFrame = { atSec: number; bytes: Uint8Array };
type Ledger = {
  kind: 'socialmedia-resources-v1';
  day: string;
  todayCalls: number;
  publishedBytes: number;
};
type CacheEntry = {
  kind: 'socialmedia-frames-v1';
  capturedAt: number;
  frames: Array<{ atSec: number; data: string }>;
};
const CACHE = /^frame-[0-9a-f]{64}\.json$/;
export class MediaResources {
  private canonical: string;
  private ledger: Ledger;
  private tail: Promise<unknown> = Promise.resolve();
  private ledgerFile: string;
  constructor(
    readonly dir: string,
    private settings: () => Partial<ResourceConfig>,
    private timezone: string,
  ) {
    mkdirSync(dir, { recursive: true });
    if (lstatSync(dir).isSymbolicLink()) throw Error('资源目录不能是目录链接。');
    this.canonical = realpathSync(dir);
    this.ledgerFile = join(dir, 'resources.json');
    this.ledger = {
      kind: 'socialmedia-resources-v1',
      day: this.day(),
      todayCalls: 0,
      publishedBytes: 0,
    };
    if (existsSync(this.ledgerFile)) {
      this.assertFile(this.ledgerFile);
      const s = JSON.parse(readFileSync(this.ledgerFile, 'utf8'));
      if (
        s.kind !== 'socialmedia-resources-v1' ||
        !Number.isSafeInteger(s.todayCalls) ||
        s.todayCalls < 0 ||
        !Number.isSafeInteger(s.publishedBytes) ||
        s.publishedBytes < 0 ||
        typeof s.day !== 'string'
      )
        throw Error('资源预算记录无法读取，已保留原文件。');
      this.ledger = s;
    }
  }
  private assertRoot() {
    if (lstatSync(this.dir).isSymbolicLink() || realpathSync(this.dir) !== this.canonical)
      throw Error('资源目录归属发生变化，未操作。');
  }
  private cfg() {
    return { ...RESOURCE_DEFAULTS, ...this.settings() };
  }
  private day() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }
  private serial<T>(fn: () => Promise<T>) {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => {});
    return p;
  }
  private assertFile(path: string) {
    this.assertRoot();
    if (
      resolve(path) !== join(resolve(this.dir), path.slice(this.dir.length + 1)) ||
      lstatSync(path).isSymbolicLink() ||
      !lstatSync(path).isFile()
    )
      throw Error('资源文件路径或归属异常，未操作。');
  }
  private atomic(path: string, data: string) {
    this.assertRoot();
    if (existsSync(path)) this.assertFile(path);
    const tmp = join(this.dir, 'write-' + randomUUID() + '.tmp');
    try {
      writeFileSync(tmp, data, { mode: 0o600, flush: true });
      renameSync(tmp, path);
    } finally {
      if (existsSync(tmp)) rmSync(tmp);
    }
  }
  private save() {
    this.atomic(this.ledgerFile, JSON.stringify(this.ledger));
  }
  private resetDay() {
    if (this.ledger.day !== this.day()) {
      this.ledger.day = this.day();
      this.ledger.todayCalls = 0;
      this.save();
    }
  }
  private entries() {
    this.assertRoot();
    return readdirSync(this.dir)
      .filter((n) => CACHE.test(n))
      .flatMap((n) => {
        const path = join(this.dir, n),
          s = lstatSync(path);
        return s.isFile() && !s.isSymbolicLink() ? [{ path, bytes: s.size, at: s.mtimeMs }] : [];
      });
  }
  private sweep() {
    const cfg = this.cfg(),
      all = this.entries().sort((a, b) => b.at - a.at);
    let total = 0,
      removed = 0;
    for (const e of all) {
      if (
        Date.now() - e.at > cfg.cacheDays * 86400000 ||
        total + e.bytes > cfg.maxCacheMB * 1048576
      ) {
        this.assertFile(e.path);
        rmSync(e.path);
        removed++;
      } else total += e.bytes;
    }
    this.sweepWorkspaces();
    return removed;
  }
  private sweepWorkspaces() {
    for (const name of readdirSync(this.dir).filter((n) => /^work-[0-9a-f-]{36}$/.test(n))) {
      const path = join(this.dir, name),
        s = lstatSync(path);
      if (!s.isDirectory() || s.isSymbolicLink() || Date.now() - s.mtimeMs < 86400000) continue;
      try {
        const marker = join(path, 'owner.json');
        if (lstatSync(marker).isSymbolicLink()) continue;
        const m = JSON.parse(readFileSync(marker, 'utf8'));
        if (m.kind !== 'socialmedia-work-v1' || m.job !== name || !Number.isInteger(m.pid))
          continue;
        let alive = true;
        try {
          process.kill(m.pid, 0);
        } catch (e) {
          alive = (e as NodeJS.ErrnoException).code !== 'ESRCH';
        }
        if (alive) continue;
        if (
          readdirSync(path).some(
            (n) =>
              lstatSync(join(path, n)).isSymbolicLink() || lstatSync(join(path, n)).isDirectory(),
          )
        )
          continue;
        rmSync(path, { recursive: true });
      } catch {
        /* Unknown or occupied data is retained. */
      }
    }
  }
  status() {
    this.resetDay();
    const entries = this.entries();
    return {
      todayCalls: this.ledger.todayCalls,
      maxDailyVisualCalls: this.cfg().maxDailyVisualCalls,
      publishedBytes: this.ledger.publishedBytes,
      maxPublishedBytes: this.cfg().maxPublishedMediaMB * 1048576,
      cacheBytes: entries.reduce((n, e) => n + e.bytes, 0),
      cacheEntries: entries.length,
      cacheDays: this.cfg().cacheDays,
      maxCacheBytes: this.cfg().maxCacheMB * 1048576,
      hostAttachments: '由Cortico保存；清理本World缓存不会删除历史附件或重置累计图片预算。',
    };
  }
  async clearCache() {
    return this.serial(async () => {
      let removed = 0;
      for (const e of this.entries()) {
        this.assertFile(e.path);
        rmSync(e.path);
        removed++;
      }
      this.sweepWorkspaces();
      return { removed, ...this.status() };
    });
  }
  async maintain() {
    return this.serial(async () => ({ removed: this.sweep(), ...this.status() }));
  }
  async workspace<T>(fn: (dir: string) => Promise<T>) {
    this.assertRoot();
    const name = 'work-' + randomUUID(),
      dir = join(this.dir, name);
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'owner.json'),
      JSON.stringify({ kind: 'socialmedia-work-v1', job: name, pid: process.pid }),
      { mode: 0o600 },
    );
    try {
      return await fn(dir);
    } finally {
      this.assertRoot();
      if (
        !lstatSync(dir).isSymbolicLink() &&
        !readdirSync(dir).some(
          (n) => lstatSync(join(dir, n)).isSymbolicLink() || lstatSync(join(dir, n)).isDirectory(),
        )
      )
        rmSync(dir, { recursive: true });
    }
  }
  async observe(key: string, capture: () => Promise<SampleFrame[]>) {
    return this.serial(async () => {
      this.sweep();
      this.resetDay();
      const cfg = this.cfg();
      if (this.ledger.todayCalls >= cfg.maxDailyVisualCalls)
        throw Error('今日视觉观察次数已用完；可继续读文字和评论。');
      const path = join(
        this.dir,
        'frame-' + createHash('sha256').update(key).digest('hex') + '.json',
      );
      this.ledger.todayCalls++;
      this.save();
      if (existsSync(path)) {
        this.assertFile(path);
        if (statSync(path).size <= 20 * 1048576) {
          const c = JSON.parse(readFileSync(path, 'utf8')) as CacheEntry;
          if (
            c.kind === 'socialmedia-frames-v1' &&
            Date.now() - c.capturedAt <= cfg.cacheDays * 86400000 &&
            Array.isArray(c.frames) &&
            c.frames.length <= 6
          ) {
            const frames = c.frames.map((f) => ({
              atSec: f.atSec,
              bytes: Buffer.from(f.data, 'base64'),
            }));
            this.validate(frames);
            return { frames, cached: true, capturedAt: c.capturedAt };
          }
        }
      }
      if (this.ledger.publishedBytes >= cfg.maxPublishedMediaMB * 1048576)
        throw Error('累计图片交付预算已用完；宿主历史附件须由Cortico管理，可继续文字交流。');
      const frames = await capture();
      this.validate(frames);
      const bytes = frames.reduce((n, f) => n + f.bytes.length, 0);
      if (this.ledger.publishedBytes + bytes > cfg.maxPublishedMediaMB * 1048576)
        throw Error('本次图片超过累计交付预算，未附加图片。');
      const capturedAt = Date.now(),
        entry: CacheEntry = {
          kind: 'socialmedia-frames-v1',
          capturedAt,
          frames: frames.map((f) => ({
            atSec: f.atSec,
            data: Buffer.from(f.bytes).toString('base64'),
          })),
        };
      this.atomic(path, JSON.stringify(entry));
      this.ledger.publishedBytes += bytes;
      this.save();
      this.sweep();
      return { frames, cached: false, capturedAt };
    });
  }
  private validate(frames: SampleFrame[]) {
    const cfg = this.cfg();
    if (
      !Array.isArray(frames) ||
      !frames.length ||
      frames.length > 6 ||
      frames.some(
        (f) =>
          !Number.isFinite(f.atSec) ||
          f.atSec < 0 ||
          !(f.bytes instanceof Uint8Array) ||
          !f.bytes.length ||
          f.bytes.length > cfg.maxImageKB * 1024,
      )
    )
      throw Error('采样图片为空、数量或大小超出限制，未附加图片。');
  }
}

export function browserCacheArgs(mb: number) {
  const n = Math.max(16, Math.min(512, Number.isFinite(mb) ? Math.trunc(mb) : 128)) * 1048576;
  return ['--disk-cache-size=' + n, '--media-cache-size=' + n];
}
export async function clearNetworkCache(context: import('playwright-core').BrowserContext) {
  const p = context.pages()[0] ?? (await context.newPage()),
    s = await context.newCDPSession(p);
  try {
    await s.send('Network.clearBrowserCache');
  } finally {
    await s.detach();
  }
}

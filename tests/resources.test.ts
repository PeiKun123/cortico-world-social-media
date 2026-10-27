import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  rm,
  writeFile,
  utimes,
  readFile,
  readdir,
  mkdir,
  rename,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaResources, RESOURCE_DEFAULTS, clearNetworkCache } from '../src/resources.ts';
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function setup(overrides: Record<string, number> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'socialmedia-resource-test-'));
  dirs.push(dir);
  const cfg = { ...RESOURCE_DEFAULTS, ...overrides };
  return { dir, cfg, r: new MediaResources(dir, () => cfg, 'UTC') };
}
const frames = [{ atSec: 2, bytes: new Uint8Array([255, 216, 255, 1, 2, 3]) }];
describe('owned media resources', () => {
  it('persists daily and cumulative budgets and reuses identical cached bytes without a new capture', async () => {
    const x = await setup();
    let calls = 0;
    const capture = async () => {
      calls++;
      return frames;
    };
    await x.r.observe('bilibili:99:2', capture);
    await x.r.observe('bilibili:99:2', capture);
    expect(calls).toBe(1);
    const restarted = new MediaResources(x.dir, () => x.cfg, 'UTC');
    expect((await restarted.status()).todayCalls).toBe(2);
    expect((await restarted.status()).publishedBytes).toBe(6);
    expect((await restarted.observe('bilibili:99:2', capture)).cached).toBe(true);
    expect(calls).toBe(1);
  });
  it('never starts another capture after the daily budget is exhausted', async () => {
    const x = await setup({ maxDailyVisualCalls: 1 });
    await x.r.observe('one', async () => frames);
    let called = false;
    await expect(
      x.r.observe('two', async () => {
        called = true;
        return frames;
      }),
    ).rejects.toThrow('今日');
    expect(called).toBe(false);
  });
  it('keeps the cumulative host contribution counter when local cached images are cleared', async () => {
    const x = await setup({ maxPublishedMediaMB: 0.000005 });
    await expect(x.r.observe('one', async () => frames)).rejects.toThrow('累计');
    expect((await x.r.status()).publishedBytes).toBe(0);
    x.cfg.maxPublishedMediaMB = 1;
    await x.r.observe('one', async () => frames);
    await x.r.clearCache();
    expect((await x.r.status()).publishedBytes).toBe(6);
    expect((await x.r.status()).cacheBytes).toBe(0);
  });
  it('removes stale owned cache entries but leaves unrelated files untouched', async () => {
    const x = await setup();
    await x.r.observe('one', async () => frames);
    await writeFile(join(x.dir, 'notes.txt'), 'keep');
    await x.r.clearCache();
    expect(await readFile(join(x.dir, 'notes.txt'), 'utf8')).toBe('keep');
  });
  it('serializes concurrent requests so they cannot overspend the last daily slot', async () => {
    const x = await setup({ maxDailyVisualCalls: 1 });
    const result = await Promise.allSettled([
      x.r.observe('a', async () => frames),
      x.r.observe('b', async () => frames),
    ]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('does not deliver oversized frames or bill them as submitted attachments', async () => {
    const x = await setup({ maxImageKB: 1 });
    await expect(
      x.r.observe('a', async () => [{ atSec: 1, bytes: new Uint8Array(1025) }]),
    ).rejects.toThrow('图片');
    expect((await x.r.status()).publishedBytes).toBe(0);
  });
});

it('clears browser network cache through its dedicated API without touching cookies', async () => {
  const methods: string[] = [];
  await clearNetworkCache({
    pages: () => [{}],
    newCDPSession: async () => ({
      send: async (m: string) => {
        methods.push(m);
      },
      detach: async () => {},
    }),
  } as any);
  expect(methods).toEqual(['Network.clearBrowserCache']);
});
it('evicts expired pictures during maintenance rather than only after a manual click', async () => {
  const x = await setup({ cacheDays: 1 });
  await x.r.observe('one', async () => frames);
  const name = (await readdir(x.dir)).find((n) => n.startsWith('frame-'))!;
  const old = new Date(Date.now() - 2 * 86400000);
  await utimes(join(x.dir, name), old, old);
  expect((await x.r.maintain()).cacheEntries).toBe(0);
});
it('removes task workspaces after decode errors', async () => {
  const x = await setup();
  await expect(
    x.r.workspace(async (dir) => {
      await writeFile(join(dir, 'video.media'), 'partial');
      throw Error('decode');
    }),
  ).rejects.toThrow('decode');
  expect((await readdir(x.dir)).filter((n) => n.startsWith('work-'))).toEqual([]);
});
it('refuses cleanup after the owned root is replaced with a directory link', async () => {
  const x = await setup(),
    target = await mkdtemp(join(tmpdir(), 'socialmedia-unrelated-test-'));
  dirs.push(target);
  await x.r.observe('one', async () => frames);
  await rename(x.dir, x.dir + '-original');
  dirs.push(x.dir + '-original');
  await symlink(target, x.dir, 'junction');
  await writeFile(join(target, 'important.txt'), 'keep');
  await expect(x.r.clearCache()).rejects.toThrow('归属');
  expect(await readFile(join(target, 'important.txt'), 'utf8')).toBe('keep');
});

it('only removes old marked workspaces after their original worker is gone', async () => {
  const x = await setup(),
    dead = 'work-11111111-1111-4111-8111-111111111111',
    live = 'work-22222222-2222-4222-8222-222222222222';
  for (const [job, pid] of [
    [dead, 123456789],
    [live, process.pid],
  ] as const) {
    const dir = join(x.dir, job);
    await mkdir(dir);
    await writeFile(
      join(dir, 'owner.json'),
      JSON.stringify({ kind: 'socialmedia-work-v1', job, pid }),
    );
    const old = new Date(Date.now() - 2 * 86400000);
    await utimes(dir, old, old);
  }
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
    if (pid === process.pid) return true;
    throw Object.assign(Error('gone'), { code: 'ESRCH' });
  });
  try {
    await x.r.maintain();
    expect(await readdir(x.dir)).not.toContain(dead);
    expect(await readdir(x.dir)).toContain(live);
  } finally {
    kill.mockRestore();
  }
});

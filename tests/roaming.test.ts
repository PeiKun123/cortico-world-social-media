import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocialStore } from '../src/store.ts';
import { SOCIALMEDIA_DEFAULTS } from '../src/config.ts';
import { Roaming } from '../src/roaming.ts';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'socialmedia-roaming-'));
  dirs.push(dir);
  const cfg = structuredClone(SOCIALMEDIA_DEFAULTS);
  cfg.roaming.enabled = true;
  Object.assign(cfg.roaming, {
    maxDailySessions: 2,
    maxVideosPerSession: 1,
    maxCommentsPerVideo: 10,
    maxCommentsPerSession: 1,
    maxDailyComments: 2,
    minIntervalMinutes: 180,
    maxSessionMinutes: 20,
  });
  let now = Date.parse('2026-10-23T03:00:00+09:00');
  const store = new SocialStore(dir);
  const roam = new Roaming(cfg, store, 'Asia/Tokyo', () => now);
  return {
    dir,
    cfg,
    store,
    roam,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe('bounded autonomous reading', () => {
  it('persists opportunities and enforces cooldown and daily cap across restarts', () => {
    const x = setup();
    const a = x.roam.offer()!;
    x.roam.finish(a.id, '没有合适内容', true);
    expect(x.roam.offer()).toBeUndefined();
    x.advance(3 * 3600000);
    const b = x.roam.offer()!;
    x.roam.finish(b.id, '看到了新的话题');
    x.advance(3 * 3600000);
    const reloaded = new Roaming(x.cfg, new SocialStore(x.dir), 'Asia/Tokyo', () =>
      Date.parse('2026-10-23T09:00:00+09:00'),
    );
    expect(reloaded.offer()).toBeUndefined();
    expect(reloaded.status().usedToday).toBe(2);
    x.advance(24 * 3600000);
    expect(x.roam.offer()).toBeDefined();
  });
  it('does not offer when disabled, and expires an abandoned round', () => {
    const x = setup();
    x.cfg.roaming.enabled = false;
    expect(x.roam.offer()).toBeUndefined();
    x.cfg.roaming.enabled = true;
    const r = x.roam.offer()!;
    x.roam.begin(r.id);
    x.advance(21 * 60000);
    expect(() => x.roam.session(r.id)).toThrow(/超时/);
    expect(x.store.roams()[0].status).toBe('expired');
  });
  it('enforces custom video, search and comment reading budgets while allowing deeper thread reads', () => {
    const x = setup();
    x.cfg.roaming.maxCommentsPerVideo = 3;
    const r = x.roam.offer()!;
    x.roam.begin(r.id);
    x.roam.recordVideo(r.id, {
      id: 'BV1',
      aid: '99',
      title: '生态',
      url: 'https://www.bilibili.com/video/av99/',
    });
    x.roam.recordVideo(r.id, {
      id: 'BV1',
      aid: '99',
      title: '生态',
      url: 'https://www.bilibili.com/video/av99/',
    });
    expect(() =>
      x.roam.recordVideo(r.id, {
        id: 'BV2',
        aid: '100',
        title: '二',
        url: 'https://www.bilibili.com/video/av100/',
      }),
    ).toThrow(/视频/);
    x.roam.search(r.id);
    x.roam.search(r.id);
    expect(() => x.roam.search(r.id)).toThrow(/搜索/);
    const page = x.roam.comments(r.id, '99', {
      items: [{ id: 'a', replies: [{ id: 'b' }, { id: 'c' }, { id: 'd' }] }, { id: 'e' }],
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].replies).toHaveLength(2);
    expect(() => x.roam.comments(r.id, '99', { items: [] })).toThrow(/评论/);
    expect(() => x.roam.comments(r.id, '101', { items: [] })).toThrow(/先读取/);
  });
  it('keeps concise notes and supports explicit skip without any publish action', () => {
    const x = setup();
    const r = x.roam.offer()!;
    x.roam.begin(r.id);
    x.roam.finish(r.id, 'a'.repeat(2000));
    expect(x.store.roams()[0].summary?.length).toBe(1000);
    expect(() => x.roam.session(r.id)).toThrow(/结束/);
    expect(x.store.outbox()).toEqual([]);
  });
});

it('keeps three independent platform quotas with one shared active session', () => {
  const x = setup();
  x.cfg.platforms.douyin.enabled = true;
  x.cfg.platforms.kuaishou.enabled = true;
  x.cfg.roaming.maxDailySessions = 1;
  const first = x.roam.offer('bilibili')!;
  expect(first.platform).toBe('bilibili');
  expect(x.roam.offer('douyin')).toBeUndefined();
  x.roam.finish(first.id, '读完');
  const second = x.roam.offer('douyin')!;
  expect(second.platform).toBe('douyin');
  x.roam.finish(second.id, '读完');
  const third = x.roam.offer('kuaishou')!;
  expect(third.platform).toBe('kuaishou');
  x.roam.finish(third.id, '读完');
  x.advance(4 * 3600000);
  expect(x.roam.offer('bilibili')).toBeUndefined();
  expect(x.roam.status().platforms.douyin.usedToday).toBe(1);
});
it('lets free roaming continue reading without daily, video or lifetime caps while retaining publish quotas', () => {
  const x = setup();
  x.cfg.roaming.mode = 'free';
  x.cfg.roaming.maxDailySessions = 1;
  const r = x.roam.offer('bilibili')!;
  x.roam.begin(r.id);
  for (let n = 0; n < 4; n++)
    x.roam.recordVideo(r.id, {
      id: 'v' + n,
      aid: String(90 + n),
      title: '作品',
      url: 'https://www.bilibili.com/video/av' + (90 + n) + '/',
    });
  for (let n = 0; n < 5; n++) x.roam.search(r.id);
  expect(
    x.roam.comments(r.id, '90', { items: Array.from({ length: 30 }, (_, n) => ({ id: n })) }).items,
  ).toHaveLength(30);
  x.advance(60 * 60000);
  expect(x.roam.session(r.id).status).toBe('active');
  x.roam.finish(r.id, '自由阅读');
  expect(x.roam.offer('bilibili')).toBeUndefined();
  x.advance(3 * 3600000);
  expect(x.roam.offer('bilibili')).toBeDefined();
});
it('binds a roaming session to its selected platform', () => {
  const x = setup();
  const r = x.roam.offer('bilibili')!;
  expect(() => x.roam.usePlatform(r.id, 'douyin')).toThrow(/平台/);
  expect(x.roam.usePlatform(r.id, 'bilibili').platform).toBe('bilibili');
});
it('keeps platform daily counts when many free sessions compact the recent history', () => {
  const x = setup();
  x.cfg.platforms.douyin.enabled = true;
  x.cfg.roaming.maxDailySessions = 1;
  const d = x.roam.offer('douyin')!;
  x.roam.finish(d.id, '读完');
  x.cfg.platforms.bilibili.roaming = { mode: 'free', minIntervalMinutes: 0 };
  for (let n = 0; n < 101; n++) {
    const r = x.roam.offer('bilibili')!;
    x.roam.finish(r.id, '读完');
    x.advance(1000);
  }
  expect(x.store.roams().length).toBeLessThanOrEqual(100);
  expect(x.roam.status().platforms.douyin.usedToday).toBe(1);
  expect(x.roam.offer('douyin')).toBeUndefined();
});

it('bounds retained context during free reading without limiting further browsing', () => {
  const x = setup();
  x.cfg.roaming.mode = 'free';
  const r = x.roam.offer('bilibili')!;
  x.roam.begin(r.id);
  for (let n = 0; n < 105; n++)
    x.roam.recordVideo(r.id, {
      id: 'v' + n,
      aid: String(1000 + n),
      title: '作品',
      url: 'https://www.bilibili.com/video/av' + (1000 + n) + '/',
    });
  expect(x.store.roams()[0].videos).toHaveLength(100);
  expect(x.roam.status().active!.videos).toHaveLength(10);
  expect(x.roam.status().active!.totalVideos).toBe(105);
  expect(() => x.roam.nextVideo(r.id)).not.toThrow();
});

import { SocialStore } from '../src/store.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SocialMediaWorld } from '../src/world.ts';
import { SOCIALMEDIA_DEFAULTS } from '../src/config.ts';
import type { WorldContext } from 'cortico/world.ts';
import type { WorldHost } from 'cortico/core/types.ts';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'socialmedia-world-'));
  dirs.push(dir);
  let cookie = '';
  let requests = 0;
  const cfg = structuredClone(SOCIALMEDIA_DEFAULTS);
  const ctx = {
    cfg,
    dataDir: dir,
    timezone: 'UTC',
    secret: () => cookie,
    storeSecret: (_k: string, v: string) => {
      cookie = v;
    },
  } as unknown as WorldContext<typeof cfg>;
  const world = new SocialMediaWorld(ctx, async (url) => {
    requests++;
    if (String(url).includes('qrcode/generate'))
      return Response.json({
        code: 0,
        data: { url: 'https://passport.bilibili.com/x/test', qrcode_key: 'secret-qr-key' },
      });
    return Response.json({ code: 0, data: { isLogin: true, mid: 42, uname: '测试账号' } });
  });
  return { world, ctx, cfg, requests: () => requests };
}
describe('Cortico integration', () => {
  it('exposes neither cookies nor login keys in tools, state or prefix', async () => {
    const x = setup();
    await x.world.webUi().invoke!('desk', 'cookie', [
      'SESSDATA=private-session; bili_jct=private-csrf',
    ]);
    await x.world.webUi().invoke!('desk', 'login', []);
    const state = await x.world.webUi().invoke!('desk', 'status', []);
    expect(
      JSON.stringify([state, x.world.envPromptVars(), x.world.tools().map((t) => t.parameters)]),
    ).not.toMatch(/private-session|private-csrf|secret-qr-key/);
  });
  it('has no network activity with monitoring disabled', async () => {
    const x = setup();
    await x.world.start({} as WorldHost);
    await x.world.webUi().invoke!('desk', 'sync', []);
    await x.world.stop();
    expect(x.requests()).toBe(0);
  });
  it('rejects malformed tool arguments instead of publishing', async () => {
    const x = setup();
    const tool = x.world.tools().find((t) => t.name === 'socialmedia_publish')!;
    const result = await tool.handler({ platform: 'bilibili', text: '你好' }, {} as never);
    expect(result).toMatchObject({ failed: true });
    expect(x.requests()).toBe(0);
  });
  it('reports the experimental platform as disabled without launching a browser', async () => {
    const x = setup();
    const tool = x.world.tools().find((t) => t.name === 'socialmedia_video')!;
    const result = await tool.handler({ platform: 'douyin', video: '123' }, {} as never);
    expect(result).toMatchObject({ failed: true, text: expect.stringContaining('已关闭') });
  });
});

it('does not let the operator publishing endpoint bypass the posting switch', async () => {
  const x = setup();
  await expect(
    x.world.webUi().invoke!('desk', 'publish', [
      {
        requestId: 'operator',
        text: '你好',
        target: { oid: '99', type: 1, root: '0', parent: '0' },
      },
    ]),
  ).rejects.toThrow(/发布已关闭/);
  expect(x.requests()).toBe(0);
});

it('offers one bounded idle round and does not interrupt a busy model or recent conversation', async () => {
  vi.useFakeTimers();
  const x = setup();
  let recent = false;
  const events: unknown[] = [];
  x.cfg.roaming.enabled = true;
  x.cfg.roaming.idleMinutes = 1;
  x.ctx.storeSecret('cookie', 'SESSDATA=test');
  const host = {
    store: { range: () => (recent ? [{ type: 'qq.message' }] : []) },
    pushEvent: async (e: unknown) => {
      events.push(e);
      return { cursor: events.length };
    },
  } as unknown as WorldHost;
  try {
    await x.world.start(host);
    x.world.onRunPhase({ state: 'model', enteredAt: new Date().toISOString(), running: [] });
    await vi.advanceTimersByTimeAsync(70000);
    expect(events).toHaveLength(0);
    x.world.onRunPhase({ state: 'idle', enteredAt: new Date().toISOString(), running: [] });
    recent = true;
    await vi.advanceTimersByTimeAsync(70000);
    expect(events).toHaveLength(0);
    recent = false;
    await vi.advanceTimersByTimeAsync(10000);
    expect(events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).toContain('socialmedia.roam');
  } finally {
    await x.world.stop();
    vi.useRealTimers();
  }
});

it('offers a private draft review once before posting and keeps idempotent receipts', async () => {
  const x = setup();
  x.cfg.platforms.bilibili.posting.enabled = true;
  x.ctx.storeSecret('cookie', 'SESSDATA=test;bili_jct=test;DedeUserID=42');
  x.world.bilibili.video = async () => ({
    id: 'BV1',
    aid: '99',
    cid: '1',
    title: '开发日志',
    url: 'https://www.bilibili.com/video/av99/',
    description: '先做水体再放生物',
    author: '作者',
    durationSec: 10,
    cover: '',
    parts: [],
  });
  x.world.bilibili.comments = async () => ({
    root: undefined,
    page: 1,
    total: 1,
    items: [
      {
        id: '101',
        author: '路人',
        authorId: '7',
        text: '这个细节很用心',
        target: { oid: '99', type: 1, root: '100', parent: '101' },
      },
    ],
  });
  const send = vi.fn(async () => ({ receiptId: '777', transport: 'browser' as const }));
  x.world.bilibili.send = send;
  x.world.bilibili.checkVisibility = async () => ({
    status: 'public',
    checkedAt: new Date().toISOString(),
    detail: 'fixture',
  });
  const publish = x.world.tools().find((t) => t.name === 'socialmedia_publish')!;
  const call = async (args: Record<string, unknown>) => {
    const result = await publish.handler(args, {} as never);
    if (typeof result === 'string') throw Error(result);
    return result;
  };
  const args = {
    platform: 'bilibili',
    requestId: 'draft-once',
    target: { oid: '99', type: 1, root: '100', parent: '101' },
    text: '这条我有一半赞同，不过我自己养着一箱蚂蚁。',
  };
  const first = await call(args),
    ready = JSON.parse(first.text!);
  expect(first.failed).not.toBe(true);
  expect(ready.status).toBe('needs_review');
  expect(ready.brief.parent.text).toBe('这个细节很用心');
  expect(send).not.toHaveBeenCalled();
  const final = {
    ...args,
    briefId: ready.brief.id,
    text: '这个小细节好可爱，能看出来花了不少心思呀～',
  };
  const revised = JSON.parse((await call(final)).text!);
  expect(revised.status).toBe('needs_review');
  expect(send).not.toHaveBeenCalled();
  const misrouted = await call({ ...final, target: { ...final.target, parent: '102' } });
  expect(misrouted.failed).toBe(true);
  expect(misrouted.text).toMatch(/凭据.*目标|目标.*凭据/);
  expect(send).not.toHaveBeenCalled();
  final.briefId = revised.brief.id;
  expect(JSON.parse((await call(final)).text!).status).toBe('sent');
  expect(JSON.parse((await call({ ...final, briefId: undefined })).text!).status).toBe('sent');
  expect(send).toHaveBeenCalledTimes(1);
  const state = (await x.world.webUi().invoke!('desk', 'status', [])) as {
    outbox: Array<{ preparation?: { briefId: string } }>;
  };
  expect(state.outbox[0].preparation?.briefId).toBe(final.briefId);
});

it('validates settings only on the configuration panel, without exposing a model settings tool', async () => {
  const x = setup();
  const updates: unknown[] = [];
  x.ctx.persist = (patch) => {
    updates.push(patch);
  };
  expect(x.world.webUi().panels?.map((p) => p.title)).toEqual(['平台与记录', '配置']);
  await expect(
    x.world.webUi().invoke!('desk', 'settings', [{ 'worlds.socialmedia.roaming.enabled': true }]),
  ).rejects.toThrow(/配置页/);
  await expect(
    x.world.webUi().invoke!('settings', 'settings', [{ 'worlds.other.enabled': true }]),
  ).rejects.toThrow();
  await x.world.webUi().invoke!('settings', 'settings', [
    { 'worlds.socialmedia.roaming.maxDailyComments': 60 },
  ]);
  expect(updates).toEqual([{ roaming: { maxDailyComments: 60 } }]);
  expect(x.world.tools().some((t) => /config|settings/.test(t.name))).toBe(false);
});

it('explains why manual notification sync is skipped instead of implying success', async () => {
  const x = setup();
  const result = (await x.world.webUi().invoke!('settings', 'sync', [])) as {
    operation: { status: string; detail: string };
  };
  expect(result.operation.status).toBe('skipped');
  expect(result.operation.detail).toContain('接收评论通知已关闭');
  expect(x.requests()).toBe(0);
});
it('reports a notification read failure and its cooldown in manual sync results', async () => {
  const x = setup();
  x.cfg.platforms.bilibili.monitor.enabled = true;
  x.ctx.storeSecret('cookie', 'SESSDATA=test');
  x.world.bilibili.notifications = async () => {
    throw Error('通知读取受限');
  };
  const first = (await x.world.webUi().invoke!('settings', 'sync', [])) as {
    operation: { status: string; detail: string };
  };
  expect(first.operation.status).toBe('error');
  expect(first.operation.detail).toContain('通知读取受限');
  const next = (await x.world.webUi().invoke!('settings', 'sync', [])) as {
    operation: { status: string; detail: string };
  };
  expect(next.operation.status).toBe('cooldown');
});
it('distinguishes an already running sync from a completed empty scan', async () => {
  const x = setup();
  x.cfg.platforms.bilibili.monitor.enabled = true;
  x.ctx.storeSecret('cookie', 'SESSDATA=test');
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  x.world.bilibili.notifications = async () => {
    await pending;
    return { items: [], done: true };
  };
  const first = x.world.webUi().invoke!('settings', 'sync', []);
  await new Promise((r) => setTimeout(r, 0));
  const next = (await x.world.webUi().invoke!('settings', 'sync', [])) as {
    operation: { status: string; detail: string };
  };
  expect(next.operation.status).toBe('busy');
  release();
  const complete = (await first) as { operation: { status: string; detail: string } };
  expect(complete.operation.status).toBe('completed');
  expect(complete.operation.detail).toContain('新增0条');
});

it('checks a top-level video editor from read history without requiring an old reply to exist', async () => {
  const x = setup();
  new SocialStore(join(x.ctx.dataDir, 'socialmedia')).rememberVideo({
    aid: '99',
    id: 'av99',
    title: '视频',
    url: 'https://www.bilibili.com/video/av99/',
  });
  const check = vi.fn(async () => ({
    ready: true,
    detail: '只读检查',
    account: { id: '42', name: '测试账号' },
    checkedAt: new Date().toISOString(),
  }));
  x.world.browserSender.check = check;
  await x.world.webUi().invoke!('settings', 'browserCheck', []);
  expect(check).toHaveBeenCalledWith(
    { oid: '99', type: 1, root: '0', parent: '0' },
    expect.any(AbortSignal),
  );
  expect(x.requests()).toBe(0);
});

it('routes enabled Douyin reads through its own adapter, preserving video and comment facts', async () => {
  const x = setup();
  x.cfg.platforms.douyin.enabled = true;
  const id = '7697799441646256819';
  x.world.douyin.video = vi.fn(async () => ({
    id,
    aid: id,
    cid: id,
    title: '游戏创作',
    description: '作品简介',
    author: '作者',
    durationSec: 10,
    cover: '',
    url: 'https://www.douyin.com/video/' + id,
    parts: [],
  }));
  x.world.douyin.comments = vi.fn(async () => ({
    items: [
      {
        id: '88',
        authorId: '8',
        author: '路人',
        text: '好可爱',
        target: { oid: id, type: 2, root: '88', parent: '88' },
      },
    ],
    page: 1,
    limited: true,
    reason: 'fixture',
    root: undefined,
    nextCursor: undefined,
  }));
  const videoTool = x.world.tools().find((t) => t.name === 'socialmedia_video')!;
  const result = await videoTool.handler({ platform: 'douyin', video: id }, {} as never);
  expect(JSON.parse(typeof result === 'string' ? result : result.text!)).toMatchObject({
    video: { id, title: '游戏创作' },
    subtitles: { available: false },
  });
  expect(x.requests()).toBe(0);
  const read = await x.world.webUi().invoke!('settings', 'douyinCheck', [id]);
  expect(read).toMatchObject({ detail: expect.stringContaining('1条评论') });
  const state = (await x.world.webUi().invoke!('desk', 'status', [])) as any;
  expect(state.platforms.find((p: any) => p.id === 'douyin')).toMatchObject({
    enabled: true,
    posting: false,
  });
  expect(state.videos).toContainEqual(expect.objectContaining({ aid: id, title: '游戏创作' }));
  await expect(x.world.webUi().invoke!('desk', 'douyinLogin', [])).rejects.toThrow('配置页');
});

it('exposes next-video browsing and applies roaming limits before touching the browser', async () => {
  const x = setup();
  x.cfg.platforms.douyin.enabled = true;
  x.cfg.roaming.enabled = true;
  x.cfg.roaming.maxVideosPerSession = 1;
  const adapter = vi.spyOn(x.world.douyin, 'nextVideo').mockResolvedValue({
    id: '99',
    aid: '99',
    cid: '99',
    title: '游戏',
    description: '',
    author: '创作者',
    url: 'https://www.douyin.com/video/99',
    durationSec: 10,
    cover: '',
    parts: [],
  });
  const roam = x.world.tools().find((t) => t.name === 'socialmedia_roam')!;
  const offered = (x.world as any).service.roaming.offer('douyin');
  await roam.handler({ action: 'begin', id: offered.id }, {} as never);
  const feed = x.world.tools().find((t) => t.name === 'socialmedia_feed')!;
  expect(
    await feed.handler({ platform: 'douyin', roamId: offered.id }, {} as never),
  ).not.toMatchObject({ failed: true });
  expect(await feed.handler({ platform: 'douyin', roamId: offered.id }, {} as never)).toMatchObject(
    { failed: true, text: expect.stringContaining('预算') },
  );
  expect(adapter).toHaveBeenCalledTimes(1);
  adapter.mockRestore();
});

it('includes saved Douyin sends in the all-platform desk even when over 50 newer Bilibili sends exist', async () => {
  const x = setup(),
    store = (x.world as any).service.store;
  store.reserve({
    id: 'old-dy',
    platform: 'douyin',
    accountId: 'bot',
    text: '抖音原评论',
    target: { oid: '123', type: 2, root: '0', parent: '0' },
  });
  store.updateSend('old-dy', { status: 'sent', receiptId: '7' });
  for (let i = 0; i < 51; i++)
    store.reserve({
      id: 'b' + i,
      platform: 'bilibili',
      accountId: '42',
      text: 'B站记录',
      target: { oid: String(500 + i), type: 1, root: '0', parent: '0' },
    });
  const state = (await x.world.webUi().invoke!('desk', 'status', [])) as any;
  expect(state.outbox.some((r: any) => r.id === 'old-dy')).toBe(true);
});

it('exposes Kuaishou connection and independent owner focus in the desk snapshot', async () => {
  const x = setup();
  const state = (await x.world.webUi().invoke!('desk', 'status', [])) as any;
  expect(state.focusPlatforms.kuaishou).toBeDefined();
  expect(state.kuaishou.capabilities.frames).toBe(false);
  expect(state.plannedPlatforms).not.toContain('kuaishou');
});

it('uses two cached frames for repeated observations and falls back to text after the daily budget', async () => {
  const x = setup();
  x.cfg.media.maxDailyVisualCalls = 2;
  const video = {
    aid: '99',
    id: 'BVtest',
    cid: '1',
    title: '作品',
    url: 'https://www.bilibili.com/video/av99/',
    description: '创作',
    author: '作者',
    durationSec: 30,
    cover: '',
    parts: [],
  };
  x.world.bilibili.video = async () => video;
  x.world.bilibili.subtitles = async () => ({ available: false, reason: 'fixture' });
  const capture = vi.fn(async (_v: any, times: number[]) =>
    times.map((atSec) => ({ atSec, bytes: new Uint8Array([255, 216, 255, 1]) })),
  );
  (x.world.bilibili as any).frames = capture;
  const tool = x.world.tools().find((t) => t.name === 'socialmedia_watch')!;
  const run = () =>
    tool.handler({ platform: 'bilibili', video: 'av99' }, {} as never) as Promise<any>;
  const a = await run(),
    b = await run(),
    c = await run();
  expect(a.blobs).toHaveLength(2);
  expect(JSON.parse(a.text).sampledAtSec).toEqual([10, 20]);
  expect(JSON.parse(b.text).cached).toBe(true);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(c.blobs).toBeUndefined();
  expect(JSON.parse(c.text).reason).toContain('今日');
});

it('can close a platform login window even after the platform was disabled', async () => {
  const x = setup();
  const ks = vi.spyOn(x.world.kuaishou, 'closeLogin').mockResolvedValue(undefined),
    dy = vi.spyOn(x.world.douyin, 'closeLogin').mockResolvedValue(undefined);
  await expect(x.world.webUi().invoke!('settings', 'kuaishouClose', [])).resolves.toMatchObject({
    detail: expect.stringContaining('已关闭'),
  });
  await x.world.webUi().invoke!('settings', 'douyinClose', []);
  expect(ks).toHaveBeenCalledTimes(1);
  expect(dy).toHaveBeenCalledTimes(1);
});

it('reports an uncertain receipt as pending confirmation rather than a failed tool', async () => {
  const x = setup();
  await x.world.webUi().invoke!('desk', 'cookie', ['SESSDATA=test-session; bili_jct=test-csrf']);
  x.cfg.platforms.bilibili.posting.enabled = true;
  const store = (x.world as any).service.store;
  const target = { oid: '99', type: 1, root: '0', parent: '0' };
  store.reserve({
    id: 'bilibili:42:uncertain',
    operationId: 'bilibili:42:uncertain',
    platform: 'bilibili',
    accountId: '42',
    text: '你好',
    target,
  });
  store.updateSend('bilibili:42:uncertain', { status: 'unknown', detail: '旧尝试超时' });
  const tool = x.world.tools().find((t) => t.name === 'socialmedia_publish')!;
  const r = (await tool.handler(
    { platform: 'bilibili', requestId: 'uncertain', target, text: '你好' },
    {} as never,
  )) as any;
  expect(r.failed).not.toBe(true);
  expect(JSON.parse(r.text)).toMatchObject({
    status: 'unknown',
    submittedThisCall: false,
    delivery: { state: 'unknown' },
  });
});

it('labels video search explicitly so nickname matches are not owner identity results', async () => {
  const x = setup();
  x.cfg.platforms.kuaishou.enabled = true;
  vi.spyOn(x.world.kuaishou, 'search').mockResolvedValue({
    items: [],
    page: 1,
    limited: true,
    reason: '官网首屏结果',
  });
  const tool = x.world.tools().find((t) => t.name === 'socialmedia_search')!;
  const result = await tool.handler({ platform: 'kuaishou', query: '主人昵称' }, {} as never);
  if (typeof result === 'string') throw Error('Expected structured outcome');
  expect(result.failed).not.toBe(true);
  expect(JSON.parse(result.text!)).toMatchObject({
    scope: 'videos',
    items: [],
    identityNotice: expect.stringContaining('不能据此'),
  });
});

it.each(['dungeon.message', 'socialmedia.comment'])(
  'finishes the in-flight roaming read and saves progress before yielding to %s',
  async (eventType) => {
    const x = setup();
    x.cfg.roaming.enabled = true;
    x.cfg.platforms.douyin.enabled = true;
    const events: any[] = [];
    (x.world as any).host = { store: { range: () => events } };
    const roam = (x.world as any).service.roaming,
      round = roam.offer('douyin');
    roam.begin(round.id);
    const video = {
      id: '7699999999999999999',
      aid: '7699999999999999999',
      cid: '1',
      title: '刚刚读完的作品',
      description: '',
      author: '作者',
      durationSec: 10,
      cover: '',
      url: 'https://www.douyin.com/video/7699999999999999999',
      parts: [],
    };
    const read = vi.spyOn(x.world.douyin, 'video').mockImplementation(async () => {
      events.push({ type: eventType, origin: 'external', ts: new Date().toISOString() });
      return video;
    });
    const tool = x.world.tools().find((t) => t.name === 'socialmedia_video')!;
    const result = await tool.handler(
      { platform: 'douyin', video: video.id, roamId: round.id },
      {} as never,
    );
    if (typeof result === 'string') throw Error(result);
    expect(JSON.parse(result.text!)).toMatchObject({
      roamingHandoff: { status: 'finished', reason: expect.stringContaining('新消息') },
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(roam.status().recent[0].videos[0].title).toBe(video.title);
    expect(roam.status().active).toBeUndefined();
  },
);
it('does not open another roaming page after an external message is already queued', async () => {
  const x = setup();
  x.cfg.roaming.enabled = true;
  x.cfg.platforms.douyin.enabled = true;
  const roam = (x.world as any).service.roaming,
    round = roam.offer('douyin');
  roam.begin(round.id);
  (x.world as any).host = {
    store: {
      range: () => [{ type: 'qq.message', origin: 'external', ts: new Date().toISOString() }],
    },
  };
  const read = vi.spyOn(x.world.douyin, 'video').mockRejectedValue(Error('unexpected page read'));
  const tool = x.world.tools().find((t) => t.name === 'socialmedia_video')!;
  const result = await tool.handler(
    { platform: 'douyin', video: '7699999999999999999', roamId: round.id },
    {} as never,
  );
  if (typeof result === 'string') throw Error(result);
  expect(result.failed).not.toBe(true);
  expect(JSON.parse(result.text!).roamingHandoff.status).toBe('finished');
  expect(read).not.toHaveBeenCalled();
});

it('prioritizes unresolved notifications before offering another idle roaming round', async () => {
  vi.useFakeTimers();
  const x = setup(),
    service = (x.world as any).service,
    events: any[] = [];
  x.cfg.roaming.enabled = true;
  x.cfg.roaming.idleMinutes = 1;
  x.cfg.platforms.bilibili.monitor.enabled = true;
  x.cfg.platforms.bilibili.posting.enabled = true;
  x.ctx.storeSecret('cookie', 'SESSDATA=test');
  await service.connect('bilibili');
  vi.spyOn(service, 'poll').mockResolvedValue(true);
  service.store.addInbox({
    id: 'waiting',
    platform: 'bilibili',
    accountId: '42',
    authorId: '7',
    author: '访客',
    text: '好可爱',
    target: { oid: '99', type: 1, root: '100', parent: '100' },
    occurredAt: 1,
    status: 'pending',
    delivered: true,
  });
  try {
    await x.world.start({
      store: { range: () => [] },
      pushEvent: async (e: any) => {
        events.push(e);
        return { cursor: events.length };
      },
    } as unknown as WorldHost);
    await vi.advanceTimersByTimeAsync(75000);
    expect(events.map((e) => e.type)).toEqual(['socialmedia.comment']);
    expect(events[0].text).toContain('inboxId');
    const tool = x.world.tools().find((t) => t.name === 'socialmedia_inbox')!;
    await tool.handler({ action: 'defer', id: 'waiting', minutes: 30 }, {} as never);
    await vi.advanceTimersByTimeAsync(75000);
    expect(events.some((e) => e.type === 'socialmedia.roam')).toBe(true);
  } finally {
    await x.world.stop();
    vi.useRealTimers();
  }
});
it('keeps notification preparation independent from an expired roaming context', async () => {
  const x = setup();
  x.ctx.storeSecret('cookie', 'SESSDATA=test');
  const service = (x.world as any).service;
  service.store.addInbox({
    id: 'direct-reply',
    platform: 'bilibili',
    accountId: '42',
    authorId: '7',
    author: '访客',
    text: '好可爱',
    target: { oid: '99', type: 1, root: '100', parent: '100' },
    occurredAt: 1,
    status: 'pending',
  });
  vi.spyOn(x.world.bilibili, 'video').mockResolvedValue({
    id: 'av99',
    aid: '99',
    title: '小细节',
    url: 'https://www.bilibili.com/video/av99',
    cid: '1',
    description: '',
    author: '作者',
    durationSec: 1,
    cover: '',
    parts: [],
  });
  const tool = x.world.tools().find((t) => t.name === 'socialmedia_prepare')!;
  const result = (await tool.handler(
    {
      platform: 'bilibili',
      inboxId: 'direct-reply',
      roamId: 'expired-round',
      draft: '这个细节确实可爱。',
      purpose: '回应评论',
    },
    {} as never,
  )) as any;
  expect(result.failed).not.toBe(true);
  expect(JSON.parse(result.text).parent.text).toBe('好可爱');
});
it('keeps Douyin group tools disabled until locally configured, without using QQ or comment delivery', async () => {
  const x = setup(),
    tool = x.world.tools().find((t) => t.name === 'socialmedia_groupchat')!;
  for (const args of [
    { platform: 'qq', action: 'read', groupId: '123456' },
    { platform: 'douyin', action: 'prepare', groupId: '123456', draft: '你好' },
  ])
    expect(await tool.handler(args, {} as never)).toMatchObject({ failed: true });
  expect(x.requests()).toBe(0);
});
it('delivers one compact event for a batch of active Douyin group conversation', async () => {
  vi.useFakeTimers();
  const x = setup();
  x.cfg.enabled = true;
  x.cfg.platforms.douyin.enabled = true;
  x.cfg.platforms.douyin.chat = {
    enabled: true,
    allowSend: true,
    groups: '123456|测试群',
    intervalSec: 60,
    minIntervalSec: 30,
    maxDailyMessages: 100,
    activity: 'active',
  };
  const view = {
    accountId: 'bot',
    conversationId: 'conv',
    name: '测试群',
    messages: [
      { id: 'base', sender: '甲', senderId: 'u', text: '旧上下文', own: false, time: Date.now() },
    ],
  };
  vi.spyOn(x.world.douyin, 'readGroup').mockImplementation(async () =>
    structuredClone({
      ...view,
      messages: view.messages.map((m) => ({ ...m, conversationId: 'conv', serverStatus: 0 })),
    }),
  );
  await x.world.webUi().invoke!('settings', 'groupCheck', []);
  view.messages.push(
    { id: 'new1', sender: '甲', senderId: 'u', text: '大家在玩什么', own: false, time: Date.now() },
    { id: 'new2', sender: '乙', senderId: 'v', text: '一起聊聊呀', own: false, time: Date.now() },
  );
  const events: Array<{ type: string; text: string; meta?: Record<string, unknown> }> = [];
  try {
    await x.world.start({
      store: { range: () => [] },
      pushEvent: async (e: never) => {
        events.push(e);
        return { cursor: events.length };
      },
    } as unknown as WorldHost);
    await vi.advanceTimersByTimeAsync(4500);
    const groups = events.filter((e) => e.type === 'socialmedia.group.message');
    expect(groups).toHaveLength(1);
    expect(groups[0].meta?.messageIds).toEqual(['new1', 'new2']);
    expect(groups[0].text).toContain('活跃档');
    expect(groups[0].text).toContain('大家在玩什么');
  } finally {
    await x.world.stop();
    vi.useRealTimers();
  }
});

it('routes a temporary unsent reply back to pending rather than silently treating it as answered', async () => {
  const x = setup();
  x.cfg.enabled = true;
  const store = (x.world as any).service.store;
  const t = { oid: '99', type: 2, root: '100', parent: '101' };
  store.addInbox({
    id: 'ui-failure',
    platform: 'douyin',
    accountId: '42',
    authorId: '7',
    author: '路人',
    text: '你好',
    target: t,
    occurredAt: 1,
    status: 'pending',
  });
  store.reserve({
    id: 'ui-send',
    platform: 'douyin',
    accountId: '42',
    target: t,
    text: '待发',
    inboxId: 'ui-failure',
  });
  store.updateSend('ui-send', {
    status: 'rejected',
    detail: '尚未点击发送：填写评论未完成，请稍后重新读取该楼层。',
  });
  const tool = x.world.tools().find((t) => t.name === 'socialmedia_inbox')!;
  const retained = await tool.handler({ action: 'handled', id: 'ui-failure' }, {} as never);
  expect(typeof retained === 'string' ? retained : retained.text).toContain('pending');
  expect(store.getInbox('ui-failure').status).toBe('pending');
  await tool.handler(
    { action: 'handled', id: 'ui-failure', reason: '明确决定不接话' },
    {} as never,
  );
  expect(store.getInbox('ui-failure').status).toBe('handled');
  expect(x.requests()).toBe(0);
});

it('keeps the model inbox transport bounded and retrieves one complete original receipt by id', async () => {
  const x = setup();
  x.cfg.enabled = true;
  const store = (x.world as any).service.store;
  const target = { oid: '99', type: 2, root: '100', parent: '101' };
  for (let i = 0; i < 20; i++) {
    store.reserve({
      id: 'bounded-' + i,
      platform: 'douyin',
      accountId: '42',
      target,
      text: '回复原文'.repeat(160),
      preparation: { briefId: 'brief-' + i, purpose: '准备依据'.repeat(5000) },
    });
    store.updateSend('bounded-' + i, { status: 'sent', receiptId: 'receipt-' + i });
  }
  const tool = x.world.tools().find((t) => t.name === 'socialmedia_inbox')!;
  const result = await tool.handler(
    { action: 'list', status: 'all', query: 'douyin', limit: 50 },
    {} as never,
  );
  const body = typeof result === 'string' ? result : result.text;
  expect(body.length).toBeLessThan(8000);
  const page = JSON.parse(body);
  expect(page.outbox.length).toBeGreaterThan(0);
  expect(page.nextOutboxOffset).not.toBeNull();
  const detail = await tool.handler({ action: 'get', id: page.outbox[0].id }, {} as never);
  const record = JSON.parse(typeof detail === 'string' ? detail : detail.text).record;
  expect(record.text).toBe('回复原文'.repeat(160));
  expect(record.preparation.purpose).toBe('准备依据'.repeat(5000));
  expect(record.receiptId).toBeTruthy();
  expect(store.outbox()).toHaveLength(20);
  expect(x.requests()).toBe(0);
});

it('keeps dynamic reading disabled without network and rejects unimplemented publishing', async () => {
  const x = setup();
  const t = x.world.tools().find((t) => t.name === 'socialmedia_dynamic')!;
  expect(await t.handler({ action: 'list', scope: 'feed' }, {} as never)).toMatchObject({
    failed: true,
    text: expect.stringContaining('尚未开启'),
  });
  expect(await t.handler({ action: 'publish', text: '不会发送' }, {} as never)).toMatchObject({
    failed: true,
    text: expect.stringContaining('draftId'),
  });
  expect(x.requests()).toBe(0);
});
it('reads bounded official dynamics once, saves current-account cache and preserves daily quota across restart', async () => {
  const x = setup();
  x.cfg.platforms.bilibili.dynamics = { enabled: true, maxDailyReads: 1 };
  x.ctx.storeSecret('cookie', 'SESSDATA=test;bili_jct=test;DedeUserID=42');
  const value = {
    id: '1234567890123456789',
    authorId: '7',
    author: '朋友',
    text: '今天很好',
    title: '',
    url: 'https://t.bilibili.com/1234567890123456789',
    publishedAt: 123,
    type: 'DYNAMIC_TYPE_WORD',
    imageCount: 0,
  };
  const read = vi.spyOn(x.world.browserSender, 'readDynamics').mockResolvedValue({
    items: [value],
    accountId: '42',
    hasMore: false,
    scope: '首屏',
    transport: 'browser',
  });
  const t = x.world.tools().find((t) => t.name === 'socialmedia_dynamic')!;
  const first = await t.handler({ action: 'list', scope: 'feed' }, {} as never);
  if (typeof first === 'string') throw Error('Expected structured outcome');
  expect(first.failed).toBeUndefined();
  expect(read).toHaveBeenCalledTimes(1);
  expect(JSON.parse(first.text)).toMatchObject({ items: [{ id: value.id }], readsToday: 1 });
  const cached = await t.handler({ action: 'cached' }, {} as never);
  if (typeof cached === 'string') throw Error('Expected structured cache');
  expect(JSON.parse(cached.text).items).toHaveLength(1);
  expect(read).toHaveBeenCalledTimes(1);
  expect(await t.handler({ action: 'list', scope: 'feed' }, {} as never)).toMatchObject({
    failed: true,
    text: expect.stringContaining('已达本地上限'),
  });
  const restored = new SocialStore(join(x.ctx.dataDir, 'socialmedia'));
  expect(restored.dynamics('42')).toHaveLength(1);
  expect(restored.dynamics('84')).toHaveLength(0);
  expect(
    restored.dynamicReadCount(
      '42',
      new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date()),
    ),
  ).toBe(1);
});

it('prepares account-bound dynamic drafts, uses separate publishing opt-in and reuses a saved receipt', async () => {
  const x = setup();
  x.cfg.enabled = true;
  x.ctx.storeSecret('cookie', 'SESSDATA=test;bili_jct=test;DedeUserID=42');
  const tool = x.world.tools().find((t) => t.name === 'socialmedia_dynamic')!;
  const prepare = (await tool.handler(
    { action: 'prepare', text: '今天也要开心呀。' },
    {} as never,
  )) as any;
  const draft = JSON.parse(prepare.text);
  expect(draft.status).toBe('prepared');
  expect(await tool.handler({ action: 'publish', draftId: draft.id }, {} as never)).toMatchObject({
    failed: true,
    text: expect.stringContaining('关闭'),
  });
  x.cfg.platforms.bilibili.dynamics!.allowPublishing = true;
  const send = vi.spyOn(x.world.browserSender, 'publishDynamic').mockResolvedValue({
    status: 'sent',
    dynamicId: '1261990610011684873',
    url: 'https://t.bilibili.com/1261990610011684873',
  });
  const result = (await tool.handler({ action: 'publish', draftId: draft.id }, {} as never)) as any;
  expect(JSON.parse(result.text)).toMatchObject({ status: 'sent' });
  await tool.handler({ action: 'publish', draftId: draft.id }, {} as never);
  expect(send).toHaveBeenCalledTimes(1);
  const posts = (await tool.handler({ action: 'posts' }, {} as never)) as any;
  expect(JSON.parse(posts.text).items[0].dynamicId).toBe('1261990610011684873');
  expect(
    await tool.handler({ action: 'prepare', text: '想分享', mentionFocus: true }, {} as never),
  ).toMatchObject({ failed: true, text: expect.stringContaining('允许@') });
});

it('offers an autonomous dynamic only after quiet idle, without sending and without repeated wakeups', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-27T12:00:00Z'));
  const x = setup();
  x.cfg.enabled = true;
  x.cfg.platforms.bilibili.dynamics = {
    enabled: true,
    allowPublishing: true,
    autonomousEnabled: true,
    autoIdleMinutes: 1,
    autoMaxDaily: 1,
    autoMinIntervalMinutes: 360,
    autoStartHour: 9,
    autoEndHour: 23,
  };
  x.ctx.storeSecret('cookie', 'SESSDATA=test;bili_jct=test;DedeUserID=42');
  let recent = false;
  const events: any[] = [];
  const host = {
    store: { range: () => (recent ? [{ type: 'qq.message' }] : []) },
    pushEvent: async (e: any) => {
      events.push(e);
      return { cursor: events.length };
    },
  } as unknown as WorldHost;
  try {
    await x.world.start(host);
    x.world.onRunPhase({ state: 'model', enteredAt: new Date().toISOString(), running: [] });
    await vi.advanceTimersByTimeAsync(70000);
    expect(events).toHaveLength(0);
    x.world.onRunPhase({ state: 'idle', enteredAt: new Date().toISOString(), running: [] });
    recent = true;
    await vi.advanceTimersByTimeAsync(70000);
    expect(events).toHaveLength(0);
    recent = false;
    await vi.advanceTimersByTimeAsync(10000);
    expect(events.filter((e) => e.type === 'socialmedia.dynamic')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(events.filter((e) => e.type === 'socialmedia.dynamic')).toHaveLength(1);
    expect((x.world as any).service.store.dynamicPosts('42')).toHaveLength(0);
  } finally {
    await x.world.stop();
    vi.useRealTimers();
  }
});

it('offers a group topic only while quiet and idle, never sends automatically and does not repeat opportunities', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-27T12:00:00Z'));
  const x = setup(),
    events: any[] = [];
  let recent = false;
  x.cfg.enabled = true;
  x.cfg.platforms.douyin.enabled = true;
  x.cfg.platforms.douyin.chat = {
    enabled: true,
    allowSend: true,
    groups: '123456|测试群',
    intervalSec: 60,
    minIntervalSec: 30,
    maxDailyMessages: 100,
    proactiveEnabled: true,
    proactiveIdleMinutes: 5,
    proactiveMaxDaily: 1,
  };
  vi.spyOn(x.world.douyin, 'readGroup').mockResolvedValue({
    accountId: 'bot',
    conversationId: 'conv',
    name: '测试群',
    messages: [
      {
        id: 'old',
        senderId: 'u',
        sender: '甲',
        text: '昨天的背景',
        own: false,
        time: Date.now() - 86400000,
        conversationId: 'conv',
        serverStatus: 0,
      },
    ],
  });
  const send = vi.spyOn(x.world.douyin, 'sendGroup');
  try {
    await x.world.webUi().invoke!('settings', 'groupCheck', []);
    await x.world.start({
      store: { range: () => (recent ? [{ type: 'qq.message' }] : []) },
      pushEvent: async (e: any) => {
        events.push(e);
        return { cursor: events.length };
      },
    } as unknown as WorldHost);
    x.world.onRunPhase({ state: 'model', enteredAt: new Date().toISOString(), running: [] });
    await vi.advanceTimersByTimeAsync(360000);
    expect(events.filter((e) => e.type === 'socialmedia.group.invite')).toHaveLength(0);
    x.world.onRunPhase({ state: 'idle', enteredAt: new Date().toISOString(), running: [] });
    recent = true;
    await vi.advanceTimersByTimeAsync(360000);
    expect(events.filter((e) => e.type === 'socialmedia.group.invite')).toHaveLength(0);
    recent = false;
    await vi.advanceTimersByTimeAsync(61000);
    expect(events.filter((e) => e.type === 'socialmedia.group.invite')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(360000);
    expect(events.filter((e) => e.type === 'socialmedia.group.invite')).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  } finally {
    await x.world.stop();
    vi.useRealTimers();
  }
});

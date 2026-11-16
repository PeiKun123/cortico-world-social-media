import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { WorldContext } from 'cortico/world.ts';
import { SOCIALMEDIA_DEFAULTS } from '../src/config.ts';
import { ExpressionLog } from '../src/expression.ts';
import { SocialStore } from '../src/store.ts';
import { SocialMediaWorld } from '../src/world.ts';
import { Roaming } from '../src/roaming.ts';
import type { PracticeTeacher } from '../src/platforms/gemini-practice.ts';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(teacher: PracticeTeacher) {
  const dir = mkdtempSync(join(tmpdir(), 'socialmedia-expression-'));
  directories.push(dir);
  const cfg = structuredClone(SOCIALMEDIA_DEFAULTS);
  cfg.enabled = true;
  const ctx = {
    cfg, dataDir: dir, timezone: 'UTC', secret: () => '',
    persist: (patch: Partial<typeof cfg>) => {
      if (patch.experiments) Object.assign(cfg.experiments!, patch.experiments);
    },
  } as unknown as WorldContext<typeof cfg>;
  const world = new SocialMediaWorld(ctx, async () => { throw Error('Unexpected social request'); }, teacher);
  const events: Array<{ text: string }> = [];
  const range = vi.fn<() => Array<{ type: string; meta?: { ownerComment: boolean } }>>(() => []);
  Object.assign(world, { host: { store: { range }, pushEvent: async (event: { text: string }) => { events.push(event); } } });
  const invoke = world.webUi().invoke!;
  const invite = async () => {
    await invoke('settings', 'expressionInvite', []);
    return events.at(-1)!.text.match(/offerId=([\w-]+)/)![1];
  };
  const tool = async (args: Record<string, unknown>, instance = world) => {
    const result = await instance.tools().find(entry => entry.name === 'socialmedia_expression')!.handler(args, {} as never);
    return typeof result === 'string' ? { text: result } : result;
  };
  return { cfg, ctx, invoke, tool, invite, events, range, world };
}
it('keeps the staged public-post adapters inaccessible with older enabled settings', async () => {
  const teacher: PracticeTeacher = {
    openLogin: async () => {}, close: async () => {}, verifyConversation: async (url) => url,
    practice: async () => {},
  };
  const { cfg, invoke, tool, world } = setup(teacher);
  Object.assign(cfg.experiments!, { tieba: true, xiaohongshu: true });
  const expression = world.tools().find(entry => entry.name === 'socialmedia_expression')!;
  expect(JSON.stringify(expression.parameters)).not.toMatch(/tieba|xiaohongshu|publicSearch/);
  for (const platform of ['tieba', 'xiaohongshu']) {
    await expect(tool({ action: 'publicSearch', platform, query: '试读' })).resolves.toMatchObject({ failed: true });
    await expect(invoke('settings', 'expressionPublicLogin', [platform])).rejects.toThrow('暂未开放');
    await expect(invoke('settings', 'expressionReadPost', [platform])).rejects.toThrow('暂未开放');
  }
});
it('uses an exact public excerpt, submits only that excerpt, and retrieves only approved advice after reopening', async () => {
  const sent: string[] = [];
  const teacher: PracticeTeacher = {
    openLogin: async () => {}, close: async () => {}, verifyConversation: async (url) => url,
    practice: async (url, first, second, _signal, report) => {
      expect(url).toBe('https://gemini.google.com/app/teaching');
      sent.push(first);
      report('把空泛的感叹换成对一个动作的观察。');
      if (second) { sent.push(second); report('新题：看到一段慢慢整理积木的视频，你怎么接话？'); }
    },
  };
  const { cfg, ctx, invoke, tool, invite } = setup(teacher);
  const store = new SocialStore(join(ctx.dataDir, 'socialmedia'));
  store.rememberVideo({ aid: '9', id: '9', title: '样片话题', url: 'https://www.bilibili.com/video/av9' });
  const target = { oid: '9', type: 1, root: '7', parent: '7' };
  store.rememberComment({ id: '7', author: '公开作者', target, text: '这里停了一秒才转身，很有意思。' });
  const sampleArgs = { action: 'save', platform: 'bilibili', target, quote: '停了一秒才转身', note: '私人备忘不出站' };
  expect(await tool(sampleArgs)).toMatchObject({ failed: true });
  cfg.experiments!.corpus = true;
  expect(await tool({ ...sampleArgs, quote: '模型编造的句子' })).toMatchObject({ failed: true });
  const sample = JSON.parse((await tool(sampleArgs)).text).item;
  await expect(invoke('settings', 'expressionInvite', [])).rejects.toThrow('已关闭');
  cfg.experiments!.practice = true;
  await expect(invoke('settings', 'expressionInvite', [])).rejects.toThrow('请先绑定');
  await invoke('settings', 'expressionBind', ['https://gemini.google.com/app/teaching']);
  const offerId = await invite();
  expect(await tool({ action: 'chat', offerId, message: '联系我 test@example.com' })).toMatchObject({ failed: true });
  const chat = await tool({ action: 'chat', offerId, message: '怎么接一句才自然？', sampleId: sample.id, followup: true });
  const { id } = JSON.parse(chat.text);
  expect(await tool({ action: 'chat', offerId, message: '重复发' })).toMatchObject({ failed: true });
  const row = JSON.parse((await tool({ action: 'practice', id })).text);
  expect(row).toMatchObject({ status: 'review', feedback: expect.arrayContaining([expect.stringContaining('新题')]) });
  expect(sent).toHaveLength(2);
  expect(sent[0]).toContain('停了一秒才转身');
  expect(sent.every(message => message.startsWith('我是小K，一个在练中文口语和聊天语感的 AI。'))).toBe(true);
  expect(sent[0]).not.toMatch(/私人备忘|bilibili\.com|公开作者/);
  await expect(invoke('settings', 'expressionAdopt', [row.id, true])).rejects.toThrow('等小K完成');
  await tool({ action: 'reflect', id: row.id, choice: '选具体动作，保留原先的惊讶', lesson: '具体动作比空泛称赞更自然', newQuestion: '积木视频怎么接话', newAnswer: '摆到最后那块才发现颜色能拼成一条线。' });
  expect(JSON.parse((await tool({ action: 'handbook' })).text).items).toEqual([]);
  await invoke('settings', 'expressionAdopt', [row.id, true]);
  const reopened = new SocialMediaWorld(ctx, fetch, teacher);
  expect(JSON.parse((await tool({ action: 'handbook', query: '具体动作' }, reopened)).text).items)
    .toMatchObject([{ id: row.id, source: expect.stringContaining('av9') }]);
  await reopened.webUi().invoke!('settings', 'expressionAdopt', [row.id, false]);
  expect(JSON.parse((await tool({ action: 'handbook' }, reopened)).text).items).toEqual([]);
});
it('turning practice off aborts a running round and prevents a follow-up', async () => {
  let begin!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  let followup = false;
  const teacher: PracticeTeacher = {
    openLogin: async () => {}, close: async () => {}, verifyConversation: async (url) => url,
    practice: async (_url, _first, _second, signal, report) => {
      report('点评');
      begin();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      signal.throwIfAborted();
      followup = true;
    },
  };
  const { cfg, invoke, invite, tool } = setup(teacher);
  cfg.experiments!.practice = true;
  await invoke('settings', 'expressionBind', ['https://gemini.google.com/app/teaching']);
  const offerId = await invite();
  const { id } = JSON.parse((await tool({ action: 'chat', offerId, message: '这个停顿真有意思' })).text);
  await started;
  await invoke('settings', 'settings', [{ 'worlds.socialmedia.experiments.practice': false }]);
  const snapshot = await invoke('settings', 'expressionList', []);
  expect(snapshot).toMatchObject({ practices: [{ id, status: 'paused', feedback: ['点评'] }] });
  expect(followup).toBe(false);
  await expect(invoke('settings', 'expressionInvite', [])).rejects.toThrow('已关闭');
});
it('starts continuous training automatically, waits for private chat, and follows up in the same thread', async () => {
  const sent: Array<{ url: string; message: string }> = [];
  const teacher: PracticeTeacher = {
    openLogin: async () => {}, close: async () => {}, verifyConversation: async url => url,
    practice: async (url, message, _followup, _signal, report) => {
      sent.push({ url, message });
      report('第' + sent.length + '条回复');
    },
  };
  const { cfg, invoke, events, range, tool, world } = setup(teacher);
  const state = world as unknown as { trainingReadyAt: number; maybeOfferPractice(): Promise<void> };
  const url = 'https://gemini.google.com/app/teaching';
  cfg.experiments!.practice = true;
  await invoke('settings', 'expressionBind', [url]);
  await state.maybeOfferPractice();
  expect(events).toHaveLength(0);
  cfg.experiments!.training = true;
  range.mockReturnValueOnce([{ type: 'qq.message' }]);
  await state.maybeOfferPractice();
  expect(events).toHaveLength(0);
  await state.maybeOfferPractice();
  const offerId = events.at(-1)!.text.match(/offerId=([\w-]+)/)![1];
  const { id } = JSON.parse((await tool({ action: 'chat', offerId, message: '怎么自然接话？' })).text);
  await state.maybeOfferPractice();
  expect(events.at(-1)!.text).toContain('step=1');
  range.mockReturnValueOnce([{ type: 'console.message' }]);
  expect(await tool({ action: 'continue', id, step: 1, message: '可以给个具体例子吗？' })).toMatchObject({ failed: true });
  expect(sent).toHaveLength(1);
  await state.maybeOfferPractice();
  expect(events.at(-1)!.text).toContain('step=1');
  range.mockReturnValueOnce([{ type: 'socialmedia.comment', meta: { ownerComment: true } }]);
  expect(await tool({ action: 'continue', id, step: 1, message: '等主人评论处理完再问' })).toMatchObject({ failed: true });
  expect(sent).toHaveLength(1);
  await state.maybeOfferPractice();
  for (const [i, message] of ['可以给个具体例子吗？', '换成我这句自然吗？', '朋友只是随口说一句又怎么接？'].entries()) {
    const step = i + 1;
    expect(await tool({ action: 'continue', id, step, message })).not.toMatchObject({ failed: true });
    expect(await tool({ action: 'continue', id, step, message })).toMatchObject({ failed: true });
    await state.maybeOfferPractice();
  }
  expect(sent.map(item => item.url)).toEqual([url, url, url, url]);
  expect(events.at(-1)!.text).toContain('收尾阶段');
  const row = JSON.parse((await tool({ action: 'practice', id })).text);
  expect(row.followups).toHaveLength(3);
  expect(row.feedback).toHaveLength(4);
  expect(await tool({ action: 'continue', id, step: 4, message: '第五条' })).toMatchObject({ failed: true });
  expect(JSON.parse((await tool({ action: 'reflect', id, choice: '接具体动作', lesson: '先接最后一句', newQuestion: '怎么接别人聊做饭', newAnswer: '你那个面包边是不是烤得脆脆的？' })).text).status).toContain('训练自动继续');
  expect(JSON.parse((await tool({ action: 'handbook' })).text).items).toEqual([]);
  const assess = { action: 'assess', id, verdict: 'keep', reason: '新场景中也能接住对方的细节' };
  expect(await tool(assess)).toMatchObject({ failed: true });
  world.onHandoffEnded();
  expect(events.at(-1)!.text).toContain(id);
  expect(await tool(assess)).not.toMatchObject({ failed: true });
  expect(await tool(assess)).toMatchObject({ failed: true });
  expect(JSON.parse((await tool({ action: 'handbook' })).text).items).toMatchObject([{ id }]);
  await invoke('settings', 'expressionAdopt', [id, false]);
  world.onHandoffEnded();
  expect(await tool(assess)).toMatchObject({ failed: true });
  expect(JSON.parse((await tool({ action: 'handbook' })).text).items).toEqual([]);
  state.trainingReadyAt = 0;
  await state.maybeOfferPractice();
  expect(events.at(-1)!.text).toContain('offerId=');
});
it('stops background training when the continuous switch is turned off', async () => {
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const teacher: PracticeTeacher = {
    openLogin: async () => {}, close: async () => {}, verifyConversation: async url => url,
    practice: async (_url, _message, _followup, signal) => {
      started();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      signal.throwIfAborted();
    },
  };
  const { cfg, invoke, events, tool, world } = setup(teacher);
  const state = world as unknown as { maybeOfferPractice(): Promise<void>; practiceWork?: Promise<void> };
  cfg.experiments!.practice = true;
  await invoke('settings', 'expressionBind', ['https://gemini.google.com/app/teaching']);
  cfg.experiments!.training = true;
  await state.maybeOfferPractice();
  const offerId = events.at(-1)!.text.match(/offerId=([\w-]+)/)![1];
  await tool({ action: 'chat', offerId, message: '聊聊怎么开场。' });
  await waiting;
  await invoke('settings', 'settings', [{ 'worlds.socialmedia.experiments.training': false }]);
  await state.practiceWork;
  await state.maybeOfferPractice();
  expect(events).toHaveLength(1);
  expect(await invoke('settings', 'expressionList', [])).toMatchObject({ practices: [{ status: 'paused' }] });
});
it('uses existing roaming counts while diversifying replies and recognizing a cross-platform duplicate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'socialmedia-diversity-'));
  directories.push(dir);
  const cfg = structuredClone(SOCIALMEDIA_DEFAULTS);
  cfg.roaming.enabled = true;
  cfg.roaming.maxCommentsPerVideo = 3;
  delete cfg.platforms.bilibili.roaming;
  delete cfg.platforms.douyin.roaming;
  cfg.platforms.douyin.enabled = true;
  const store = new SocialStore(dir);
  const roaming = new Roaming(cfg, store, 'UTC');
  const a = roaming.offer('bilibili')!;
  const title = '这是一个足够具体而且可以识别的我的世界作品标题';
  roaming.recordVideo(a.id, { id: '1', aid: '1', url: 'https://www.bilibili.com/video/av1', title }, '主动搜索');
  const rows = [
    { id: 'best', text: '平台原来的首条' },
    { id: 'older', text: '这一条只是比较早的普通回复。', createdAt: 1 },
    { id: 'context', text: '这条评论的前后还有值得了解的细节。', replies: [{ id: 'nested' }] },
    { id: 'newer', text: '这一条来自刚刚进入评论区的新读者。', createdAt: 10 },
  ];
  const result = roaming.comments(a.id, '1', { items: rows }, true);
  expect(result.items.map(item => item.id)).toEqual(['best', 'newer', 'context']);
  expect(result.readingRemaining).toBe(0);
  roaming.finish(a.id, '完成');
  const b = roaming.offer('douyin')!;
  expect(roaming.duplicate(b.id, title + ' #游戏')).toBe(true);
  expect(roaming.duplicate(b.id, '另一个不同的话题')).toBe(false);
  roaming.search(b.id, '相邻主题');
  expect(() => roaming.search(b.id, '相邻主题')).toThrow('机会已用完');
});

it('pages all saved practices newest first and clamps stale page numbers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'socialmedia-expression-'));
  directories.push(dir);
  const log = new ExpressionLog(join(dir, 'expression.json'));
  for (let i = 1; i <= 34; i++) log.begin('topic ' + i);
  expect(log.practicePage(1)).toMatchObject({
    practiceTotal: 34, practicePage: 1, practicePages: 12,
    practices: ['topic 34', 'topic 33', 'topic 32'].map(original => expect.objectContaining({ original })),
  });
  expect(log.practicePage(99)).toMatchObject({
    practiceTotal: 34, practicePage: 12, practices: [expect.objectContaining({ original: 'topic 1' })],
  });
  expect(log.practicePage(-1).practicePage).toBe(1);
});

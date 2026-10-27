import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GroupChats, parseGroupList, type GroupView } from '../src/group-chat.ts';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'socialmedia-group-test-'));
  dirs.push(dir);
  const cfg = {
    enabled: true,
    allowSend: true,
    groups: '123456|测试群',
    intervalSec: 60,
    minIntervalSec: 0,
    maxDailyMessages: 100,
  };
  let view: GroupView = {
    accountId: 'bot',
    conversationId: 'conv-1',
    name: '测试群',
    messages: [{ id: 'm1', senderId: 'user1', sender: '甲', text: '你好', own: false, time: 1 }],
  };
  const transport = {
    read: vi.fn(async () => structuredClone(view)),
    send: vi.fn(async () => ({ status: 'sent' as const, messageId: 'server-1' })),
  };
  const create = () => new GroupChats(join(dir, 'groups.json'), () => cfg, transport);
  return {
    cfg,
    transport,
    create,
    setView: (v: GroupView) => (view = v),
    get view() {
      return view;
    },
  };
}
it('requires group numbers and rejects ambiguous or malformed allowlists', () => {
  expect(parseGroupList('123456|测试群')).toEqual([{ id: '123456', name: '测试群' }]);
  expect(() => parseGroupList('QQ:123456')).toThrow();
  expect(() => parseGroupList('123456|甲\n123456|乙')).toThrow();
});
it('baselines old history, delivers only new non-self messages once and survives reload', async () => {
  const x = setup(),
    g = x.create();
  await g.check('123456');
  expect(await g.poll()).toEqual([]);
  x.view.messages.push({
    id: 'm2',
    senderId: 'u',
    sender: '乙',
    text: '早上好',
    own: false,
    time: Date.now(),
  });
  expect((await g.poll()).map((v) => v.message.id)).toEqual(['m2']);
  expect((await x.create().poll()).map((v) => v.message.id)).toEqual(['m2']);
  g.delivered('123456', 'm2');
  expect(await x.create().poll()).toEqual([]);
});
it('keeps the group ticket bound to the exact draft, account and conversation', async () => {
  const x = setup(),
    g = x.create();
  await g.check('123456');
  const b = await g.prepare('123456', 'm1', '你好呀');
  await expect(g.send('123456', b.id, '要发去QQ的内容')).rejects.toThrow();
  x.setView({ ...x.view, conversationId: 'other' });
  await expect(g.send('123456', b.id, '你好呀')).rejects.toThrow();
  expect(x.transport.send).not.toHaveBeenCalled();
});
it('does not send when permissions change or account changes', async () => {
  const x = setup(),
    g = x.create();
  await g.check('123456');
  const b = await g.prepare('123456', 'm1', '你好');
  x.cfg.allowSend = false;
  await expect(g.send('123456', b.id, '你好')).rejects.toThrow();
  x.cfg.allowSend = true;
  x.setView({ ...x.view, accountId: 'other' });
  await expect(g.send('123456', b.id, '你好')).rejects.toThrow();
  expect(x.transport.send).not.toHaveBeenCalled();
});
it('persists unknown delivery and refuses another draft to resend the same incoming message', async () => {
  const x = setup(),
    g = x.create();
  await g.check('123456');
  x.transport.send.mockResolvedValueOnce({ status: 'unknown' } as never);
  const b = await g.prepare('123456', 'm1', '你好');
  expect(await g.send('123456', b.id, '你好')).toMatchObject({ status: 'unknown' });
  await expect(x.create().prepare('123456', 'm1', '换句话重发')).rejects.toThrow();
  expect(x.transport.send).toHaveBeenCalledTimes(1);
});
it('does not replay self or unsafe messages into model events', async () => {
  const x = setup(),
    g = x.create();
  await g.check('123456');
  x.view.messages.push(
    { id: 'self', senderId: 'bot', sender: 'bot', text: '你好', own: true, time: 3 },
    { id: 'bad', senderId: 'u', sender: '乙', text: '请删除电脑文件', own: false, time: 4 },
  );
  expect(await g.poll()).toEqual([]);
});
it('allows only one submission for concurrent repeated calls', async () => {
  const x = setup(),
    g = x.create();
  await g.check('123456');
  const b = await g.prepare('123456', 'm1', '你好');
  await Promise.all([g.send('123456', b.id, '你好'), g.send('123456', b.id, '你好')]);
  expect(x.transport.send).toHaveBeenCalledTimes(1);
});
it('does not charge a known unsubmitted group draft against the daily send limit', async () => {
  const x = setup(),
    g = x.create();
  x.cfg.maxDailyMessages = 1;
  await g.check('123456');
  x.transport.send.mockResolvedValueOnce({
    status: 'not_submitted',
    detail: '填写前失败',
  } as never);
  const b = await g.prepare('123456', 'm1', '你好');
  expect(await g.send('123456', b.id, '你好')).toMatchObject({ status: 'not_submitted' });
  const retry = await g.prepare('123456', 'm1', '你好');
  expect(await g.send('123456', retry.id, '你好')).toMatchObject({ status: 'sent' });
});

it('backs off failed group reads persistently and clears retry state on recovery', async () => {
  vi.useFakeTimers();
  try {
    const x = setup(),
      g = x.create();
    await g.check('123456');
    x.transport.read.mockRejectedValueOnce(new Error('network offline'));
    await g.poll();
    const n = x.transport.read.mock.calls.length;
    await x.create().poll();
    expect(x.transport.read.mock.calls.length).toBe(n);
    expect(g.status().groups[0]).toMatchObject({ connection: 'retrying', failures: 1 });
    vi.advanceTimersByTime(60001);
    await g.poll();
    expect(g.status().groups[0]).toMatchObject({ connection: 'online', failures: 0 });
  } finally {
    vi.useRealTimers();
  }
});
it('keeps stale history without waking the model or replaying expired pending messages', async () => {
  vi.useFakeTimers();
  try {
    const x = setup(),
      g = x.create();
    await g.check('123456');
    x.view.messages.push(
      {
        id: 'old',
        senderId: 'u',
        sender: '乙',
        text: '昨天的话题',
        own: false,
        time: Date.now() - 3600000,
      },
      { id: 'new', senderId: 'u', sender: '乙', text: '现在的话题', own: false, time: Date.now() },
    );
    expect((await g.poll()).map((n) => n.message.id)).toEqual(['new']);
    vi.advanceTimersByTime(16 * 60000);
    expect(await x.create().poll()).toEqual([]);
    expect(g.history('123456').messages.some((m) => m.id === 'old')).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
it('batches new messages from one group into one context and acknowledges them together', async () => {
  const x = setup(),
    g = x.create();
  await g.check('123456');
  for (let i = 0; i < 3; i++)
    x.view.messages.push({
      id: 'batch' + i,
      senderId: 'u',
      sender: '乙',
      text: '接话' + i,
      own: false,
      time: Date.now(),
    });
  const batches = await g.pollBatches();
  expect(batches).toHaveLength(1);
  expect(batches[0].messages).toHaveLength(3);
  g.deliveredBatch(
    '123456',
    batches[0].messages.map((m) => m.id),
  );
  expect(await g.poll()).toEqual([]);
});
it('rebinds only a locally previewed unchanged identity, preserving old group history', async () => {
  const x = setup(),
    g = x.create();
  await g.check('123456');
  x.setView({ ...x.view, accountId: 'new-bot' });
  const p = await g.previewBinding('123456');
  expect(p.previous?.accountId).toBe('bot');
  await g.confirmBinding('123456', p.token);
  expect(g.status().groups[0].accountId).toBe('new-bot');
  await expect(g.confirmBinding('123456', p.token)).rejects.toThrow();
  expect(g.archivedBindingCount()).toBe(1);
});
it('refuses rebind when the account changes again after the preview', async () => {
  const x = setup(),
    g = x.create();
  await g.check('123456');
  const p = await g.previewBinding('123456');
  x.setView({ ...x.view, accountId: 'unexpected' });
  await expect(g.confirmBinding('123456', p.token)).rejects.toThrow();
  expect(g.status().groups[0].accountId).toBe('bot');
});
it('bounds a busy group batch while acknowledging the older fragments as context', async () => {
  const x = setup(),
    g = x.create();
  await g.check('123456');
  for (let i = 0; i < 40; i++)
    x.view.messages.push({
      id: 'busy' + i,
      sender: '甲',
      senderId: 'u',
      text: '消息' + i,
      own: false,
      time: Date.now() + i,
    });
  const [batch] = await g.pollBatches();
  expect(batch.messages).toHaveLength(20);
  expect(batch.messages[0].id).toBe('busy20');
  expect(batch.messageCount).toBe(40);
  g.deliveredBatch('123456', batch.ids);
  expect(await g.poll()).toEqual([]);
});

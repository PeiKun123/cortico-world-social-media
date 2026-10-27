import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocialStore } from '../src/store.ts';
import { DynamicPublishing } from '../src/dynamic-publishing.ts';
const dirs: string[] = [];
afterEach(() => {
  for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'social-dynamic-post-'));
  dirs.push(dir);
  const store = new SocialStore(dir);
  let time = Date.parse('2026-10-27T09:00:00Z');
  const cfg = { enabled: true, allowPublishing: true, maxDailyPosts: 2, minIntervalSec: 60 };
  const send = vi.fn(async (_draft: import('../src/dynamic-publishing.ts').DynamicPost) => ({
    status: 'sent' as const,
    dynamicId: '1261990610011684873',
    url: 'https://t.bilibili.com/1261990610011684873',
    detail: '已在本人动态读取到',
  }));
  const make = (s = store) =>
    new DynamicPublishing(
      s,
      () => cfg,
      send,
      'UTC',
      () => time,
    );
  return {
    dir,
    store,
    cfg,
    send,
    make,
    advance: () => {
      time += 61000;
    },
  };
}
it('binds exact text, account and resolved mention to a draft, reuses the same published operation', async () => {
  const x = setup(),
    p = x.make();
  const d = p.prepare('42', '今天也要开开心心呀。', { id: '7', name: '主人' });
  expect(d.status).toBe('prepared');
  expect(x.send).not.toHaveBeenCalled();
  const r = await p.publish('42', d.id);
  expect(r.status).toBe('sent');
  expect(x.send.mock.calls[0][0]).toMatchObject({
    accountId: '42',
    text: '今天也要开开心心呀。',
    mention: { id: '7', name: '主人' },
  });
  expect(await p.publish('42', d.id)).toMatchObject({ status: 'sent', dynamicId: r.dynamicId });
  expect(x.send).toHaveBeenCalledTimes(1);
  expect(p.prepare('42', '今天也要开开心心呀。', { id: '7', name: '主人' }).id).toBe(d.id);
});
it('blocks disabled publishing, changed account and expired drafts before sending', async () => {
  const x = setup(),
    p = x.make();
  const d = p.prepare('42', '一条动态');
  x.cfg.allowPublishing = false;
  await expect(p.publish('42', d.id)).rejects.toThrow(/发布.*关闭/);
  x.cfg.allowPublishing = true;
  await expect(p.publish('99', d.id)).rejects.toThrow(/账号/);
  for (let i = 0; i < 31; i++) x.advance();
  await expect(p.publish('42', d.id)).rejects.toThrow(/过期/);
  expect(x.send).not.toHaveBeenCalled();
});
it('persists an unknown result across restart, refuses changed-text retries, and reserves only once concurrently', async () => {
  const x = setup();
  let release!: (r: any) => void;
  x.send.mockImplementation(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const p = x.make(),
    d = p.prepare('42', '不重复');
  const first = p.publish('42', d.id);
  expect(await p.publish('42', d.id)).toMatchObject({ status: 'sending' });
  release({ status: 'unknown', detail: '未核实' });
  expect((await first).status).toBe('unknown');
  const restored = x.make(new SocialStore(x.dir));
  expect(await restored.publish('42', d.id)).toMatchObject({ status: 'unknown' });
  const next = restored.prepare('42', '换文字也不重发');
  await expect(restored.publish('42', next.id)).rejects.toThrow(/待核实/);
  expect(x.send).toHaveBeenCalledTimes(1);
});
it('counts daily attempts and checks intervals even after a restart', async () => {
  const x = setup(),
    p = x.make();
  await p.publish('42', p.prepare('42', '第一条').id);
  await expect(p.publish('42', p.prepare('42', '第二条').id)).rejects.toThrow(/间隔/);
  x.advance();
  await p.publish('42', p.prepare('42', '第二条').id);
  x.advance();
  const q = x.make(new SocialStore(x.dir));
  await expect(q.publish('42', q.prepare('42', '第三条').id)).rejects.toThrow(/上限/);
  expect(x.send).toHaveBeenCalledTimes(2);
});
it('marks an interrupted persisted send unknown and limits text and public results', () => {
  const x = setup(),
    p = x.make();
  expect(() => p.prepare('42', '')).toThrow();
  expect(() => p.prepare('42', '字'.repeat(501))).toThrow();
  const d = p.prepare('42', '中断');
  x.store.saveDynamicPost({ ...d, status: 'sending', attemptedAt: new Date().toISOString() });
  const restored = x.make(new SocialStore(x.dir));
  expect(restored.records('42')[0].status).toBe('unknown');
  expect(restored.records('99')).toEqual([]);
});

it('allows a new explicit draft after a known rejection but never reuses or retries an unknown send', async () => {
  const x = setup(),
    p = x.make();
  x.send.mockResolvedValueOnce({ status: 'rejected' as any, detail: '尚未提交' } as any);
  const first = p.prepare('42', '同一条测试');
  expect((await p.publish('42', first.id)).status).toBe('rejected');
  const retry = p.prepare('42', '同一条测试');
  expect(retry.id).not.toBe(first.id);
  expect((await p.publish('42', first.id)).status).toBe('rejected');
  expect(x.send).toHaveBeenCalledTimes(1);
});

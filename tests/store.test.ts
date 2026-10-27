import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SocialStore } from '../src/store.ts';
const dirs: string[] = [];
function dir() {
  const d = mkdtempSync(join(tmpdir(), 'socialmedia-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const item = {
  id: 'bilibili:42:123',
  platform: 'bilibili',
  accountId: '42',
  authorId: '7',
  author: '朋友',
  text: '你好',
  target: { oid: '99', type: 1, root: '123', parent: '123' },
  occurredAt: 123,
  status: 'pending' as const,
};
describe('durable social state', () => {
  it('keeps unread messages and deduplicates after restart', () => {
    const d = dir();
    const a = new SocialStore(d);
    a.addInbox(item);
    a.addInbox(item);
    const b = new SocialStore(d);
    expect(b.inbox()).toEqual([item]);
  });
  it('never automatically retries an interrupted external send', () => {
    const d = dir();
    const a = new SocialStore(d);
    a.reserve({
      id: 'op1',
      platform: 'bilibili',
      accountId: '42',
      text: '你好',
      target: item.target,
    });
    const b = new SocialStore(d);
    expect(b.outbox()[0].status).toBe('unknown');
    expect(() =>
      b.reserve({
        id: 'op1',
        platform: 'bilibili',
        accountId: '42',
        text: '再发',
        target: item.target,
      }),
    ).toThrow(/已存在/);
  });
  it('fails closed on damaged state without replacing evidence', () => {
    const d = dir();
    writeFileSync(join(d, 'state.json'), '{oops');
    expect(() => new SocialStore(d)).toThrow(/记录无法读取/);
  });
});

it('adds public context to legacy state without changing notifications or send records', () => {
  const d = dir();
  const sent = {
    id: 'old',
    platform: 'bilibili',
    accountId: '42',
    text: '原有发言',
    target: item.target,
    status: 'sent',
    createdAt: '2026-10-01T00:00:00Z',
    receiptId: '1234567890123456789',
  };
  writeFileSync(
    join(d, 'state.json'),
    JSON.stringify({ version: 1, inbox: [item], outbox: [sent], feeds: {} }),
  );
  const store = new SocialStore(d);
  store.rememberVideo({
    aid: '99',
    id: 'av99',
    title: '原标题',
    url: 'https://www.bilibili.com/video/av99/',
  });
  store.rememberComments({
    items: [{ id: '123', author: '朋友', text: '原话', target: item.target }],
  });
  const loaded = new SocialStore(d);
  expect(loaded.inbox()).toEqual([item]);
  expect(loaded.outbox()).toEqual([sent]);
  expect(loaded.comment({ parent: '123', root: '123', type: 1, oid: '99' })?.text).toBe('原话');
  expect(loaded.video('99')?.title).toBe('原标题');
});

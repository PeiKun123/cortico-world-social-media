import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocialStore } from '../src/store.ts';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
it('archives old full receipts but preserves exact operation recovery across restart', () => {
  const d = mkdtempSync(join(tmpdir(), 'socialmedia-archive-test-'));
  dirs.push(d);
  const s = new SocialStore(d);
  s.reserve({
    id: 'old',
    operationId: 'bilibili:42:once',
    platform: 'bilibili',
    accountId: '42',
    text: '同一句',
    target: { oid: '99', type: 1, root: '0', parent: '0' },
  });
  s.updateSend('old', { status: 'sent', receiptId: '777' });
  (s as any).state.outbox[0].createdAt = '2020-01-01T00:00:00.000Z';
  s.maintainHistory();
  expect(s.outbox()).toHaveLength(0);
  expect((s as any).state.version).toBe(2);
  const restored = new SocialStore(d);
  expect(restored.operationSends('bilibili:42:once')[0]).toMatchObject({
    id: 'old',
    text: '同一句',
    receiptId: '777',
  });
  expect(restored.getSend('old')?.status).toBe('sent');
  expect(restored.historyPage(10, 0)).toHaveLength(1);
});
it('never archives pending outcomes or recent records used for daily quotas', () => {
  const d = mkdtempSync(join(tmpdir(), 'socialmedia-archive-test-'));
  dirs.push(d);
  const s = new SocialStore(d);
  for (const id of ['recent', 'unknown'])
    s.reserve({
      id,
      platform: 'bilibili',
      accountId: '42',
      text: '保留',
      target: { oid: '99', type: 1, root: '0', parent: '0' },
    });
  s.updateSend('recent', { status: 'sent' });
  s.updateSend('unknown', { status: 'unknown' });
  (s as any).state.outbox[1].createdAt = '2020-01-01T00:00:00.000Z';
  s.maintainHistory();
  expect(s.outbox()).toHaveLength(2);
});

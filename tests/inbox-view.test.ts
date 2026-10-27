import { expect, it } from 'vitest';
import { compactInboxPage } from '../src/inbox-view.ts';
import type { InboxItem, SendRecord } from '../src/platform.ts';
it('pages huge inbox and send history within a fixed model response budget without dropping receipts or stored originals', () => {
  const target = { oid: '99', type: 2, root: '100', parent: '101' };
  const inbox = Array.from(
    { length: 50 },
    (_, i) =>
      ({
        id: 'in-' + i,
        platform: 'douyin',
        accountId: '42',
        authorId: '7',
        author: '访客',
        text: '原文'.repeat(1000),
        target,
        occurredAt: i,
        status: 'pending',
      }) as InboxItem,
  );
  const sends = Array.from(
    { length: 50 },
    (_, i) =>
      ({
        id: 'out-' + i,
        platform: 'douyin',
        accountId: '42',
        text: '回复'.repeat(500),
        target,
        status: 'sent',
        receiptId: 'receipt-' + i,
        createdAt: new Date(i).toISOString(),
        preparation: { purpose: '长篇记录'.repeat(5000) },
      }) as SendRecord,
  );
  const before = JSON.stringify({ inbox, sends });
  let offset = 0,
    outboxOffset = 0;
  const seen = new Set<string>(),
    receipts = new Set<string>();
  for (let n = 0; n < 60; n++) {
    const p = compactInboxPage(inbox, sends, {
      query: 'douyin',
      status: 'all',
      limit: 50,
      offset,
      outboxOffset,
    });
    expect(JSON.stringify(p).length).toBeLessThanOrEqual(8000);
    for (const i of p.items) seen.add(i.id);
    for (const r of p.outbox) receipts.add(r.receiptId!);
    if (p.nextOffset === null && p.nextOutboxOffset === null) break;
    offset = p.nextOffset ?? p.totalItems;
    outboxOffset = p.nextOutboxOffset ?? p.totalOutbox;
  }
  expect(seen.size).toBe(50);
  expect(receipts.size).toBe(50);
  expect(JSON.stringify({ inbox, sends })).toBe(before);
});

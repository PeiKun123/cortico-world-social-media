import type { InboxItem, SendRecord } from './platform.ts';

/** Model list view only; operator history and stored preparation evidence remain complete. */
export function compactInboxPage(
  inbox: InboxItem[],
  sends: SendRecord[],
  options: {
    query?: string;
    status?: string;
    limit?: number;
    offset?: number;
    outboxOffset?: number;
  },
) {
  const { offset = 0, outboxOffset = 0, limit = 10, status = 'pending' } = options;
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(outboxOffset) ||
    outboxOffset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw Error('分页参数无效');
  const q = (options.query ?? '').toLocaleLowerCase();
  const matches = (row: unknown) => !q || JSON.stringify(row).toLocaleLowerCase().includes(q);
  const allItems = inbox
    .filter((i) => (status === 'all' || i.status === status) && matches(i))
    .sort((a, b) => b.occurredAt - a.occurredAt);
  const allSends = sends
    .filter(matches)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  function take<T, R>(rows: T[], start: number, map: (row: T) => R) {
    const result: R[] = [];
    let chars = 2;
    for (const row of rows.slice(start, start + limit)) {
      const item = map(row),
        size = JSON.stringify(item).length + 1;
      if (chars + size > 3200) break;
      result.push(item);
      chars += size;
    }
    return result;
  }
  const items = take(allItems, offset, (i) => ({
    id: i.id,
    platform: i.platform,
    accountId: i.accountId,
    author: i.author.slice(0, 80),
    authorId: i.authorId,
    text: i.text.slice(0, 160),
    textTruncated: i.text.length > 160,
    target: i.target,
    status: i.status,
    ownerAutoReply: i.ownerAutoReply,
    occurredAt: i.occurredAt,
    retryAt: i.retryAt,
  }));
  const outbox = take(allSends, outboxOffset, (r) => ({
    id: r.id,
    platform: r.platform,
    accountId: r.accountId,
    inboxId: r.inboxId,
    target: r.target,
    status: r.status,
    receiptId: r.receiptId,
    createdAt: r.createdAt,
    text: r.text.slice(0, 160),
    textTruncated: r.text.length > 160,
    detail: r.detail?.slice(0, 180),
    visibility: r.visibility?.status,
    briefId: r.preparation?.briefId,
    mention: r.mention,
  }));
  return {
    items,
    outbox,
    totalItems: allItems.length,
    totalOutbox: allSends.length,
    nextOffset: offset + items.length < allItems.length ? offset + items.length : null,
    nextOutboxOffset:
      outboxOffset + outbox.length < allSends.length ? outboxOffset + outbox.length : null,
    note: '这是有长度预算的短列表，不代表只剩这些条目。沿nextOffset/nextOutboxOffset分页；原文或完整回执用action=get与对应id单条读取，不批量重读准备材料。',
  };
}
export function singleInboxRecord(item: InboxItem | undefined, record: SendRecord | undefined) {
  if (item) return { item };
  if (!record) throw Error('消息或发送记录不存在');
  const { preparation, ...receipt } = record;
  return {
    record: {
      ...receipt,
      ...(preparation
        ? {
            preparation: {
              briefId: preparation.briefId,
              purpose: preparation.purpose,
              judgment: preparation.judgment,
            },
          }
        : {}),
    },
  };
}

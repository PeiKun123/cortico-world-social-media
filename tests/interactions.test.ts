import { expect, it } from 'vitest';
import { buildInteractions, commentLink, filterInteractions } from '../src/interactions.ts';
import type { InboxItem, SendRecord } from '../src/platform.ts';
const target = { oid: '99', type: 1, root: '1234567890123456789', parent: '1234567890123456790' };
const incoming = {
  id: 'in',
  platform: 'bilibili',
  accountId: '42',
  author: '访客',
  authorId: '8',
  text: '这个安排很用心',
  target,
  occurredAt: 100,
  status: 'pending',
} as InboxItem;
const outgoing = {
  id: 'out',
  platform: 'bilibili',
  accountId: '42',
  text: '确实，那个小细节好可爱～',
  target,
  createdAt: new Date(101000).toISOString(),
  status: 'sent',
  receiptId: '1234567890123456791',
  inboxId: 'in',
  visibility: { status: 'public', checkedAt: new Date().toISOString(), detail: 'ok' },
} as SendRecord;
it('groups incoming and outgoing by video and root while preserving exact comment links', () => {
  const a = buildInteractions([incoming], [outgoing], []);
  expect(a).toHaveLength(1);
  expect(a[0].threads).toHaveLength(1);
  expect(a[0].threads[0].entries).toHaveLength(2);
  expect(commentLink(target, outgoing.receiptId)).toContain(
    'comment_secondary_id=1234567890123456791',
  );
  expect(commentLink(target, outgoing.receiptId)).toContain('#reply1234567890123456791');
});
it('shows proactive comments without notifications, with video title and truthful public status', () => {
  const a = buildInteractions(
    [],
    [
      {
        ...outgoing,
        inboxId: undefined,
        target: { ...target, root: '0', parent: '0' },
        visibility: { status: 'self-only', checkedAt: '', detail: 'state17' },
      },
    ],
    [
      {
        aid: '99',
        id: 'BV1',
        title: '开发日志',
        url: 'https://www.bilibili.com/video/av99/',
        updatedAt: '',
      },
    ],
  );
  expect(a[0].video.title).toBe('开发日志');
  const e = a[0].threads[0].entries[0];
  expect(e.kind).toBe('主动评论');
  expect(e.status).toBe('仅自己可见');
  expect(e.pending).toBe(false);
  expect(filterInteractions(a, 'pending', '')).toEqual([]);
  expect(filterInteractions(a, 'sent', '开发日志')).toHaveLength(1);
});
it('keeps unknown sends separate from incoming pending and refuses unsafe source URLs', () => {
  const a = buildInteractions([], [{ ...outgoing, status: 'unknown', receiptId: undefined }], []);
  expect(a[0].threads[0].entries[0].pending).toBe(false);
  expect(commentLink({ ...target, oid: 'not-an-id' })).toBeUndefined();
});

it('keeps dynamic replies linked to their original dynamic and exact child comment', () => {
  const t = { oid: '88', type: 11, root: '900', parent: '901' };
  const url = 'https://t.bilibili.com/1234567890123456789';
  const a = buildInteractions([], [{ ...outgoing, target: t, resourceUrl: url, receiptId: '902' }]);
  expect(a[0].video.title).toContain('动态');
  expect(a[0].video.url).toBe(url);
  expect(a[0].threads[0].entries[0].url).toContain('comment_root_id=900');
  expect(a[0].threads[0].entries[0].url).toContain('comment_secondary_id=902');
  expect(commentLink(t, '902', 'https://evil.test/123')).toBeUndefined();
});

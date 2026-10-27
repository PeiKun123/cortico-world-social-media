import type {
  CommentTarget,
  InboxItem,
  SendRecord,
  PublicVideo,
  PublicComment,
} from './platform.ts';
export type InteractionFilter = 'all' | 'pending' | 'sent' | 'roam';
export interface InteractionEntry {
  id: string;
  at: number;
  direction: 'incoming' | 'outgoing';
  kind: string;
  status: string;
  pending: boolean;
  text: string;
  author: string;
  target: CommentTarget;
  url?: string;
  quote?: PublicComment;
  inbox?: InboxItem;
  record?: SendRecord;
}
export interface InteractionGroup {
  platform: string;
  key: string;
  video: { aid: string; title: string; url?: string; author?: string };
  latestAt: number;
  threads: Array<{ key: string; root: string; entries: InteractionEntry[] }>;
}
export function safeBiliLink(raw: string | undefined) {
  try {
    const u = new URL(raw || '');
    return u.protocol === 'https:' &&
      (['www.bilibili.com', 'bilibili.com', 'm.bilibili.com', 't.bilibili.com'].includes(
        u.hostname,
      ) ||
        (['https://www.douyin.com', 'https://www.kuaishou.com'].includes(u.origin) &&
          !u.username &&
          !u.password))
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
}
function videoLink(t: CommentTarget) {
  if (t.type === 3 && /^[A-Za-z0-9_-]{5,80}$/.test(t.oid))
    return 'https://www.kuaishou.com/short-video/' + t.oid;
  if (t.type === 2 && /^\d+$/.test(t.oid)) return 'https://www.douyin.com/video/' + t.oid;
  return t.type === 1 && /^\d+$/.test(t.oid)
    ? 'https://www.bilibili.com/video/av' + t.oid + '/'
    : undefined;
}
function dynamicPage(raw?: string) {
  try {
    const u = new URL(raw ?? '');
    if (u.username || u.password) return;
    const ok =
      (u.origin === 'https://t.bilibili.com' && /^\/\d+\/?$/.test(u.pathname)) ||
      (u.origin === 'https://www.bilibili.com' && /^\/opus\/\d+\/?$/.test(u.pathname));
    if (!ok) return;
    u.search = '';
    u.hash = '';
    return u.href;
  } catch {
    return;
  }
}
export function commentLink(t: CommentTarget, receiptId?: string, resourceUrl?: string) {
  const base = videoLink(t) || ([11, 17].includes(t.type) ? dynamicPage(resourceUrl) : undefined);
  if (!base) return;
  if (t.type === 2 || t.type === 3) return base; // No unverified deep-link parameters for Douyin comments.
  const id = receiptId ?? t.parent;
  if (!/^\d+$/.test(id) || id === '0') return;
  const root = t.root && t.root !== '0' ? t.root : id;
  if (!/^\d+$/.test(root)) return;
  const u = new URL(base);
  u.searchParams.set('comment_root_id', root);
  u.searchParams.set('comment_secondary_id', id);
  u.hash = 'reply' + id;
  return u.href;
}
export function buildInteractions(
  inbox: InboxItem[],
  outbox: SendRecord[],
  videos: PublicVideo[] = [],
  comments: PublicComment[] = [],
): InteractionGroup[] {
  const groups = new Map<string, InteractionGroup>();
  const add = (platform: string, e: InteractionEntry, sourceUrl?: string) => {
    const key = [platform, e.target.type, e.target.oid].join(':'),
      v = [11, 17].includes(e.target.type)
        ? undefined
        : videos.find((v) => v.aid === e.target.oid) || e.record?.preparation?.video;
    let group = groups.get(key);
    if (!group) {
      group = {
        platform,
        key,
        video: {
          aid: e.target.oid,
          title:
            v?.title ||
            (e.target.type === 1
              ? '视频 av' + e.target.oid
              : [11, 17].includes(e.target.type)
                ? 'B站动态 ' + e.target.oid
                : '平台评论 ' + e.target.oid),
          url:
            safeBiliLink(v?.url) ||
            videoLink(e.target) ||
            dynamicPage(e.record?.resourceUrl ?? sourceUrl) ||
            safeBiliLink(sourceUrl),
          author: v?.author,
        },
        latestAt: e.at,
        threads: [],
      };
      groups.set(key, group);
    }
    group.latestAt = Math.max(group.latestAt, e.at);
    const root =
      e.target.root && e.target.root !== '0' ? e.target.root : e.record?.receiptId || e.id;
    let thread = group.threads.find((t) => t.root === root);
    if (!thread) {
      thread = { key: key + ':' + root, root, entries: [] };
      group.threads.push(thread);
    }
    thread.entries.push(e);
  };
  for (const i of inbox)
    add(
      i.platform,
      {
        id: 'in:' + i.id,
        at: i.occurredAt * 1000,
        direction: 'incoming',
        kind: i.ownerAutoReply
          ? '主人评论区自动回应'
          : i.notificationType === 'focus-video'
            ? '关注作品'
            : i.notificationType === 'focus-comment'
              ? '关注评论区'
              : i.notificationType === 'mention'
                ? '被@'
                : i.notificationType === 'reply'
                  ? '收到回复'
                  : '收到评论',
        status: i.handling ? '已跳过' : i.status === 'pending' ? '待回应' : '已处理',
        pending: i.status === 'pending',
        text: i.text,
        author: i.author,
        target: i.target,
        url: commentLink(i.target, undefined, i.url) || safeBiliLink(i.url),
        inbox: i,
      },
      i.url,
    );
  for (const r of outbox) {
    const visibility = { public: '访客可见', 'self-only': '仅自己可见', unconfirmed: '公开待核验' };
    const status =
      r.status === 'sent'
        ? r.visibility
          ? visibility[r.visibility.status]
          : '公开待核验'
        : { sending: '发送中', unknown: '发送待核对', rejected: '未发出' }[r.status];
    const quote =
      r.preparation?.parent ??
      comments.find(
        (c) =>
          c.target.oid === r.target.oid &&
          c.target.type === r.target.type &&
          c.target.parent === r.target.parent,
      );
    add(r.platform, {
      id: 'out:' + r.id,
      at: Date.parse(r.createdAt) || 0,
      direction: 'outgoing',
      kind: r.target.parent === '0' ? '主动评论' : r.inboxId ? '通知回复' : '主动接楼',
      status,
      pending: false,
      text: r.mention ? '@' + r.mention.name + ' ' + r.text : r.text,
      author: '我',
      target: r.target,
      url: commentLink(r.target, r.receiptId, r.resourceUrl),
      quote,
      record: r,
    });
  }
  for (const group of groups.values()) {
    for (const t of group.threads) t.entries.sort((a, b) => a.at - b.at);
    group.threads.sort((a, b) => (b.entries.at(-1)?.at ?? 0) - (a.entries.at(-1)?.at ?? 0));
  }
  return [...groups.values()].sort((a, b) => b.latestAt - a.latestAt);
}
export function filterInteractions(
  groups: InteractionGroup[],
  filter: InteractionFilter,
  query: string,
) {
  const q = query.trim().toLocaleLowerCase();
  return groups
    .map((g) => ({
      ...g,
      threads: g.threads.filter((t) => {
        const match =
          filter === 'all' ||
          t.entries.some((e) =>
            filter === 'pending'
              ? e.pending
              : filter === 'sent'
                ? e.record?.status === 'sent'
                : Boolean(e.record?.roamId),
          );
        return (
          match &&
          (!q ||
            [
              g.video.title,
              g.video.aid,
              ...t.entries.flatMap((e) => [e.text, e.author, e.quote?.text || '']),
            ]
              .join(' ')
              .toLocaleLowerCase()
              .includes(q))
        );
      }),
    }))
    .filter((g) => g.threads.length);
}

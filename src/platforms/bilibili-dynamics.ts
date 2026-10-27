import type { Page } from 'playwright-core';
import { PlatformError, type CommentTarget } from '../platform.ts';
import { numericId, parsePlatformJson } from './bilibili.ts';
export interface PublicDynamic {
  mentions?: Array<{ id: string; text: string }>;
  id: string;
  accountId?: string;
  authorId: string;
  author: string;
  publishedAt: number;
  type: string;
  text: string;
  title: string;
  url: string;
  imageCount: number;
  target?: CommentTarget;
  original?: { id: string; author: string; text: string };
}
const clean = (v: unknown, n: number) =>
  String(v ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/\u0000/g, '')
    .slice(0, n);
export function dynamicId(raw: string): string {
  if (typeof raw !== 'string') throw new PlatformError('动态编号须传原始字符串，避免精度损失。');
  let id = raw.trim();
  if (id.includes('://')) {
    const u = new URL(id);
    const m =
      u.origin === 'https://t.bilibili.com'
        ? u.pathname.match(/^\/(\d+)\/?$/)
        : u.origin === 'https://www.bilibili.com'
          ? u.pathname.match(/^\/opus\/(\d+)\/?$/)
          : undefined;
    if (!m || u.username || u.password)
      throw new PlatformError('请提供B站官网完整动态链接或原始动态编号。');
    id = m[1];
  }
  return numericId(id);
}
function mapItem(x: any): PublicDynamic {
  const id = numericId(x?.id_str),
    a = x.modules?.module_author,
    d = x.modules?.module_dynamic ?? {},
    major = d.major ?? {};
  const authorId = numericId(a?.mid),
    type = clean(x.type, 60);
  const content = d.desc?.text ?? major.opus?.summary?.text ?? major.archive?.desc ?? '';
  const rich = d.desc?.rich_text_nodes ?? major.opus?.summary?.rich_text_nodes ?? [];
  const mentions: Array<{ id: string; text: string }> = [];
  for (const node of (Array.isArray(rich) ? rich : []).slice(0, 100)) {
    if (node?.type !== 'RICH_TEXT_NODE_TYPE_AT' || mentions.length >= 8) continue;
    try {
      const id = numericId(node.rid),
        text = clean(node.orig_text ?? node.text, 90);
      if (text.startsWith('@') && !mentions.some((m) => m.id === id)) mentions.push({ id, text });
    } catch {}
  }
  const basic = x.basic ?? {};
  let target: CommentTarget | undefined;
  if ([1, 11, 17].includes(Number(basic.comment_type))) {
    try {
      target = {
        oid: numericId(basic.comment_id_str ?? basic.rid_str),
        type: Number(basic.comment_type),
        root: '0',
        parent: '0',
      };
    } catch {}
  }
  const orig = x.orig;
  let original: PublicDynamic['original'];
  if (orig?.id_str)
    try {
      original = {
        id: numericId(orig.id_str),
        author: clean(orig.modules?.module_author?.name, 80),
        text: clean(
          orig.modules?.module_dynamic?.desc?.text ??
            orig.modules?.module_dynamic?.major?.opus?.summary?.text,
          400,
        ),
      };
    } catch {}
  return {
    id,
    authorId,
    author: clean(a.name, 80),
    publishedAt: Number.isFinite(Number(a.pub_ts)) ? Number(a.pub_ts) : 0,
    type,
    text: clean(content, 1400),
    title: clean(major.opus?.title ?? major.archive?.title ?? '', 160),
    url: 'https://t.bilibili.com/' + id,
    imageCount: Math.min(
      99,
      Math.max(0, (major.opus?.pics ?? major.draw?.items ?? []).length ?? 0),
    ),
    ...(mentions.length ? { mentions } : {}),
    ...(target ? { target } : {}),
    ...(original ? { original } : {}),
  };
}
export function mapDynamicPage(raw: any, limit = 5, ownerId?: string) {
  if (raw?.code !== 0)
    throw new PlatformError(
      'B站动态读取未完成：' + clean(raw?.message ?? '响应无效', 160),
      [-352, -412, -509].includes(raw?.code) ? 'rate' : 'invalid',
    );
  const n = Math.max(1, Math.min(5, Number.isInteger(limit) ? limit : 5)),
    data = raw.data;
  if (!data || (!Array.isArray(data.items) && !data.item))
    throw new PlatformError('B站未返回可核实的动态列表，不据此断言没有动态。');
  const items: PublicDynamic[] = [];
  let budget = 0;
  for (const row of (data.item ? [data.item] : data.items).slice(0, 50)) {
    try {
      const d = mapItem(row);
      if (ownerId && d.authorId !== ownerId) continue;
      const size = JSON.stringify(d).length;
      if (items.length >= n || budget + size > 6000) break;
      if (!items.some((x) => x.id === d.id)) {
        items.push(d);
        budget += size;
      }
    } catch {}
  }
  return {
    items,
    hasMore: Boolean(data.has_more) || items.length < (data.items?.length ?? 0),
    scope: '官网当前首屏；不是完整历史或实时推送',
    transport: 'browser' as const,
  };
}
export async function readDynamicPage(
  page: Page,
  options: { ownerId?: string; id?: string; limit?: number },
  signal?: AbortSignal,
) {
  const owner = options.ownerId ? numericId(options.ownerId) : undefined,
    id = options.id ? dynamicId(options.id) : undefined;
  const endpoint = id
    ? '/x/polymer/web-dynamic/v1/detail'
    : owner
      ? '/x/polymer/web-dynamic/v1/feed/space'
      : '/x/polymer/web-dynamic/v1/feed/all';
  const url = id
    ? 'https://t.bilibili.com/' + id
    : owner
      ? 'https://space.bilibili.com/' + owner + '/dynamic'
      : 'https://t.bilibili.com/';
  signal?.throwIfAborted();
  const result = page.waitForResponse(
    (r) => {
      const u = new URL(r.url());
      return (
        u.origin === 'https://api.bilibili.com' &&
        u.pathname === endpoint &&
        (!owner || u.searchParams.get('host_mid') === owner) &&
        (!id || u.searchParams.get('id') === id)
      );
    },
    { timeout: 22000 },
  );
  void result.catch(() => {});
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  const r = await result;
  signal?.throwIfAborted();
  if (!r.ok())
    throw new PlatformError(
      '官网动态返回HTTP ' + r.status() + '，请在官网完成验证后再试；未绕过。',
      r.status() === 412 ? 'rate' : 'network',
    );
  const raw = await r.text();
  if (raw.length > 4 * 1024 * 1024) throw new PlatformError('动态响应过大，已停止本次读取。');
  const out = mapDynamicPage(parsePlatformJson(raw), options.limit, owner);
  if (id && !out.items.some((x) => x.id === id))
    throw new PlatformError('官网未返回指定动态，未用推荐内容替代。');
  return out;
}

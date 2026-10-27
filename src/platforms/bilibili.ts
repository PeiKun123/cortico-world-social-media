import { createHash } from 'node:crypto';
import {
  PlatformError,
  type Account,
  type CommentTarget,
  type NotificationPage,
  type SocialPlatform,
  type SendReceipt,
  type VisibilityReport,
  type Video,
  type FocusMention,
} from '../platform.ts';

type Json = Record<string, any>;
const API = 'https://api.bilibili.com';
const PASSPORT = 'https://passport.bilibili.com';
const MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';
export function parsePlatformJson(text: string): Json {
  return JSON.parse(
    text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token) =>
      /^-?\d{16,}$/.test(token) ? JSON.stringify(token) : token,
    ),
  );
}
export function numericId(value: unknown, allowZero = false): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new PlatformError('ID 必须传字符串，避免精度损失。');
  const s = String(value ?? '');
  if (!/^[0-9]{1,24}$/.test(s) || (!allowZero && BigInt(s) === 0n))
    throw new PlatformError('平台 ID 无效。');
  return s;
}
export function normalizeTarget(value: unknown): CommentTarget {
  const t = value as Json;
  if (!t || ![1, 11, 17].includes(t.type))
    throw new PlatformError('评论类型仅支持视频(1)、动态(11/17)。');
  const target = {
    oid: numericId(t.oid),
    type: t.type,
    root: numericId(t.root ?? '0', true),
    parent: numericId(t.parent ?? '0', true),
  };
  if ((target.root === '0') !== (target.parent === '0'))
    throw new PlatformError('回复必须同时提供 root 和 parent；新评论二者都为 0。');
  return target;
}
export function videoId(input: string): string {
  let value = input.trim();
  if (/^https?:/.test(value)) {
    const u = new URL(value);
    if (
      !['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(u.hostname) ||
      u.protocol !== 'https:'
    )
      throw new PlatformError('请提供 B站完整视频链接或 BV/av 号。');
    value = u.pathname.split('/').filter(Boolean)[1] ?? '';
  }
  if (!/^(BV[0-9A-Za-z]{10}|av\d{1,20})$/.test(value))
    throw new PlatformError('视频编号无效；短链接请先在浏览器展开。');
  return value;
}
export function cleanCookie(input: string): string {
  if (input.length > 12000 || /[\r\n]/.test(input)) throw new PlatformError('Cookie 格式无效');
  const parts = input
    .split(';')
    .map((x) => x.trim())
    .filter((x) => /^(SESSDATA|bili_jct|DedeUserID|buvid3|buvid4)=/.test(x));
  if (
    !parts.some((x) => x.startsWith('SESSDATA=')) ||
    !parts.some((x) => x.startsWith('bili_jct='))
  )
    throw new PlatformError('缺少 SESSDATA 或 bili_jct，请重新扫码登录。');
  if (parts.some((part) => /\s/.test(part)))
    throw new PlatformError('Cookie字段内部含空白，请重新扫码或提供原始编码值。');
  // Cortico secretReader stops at whitespace when loading .env after a restart.
  return parts.join(';');
}
export function safeAssetUrl(input: string): string {
  const u = new URL(input.startsWith('//') ? `https:${input}` : input);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.port ||
    !['hdslb.com', 'bilivideo.com', 'bilivideo.cn'].some((h) => u.hostname.endsWith(`.${h}`))
  )
    throw new PlatformError('素材地址不属于 B站媒体域名。');
  return u.href;
}
function cleanText(v: unknown, max = 8000) {
  return String(v ?? '')
    .replace(/<[^>]*>/g, '')
    .slice(0, max);
}
export class BilibiliPlatform implements SocialPlatform {
  readonly id = 'bilibili';
  normalizeTarget = normalizeTarget;
  private keys?: { key: string; at: number };
  constructor(
    private cookie: () => string,
    private fetcher: typeof fetch = fetch,
    private saveCookie?: (cookie: string) => void,
    private browserSend?: (
      target: CommentTarget,
      text: string,
      signal?: AbortSignal,
      expectedAccountId?: string,
      mention?: FocusMention,
    ) => Promise<SendReceipt>,
  ) {}
  private prepared?: { source: string; value: string };
  private currentCookie() {
    const source = this.cookie();
    return this.prepared?.source === source ? this.prepared.value : source;
  }
  private async prepareSession(signal?: AbortSignal) {
    const source = this.cookie();
    const value = cleanCookie(this.currentCookie());
    const parts = new Map(
      value.split(';').map((s) => {
        const [key, ...rest] = s.trim().split('=');
        return [key, rest.join('=')];
      }),
    );
    if (parts.get('buvid3') && parts.get('buvid4')) return;
    try {
      // Use device identifiers assigned by Bilibili, never fabricate or rotate them.
      const d = await this.request('/x/frontend/finger/spi', {}, signal);
      for (const [cookieKey, field] of [
        ['buvid3', 'b_3'],
        ['buvid4', 'b_4'],
      ]) {
        if (!parts.get(cookieKey)) {
          const id = String(d[field] ?? '');
          if (!/^[A-Za-z0-9_-]{8,200}$/.test(id)) throw Error('Invalid device identifier');
          parts.set(cookieKey, id);
        }
      }
      if (this.cookie() !== source || signal?.aborted) throw Error('Session changed');
      const merged = cleanCookie([...parts].map(([k, v]) => k + '=' + v).join('; '));
      this.saveCookie?.(merged);
      this.prepared = { source: this.cookie(), value: merged };
    } catch {
      throw new PlatformError(
        '发送前的网页会话初始化未完成，尚未提交评论；请稍后重试或重新扫码。',
        'rejected',
      );
    }
  }
  private headers(withCookie: boolean) {
    const h = new Headers({
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
      Accept: 'application/json',
    });
    if (withCookie && this.currentCookie()) h.set('Cookie', this.currentCookie());
    return h;
  }
  private async raw(
    url: string,
    init: RequestInit = {},
    signal?: AbortSignal,
    auth = true,
  ): Promise<{ data: Json; cookies: string[] }> {
    let response: Response;
    const timeout = AbortSignal.timeout(15000);
    try {
      response = await this.fetcher(url, {
        ...init,
        headers: {
          ...Object.fromEntries(this.headers(auth)),
          ...Object.fromEntries(new Headers(init.headers)),
        },
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok)
        throw new PlatformError(
          `B站请求返回 HTTP ${response.status}`,
          [412, 429].includes(response.status) ? 'rate' : 'network',
        );
      if (Number(response.headers.get('content-length') || 0) > 8 * 1024 * 1024)
        throw new PlatformError('响应过大');
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader) {
        try {
          for (;;) {
            const r = await reader.read();
            if (r.done) break;
            length += r.value.length;
            if (length > 8 * 1024 * 1024) throw new PlatformError('响应过大');
            chunks.push(r.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      }
      return {
        data: parsePlatformJson(Buffer.concat(chunks).toString('utf8')),
        cookies: response.headers.getSetCookie(),
      };
    } catch (e) {
      if (e instanceof PlatformError) throw e;
      throw new PlatformError(
        signal?.aborted
          ? '操作已取消；若正在发送，请先核实是否已发布。'
          : 'B站连接中断或响应无效，请稍后核实。',
        'network',
      );
    }
  }
  async request(
    path: string,
    params: Record<string, string | number> = {},
    signal?: AbortSignal,
    form?: Record<string, string | number>,
  ): Promise<Json> {
    const url = new URL(path, API);
    if (![API, PASSPORT].includes(url.origin)) throw new PlatformError('请求目标无效');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const { data } = await this.raw(
      url.href,
      form
        ? {
            method: 'POST',
            headers: { Origin: 'https://www.bilibili.com' },
            body: new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])),
          }
        : {},
      signal,
    );
    if (data.code !== 0) {
      const kind = [-101, -111].includes(data.code)
        ? 'auth'
        : [-352, -412, -509, 12051].includes(data.code)
          ? 'rate'
          : 'rejected';
      throw new PlatformError(
        `B站返回 ${data.code}：${cleanText(data.message || '请求未获准', 160)}`,
        kind,
      );
    }
    return data.data ?? {};
  }
  async account(signal?: AbortSignal): Promise<Account> {
    if (!this.cookie()) throw new PlatformError('尚未登录，请在面板中扫码登录。', 'auth');
    const d = await this.request('/x/web-interface/nav', {}, signal);
    if (!d.isLogin) throw new PlatformError('尚未登录或登录已失效，请扫码登录。', 'auth');
    return { id: numericId(d.mid), name: cleanText(d.uname, 80) };
  }
  private async signedParams(params: Record<string, string | number>, signal?: AbortSignal) {
    if (!this.keys || Date.now() - this.keys.at > 6 * 3600000) {
      const nav = await this.raw(`${API}/x/web-interface/nav`, {}, signal);
      const d = nav.data.data ?? {};
      const original = ['img_url', 'sub_url']
        .map(
          (k) =>
            String(d.wbi_img?.[k] ?? '')
              .split('/')
              .pop()
              ?.split('.')[0] ?? '',
        )
        .join('');
      if (original.length !== 64) throw new PlatformError('无法取得 B站请求签名，请稍后重试。');
      this.keys = {
        key: MIXIN.map((i) => original[i])
          .join('')
          .slice(0, 32),
        at: Date.now(),
      };
    }
    const p = { ...params, wts: Math.floor(Date.now() / 1000) };
    const query = Object.keys(p)
      .sort()
      .map(
        (k) =>
          `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k as keyof typeof p]).replace(/[!'()*]/g, ''))}`,
      )
      .join('&');
    return {
      ...p,
      w_rid: createHash('md5')
        .update(query + this.keys.key)
        .digest('hex'),
    };
  }
  private async wbi(path: string, params: Record<string, string | number>, signal?: AbortSignal) {
    return this.request(path, await this.signedParams(params, signal), signal);
  }
  async creatorVideos(uid: string, limit = 12, signal?: AbortSignal) {
    if (!/^[1-9]\d{0,19}$/.test(uid)) throw new PlatformError('关注UID无效');
    const d = await this.wbi(
      '/x/space/wbi/arc/search',
      { mid: uid, pn: 1, ps: 30, order: 'pubdate', index: 1 },
      signal,
    );
    return {
      items: (d.list?.vlist ?? []).slice(0, Math.max(1, Math.min(30, limit))).map((v: Json) => ({
        aid: numericId(v.aid),
        id: String(v.bvid ?? 'av' + v.aid),
        ownerId: String(v.mid ?? uid),
        title: cleanText(v.title, 200),
        author: cleanText(v.author, 80),
        publishedAt: Number(v.created) || 0,
        url: 'https://www.bilibili.com/video/' + String(v.bvid ?? 'av' + v.aid) + '/',
      })),
    };
  }
  async search(query: string, page = 1, signal?: AbortSignal) {
    const q = query.trim();
    if (!q || q.length > 120) throw new PlatformError('检索词应为 1–120 字');
    const d = await this.wbi(
      '/x/web-interface/wbi/search/type',
      { search_type: 'video', keyword: q, page: Math.max(1, Math.min(50, page)), page_size: 10 },
      signal,
    );
    return {
      page,
      total: d.numResults,
      items: (d.result ?? []).slice(0, 10).map((v: Json) => ({
        id: v.bvid,
        title: cleanText(v.title, 200),
        author: cleanText(v.author, 80),
        description: cleanText(v.description, 1000),
        duration: v.duration,
        url: `https://www.bilibili.com/video/${v.bvid}`,
        cover: String(v.pic ?? ''),
      })),
    };
  }
  async video(input: string, part = 1, signal?: AbortSignal): Promise<Video> {
    const id = videoId(input);
    const d = await this.request(
      '/x/web-interface/view',
      id.startsWith('BV') ? { bvid: id } : { aid: id.slice(2) },
      signal,
    );
    const pages = d.pages ?? [];
    const p = pages[part - 1];
    if (!p) throw new PlatformError(`该视频没有第 ${part} 集`);
    return {
      id: d.bvid,
      aid: numericId(d.aid),
      cid: numericId(p.cid),
      title: cleanText(d.title, 200),
      description: cleanText(d.desc),
      author: cleanText(d.owner?.name, 80),
      durationSec: Number(p.duration),
      cover: String(d.pic ?? ''),
      url: `https://www.bilibili.com/video/${d.bvid}?p=${part}`,
      parts: pages.slice(0, 100).map((v: Json) => ({
        cid: numericId(v.cid),
        title: cleanText(v.part, 160),
        durationSec: Number(v.duration),
      })),
    };
  }
  async assetJson(url: string, signal?: AbortSignal) {
    return (await this.raw(safeAssetUrl(url), {}, signal, false)).data;
  }
  async subtitles(video: Video, signal?: AbortSignal) {
    const d = await this.wbi('/x/player/wbi/v2', { aid: video.aid, cid: video.cid }, signal);
    const tracks = d.subtitle?.subtitles ?? [];
    const selected = tracks.find((s: Json) => /^zh/.test(s.lan)) ?? tracks[0];
    if (!selected) return { available: false, reason: '当前登录状态下未提供字幕。' };
    const data = await this.assetJson(selected.subtitle_url, signal);
    return {
      available: true,
      language: selected.lan,
      segments: (data.body ?? [])
        .slice(0, 1000)
        .map((s: Json) => ({ from: s.from, to: s.to, text: cleanText(s.content, 500) })),
      truncated: (data.body ?? []).length > 1000,
    };
  }
  async comments(input: CommentTarget, page = 1, signal?: AbortSignal, cursor?: string) {
    const t = normalizeTarget(input);
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 4000))
      throw new PlatformError('评论游标无效');
    if (t.root === '0' && page > 1 && !cursor)
      throw new PlatformError('顶层评论翻页请传入上一页返回的 nextCursor，避免跳过或重复评论。');
    const d =
      t.root === '0'
        ? await this.wbi(
            '/x/v2/reply/wbi/main',
            {
              oid: t.oid,
              type: t.type,
              mode: 2,
              pagination_str: JSON.stringify({ offset: cursor ?? '' }),
            },
            signal,
          )
        : await this.request(
            '/x/v2/reply/reply',
            {
              oid: t.oid,
              type: t.type,
              root: t.root,
              pn: Math.max(1, Math.min(500, page)),
              ps: 20,
            },
            signal,
          );
    const project = (r: Json) => ({
      id: numericId(r.rpid),
      authorId: String(r.mid ?? r.member?.mid ?? ''),
      author: cleanText(r.member?.uname, 80),
      text: cleanText(r.content?.message),
      createdAt: r.ctime,
      target: { oid: t.oid, type: t.type, root: String(r.root || r.rpid), parent: String(r.rpid) },
      replies: (r.replies ?? []).slice(0, 5).map((s: Json) => ({
        id: String(s.rpid),
        authorId: String(s.mid ?? s.member?.mid ?? ''),
        author: cleanText(s.member?.uname, 80),
        text: cleanText(s.content?.message),
        target: {
          oid: t.oid,
          type: t.type,
          root: String(s.root || r.rpid),
          parent: String(s.rpid),
        },
      })),
    });
    return {
      page,
      total: d.cursor?.all_count ?? d.page?.count,
      ...(t.root === '0'
        ? {
            nextCursor: d.cursor?.pagination_reply?.next_offset,
            hasMore: d.cursor?.is_end === false,
          }
        : {}),
      root: d.root ? project(d.root) : undefined,
      items: (d.replies ?? []).map(project),
    };
  }
  async notifications(
    lane: 'reply' | 'at',
    accountId: string,
    cursor?: { id: string; time: number },
    signal?: AbortSignal,
  ): Promise<NotificationPage> {
    const d = await this.request(
      `/x/msgfeed/${lane}`,
      cursor ? { id: cursor.id, [lane === 'at' ? 'at_time' : 'reply_time']: cursor.time } : {},
      signal,
    );
    const items = [];
    for (const r of d.items ?? []) {
      const i = r.item ?? {};
      if (![1, 11, 17].includes(i.business_id) || !i.source_id || !i.subject_id) continue;
      const parent = numericId(i.source_id);
      const root = i.root_id && String(i.root_id) !== '0' ? numericId(i.root_id) : parent;
      items.push({
        id: `bilibili:${accountId}:${parent}`,
        platform: 'bilibili',
        accountId,
        authorId: String(r.user?.mid ?? ''),
        author: cleanText(r.user?.nickname, 80),
        text: cleanText(i.source_content),
        target: { oid: numericId(i.subject_id), type: i.business_id, root, parent },
        occurredAt: Number(r[lane === 'at' ? 'at_time' : 'reply_time'] ?? 0),
        status: 'pending' as const,
        notificationType: lane === 'at' ? ('mention' as const) : ('reply' as const),
        url:
          typeof i.uri === 'string' && /^https:\/\/(www\.)?bilibili\.com\//.test(i.uri)
            ? i.uri
            : undefined,
      });
    }
    const c = d.cursor;
    return {
      items,
      cursor: c?.id && c?.time ? { id: String(c.id), time: Number(c.time) } : undefined,
      done: Boolean(c?.is_end) || !(d.items ?? []).length,
    };
  }
  async send(
    input: CommentTarget,
    text: string,
    signal?: AbortSignal,
    expectedAccountId?: string,
    mention?: FocusMention,
  ): Promise<SendReceipt> {
    const t = normalizeTarget(input);
    if (
      mention &&
      (!mention.name.trim() || mention.name.length > 80 || /[\r\n@]/.test(mention.name))
    )
      throw new PlatformError('@账号名称无效，未提交。');
    const mid = mention ? numericId(mention.id) : undefined;
    const message = (mention ? '@' + mention.name + ' ' : '') + text.trim();
    if (!message || message.length > 1000) throw new PlatformError('评论应为 1–1000 字');
    if (this.browserSend)
      return this.browserSend(t, text.trim(), signal, expectedAccountId, mention);
    await this.prepareSession(signal);
    const csrf = this.currentCookie()
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('bili_jct='))
      ?.slice(9);
    if (!csrf) throw new PlatformError('尚未登录或缺少发布凭证。', 'auth');
    signal?.throwIfAborted();
    const current = this.cookie();
    const params = await this.signedParams({}, signal);
    if (
      this.cookie() !== current ||
      (expectedAccountId &&
        !this.currentCookie()
          .split(';')
          .some((v) => v.trim() === 'DedeUserID=' + expectedAccountId))
    )
      throw new PlatformError('发送前账号已变化或与预期不符，尚未提交。', 'auth');
    const d = await this.request('/x/v2/reply/add', params, signal, {
      ...t,
      message,
      csrf,
      plat: 1,
      at_name_to_mid: mention ? '{' + JSON.stringify(mention.name) + ':' + mid + '}' : '{}',
      gaia_source: 'main_web',
      statistics: JSON.stringify({ appId: 100, platform: 5 }),
    });
    const receiptId = d.rpid_str ?? d.rpid ?? d.reply?.rpid_str ?? d.reply?.rpid;
    if (!receiptId) throw new PlatformError('平台未返回评论编号，请核实是否已发布。', 'network');
    return {
      receiptId: numericId(receiptId),
      transport: 'api',
      ...(typeof d.reply?.state === 'number' ? { platformState: d.reply.state } : {}),
    };
  }
  async checkVisibility(
    input: CommentTarget,
    receiptId: string,
    signal?: AbortSignal,
  ): Promise<VisibilityReport> {
    const t = normalizeTarget(input);
    const id = numericId(receiptId);
    const budget = AbortSignal.timeout(8000);
    const checkSignal = signal ? AbortSignal.any([signal, budget]) : budget;
    const report = (
      status: VisibilityReport['status'],
      detail: string,
      platformState?: number,
    ): VisibilityReport => ({
      status,
      detail,
      checkedAt: new Date().toISOString(),
      ...(platformState === undefined ? {} : { platformState }),
    });
    const find = (d: Json): Json | undefined => {
      const roots = [d.root, ...(d.replies ?? []), ...(d.top_replies ?? []), d.top?.upper].filter(
        Boolean,
      );
      return roots
        .flatMap((r) => [r, ...(r.replies ?? [])])
        .find((r) => String(r.rpid_str ?? r.rpid) === id);
    };
    // A detail endpoint alone can expose comments still under review. Require guest list membership.
    const guest = new BilibiliPlatform(() => '', this.fetcher);
    try {
      const d =
        t.root === '0'
          ? await guest.wbi(
              '/x/v2/reply/wbi/main',
              {
                oid: t.oid,
                type: t.type,
                mode: 2,
                seek_rpid: id,
                pagination_str: JSON.stringify({ offset: '' }),
              },
              checkSignal,
            )
          : await guest.request(
              '/x/v2/reply/reply',
              { oid: t.oid, type: t.type, root: t.root, pn: 1, ps: 20 },
              checkSignal,
            );
      const r = find(d);
      if (r && r.state !== 17)
        return report(
          'public',
          '已在未登录访客的评论列表中读到本条评论；可见性可能随后变化。',
          r.state,
        );
    } catch {
      // A failed or incomplete guest read is not evidence of a moderation decision.
    }
    try {
      const d = await this.request(
        '/x/v2/reply/reply',
        { oid: t.oid, type: t.type, root: t.root === '0' ? id : t.root, pn: 1, ps: 20 },
        checkSignal,
      );
      const r = find(d);
      if (r?.state === 17)
        return report(
          'self-only',
          'B站明确返回仅自己可见（state 17），未确认公开。World 无法改写平台审核结果，请勿自动重复发布。',
          17,
        );
    } catch {
      // Preserve the original send receipt even when verification cannot complete.
    }
    return report(
      'unconfirmed',
      '尚未在访客评论列表中核实：可能等待审核、分页未覆盖或读取受限；不能据此断言仅自己可见。可稍后复查，不要重复发布。',
    );
  }
  async qrGenerate(signal?: AbortSignal) {
    const d = await this.request(`${PASSPORT}/x/passport-login/web/qrcode/generate`, {}, signal);
    const u = new URL(d.url);
    if (u.protocol !== 'https:' || !u.hostname.endsWith('.bilibili.com'))
      throw new PlatformError('登录二维码地址异常');
    return { url: u.href, key: String(d.qrcode_key) };
  }
  async qrPoll(key: string, signal?: AbortSignal) {
    const u = new URL(`${PASSPORT}/x/passport-login/web/qrcode/poll`);
    u.searchParams.set('qrcode_key', key);
    const { data, cookies } = await this.raw(u.href, {}, signal, false);
    if (data.code !== 0) throw new PlatformError('登录服务暂不可用');
    const d = data.data ?? {};
    const code = Number(d.code);
    if (code !== 0)
      return {
        status:
          code === 86038
            ? 'expired'
            : code === 86090
              ? 'scanned'
              : code === 86101
                ? 'waiting'
                : 'error',
      };
    const parts = cookies.map((s) => s.split(';')[0]);
    if (d.url) {
      const url = new URL(d.url);
      for (const k of ['SESSDATA', 'bili_jct', 'DedeUserID'])
        if (url.searchParams.has(k) && !parts.some((x) => x.startsWith(k + '=')))
          parts.push(`${k}=${url.searchParams.get(k)}`);
    }
    return { status: 'success', cookie: cleanCookie(parts.join('; ')) };
  }
  async stream(video: Video, signal?: AbortSignal): Promise<string> {
    const d = await this.request(
      '/x/player/playurl',
      { bvid: video.id, cid: video.cid, qn: 16, fnval: 1, fourk: 0 },
      signal,
    );
    const stream = d.durl?.[0];
    if (stream)
      for (const candidate of [stream.url, ...(stream.backup_url ?? [])]) {
        try {
          const url = new URL(candidate);
          if (url.protocol === 'http:') url.protocol = 'https:';
          return safeAssetUrl(url.href);
        } catch {
          /* Try only recognized HTTPS CDN candidates from the playback response. */
        }
      }
    throw new PlatformError('当前账号未取得受支持的 HTTPS 视频流；可使用浏览器观看。');
  }
}

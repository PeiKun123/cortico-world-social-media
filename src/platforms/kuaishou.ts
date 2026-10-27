import { browserCacheArgs, clearNetworkCache } from '../resources.ts';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import {
  PlatformError,
  type Account,
  type CommentTarget,
  type PublicComment,
  type SocialPlatform,
  type Video,
  type SendReceipt,
} from '../platform.ts';
import { findBrowserExecutable } from './bilibili-browser.ts';
import { parsePlatformJson } from './bilibili.ts';
const ORIGIN = 'https://www.kuaishou.com';
const token = (v: unknown, zero = false): string => {
  if (typeof v !== 'string' || !((zero && v === '0') || /^[A-Za-z0-9_-]{5,80}$/.test(v)))
    throw new PlatformError('快手编号无效，请使用读取返回的原始编号。');
  return v;
};
function commentReceiptId(value: unknown): string {
  const id =
    typeof value === 'string'
      ? value
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? String(value)
        : '';
  if (!/^[1-9]\d{4,24}$/.test(id))
    throw new PlatformError('快手已尝试提交，但没有返回可核实的评论编号，不重投。', 'network');
  return id;
}
export function kuaishouVideoId(raw: string) {
  if (/^[A-Za-z0-9_-]{5,80}$/.test(raw)) return raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new PlatformError('请提供快手完整作品链接。');
  }
  if (u.origin !== ORIGIN || u.username || u.password)
    throw new PlatformError('仅接受HTTPS快手官网完整作品链接，短链请先展开。');
  const id = u.pathname.match(/^\/short-video\/([A-Za-z0-9_-]{5,80})\/?$/)?.[1];
  if (!id) throw new PlatformError('链接未包含快手作品编号。');
  return id;
}
export function kuaishouTarget(raw: unknown): CommentTarget {
  const v = raw as Partial<CommentTarget> | null;
  if (v?.type !== 3) throw new PlatformError('快手目标须使用type=3，不能混用其他平台。');
  const t = {
    oid: token(v.oid),
    type: 3,
    root: token(v.root ?? '0', true),
    parent: token(v.parent ?? '0', true),
  };
  if ((t.root === '0') !== (t.parent === '0'))
    throw new PlatformError('回复须同时保留主楼和实际评论编号。');
  return t;
}
export function mapKuaishouComment(
  v: Record<string, any>,
  oid: string,
  root?: string,
): PublicComment {
  const id = token(String(v.commentId ?? v.comment_id));
  const at = Number(v.timestamp);
  return {
    id,
    authorId: token(String(v.authorId ?? v.author_id)),
    author: String(v.authorName ?? v.author_name ?? '').slice(0, 80),
    text: String(v.content ?? '').slice(0, 2000),
    createdAt: Number.isFinite(at) && at > 0 ? (at > 1e12 ? at / 1000 : at) : undefined,
    target: { oid: token(oid), type: 3, root: root ?? id, parent: id },
  };
}
export function matchesKuaishouPublish(
  v: Record<string, unknown>,
  target: CommentTarget,
  text: string,
  author: string,
  recipient?: string,
) {
  const t = kuaishouTarget(target);
  return (
    v.photoId === t.oid &&
    v.photoAuthorId === author &&
    v.content === text &&
    String(v.replyToCommentId ?? '0') === t.parent &&
    (t.parent === '0' ? ['', '0'].includes(String(v.replyTo ?? '')) : v.replyTo === recipient)
  );
}
const DETAIL =
  'query visionVideoDetail($photoId:String){visionVideoDetail(photoId:$photoId){status type author{id name}photo{id caption duration timestamp expTag}}}';
const COMMENTS =
  'query commentListQuery($photoId:String,$pcursor:String){visionCommentList(photoId:$photoId,pcursor:$pcursor){pcursorV2 rootCommentsV2{commentId authorId authorName content timestamp hasSubComments} rootComments{commentId authorId authorName content timestamp subComments{commentId authorId authorName content timestamp replyTo}}}}';
// Official webpage calls this read using a GraphQL mutation operation.
const SUB_COMMENTS =
  'mutation visionSubCommentList($photoId:String,$rootCommentId:String,$pcursor:String){visionSubCommentList(photoId:$photoId,rootCommentId:$rootCommentId,pcursor:$pcursor){pcursor pcursorV2 subComments{commentId authorId authorName content timestamp status}subCommentsV2{commentId authorId authorName content timestamp status}}}';
const SELF = 'query userInfo{userInfo{id name eid}}';
// This is the mutation used by the official webpage. Auth and normal request handling stay in its browser context.
const ADD =
  'mutation visionAddComment($photoId:String,$photoAuthorId:String,$content:String,$replyToCommentId:ID,$replyTo:ID,$expTag:String){visionAddComment(photoId:$photoId,photoAuthorId:$photoAuthorId,content:$content,replyToCommentId:$replyToCommentId,replyTo:$replyTo,expTag:$expTag){result commentId content timestamp status}}';
type Json = Record<string, any>;
export class KuaishouPlatform implements SocialPlatform {
  readonly id = 'kuaishou';
  readonly normalizeTarget = kuaishouTarget;
  readonly validRecipientId = (v: string) => /^[A-Za-z0-9_-]{5,80}$/.test(v);
  private context?: BrowserContext;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private loginOpen = false;
  private lastCacheClear = 0;
  private clearCachePending = false;
  private detail = '快手实验接入；请在配置中登录独立Edge。';
  private write?: { variables: Json; used: boolean; browser?: boolean };
  private feedCandidates: Video[] = [];
  private creatorPages = new Map<string, { at: number; items: Video[] }>();
  constructor(
    private profileDir: string,
    private executable: () => string,
    private background: () => boolean,
    private enabled: () => boolean,
    private posting: () => boolean,
    private cacheMB: () => number = () => 128,
  ) {}
  status() {
    return {
      available: Boolean(findBrowserExecutable(this.executable() || undefined)),
      running: Boolean(this.context),
      runtimeState: !this.enabled()
        ? 'disabled'
        : this.loginOpen
          ? 'login'
          : this.context
            ? 'active'
            : 'idle',
      runtimeNote:
        '后台开启时日常操作使用无窗口浏览器，空闲后自动关闭；登录窗口仅由配置页主动打开。running=false不是启动失败。',
      loginOpen: this.loginOpen,
      detail: this.detail,
      capabilities: {
        read: true,
        search: true,
        feed: true,
        focus: true,
        frames: false,
        publish: 'experimental',
        notifications: false,
        visibility: false,
        subtitles: false,
      },
    };
  }
  reset() {
    this.stopped = false;
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.queue.then(fn, fn);
    this.queue = r.catch(() => {});
    return r;
  }
  private async launch(visible = false) {
    if (this.stopped || !this.enabled()) throw new PlatformError('快手已关闭。', 'rejected');
    if (this.context) return this.context;
    const executablePath =
      findBrowserExecutable(
        this.executable() || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      ) || findBrowserExecutable();
    if (!executablePath) throw new PlatformError('未找到Edge或Chrome，请填写浏览器程序路径。');
    const c = await chromium.launchPersistentContext(this.profileDir, {
      executablePath,
      headless: !visible && this.background(),
      chromiumSandbox: true,
      viewport: { width: 1280, height: 900 },
      timeout: 20000,
      args: [...browserCacheArgs(this.cacheMB()), '--mute-audio', '--disable-notifications'],
    });
    c.on('response', async (response) => {
      const u = new URL(response.url());
      if (u.origin !== ORIGIN || !['/rest/v/profile/feed', '/rest/v/feed/hot'].includes(u.pathname))
        return;
      try {
        const raw = await response.text();
        if (raw.length > 3_000_000) return;
        const j = parsePlatformJson(raw) as Json;
        if (j.result !== 1) return;
        const items = (j.feeds ?? []).flatMap((r: Json) => {
          const v = this.project(r);
          return v ? [v] : [];
        }) as Video[];
        if (u.pathname === '/rest/v/feed/hot')
          this.feedCandidates = [
            ...new Map([...this.feedCandidates, ...items].map((v) => [v.id, v])).values(),
          ].slice(-100);
        else {
          const b = JSON.parse(response.request().postData() || '{}'),
            id = String(b.user_id ?? '');
          if (id) {
            const prior = this.creatorPages.get(id);
            this.creatorPages.set(id, {
              at: Date.now(),
              items: [
                ...new Map(
                  [
                    ...items.filter((v) => v.ownerId === id),
                    ...(b.pcursor ? (prior?.items ?? []) : []),
                  ].map((v) => [v.id, v]),
                ).values(),
              ].slice(0, 30),
            });
          }
        }
      } catch {
        /* Only complete public records are retained. */
      }
    });
    this.context = c;
    if (this.clearCachePending || Date.now() - this.lastCacheClear > 86400000) {
      try {
        await clearNetworkCache(c);
        this.lastCacheClear = Date.now();
        this.clearCachePending = false;
      } catch {}
    }
    c.once('close', () => {
      if (this.context === c) {
        this.context = undefined;
        this.loginOpen = false;
      }
    });
    await c.route('https://www.kuaishou.com/**', (route) => {
      const r = route.request(),
        u = new URL(r.url());
      let b: Json;
      try {
        b = JSON.parse(r.postData() || '{}');
      } catch {
        b = {};
      }
      const v = b.variables;
      if (
        r.method() === 'POST' &&
        u.pathname === '/graphql' &&
        b.operationName === 'visionSubCommentList' &&
        b.query === SUB_COMMENTS &&
        v &&
        Object.keys(v).every((k) => ['photoId', 'rootCommentId', 'pcursor'].includes(k)) &&
        typeof v.photoId === 'string' &&
        /^[A-Za-z0-9_-]{5,80}$/.test(v.photoId) &&
        typeof v.rootCommentId === 'string' &&
        /^[A-Za-z0-9_-]{5,80}$/.test(v.rootCommentId) &&
        typeof v.pcursor === 'string' &&
        /^[A-Za-z0-9_-]{0,80}$/.test(v.pcursor)
      )
        return route.fallback();
      const mutation =
        r.method() === 'POST' &&
        ((u.pathname === '/graphql' && /\bmutation\b/.test(String(b.query || ''))) ||
          /\/comment\/(?:add|publish|delete)/.test(u.pathname));
      if (!mutation) return route.fallback();
      const w = this.write;
      if (
        w &&
        !w.used &&
        u.pathname === '/graphql' &&
        b.operationName === 'visionAddComment' &&
        (w.browser
          ? typeof b.query === 'string' &&
            b.query.replace(/\s+/g, '').replace(/__typename/g, '') === ADD.replace(/\s+/g, '') &&
            v &&
            Object.keys(v).every((k) =>
              [
                'photoId',
                'photoAuthorId',
                'content',
                'replyToCommentId',
                'replyTo',
                'expTag',
              ].includes(k),
            ) &&
            matchesKuaishouPublish(
              v,
              { oid: w.variables.photoId, type: 3, root: '0', parent: '0' },
              w.variables.content,
              w.variables.photoAuthorId,
            ) &&
            (v.expTag == null || (typeof v.expTag === 'string' && v.expTag.length <= 16384))
          : b.query === ADD && JSON.stringify(b.variables) === JSON.stringify(w.variables)) &&
        this.enabled() &&
        this.posting()
      ) {
        w.used = true;
        return route.fallback();
      }
      return route.abort();
    });

    return c;
  }
  private async visit<T>(
    path: string,
    fn: (p: Page) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.serial(async () => {
      if (this.loginOpen)
        throw new PlatformError('快手登录窗口待确认，请点击“完成快手登录”。', 'auth');
      if (this.idleTimer) clearTimeout(this.idleTimer);
      const budget = AbortSignal.timeout(45000),
        s = signal ? AbortSignal.any([signal, budget]) : budget;
      s.throwIfAborted();
      const c = await this.launch(),
        p = c.pages()[0] || (await c.newPage());
      p.setDefaultTimeout(6500);
      const abort = () => {
        void c.close().catch(() => {});
      };
      s.addEventListener('abort', abort, { once: true });
      try {
        if (p.url() !== ORIGIN + path)
          await p.goto(ORIGIN + path, { waitUntil: 'domcontentloaded', timeout: 22000 });
        if (new URL(p.url()).origin !== ORIGIN)
          throw new PlatformError('快手跳转到未支持地址，本次停止。');
        const result = await fn(p);
        s.throwIfAborted();
        return result;
      } catch (e) {
        this.detail =
          e instanceof PlatformError ? e.message : '快手网页读取未完成，请检查登录或验证提示。';
        if (e instanceof PlatformError) throw e;
        throw new PlatformError(this.detail, 'network');
      } finally {
        s.removeEventListener('abort', abort);
        if (s.aborted || this.stopped) await c.close().catch(() => {});
        else {
          this.idleTimer = setTimeout(() => {
            if (this.context === c && !this.loginOpen) void c.close().catch(() => {});
          }, 30000);
          this.idleTimer.unref();
        }
      }
    });
  }
  private async request(p: Page, path: string, body?: Json) {
    const raw = await p.evaluate(
      async ({ path, body }) => {
        const r = await fetch(path, {
          method: body ? 'POST' : 'GET',
          credentials: 'same-origin',
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(12000),
        });
        if (!r.ok) throw Error('HTTP ' + r.status);
        const text = await r.text();
        if (text.length > 3_000_000) throw Error('Response too large');
        return text;
      },
      { path, body },
    );
    return parsePlatformJson(raw) as Json;
  }
  private async graphql(p: Page, operationName: string, query: string, variables: Json = {}) {
    const j = await this.request(p, '/graphql', { operationName, query, variables });
    if (j.errors?.length || !j.data)
      throw new PlatformError('快手未提供本次请求的数据；请检查官网登录或验证提示。', 'network');
    return j.data as Json;
  }
  private project(row: Json): Video | undefined {
    const v = row.photo,
      a = row.author;
    if (!v?.id || !a?.id || typeof v.caption !== 'string') return;
    try {
      const id = token(String(v.id));
      return {
        id,
        aid: id,
        cid: id,
        title: v.caption.slice(0, 200),
        description: v.caption.slice(0, 4000),
        author: String(a.name || '').slice(0, 80),
        ownerId: token(String(a.id)),
        publishedAt:
          Number(v.timestamp) > 1e12
            ? Number(v.timestamp) / 1000
            : Number(v.timestamp) || undefined,
        durationSec: Math.max(0, Number(v.duration) || 0) / 1000,
        cover: '',
        url: ORIGIN + '/short-video/' + id,
        parts: [],
      };
    } catch {
      return;
    }
  }
  private async own(p: Page): Promise<Account> {
    const d = await this.graphql(p, 'userInfo', SELF),
      u = d.userInfo;
    if (!u?.id || !u.name)
      throw new PlatformError('尚未确认快手登录，请在独立Edge中扫码。', 'auth');
    return { id: token(String(u.eid || u.id)), name: String(u.name).slice(0, 80) };
  }
  async account(signal?: AbortSignal) {
    return this.visit(
      '/new-reco',
      async (p) => {
        const a = await this.own(p);
        this.detail = '已核对快手账号：' + a.name;
        return a;
      },
      signal,
    );
  }
  private async videoData(p: Page, id: string) {
    const d = (await this.graphql(p, 'visionVideoDetail', DETAIL, { photoId: id }))
      .visionVideoDetail;
    if (d?.status === 208005)
      throw new PlatformError(
        '快手电脑端暂不支持这条图文的作品详情；评论可单独读取，但无法核实作者和正文，暂不自动发评。',
        'rejected',
      );
    if (d?.status !== 1 || String(d.photo?.id) !== id)
      throw new PlatformError('未取得指定快手作品，未把推荐内容当作目标。');
    const v = this.project(d);
    if (!v) throw new PlatformError('作品元数据暂不完整。', 'network');
    return { video: v, photo: d.photo };
  }
  async video(input: string, part = 1, signal?: AbortSignal) {
    const id = kuaishouVideoId(input);
    if (part !== 1) throw new PlatformError('快手请提供具体作品，不支持分集参数。');
    return this.visit(
      '/short-video/' + id,
      async (p) => (await this.videoData(p, id)).video,
      signal,
    );
  }
  private async commentData(p: Page, t: CommentTarget, cursor = '') {
    const d = (
      await this.graphql(p, 'commentListQuery', COMMENTS, { photoId: t.oid, pcursor: cursor })
    ).visionCommentList;
    if (!d) throw new PlatformError('未取得快手评论。', 'network');
    const raw =
      Array.isArray(d.rootCommentsV2) && d.rootCommentsV2.length
        ? d.rootCommentsV2
        : (d.rootComments ?? []);
    const items: Array<PublicComment & { replies?: PublicComment[] }> = [];
    for (const v of raw.slice(0, 60)) {
      try {
        const root = mapKuaishouComment(v, t.oid);
        items.push({
          ...root,
          replies: (v.subComments ?? []).slice(0, 30).flatMap((x: Json) => {
            try {
              return [mapKuaishouComment(x, t.oid, root.id)];
            } catch {
              return [];
            }
          }),
        });
      } catch {}
    }
    return {
      items,
      nextCursor: d.pcursorV2 && d.pcursorV2 !== 'no_more' ? String(d.pcursorV2) : undefined,
    };
  }
  private async rootFor(p: Page, t: CommentTarget) {
    let cursor: string | undefined;
    for (let n = 0; n < 3; n++) {
      const page = await this.commentData(p, t, cursor),
        root = page.items.find((c) => c.id === t.root);
      if (root) return root;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    throw new PlatformError('当前读取范围未覆盖指定主楼，未改读其他位置。', 'rejected');
  }
  private async subcommentData(p: Page, t: CommentTarget, cursor = '') {
    const d = (
      await this.graphql(p, 'visionSubCommentList', SUB_COMMENTS, {
        photoId: t.oid,
        rootCommentId: t.root,
        pcursor: cursor,
      })
    ).visionSubCommentList;
    if (!d) throw new PlatformError('尚未读到快手子回复数据。', 'network');
    const rows =
      Array.isArray(d.subCommentsV2) && d.subCommentsV2.length
        ? d.subCommentsV2
        : (d.subComments ?? []);
    const items: PublicComment[] = rows.slice(0, 60).flatMap((row: Json) => {
      try {
        return [mapKuaishouComment(row, t.oid, t.root)];
      } catch {
        return [];
      }
    });
    const next = d.pcursorV2 ?? d.pcursor;
    return { items, nextCursor: next && next !== 'no_more' ? String(next) : undefined };
  }
  private async parentFor(p: Page, t: CommentTarget) {
    const root = await this.rootFor(p, t);
    if (t.parent === root.id) return root;
    let cursor: string | undefined;
    for (let n = 0; n < 3; n++) {
      const page = await this.subcommentData(p, t, cursor),
        parent = page.items.find((c) => c.id === t.parent);
      if (parent) return parent;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    throw new PlatformError('本次尚未读到目标子回复，未改发其他楼层。', 'rejected');
  }
  async comments(raw: CommentTarget, page = 1, signal?: AbortSignal, cursor?: string) {
    const t = kuaishouTarget(raw);
    if (page < 1 || page > 3 || (cursor !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(cursor)))
      throw new PlatformError('快手单次最多查看前三页评论，游标须来自前次读取。');
    return this.visit(
      '/short-video/' + t.oid,
      async (p) => {
        if (t.root !== '0') {
          const root = await this.rootFor(p, t);
          let result = await this.subcommentData(p, t, cursor);
          if (page > 1 && !cursor)
            for (let n = 1; n < page && result.nextCursor; n++)
              result = await this.subcommentData(p, t, result.nextCursor);
          return {
            ...result,
            root,
            page,
            limited: true,
            reason: '已读取指定主楼的独立子回复接口；空结果不能证明发送失败或访客不可见。',
          };
        }
        let result = await this.commentData(p, t, cursor);
        if (page > 1 && !cursor)
          for (let n = 1; n < page && result.nextCursor; n++)
            result = await this.commentData(p, t, result.nextCursor);
        return { ...result, page, limited: true };
      },
      signal,
    );
  }
  async creatorVideos(uid: string, limit: number, signal?: AbortSignal) {
    const owner = token(uid),
      started = Date.now();
    return this.visit(
      '/profile/' + owner,
      async (p) => {
        const cached = this.creatorPages.get(owner);
        if (cached && cached.at < started) {
          this.creatorPages.delete(owner);
          await p.reload({ waitUntil: 'domcontentloaded', timeout: 18000 });
        }
        const until = Date.now() + 6500;
        while (
          (!this.creatorPages.get(owner) || this.creatorPages.get(owner)!.at < started) &&
          Date.now() < until
        )
          await p.waitForTimeout(150);
        const result = this.creatorPages.get(owner);
        if (!result?.items.length || result.at < started)
          throw new PlatformError(
            '快手官网作品页没有返回可核实的作品；这不代表账号没有作品，图文可能未被当前网页列出。',
            'network',
          );
        return { items: result.items.slice(0, Math.min(30, Math.max(1, limit))) };
      },
      signal,
    );
  }
  async resolveCreator(input: string, signal?: AbortSignal): Promise<Account> {
    let id = input.normalize('NFKC').trim();
    if (id.includes('://')) {
      const u = new URL(id);
      if (u.origin !== ORIGIN || u.username || u.password)
        throw new PlatformError('请填写快手官网完整用户主页。');
      id = u.pathname.match(/^\/profile\/([A-Za-z0-9_-]{5,80})\/?$/)?.[1] || '';
      return { id: token(id), name: '快手主人' };
    }
    if (/^3x[a-z0-9]{10,30}$/i.test(id)) return { id: token(id), name: '快手主人' };
    if (!id || id.length > 80 || /[\s/\\]/.test(id))
      throw new PlatformError('请填写准确快手号或完整主页。');
    const handle = id;
    return this.visit(
      '/new-reco',
      async (p) => {
        const users = new Map<string, string>();
        const listener = async (r: import('playwright-core').Response) => {
          if (
            new URL(r.url()).origin !== ORIGIN ||
            new URL(r.url()).pathname !== '/rest/v/search/user'
          )
            return;
          try {
            let request: Json = {};
            try {
              request = JSON.parse(r.request().postData() || '{}');
            } catch {}
            if (request.keyword !== handle) return;
            const data = parsePlatformJson(await r.text()) as Json;
            for (const u of data.users ?? [])
              if (typeof u.user_id === 'string' && typeof u.user_name === 'string')
                users.set(u.user_id, u.user_name);
          } catch {}
        };
        p.on('response', listener);
        try {
          await p.goto(ORIGIN + '/search/' + encodeURIComponent(handle) + '?source=NewReco', {
            waitUntil: 'domcontentloaded',
            timeout: 18000,
          });
          const until = Date.now() + 6500;
          while (!users.size && Date.now() < until) await p.waitForTimeout(150);
          p.off('response', listener);
          for (const [id, name] of [...users].slice(0, 3)) {
            await p.goto(ORIGIN + '/profile/' + token(id), {
              waitUntil: 'domcontentloaded',
              timeout: 12000,
            });
            const field = p
              .locator('.uid')
              .filter({ hasText: /快手号[：:]/ })
              .first();
            try {
              await field.waitFor({ state: 'visible', timeout: 5000 });
            } catch {
              continue;
            }
            const label = await field.innerText();
            if (
              label
                ?.trim()
                .replace(/^快手号[：:]\s*/, '')
                .trim() === handle
            )
              return { id, name };
          }
          throw new PlatformError(
            '没有在公开主页上精确核对到这个快手号；可改填完整主页，不按昵称猜测。',
          );
        } finally {
          p.off('response', listener);
        }
      },
      signal,
    );
  }
  async search(query: string, page = 1, signal?: AbortSignal) {
    if (!query.trim() || query.length > 120 || page !== 1)
      throw new PlatformError('快手检索词应为1—120字，目前只读取首屏。');
    return this.visit(
      '/new-reco',
      async (p) => {
        const found = new Map<string, Video>();
        const listener = async (r: import('playwright-core').Response) => {
          if (new URL(r.url()).origin !== ORIGIN || !new URL(r.url()).pathname.includes('/search/'))
            return;
          try {
            const j = parsePlatformJson(await r.text()) as Json;
            for (const row of j.feeds ?? []) {
              const v = this.project(row);
              if (v) found.set(v.id, v);
            }
          } catch {}
        };
        p.on('response', listener);
        try {
          await p.goto(ORIGIN + '/search/' + encodeURIComponent(query) + '?source=NewReco', {
            waitUntil: 'domcontentloaded',
            timeout: 18000,
          });
          const until = Date.now() + 8000;
          while (!found.size && Date.now() < until) await p.waitForTimeout(150);
          return {
            page: 1,
            items: [...found.values()].slice(0, 10),
            limited: true,
            reason: found.size ? '官网首屏结果' : '官网未提供可核实搜索结果。',
          };
        } finally {
          p.off('response', listener);
        }
      },
      signal,
    );
  }
  async nextVideo(seen: string[] = [], signal?: AbortSignal) {
    return this.visit(
      '/new-reco',
      async (p) => {
        const until = Date.now() + 6500;
        while (!this.feedCandidates.length && Date.now() < until) await p.waitForTimeout(150);
        const v = this.feedCandidates.find((v) => !seen.includes(v.id));
        if (!v) throw new PlatformError('官网推荐页未提供可核实的新候选，本轮停止。', 'network');
        return v;
      },
      signal,
    );
  }
  async subtitles() {
    return { available: false, reason: '快手字幕尚未接入，不根据标题编造视频内容。' };
  }
  async notifications(): Promise<never> {
    throw new PlatformError('快手全站通知尚未接入；主人评论区通过独立的特别关注轮询处理。');
  }
  private async sendTop(
    p: Page,
    t: CommentTarget,
    text: string,
    video: Video,
    photo: Json,
    expected: string,
    signal: AbortSignal | undefined,
    onAttempt: () => void,
  ): Promise<SendReceipt> {
    if (text.length > 500) throw new PlatformError('快手网页评论最多500字，未提交。', 'rejected');
    const scopes = p.locator('.comment-container .comment-input').filter({ visible: true });
    await scopes.first().waitFor({ state: 'visible', timeout: 8000 });
    if ((await scopes.count()) !== 1)
      throw new PlatformError('尚未找到唯一的快手顶楼评论框，未提交。', 'rejected');
    const editor = scopes.locator('textarea'),
      button = scopes.locator('button.submit-button');
    if ((await editor.count()) !== 1 || (await button.count()) !== 1)
      throw new PlatformError('快手网页评论控件未就绪，未提交。', 'rejected');
    // Hydration can replace the first editor; prepare again only before any submission.
    for (let n = 0; n < 2; n++) {
      await editor.fill(text);
      await p.waitForTimeout(250);
      if ((await editor.inputValue()) === text && (await button.isEnabled())) break;
    }
    if ((await editor.inputValue()) !== text || !(await button.isEnabled()))
      throw new PlatformError('快手网页尚未启用发送按钮，未提交。', 'rejected');
    if (kuaishouVideoId(p.url()) !== t.oid || (await this.own(p)).id !== expected)
      throw new PlatformError('快手页面或账号发生变化，未提交。', 'auth');
    const w = (this.write = {
      variables: {
        photoId: t.oid,
        photoAuthorId: video.ownerId,
        content: text,
        ...(typeof photo.expTag === 'string' ? { expTag: photo.expTag } : {}),
      },
      used: false,
      browser: true,
    });
    const response = p
      .waitForResponse(
        (r) => {
          if (
            !w.used ||
            new URL(r.url()).origin !== ORIGIN ||
            new URL(r.url()).pathname !== '/graphql'
          )
            return false;
          try {
            const b = r.request().postDataJSON();
            return (
              b?.operationName === 'visionAddComment' &&
              matchesKuaishouPublish(b.variables ?? {}, t, text, video.ownerId!)
            );
          } catch {
            return false;
          }
        },
        { timeout: 8000 },
      )
      .catch(() => undefined);
    try {
      signal?.throwIfAborted();
      await button.click({ timeout: 4000 });
      const r = await response;
      if (!w.used)
        throw new PlatformError('官网提交与本次目标不一致或尚未提交，已拦截。', 'rejected');
      if (!r?.ok())
        throw new PlatformError('快手网页已尝试提交，但回执未确认；不重投。', 'network');
      const j = parsePlatformJson(await r.text()) as Json,
        d = j.data?.visionAddComment;
      if (j.errors?.length || !d)
        throw new PlatformError('快手网页提交后未返回完整回执，不重投。', 'network');
      if (d.result !== 1)
        throw new PlatformError('快手网页明确未受理此评论，不自动重试。', 'rejected');
      this.detail = '已通过官网评论框提交并取得编号，仍需另一账号核对公开展示。';
      return {
        receiptId: commentReceiptId(d.commentId),
        transport: 'browser',
        ...(typeof d.status === 'number' ? { platformState: d.status } : {}),
      };
    } finally {
      if (w.used) onAttempt();
      this.write = undefined;
    }
  }
  async send(
    raw: CommentTarget,
    text: string,
    signal?: AbortSignal,
    expected?: string,
  ): Promise<SendReceipt> {
    const t = kuaishouTarget(raw);
    if (!this.posting() || !expected || !text.trim() || text.length > 1000)
      throw new PlatformError('快手发布未开启、账号未核对或评论长度无效。', 'rejected');
    let attempted = false;
    try {
      return await this.visit(
        '/short-video/' + t.oid,
        async (p) => {
          const own = await this.own(p);
          if (own.id !== expected) throw new PlatformError('快手账号已变化，未提交。', 'auth');
          const { video, photo } = await this.videoData(p, t.oid);
          if (t.parent === '0')
            return this.sendTop(p, t, text, video, photo, expected, signal, () => {
              attempted = true;
            });
          let parent: PublicComment | undefined;
          if (t.parent !== '0') parent = await this.parentFor(p, t);
          const variables: Json = {
            photoId: t.oid,
            photoAuthorId: video.ownerId,
            content: text,
            replyToCommentId: t.parent,
            ...(parent ? { replyTo: parent.authorId } : {}),
            ...(typeof photo.expTag === 'string' ? { expTag: photo.expTag } : {}),
          };
          if (!matchesKuaishouPublish(variables, t, text, video.ownerId!, parent?.authorId))
            throw new PlatformError('快手目标与准备记录不一致。', 'rejected');
          this.write = { variables, used: false };
          try {
            signal?.throwIfAborted();
            attempted = true;
            const d = (await this.graphql(p, 'visionAddComment', ADD, variables)).visionAddComment;
            if (d?.result !== 1)
              throw new PlatformError(
                '快手没有接受这条评论，请查看平台提示，不自动重试。',
                'rejected',
              );
            const receiptId = commentReceiptId(d.commentId);
            this.detail = '快手返回评论编号，访客可见性仍待核实。';
            return {
              receiptId,
              transport: 'api',
              ...(typeof d.status === 'number' ? { platformState: d.status } : {}),
            };
          } finally {
            this.write = undefined;
          }
        },
        signal,
      );
    } catch (e) {
      if (
        !attempted &&
        !(e instanceof PlatformError && ['auth', 'rejected', 'invalid'].includes(e.kind))
      )
        throw new PlatformError('快手尚未提交：读取或账号核对未完成。', 'rejected');
      throw e;
    }
  }
  async checkVisibility() {
    return {
      status: 'unconfirmed' as const,
      checkedAt: new Date().toISOString(),
      detail: '快手访客可见性尚未核实；不自动重发。',
    };
  }
  async openLogin() {
    return this.serial(async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      await this.context?.close();
      const c = await this.launch(true);
      this.loginOpen = true;
      const p = c.pages()[0] || (await c.newPage());
      await p.goto(ORIGIN + '/new-reco', { waitUntil: 'domcontentloaded', timeout: 22000 });
      const login = p.getByText('登录', { exact: true }).filter({ visible: true });
      if ((await login.count()) === 1) await login.click();
      return { detail: '请在独立Edge中登录快手，再点击“完成快手登录”。' };
    });
  }
  async closeLogin() {
    return this.serial(async () => {
      this.loginOpen = false;
      await this.context?.close();
    });
  }
  async clearCache() {
    return this.serial(async () => {
      if (this.loginOpen || !this.context) {
        this.clearCachePending = true;
        return { detail: '快手网络缓存将在下次普通访问时清理；登录资料保留。' };
      }
      await clearNetworkCache(this.context);
      this.lastCacheClear = Date.now();
      this.clearCachePending = false;
      return { detail: '快手网络缓存已清理；登录资料保留。' };
    });
  }
  async stop() {
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.context?.close().catch(() => {});
    await this.queue;
  }
}

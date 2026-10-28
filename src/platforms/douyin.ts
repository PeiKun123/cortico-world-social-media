import { readDouyinGroup, sendDouyinGroup, type GroupBinding } from './douyin-chat.ts';
import { browserCacheArgs, clearNetworkCache } from '../resources.ts';
import { parseFocusAccount } from '../focus.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  chromium,
  type BrowserContext,
  type Page,
  type Response as BrowserResponse,
  type Route,
  type Locator,
} from 'playwright-core';
import {
  PlatformError,
  type Account,
  type CommentTarget,
  type NotificationPage,
  type PublicComment,
  type SendReceipt,
  type SocialPlatform,
  type Video,
  type VisibilityReport,
} from '../platform.ts';
import { findBrowserExecutable } from './bilibili-browser.ts';
import { numericId, parsePlatformJson } from './bilibili.ts';

const ORIGIN = 'https://www.douyin.com';
const PUBLISH_ROUTE = /^https:\/\/www\.douyin\.com\/aweme\/v1\/web\/comment\/publish\/?(?:\?.*)?$/;
const playerUrl = (id: string) => ORIGIN + '/jingxuan?modal_id=' + numericId(id);
// Type 2 is this World's Douyin namespace, not a platform API parameter.
export const DOUYIN_VIDEO_TYPE = 2;
type Json = Record<string, any>;
export const parseDouyinResponse = parsePlatformJson;
const validSecUid = (value: unknown): value is string =>
  typeof value === 'string' && /^MS4w[A-Za-z0-9_.-]{10,200}$/.test(value);
export function douyinVideoId(input: string): string {
  if (/^[1-9]\d{0,23}$/.test(input)) return numericId(input);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new PlatformError('请提供抖音视频编号或完整 www.douyin.com 视频链接。');
  }
  if (url.origin !== ORIGIN || url.username || url.password)
    throw new PlatformError('仅接受 HTTPS 抖音官网视频链接；短链请先展开。');
  const match = /^\/video\/([1-9]\d{0,23})\/?$/.exec(url.pathname);
  if (match) return match[1];
  if (['/jingxuan', '/'].includes(url.pathname) && url.searchParams.has('modal_id'))
    return numericId(url.searchParams.get('modal_id'));
  throw new PlatformError('链接中没有可确认的抖音视频编号。');
}
export function douyinTarget(raw: unknown): CommentTarget {
  const value = raw as Partial<CommentTarget> | null;
  if (!value || value.type !== DOUYIN_VIDEO_TYPE)
    throw new PlatformError('抖音评论目标须使用 type=2；不能混用B站楼层。');
  const target = {
    oid: numericId(value.oid),
    type: DOUYIN_VIDEO_TYPE,
    root: numericId(value.root ?? '0', true),
    parent: numericId(value.parent ?? '0', true),
  };
  if ((target.root === '0') !== (target.parent === '0'))
    throw new PlatformError('回复须同时提供原楼与目标评论编号。');
  return target;
}
export function mapDouyinVideo(v: Json): Video {
  const id = numericId(v.aweme_id);
  const duration = Number(v.video?.duration ?? v.duration) / 1000;
  return {
    id,
    kind: Array.isArray(v.images) && v.images.length ? 'images' : 'video',
    aid: id,
    cid: id,
    title: String(v.desc ?? '').slice(0, 200),
    description: String(v.desc ?? '').slice(0, 4000),
    ownerId: validSecUid(v.author?.sec_uid) ? v.author.sec_uid : undefined,
    publishedAt: Number.isFinite(Number(v.create_time)) ? Number(v.create_time) : undefined,
    author: String(v.author?.nickname ?? '').slice(0, 80),
    durationSec: Number.isFinite(duration) ? Math.max(0, duration) : 0,
    cover: '',
    url: ORIGIN + '/video/' + id,
    parts: [],
  };
}
export function mapDouyinComment(v: Json, videoId: string, root?: string): PublicComment {
  const id = numericId(v.cid);
  return {
    id,
    createdAt: Number(v.create_time) || undefined,
    authorId: validSecUid(v.user?.sec_uid) ? v.user.sec_uid : numericId(v.user?.uid),
    author: String(v.user?.nickname ?? '').slice(0, 80),
    text: String(v.text ?? '').slice(0, 2000),
    target: {
      oid: numericId(videoId),
      type: DOUYIN_VIDEO_TYPE,
      root: root
        ? numericId(root)
        : v.reply_id && String(v.reply_id) !== '0'
          ? numericId(v.reply_id)
          : id,
      parent: id,
    },
  };
}
export function matchesDouyinPublish(form: URLSearchParams, raw: CommentTarget, text: string) {
  const t = douyinTarget(raw);
  return (
    form.get('aweme_id') === t.oid &&
    form.get('text') === text &&
    (form.get('reply_id') || '0') === t.root &&
    (form.get('reply_to_reply_id') || '0') === (t.parent === t.root ? '0' : t.parent)
  );
}
function edgeExecutable(configured: string) {
  if (configured) return findBrowserExecutable(configured);
  const edge =
    process.platform === 'win32'
      ? join(
          process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)',
          'Microsoft/Edge/Application/msedge.exe',
        )
      : process.platform === 'darwin'
        ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
        : '/usr/bin/microsoft-edge';
  return existsSync(edge) ? edge : findBrowserExecutable();
}
interface Capture {
  creators: Map<string, Account & { handle: string }>;
  videos: Map<string, Video>;
  rows: PublicComment[];
  pages: Array<{ cursor: string; next: string; more: boolean; root: string }>;
  self?: Account;
  pending: Set<Promise<void>>;
}
/** Only the official page makes requests; this adapter does not forge signatures or bypass verification. */
export class DouyinPlatform implements SocialPlatform {
  readonly id = 'douyin';
  readonly normalizeTarget = douyinTarget;
  readonly validRecipientId = validSecUid; // Use the same public sec_uid in DOM and API modes for the per-person limit.
  private context?: BrowserContext;
  private pageData = new WeakMap<Page, Capture>();
  private commentGuardedPages = new WeakSet<Page>();
  private chatPage?: Page;
  private groupIdentityCache?: { context: BrowserContext; account: Account; at: number };
  private idleTimer?: ReturnType<typeof setTimeout>;
  private queue: Promise<unknown> = Promise.resolve();
  private allowedRequest?: import('playwright-core').Request;
  private loginOpen = false;
  private lastCacheClear = 0;
  private clearCachePending = false;
  private stopped = false;
  private lastFeedId?: string;
  private feedUrl?: string;
  private detail = '实验接入：视频与评论通过独立Edge读取；发评需登录验收。';
  constructor(
    private profileDir: string,
    private executable: () => string,
    private background: () => boolean,
    private enabled: () => boolean,
    private posting: () => boolean,
    private cacheMB: () => number = () => 128,
    private groupListening: () => boolean = () => false,
    private releaseAfterTask: () => boolean = () => true,
    private compatibilityWindow: () => boolean = () => false,
  ) {}
  status() {
    return {
      available: Boolean(edgeExecutable(this.executable())),
      running: Boolean(this.context),
      runtimeState: !this.enabled()
        ? 'disabled'
        : this.loginOpen
          ? 'login'
          : this.context
            ? 'active'
            : 'idle',
      runtimeNote:
        '后台任务默认结束即退出浏览器，登录资料保留；群聊按间隔重新启动读取。可关闭立即释放以保留连接。登录窗口仅由配置页主动打开。running=false不是启动失败。',
      loginOpen: this.loginOpen,
      browserMode:
        this.loginOpen || !this.background()
          ? 'visible'
          : this.compatibilityWindow()
            ? 'compatible'
            : 'windowless',
      detail: this.detail,
      capabilities: {
        read: true,
        search: true,
        frames: true,
        publish: 'experimental',
        notifications: false,
        visibility: false,
        subtitles: false,
        focus: true,
        feed: true,
      },
    };
  }
  reset() {
    this.stopped = false;
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action, action);
    this.queue = result.catch(() => {});
    return result;
  }
  private async launch(visible = false) {
    if (this.stopped || !this.enabled()) throw new PlatformError('抖音已关闭。', 'rejected');
    if (this.context) return this.context;
    const executablePath = edgeExecutable(this.executable());
    if (!executablePath)
      throw new PlatformError('未找到Edge或Chrome，请在抖音浏览器设置填写程序路径。', 'rejected');
    const compatible = !visible && this.background() && this.compatibilityWindow();
    if (compatible && process.platform !== 'win32')
      throw new PlatformError(
        '兼容窗口模式目前只支持Windows；请关闭兼容模式，使用无窗口后台或普通窗口。',
        'rejected',
      );
    const context = await chromium.launchPersistentContext(this.profileDir, {
      executablePath,
      headless: !visible && this.background() && !compatible,
      chromiumSandbox: true,
      ignoreDefaultArgs: ['--unsafely-disable-devtools-self-xss-warnings'],
      viewport: { width: 1280, height: 900 },
      timeout: 20000,
      args: [
        ...browserCacheArgs(this.cacheMB()),
        ...(compatible
          ? ['--window-position=-32000,-32000', '--window-size=1280,900']
          : process.platform === 'win32'
            ? ['--window-position=100,100']
            : []),
        '--mute-audio',
        '--disable-notifications',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ],
    });

    this.context = context;
    if (this.clearCachePending || Date.now() - this.lastCacheClear > 86400000) {
      try {
        await clearNetworkCache(context);
        this.lastCacheClear = Date.now();
        this.clearCachePending = false;
      } catch {}
    }
    context.once('close', () => {
      if (this.context === context) {
        this.context = undefined;
        this.chatPage = undefined;
        this.feedUrl = undefined;
        this.groupIdentityCache = undefined;
        this.loginOpen = false;
      }
    });
    return context;
  }
  private async guardCommentPage(page: Page) {
    if (this.commentGuardedPages.has(page)) return;
    await page.route('**/aweme/v1/web/comment/**', (route) =>
      route.request().method() === 'GET' || this.allowedRequest === route.request()
        ? route.fallback()
        : route.abort(),
    );
    this.commentGuardedPages.add(page);
  }
  private capture(page: Page): Capture {
    const data: Capture = {
      creators: new Map(),
      videos: new Map(),
      rows: [],
      pages: [],
      pending: new Set(),
    };
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (
        url.origin !== ORIGIN ||
        !url.pathname.startsWith('/aweme/v1/web/') ||
        !/\/(?:feed|detail|aweme\/post|comment\/list|search)\/|\/user\/profile\/self\//.test(
          url.pathname,
        )
      )
        return;
      const pending = this.consume(response, url, data)
        .catch(() => {})
        .finally(() => data.pending.delete(pending));
      data.pending.add(pending);
    });
    return data;
  }
  private async consume(response: BrowserResponse, url: URL, data: Capture) {
    if (!response.ok() || Number(response.headers()['content-length'] || 0) > 3_000_000) return;
    const raw = await response.text();
    if (raw.length > 3_000_000) return;
    const json = parseDouyinResponse(raw);
    if (json.status_code !== undefined && Number(json.status_code) !== 0) return;
    if (url.pathname.includes('/search/') && Array.isArray(json.user_list)) {
      for (const row of json.user_list.slice(0, 50)) {
        const user = row?.user_info;
        const handle =
          typeof user?.unique_id === 'string' && user.unique_id ? user.unique_id : user?.short_id;
        if (
          validSecUid(user?.sec_uid) &&
          typeof handle === 'string' &&
          handle.length <= 80 &&
          typeof user.nickname === 'string'
        )
          data.creators.set(user.sec_uid, {
            id: user.sec_uid,
            name: user.nickname.slice(0, 80),
            handle,
          });
      }
    }
    if (url.pathname.includes('/user/profile/self/')) {
      const user = json.user;
      if (user?.uid && user.nickname)
        data.self = {
          id: validSecUid(user.sec_uid) ? user.sec_uid : numericId(user.uid),
          name: String(user.nickname).slice(0, 80),
        };
      return;
    }
    const videos = [
      ...(json.aweme_detail ? [json.aweme_detail] : []),
      ...(Array.isArray(json.aweme_list) ? json.aweme_list : []),
      ...(Array.isArray(json.data)
        ? json.data.flatMap((x: Json) =>
            x.aweme_info ? [x.aweme_info] : Array.isArray(x.items) ? x.items : [],
          )
        : []),
    ];
    for (const rawVideo of videos.slice(0, 40)) {
      try {
        const v = mapDouyinVideo(rawVideo);
        data.videos.set(v.id, v);
      } catch {
        /* Unrecognized records have no usable target. */
      }
    }
    if (!url.pathname.includes('/comment/list/')) return;
    const id = url.searchParams.get('aweme_id') || url.searchParams.get('item_id');
    const root = url.searchParams.get('comment_id') || undefined;
    const pageId = id || (root ? data.rows.find((c) => c.id === root)?.target.oid : undefined);
    if (!pageId) return;
    const pendingRows: Array<{ row: Json; root?: string }> = (
      Array.isArray(json.comments) ? json.comments : []
    )
      .slice(0, 60)
      .map((row: Json) => ({ row, root }));
    for (let index = 0; index < pendingRows.length && index < 180; index++) {
      try {
        const entry = pendingRows[index],
          c = mapDouyinComment(entry.row, pageId, entry.root);
        const old = data.rows.findIndex((r) => r.id === c.id);
        if (old < 0) data.rows.push(c);
        else data.rows[old] = c;
        if (Array.isArray(entry.row.reply_comment))
          for (const row of entry.row.reply_comment.slice(0, 60))
            if (pendingRows.length < 180) pendingRows.push({ row, root: c.target.root });
      } catch {
        /* Unrecognized IDs are never guessed or rounded. */
      }
    }
    data.rows = data.rows.slice(-180);
    data.pages.push({
      cursor: url.searchParams.get('cursor') || '0',
      next: String(json.cursor ?? ''),
      more: Boolean(Number(json.has_more)),
      root: root || '0',
    });
  }
  private async checkPageBlock(page: Page) {
    const title = (await page.title()).trim();
    if (/^(?:验证码中间页|安全验证|验证中心)(?:$|\s|[-—|])/.test(title))
      throw new PlatformError(
        '抖音官网正在要求人工验证，后台不能代为完成。请在配置页打开抖音登录窗口，完成官网验证后点击“完成抖音登录”，再用“检查抖音推荐流”重试；这不代表账号已掉线，也不会自动切换有窗口模式。',
        'auth',
      );
  }
  private async settle(
    page: Page,
    data: Capture,
    ready: () => boolean | Promise<boolean>,
    ms = 6500,
  ) {
    const until = Date.now() + ms;
    while (!(await ready()) && Date.now() < until && !page.isClosed()) {
      await this.checkPageBlock(page);
      await page.waitForTimeout(150);
      await Promise.allSettled([...data.pending]);
    }
  }
  private async dismiss(page: Page) {
    const close = page.locator('#douyin_login_comp_flat_panel .YoNA2Hyj');
    if (await close.isVisible().catch(() => false))
      await close.click({ timeout: 1500 }).catch(() => {});
    const tip = page.getByRole('button', { name: '我知道了', exact: true });
    if (await tip.isVisible().catch(() => false))
      await tip.click({ timeout: 1500 }).catch(() => {});
  }
  private async visit<T>(
    url: string,
    action: (page: Page, data: Capture) => Promise<T>,
    signal?: AbortSignal,
    visible = false,
    budgetMs = 45000,
    kind: 'main' | 'chat' | 'send' = 'main',
  ): Promise<T> {
    return this.serial(async () => {
      if (this.loginOpen)
        throw new PlatformError('独立Edge正在等待你登录；登录后在配置页点“完成抖音登录”。', 'auth');
      if (this.idleTimer) clearTimeout(this.idleTimer);
      const budget = AbortSignal.timeout(budgetMs),
        combined = signal ? AbortSignal.any([signal, budget]) : budget;
      combined.throwIfAborted();
      const ctx = await this.launch(visible);
      let p: Page;
      if (kind === 'chat') {
        if (!this.chatPage || this.chatPage.isClosed()) this.chatPage = await ctx.newPage();
        p = this.chatPage;
        if (!this.background()) await p.bringToFront();
      } else {
        p = kind === 'send' ? await ctx.newPage() : ctx.pages()[0] || (await ctx.newPage());
        await this.guardCommentPage(p);
      }
      if (combined.aborted) {
        await ctx.close().catch(() => {});
        combined.throwIfAborted();
      }
      p.setDefaultTimeout(6500);
      let data = this.pageData.get(p);
      if (!data) {
        data = this.capture(p);
        this.pageData.set(p, data);
      }
      const abort = () => {
        void ctx.close().catch(() => {});
      };
      combined.addEventListener('abort', abort, { once: true });
      try {
        if (p.url() !== url || url === ORIGIN + '/user/self') {
          data.creators.clear();
          data.videos.clear();
          data.rows = [];
          data.pages = [];
          data.self = undefined;
          await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 22000 });
        }
        if (new URL(p.url()).origin !== ORIGIN)
          throw new PlatformError('官网跳转到了未支持的地址，停止本次操作。', 'rejected');
        await this.checkPageBlock(p);
        const result = await action(p, data);
        combined.throwIfAborted();
        return result;
      } catch (e) {
        this.detail =
          e instanceof PlatformError
            ? e.message
            : '抖音网页未完成操作；请检查独立浏览器的登录或验证提示。';
        if (combined.aborted)
          throw new PlatformError('抖音操作已取消或超时；不会无限等待。', 'network');
        if (e instanceof PlatformError) throw e;
        throw new PlatformError(this.detail, 'network');
      } finally {
        combined.removeEventListener('abort', abort);
        if (kind === 'send' && !p.isClosed()) await p.close().catch(() => {});
        if (this.releaseAfterTask() || combined.aborted || this.stopped || !this.enabled())
          await ctx.close().catch(() => {});
        else if (this.groupListening()) {
          for (const tab of ctx.pages())
            await tab
              .locator('video,audio')
              .evaluateAll((nodes) => nodes.forEach((n) => (n as HTMLMediaElement).pause()))
              .catch(() => {});
        } else if (!this.groupListening()) {
          this.idleTimer = setTimeout(() => {
            if (this.context === ctx && !this.loginOpen) void ctx.close().catch(() => {});
          }, 30000);
          this.idleTimer.unref();
        }
      }
    });
  }
  async openLogin() {
    return this.serial(async () => {
      if (this.context && this.loginOpen)
        return { detail: '独立Edge已打开，请在其中完成抖音登录。' };
      if (this.idleTimer) clearTimeout(this.idleTimer);
      if (this.context) await this.context.close();
      const ctx = await this.launch(true);
      this.loginOpen = true;
      try {
        const p = ctx.pages()[0] || (await ctx.newPage());
        await p.goto(ORIGIN + '/jingxuan', { waitUntil: 'domcontentloaded', timeout: 22000 });
        const login = p.getByRole('button', { name: '登录', exact: true });
        if (await login.isVisible().catch(() => false))
          await login.click({ timeout: 5000 }).catch(() => {});
        this.detail =
          '请在独立Edge中扫码登录；完成后回配置页点“完成抖音登录”。不会读取日常Edge账号。';
        return { detail: this.detail };
      } catch (e) {
        await ctx.close().catch(() => {});
        throw new PlatformError('抖音登录页未打开，请稍后重试。', 'network');
      }
    });
  }
  async closeLogin() {
    await this.serial(async () => {
      this.loginOpen = false;
      await this.context?.close();
    });
  }
  private async pageSelf(p: Page): Promise<Account | undefined> {
    // /user/self may be server-rendered without making a profile API request.
    // Its official canonical profile link and visible nickname identify this signed-in account.
    if (
      await p
        .getByRole('button', { name: '登录', exact: true })
        .isVisible()
        .catch(() => false)
    )
      return;
    if (!(await p.locator('link[rel=canonical]').count())) return;
    const raw = await p
      .locator('link[rel="canonical"]')
      .getAttribute('href')
      .catch(() => null);
    if (!raw) return;
    let canonical: URL;
    try {
      canonical = new URL(raw);
    } catch {
      return;
    }
    const id = canonical.pathname.match(/^\/user\/(MS4w[A-Za-z0-9_.-]+)\/?$/)?.[1];
    if (canonical.origin !== ORIGIN || !validSecUid(id)) return;
    const current = new URL(p.url());
    if (current.origin !== ORIGIN || !['/user/self', canonical.pathname].includes(current.pathname))
      return;
    const names = await p.locator('h1').allTextContents();
    if (names.length !== 1 || !names[0].trim()) return;
    return { id, name: names[0].trim().slice(0, 80) };
  }
  private async selfReady(p: Page, data: Capture) {
    data.self = (await this.pageSelf(p)) ?? data.self;
    return Boolean(data.self);
  }
  private async groupIdentity(page: Page, force = false): Promise<Account> {
    const ctx = page.context(),
      cached = this.groupIdentityCache;
    if (!force && cached?.context === ctx && Date.now() - cached.at < 120000) return cached.account;
    const check = await ctx.newPage(),
      identity = this.capture(check);
    try {
      await check.goto(ORIGIN + '/user/self', { waitUntil: 'domcontentloaded', timeout: 22000 });
      await this.settle(
        check,
        identity,
        async () => {
          await this.selfReady(check, identity);
          return !!identity.self && validSecUid(identity.self.id);
        },
        12000,
      );
      if (!identity.self || !validSecUid(identity.self.id))
        throw new PlatformError('抖音群聊尚未核实当前Bot账号，先保留消息稍后再查。', 'auth');
      this.groupIdentityCache = { context: ctx, account: identity.self, at: Date.now() };
      return identity.self;
    } finally {
      await check.close().catch(() => {});
      if (!this.background()) await page.bringToFront();
    }
  }

  async readGroup(binding: GroupBinding, signal?: AbortSignal) {
    return this.visit(
      ORIGIN + '/jingxuan',
      async (p) => {
        const account = await this.groupIdentity(p);
        if (binding.accountId && account.id !== binding.accountId)
          throw new PlatformError('抖音登录账号已改变，群聊停止发送。', 'rejected');
        try {
          return await readDouyinGroup(p, binding, account.id);
        } catch (e) {
          throw new PlatformError(
            '群消息读取暂未完成：' + (e instanceof Error ? e.message.split('\n')[0] : '页面未就绪'),
            'network',
          );
        }
      },
      signal,
      false,
      75000,
      'chat',
    );
  }
  async sendGroup(binding: GroupBinding, draft: string, signal?: AbortSignal) {
    let stage = '核对账号',
      attempted = false;
    try {
      return await this.visit(
        ORIGIN + '/jingxuan',
        async (p) => {
          try {
            const account = await this.groupIdentity(p, true);
            if (!binding.accountId || account.id !== binding.accountId)
              throw new PlatformError('抖音群发送账号与绑定不同。', 'rejected');
            return await sendDouyinGroup(p, binding, account.id, draft, (next) => {
              stage = next;
              if (next === '提交群消息') attempted = true;
            });
          } catch (e) {
            throw new PlatformError(
              stage + '：' + (e instanceof Error ? e.message.split('\n')[0] : '页面未就绪'),
              'network',
            );
          }
        },
        signal,
        false,
        75000,
        'chat',
      );
    } catch (e) {
      return {
        status: attempted ? ('unknown' as const) : ('not_submitted' as const),
        detail: stage + ' · ' + (e instanceof Error ? e.message : '群页面未就绪'),
      };
    }
  }
  async account(signal?: AbortSignal): Promise<Account> {
    return this.visit(
      ORIGIN + '/user/self',
      async (p, data) => {
        await this.settle(p, data, () => this.selfReady(p, data), 12000);
        if (!data.self)
          throw new PlatformError(
            '尚未确认抖音登录账号；请在配置页打开独立Edge登录。浏览公开内容不需要先登录。',
            'auth',
          );
        this.detail = '已核对抖音账号：' + data.self.name;
        return data.self;
      },
      signal,
    );
  }
  async search(query: string, page = 1, signal?: AbortSignal) {
    if (!query.trim() || query.length > 120) throw new PlatformError('检索词应为1–120字。');
    if (page !== 1) throw new PlatformError('抖音实验接入只读取首屏搜索结果，不会伪造翻页。');
    return this.visit(
      ORIGIN + '/search/' + encodeURIComponent(query) + '?type=video',
      async (p, data) => {
        await this.dismiss(p);
        await this.settle(p, data, () => data.videos.size > 0);
        const items = [...data.videos.values()].slice(0, 10);
        this.detail = items.length
          ? '已读取抖音搜索结果。'
          : '搜索结果未提供可核实的视频编号；可能需要登录或完成网页验证。';
        return { page: 1, items, limited: true, reason: this.detail, externalContent: true };
      },
      signal,
    );
  }
  async resolveCreator(input: string, signal?: AbortSignal): Promise<Account> {
    const parsed = parseFocusAccount(input, 'douyin');
    if (parsed.uid) return { id: parsed.uid, name: '抖音主人' };
    return this.visit(
      ORIGIN + '/search/' + encodeURIComponent(parsed.name!) + '?type=user',
      async (p, data) => {
        await this.dismiss(p);
        const domCandidates = async () =>
          p.locator('a[href*="/user/MS4w"]').evaluateAll((anchors, handle) => {
            const found = new Map<string, string>();
            for (const anchor of anchors) {
              const a = anchor as HTMLAnchorElement;
              const u = new URL(a.href),
                id = u.pathname.match(/^\/user\/(MS4w[A-Za-z0-9_.-]{10,200})\/?$/)?.[1];
              if (u.origin !== 'https://www.douyin.com' || !id) continue;
              let node: HTMLElement | null = a;
              for (let n = 0; n < 5 && node; n++, node = node.parentElement) {
                const text = node.innerText;
                const actual = text.match(/抖音号[：:]\s*([^\s]+)/)?.[1];
                if (actual === handle) {
                  found.set(id, a.innerText.trim().slice(0, 80) || handle);
                  break;
                }
              }
            }
            return [...found].map(([id, name]) => ({ id, name }));
          }, parsed.name!);
        const candidates = async () => {
          const accounts = [...data.creators.values()]
            .filter((c) => c.handle === parsed.name)
            .map(({ id, name }) => ({ id, name }));
          return [
            ...new Map([...(await domCandidates()), ...accounts].map((c) => [c.id, c])).values(),
          ];
        };
        await this.settle(p, data, async () => (await candidates()).length > 0, 10000);
        const matched = await candidates();
        if (matched.length !== 1)
          throw new PlatformError(
            '没有唯一核对到这个抖音号；请改填主人完整用户主页链接，不会按同名账号猜测。',
          );
        return matched[0];
      },
      signal,
    );
  }
  async creatorVideos(owner: string, limit: number, signal?: AbortSignal) {
    if (!validSecUid(owner)) throw new PlatformError('抖音关注需要已经核实的用户主页身份。');
    const count = Math.max(1, Math.min(30, Math.trunc(limit)));
    return this.visit(
      ORIGIN + '/user/' + owner,
      async (p, data) => {
        await this.dismiss(p);
        const owned = () =>
          [...data.videos.values()]
            .filter((v) => v.ownerId === owner)
            .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
        const fromPage = () =>
          p.evaluate(
            ({ owner, count }) => {
              const canonical =
                document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
              if (
                !canonical ||
                new URL(canonical).origin !== 'https://www.douyin.com' ||
                new URL(canonical).pathname.replace(/\/$/, '') !== '/user/' + owner
              )
                return [];
              const author = document.querySelector('h1')?.textContent?.trim().slice(0, 80) ?? '';
              const items = new Map<
                string,
                {
                  id: string;
                  aid: string;
                  title: string;
                  url: string;
                  ownerId: string;
                  author: string;
                }
              >();
              for (const a of document.querySelectorAll<HTMLAnchorElement>(
                '[data-e2e="user-post-list"] a[href], [data-e2e="user-post-item"] a[href]',
              )) {
                const u = new URL(a.href),
                  id = u.pathname.match(/^\/video\/(\d+)\/?$/)?.[1];
                const title = (
                  a.getAttribute('title') ||
                  a.querySelector('img')?.getAttribute('alt') ||
                  a.textContent ||
                  ''
                ).trim();
                if (u.origin === 'https://www.douyin.com' && id && title)
                  items.set(id, {
                    id,
                    aid: id,
                    title: title.slice(0, 200),
                    url: 'https://www.douyin.com/video/' + id,
                    ownerId: owner,
                    author,
                  });
              }
              return [...items.values()].slice(0, count);
            },
            { owner, count },
          );
        await this.settle(
          p,
          data,
          async () => owned().length > 0 || (await fromPage()).length > 0,
          12000,
        );
        const items = owned().length ? owned().slice(0, count) : await fromPage();
        if (!items.length)
          throw new PlatformError('尚未读到主人公开作品；保留已有记录，稍后再查。', 'network');
        return { items };
      },
      signal,
    );
  }
  async nextVideo(seen: string[] = [], signal?: AbortSignal): Promise<Video> {
    return this.visit(
      this.feedUrl ?? ORIGIN + '/jingxuan',
      async (p, data) => {
        await this.dismiss(p);
        const exclude = new Set([...seen, ...(this.lastFeedId ? [this.lastFeedId] : [])]);
        const hasPlayer = await p.locator('video').evaluateAll((vs) =>
          vs.some((v) => {
            const r = v.getBoundingClientRect();
            return r.width >= 160 && r.height >= 90 && r.top < innerHeight && r.bottom > 0;
          }),
        );
        if (!this.feedUrl || !hasPlayer) {
          const recommendation = p.getByRole('link', { name: '推荐', exact: true });
          if (await recommendation.count()) await recommendation.click({ timeout: 6500 });
          await this.dismiss(p);
        }
        const active = () =>
          p.evaluate(() => {
            const candidates: Array<{ id: string; score: number }> = [];
            for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
              const copy = a.getBoundingClientRect();
              if (
                copy.width <= 0 ||
                copy.height <= 0 ||
                copy.top >= innerHeight ||
                copy.bottom <= 0
              )
                continue;
              const u = new URL(a.href);
              if (u.origin !== 'https://www.douyin.com') continue;
              const id =
                u.searchParams.get('aweme_id') || u.pathname.match(/^\/video\/(\d+)\/?$/)?.[1];
              if (!id || !/^[1-9]\d{0,23}$/.test(id)) continue;
              let region: HTMLElement | null = a;
              while (region && !region.querySelector('video')) region = region.parentElement;
              if (!region || region === document.body) continue;
              const players = [...region.querySelectorAll('video')].filter((v) => {
                const r = v.getBoundingClientRect();
                return r.width >= 160 && r.height >= 90 && r.top < innerHeight && r.bottom > 0;
              });
              if (players.length !== 1) continue;
              const r = players[0].getBoundingClientRect();
              candidates.push({
                id,
                score:
                  Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) *
                  Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)),
              });
            }
            candidates.sort((a, b) => b.score - a.score);
            return candidates[0]?.id;
          });
        for (let step = 0; step < 5; step++) {
          let id: string | undefined;
          await this.settle(
            p,
            data,
            async () => {
              id = await active();
              return Boolean(id && (!step || !exclude.has(id)));
            },
            step ? 3500 : 12000,
          );
          if (id && !exclude.has(id)) {
            await this.settle(
              p,
              data,
              async () => Boolean(await this.pageVideo(p, data, id!)),
              5000,
            );
            const video = await this.pageVideo(p, data, id);
            if (video) {
              this.lastFeedId = id;
              this.feedUrl = p.url();
              this.detail = '已读取抖音推荐流新视频。';
              return video;
            }
          }
          // Focus the actual large player before scrolling; never type into a comment editor.
          const player = p.locator('video').filter({ visible: true });
          const players = await player.all();
          for (const v of players) {
            const r = await v.boundingBox();
            if (r && r.width >= 160 && r.height >= 90 && r.y + r.height > 0 && r.y < 900) {
              await p.mouse.move(
                Math.max(1, Math.min(1270, r.x + r.width / 2)),
                Math.max(60, Math.min(830, r.y + r.height / 2)),
              );
              break;
            }
          }
          await p.evaluate(() => {
            if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          });
          await p.keyboard.press('ArrowDown');
          await p.waitForTimeout(800);
        }
        throw new PlatformError(
          '推荐流没有切到可核实的新视频，本轮停止翻页；不把重复或无关视频算成新观看。',
          'network',
        );
      },
      signal,
    );
  }
  private async pageVideo(p: Page, data: Capture, id: string): Promise<Video | undefined> {
    if (data.videos.has(id)) return data.videos.get(id);
    // Server-rendered pages may never request the detail API. Bind visible facts to an exact public hashtag link.
    const facts = await p.evaluate((wanted) => {
      const link = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].find((a) => {
        try {
          return (
            a.getBoundingClientRect().width > 0 &&
            a.getBoundingClientRect().top < innerHeight &&
            a.getBoundingClientRect().bottom > 0 &&
            new URL(a.href).origin === 'https://www.douyin.com' &&
            new URL(a.href).searchParams.get('aweme_id') === wanted
          );
        } catch {
          return false;
        }
      });
      if (!link) return;
      let region: HTMLElement | null = link;
      while (
        region &&
        !region.querySelector('video') &&
        !(
          region.innerText.includes('图文') &&
          [...region.querySelectorAll('img')].filter((img) => {
            const r = img.getBoundingClientRect();
            return (
              img.naturalWidth >= 160 &&
              r.width >= 160 &&
              r.height >= 90 &&
              r.top < innerHeight &&
              r.bottom > 0
            );
          }).length
        )
      )
        region = region.parentElement;
      if (!region || region === document.body) return;
      const players = [...region.querySelectorAll('video')].filter((v) => {
        const r = v.getBoundingClientRect();
        return (
          r.width >= 160 &&
          r.height >= 90 &&
          r.top < innerHeight &&
          r.bottom > 0 &&
          Number.isFinite(v.duration) &&
          v.duration > 3
        );
      });
      const images =
        !players.length && region.innerText.includes('图文')
          ? [...region.querySelectorAll('img')].filter((img) => {
              const r = img.getBoundingClientRect();
              return (
                img.naturalWidth >= 160 &&
                r.width >= 160 &&
                r.height >= 90 &&
                r.top < innerHeight &&
                r.bottom > 0
              );
            })
          : [];
      if (players.length !== 1 && !images.length) return;
      const desc = link.closest<HTMLElement>('[data-e2e="video-desc"]');
      let title = desc?.innerText ?? '';
      if (!title) {
        let copy: HTMLElement | null = link.parentElement;
        for (let i = 0; i < 4 && copy; i++, copy = copy.parentElement) {
          const text = copy.innerText.trim();
          if (text && !text.startsWith('#') && text.length < 4000) {
            title = text;
            break;
          }
        }
      }
      if (!title) return;
      const author = (region.innerText.match(/@([^\n·]+)(?:\s*·|\n)/)?.[1] ?? '').trim();
      return {
        title: title.slice(0, 200),
        description: title.slice(0, 4000),
        author,
        duration: players[0]?.duration ?? 0,
        kind: players.length ? ('video' as const) : ('images' as const),
      };
    }, id);
    if (!facts) return;
    const v: Video = {
      id,
      aid: id,
      cid: id,
      kind: facts.kind,
      title: facts.title,
      description: facts.description,
      author: facts.author,
      durationSec: facts.duration,
      cover: '',
      url: ORIGIN + '/video/' + id,
      parts: [],
    };
    data.videos.set(id, v);
    return v;
  }
  async video(input: string, part = 1, signal?: AbortSignal): Promise<Video> {
    const id = douyinVideoId(input);
    if (part !== 1) throw new PlatformError('抖音视频请提供具体作品链接，暂不支持合集分集参数。');
    return this.visit(
      playerUrl(id),
      async (p, data) => {
        await this.dismiss(p);
        await this.settle(p, data, async () => Boolean(await this.pageVideo(p, data, id)), 15000);
        const video = await this.pageVideo(p, data, id);
        if (video) {
          this.detail = '已读取抖音视频详情。';
          return video;
        }
        throw new PlatformError(
          '官网尚未返回这条视频的可核实详情；不会把推荐作品当成目标。请检查登录或验证提示。',
          'network',
        );
      },
      signal,
    );
  }
  async subtitles(_video: Video) {
    return {
      available: false,
      reason: '本版尚未接入抖音完整字幕；网页文字、弹幕和评论不等于字幕。',
    };
  }
  private async pageComments(p: Page, data: Capture, id: string) {
    const rows = await p.locator('[data-e2e="comment-item"]').evaluateAll((es) =>
      es.flatMap((e) => {
        const marker = [...e.querySelectorAll('[id^="tooltip_"]')].find(
          (n) => n.closest('[data-e2e="comment-item"]') === e,
        );
        const cid = marker?.id.match(/^tooltip_(\d+)$/)?.[1];
        const body = [...e.querySelectorAll('[data-e2e="comment-text"], .FduGc_lz')].find(
          (n) => n.closest('[data-e2e="comment-item"]') === e,
        );
        const author = [...e.querySelectorAll<HTMLAnchorElement>('a[href*="/user/"]')].find(
          (n) => n.closest('[data-e2e="comment-item"]') === e && n.innerText.trim(),
        );
        if (!cid || !body || !author) return [];
        let thread: Element = e;
        let ancestor = e.parentElement?.closest('[data-e2e="comment-item"]');
        while (ancestor) {
          thread = ancestor;
          ancestor = ancestor.parentElement?.closest('[data-e2e="comment-item"]');
        }
        const root = [...thread.querySelectorAll('[id^="tooltip_"]')]
          .find((n) => n.closest('[data-e2e="comment-item"]') === thread)
          ?.id.match(/^tooltip_(\d+)$/)?.[1];
        if (!root) return [];
        const copy = body.cloneNode(true) as HTMLElement;
        for (const badge of copy.querySelectorAll('.comment-item-tag,.semi-tag')) badge.remove();
        for (const image of copy.querySelectorAll('img[alt]'))
          image.replaceWith(document.createTextNode(image.getAttribute('alt') ?? ''));
        const url = new URL(author.href),
          sec =
            url.origin === 'https://www.douyin.com'
              ? url.pathname.match(/^\/user\/(MS4w[A-Za-z0-9_.-]+)\/?$/)?.[1]
              : undefined;
        return [
          {
            cid,
            root,
            text: (copy.textContent ?? '').trim().slice(0, 2000),
            author: author.innerText.trim().slice(0, 80),
            sec,
          },
        ];
      }),
    );
    for (const row of rows) {
      if (!row.text) continue;
      const index = data.rows.findIndex((c) => c.id === row.cid);
      const comment: PublicComment = {
        id: numericId(row.cid),
        createdAt: index >= 0 ? data.rows[index].createdAt : undefined,
        authorId: validSecUid(row.sec)
          ? row.sec
          : index >= 0
            ? data.rows[index].authorId
            : undefined,
        author: row.author,
        text: row.text,
        target: {
          oid: id,
          type: DOUYIN_VIDEO_TYPE,
          root: numericId(row.root),
          parent: numericId(row.cid),
        },
      };
      if (index < 0) data.rows.push(comment);
      else data.rows[index] = comment;
    }
    data.rows = data.rows.slice(-180);
    return data.rows.some((c) => c.target.oid === id);
  }
  private async commentArea(p: Page, data: Capture, id: string, refresh = true): Promise<void> {
    await this.settle(p, data, async () => Boolean(await this.pageVideo(p, data, id)), 15000);
    await this.dismiss(p);
    const rows = p.locator('[data-e2e="comment-item"]');
    // The official page may auto-open the panel after metadata arrives. Do not toggle it closed while it mounts.
    await this.settle(
      p,
      data,
      async () => {
        await this.pageComments(p, data, id);
        return Boolean(await rows.filter({ visible: true }).count());
      },
      1200,
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await rows.filter({ visible: true }).count()) break;
      const tab = p.getByText('评论', { exact: true }).filter({ visible: true });
      if ((await tab.count()) === 1) await tab.dispatchEvent('click');
      else {
        const buttons = p.locator('[data-e2e="feed-comment-icon"]');
        for (let i = 0; i < (await buttons.count()); i++) {
          const button = buttons.nth(i);
          if (
            await button.evaluate((e) => {
              const r = e.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0;
            })
          ) {
            await button.dispatchEvent('click');
            break;
          }
        }
      }
      await this.settle(
        p,
        data,
        async () => {
          await this.pageComments(p, data, id);
          return Boolean(await rows.filter({ visible: true }).count());
        },
        attempt ? 6500 : 2500,
      );
    }
    await Promise.allSettled([...data.pending]);
    await this.pageComments(p, data, id);
    if (refresh && !data.rows.some((c) => c.target.oid === id) && !(await rows.count())) {
      // One bounded refresh recovers a player mounted without its comment panel. No writes are retried.
      await p.reload({ waitUntil: 'domcontentloaded', timeout: 12000 });
      await this.commentArea(p, data, id, false);
    }
  }
  private async rowFor(p: Page, data: Capture, id: string) {
    const cid = numericId(id);
    if (!data.rows.some((c) => c.id === cid))
      throw new PlatformError('尚未读取这条评论，请先展开对应楼层。', 'rejected');
    const rows = p.locator('[data-e2e="comment-item"]');
    const matches = await rows.evaluateAll(
      (es, id) =>
        es.flatMap((e, index) =>
          [...e.querySelectorAll('[id^="tooltip_"]')].some(
            (n) => n.id === 'tooltip_' + id && n.closest('[data-e2e="comment-item"]') === e,
          )
            ? [index]
            : [],
        ),
      cid,
    );
    if (matches.length !== 1)
      throw new PlatformError('这条评论当前未唯一显示，未选择其他楼层。', 'rejected');
    return rows.nth(matches[0]);
  }
  private async ownAction(
    row: Locator,
    id: string,
    name: string | RegExp,
  ): Promise<Locator | undefined> {
    const actions = row.getByText(name, { exact: true }).filter({ visible: true });
    for (let i = 0; i < Math.min(10, await actions.count()); i++) {
      const action = actions.nth(i);
      if (
        await action.evaluate((e, id) => {
          const row = e.closest('[data-e2e="comment-item"]');
          return (
            row &&
            [...row.querySelectorAll('[id^="tooltip_"]')].some(
              (n) => n.id === 'tooltip_' + id && n.closest('[data-e2e="comment-item"]') === row,
            )
          );
        }, id)
      )
        return action;
    }
  }
  private async revealThread(p: Page, data: Capture, target: CommentTarget) {
    await this.settle(
      p,
      data,
      async () => {
        await this.pageComments(p, data, target.oid);
        return data.rows.some((c) => c.id === target.root && c.target.oid === target.oid);
      },
      6500,
    );
    for (let step = 0; step < 3; step++) {
      await this.pageComments(p, data, target.oid);
      if (
        target.parent !== target.root &&
        data.rows.some((c) => c.id === target.parent && c.target.root === target.root)
      ) {
        try {
          await this.rowFor(p, data, target.parent);
          return;
        } catch {
          /* The API may have prefetched a reply that still needs expanding. */
        }
      }
      const root = await this.rowFor(p, data, target.root);
      const expand = await this.ownAction(root, target.root, /(?:展开|查看|更多).*回复|回复.*更多/);
      if (!expand) return;
      const before = data.rows.filter((c) => c.target.root === target.root).length;
      await expand.click();
      await this.settle(
        p,
        data,
        async () => {
          await this.pageComments(p, data, target.oid);
          return (
            data.rows.filter((c) => c.target.root === target.root).length > before ||
            (await root.locator('[data-e2e="comment-item"]').filter({ visible: true }).count()) > 0
          );
        },
        3500,
      );
      if (target.parent === target.root) return;
    }
  }
  async comments(raw: CommentTarget, page = 1, signal?: AbortSignal, cursor?: string) {
    const t = douyinTarget(raw);
    if (page > 3) throw new PlatformError('抖音单次最多查看前三页评论。');
    if (cursor !== undefined && !/^\d{1,24}$/.test(cursor))
      throw new PlatformError('抖音评论游标无效。');
    return this.visit(
      playerUrl(t.oid),
      async (p, data) => {
        await this.commentArea(p, data, t.oid);
        if (t.root !== '0') await this.revealThread(p, data, t);
        // Pagination remains driven by the official visible comment list, never signed API replay.
        for (let n = 1; n < page; n++) {
          const last = p.locator('[data-e2e="comment-item"]').last();
          if (!(await last.count())) break;
          const size = data.rows.length;
          await last.scrollIntoViewIfNeeded();
          await last.hover();
          await p.mouse.wheel(0, 650);
          await this.settle(
            p,
            data,
            async () => {
              await this.pageComments(p, data, t.oid);
              return data.rows.length > size;
            },
            3500,
          );
          if (data.rows.length === size) break;
        }
        const scope = t.root === '0' ? '0' : t.root;
        const latest = data.pages.filter((x) => x.root === scope).at(-1);
        const reached = !cursor || data.pages.some((x) => x.root === scope && x.cursor === cursor);
        const rows = data.rows.filter(
          (c) =>
            c.target.oid === t.oid &&
            (t.root === '0' ? c.id === c.target.root : c.target.root === t.root),
        );
        this.detail = rows.length
          ? '已读取官网提供的评论；未登录时数量可能受限。'
          : '评论正文尚未读取成功；此结果不能证明登录失效。可稍后重读，或在配置页检查对应作品页面。';
        return {
          ...(rows.length
            ? {}
            : {
                readState: await p.locator('[data-e2e="comment-item"]').evaluateAll((es) => ({
                  nodes: es.length,
                  visible: es.filter((e) => {
                    const r = e.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                  }).length,
                  markers: es.filter((e) => e.querySelector('[id^="tooltip_"]')).length,
                  bodies: es.filter((e) => e.querySelector('[data-e2e="comment-text"], .FduGc_lz'))
                    .length,
                  authors: es.filter((e) =>
                    [...e.querySelectorAll<HTMLAnchorElement>('a[href*="/user/"]')].some((a) =>
                      a.innerText.trim(),
                    ),
                  ).length,
                  sampleIds: es.slice(0, 3).map((e) => e.querySelector('[id^="tooltip_"]')?.id),
                })),
              }),
          items: reached
            ? rows
                .filter((c) => t.root === '0' || c.id !== t.root)
                .slice(-40)
                .map((c) =>
                  t.root === '0'
                    ? {
                        ...c,
                        replies: data.rows
                          .filter(
                            (r) =>
                              r.target.oid === t.oid && r.target.root === c.id && r.id !== c.id,
                          )
                          .slice(0, 20),
                      }
                    : c,
                )
            : [],
          root: t.root === '0' ? undefined : rows.find((c) => c.id === t.root),
          page,
          limited: true,
          nextCursor: latest?.more && latest.next !== cursor ? latest.next : undefined,
          reason: reached ? this.detail : '网页尚未到达指定游标，未把旧页当成新页。',
        };
      },
      signal,
    );
  }
  async frames(video: Video, times: number[], signal?: AbortSignal) {
    const id = douyinVideoId(video.url);
    if (id !== douyinVideoId(video.id)) throw new PlatformError('采样地址与视频编号不一致。');
    return this.visit(
      playerUrl(id),
      async (p, data) => {
        await this.dismiss(p);
        await this.settle(p, data, () => data.videos.has(video.id));
        await this.pageVideo(p, data, video.id);
        if (!data.videos.has(video.id))
          throw new PlatformError('目标视频尚未核对，未采样其他作品。', 'rejected');
        // The page also contains a tiny 2.6-second placeholder player. Never return it as a real frame.
        await p.waitForFunction(
          (duration) =>
            [...document.querySelectorAll('video')].some((v) => {
              const r = v.getBoundingClientRect();
              return (
                r.width >= 160 &&
                r.height >= 90 &&
                Number.isFinite(v.duration) &&
                Math.abs(v.duration - duration) < 2
              );
            }),
          video.durationSec,
          { timeout: 12000 },
        );
        const indices = await p.locator('video').evaluateAll(
          (es, duration) =>
            es.flatMap((e, i) => {
              const v = e as HTMLVideoElement,
                r = v.getBoundingClientRect();
              return r.width >= 160 && r.height >= 90 && Math.abs(v.duration - duration) < 2
                ? [i]
                : [];
            }),
          video.durationSec,
        );
        if (indices.length !== 1)
          throw new PlatformError('尚未找到唯一的目标播放器，未返回占位画面。', 'rejected');
        const index = indices[0],
          player = p.locator('video').nth(index);
        const frames = [];
        for (const time of times.slice(0, 6)) {
          signal?.throwIfAborted();
          await player.evaluate(async (el, t) => {
            const v = el as HTMLVideoElement;
            v.pause();
            if (v.readyState < 1)
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(Error('metadata timeout')), 6000);
                v.addEventListener(
                  'loadedmetadata',
                  () => {
                    clearTimeout(timer);
                    resolve();
                  },
                  { once: true },
                );
              });
            v.currentTime = Math.min(t, Math.max(0, v.duration - 0.1));
          }, time);
          await p.waitForFunction(
            ({ index, time }) => {
              const v = document.querySelectorAll('video')[index];
              return v && v.readyState >= 2 && !v.seeking && Math.abs(v.currentTime - time) < 1;
            },
            { index, time: Math.min(time, Math.max(0, video.durationSec - 0.1)) },
            { timeout: 8000 },
          );
          const atSec = await player.evaluate((el) => (el as HTMLVideoElement).currentTime);
          const bytes = await player.screenshot({ type: 'jpeg', quality: 75, timeout: 6000 });
          if (bytes.length < 1000)
            throw new PlatformError('目标画面尚未解码，未返回空白图片。', 'network');
          frames.push({ atSec, bytes });
        }
        return frames;
      },
      signal,
    );
  }
  async notifications(): Promise<NotificationPage> {
    throw new PlatformError('抖音通知监听尚未接入；不会假报没有新消息。', 'invalid');
  }
  async send(
    raw: CommentTarget,
    text: string,
    signal?: AbortSignal,
    expectedAccountId?: string,
  ): Promise<SendReceipt> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.sendAttempt(raw, text, signal, expectedAccountId);
      } catch (e) {
        // Only known UI failures before a click may reconstruct the page. Never retry a POST or unknown outcome.
        const recoverable =
          e instanceof PlatformError &&
          e.kind === 'rejected' &&
          /^(?:尚未点击发送：(?!核对账号)|这条评论的回复入口暂未显示|未找到唯一的抖音评论输入框)/u.test(
            e.message,
          );
        if (attempt || !recoverable || signal?.aborted) throw e;
      }
    }
  }
  private async sendAttempt(
    raw: CommentTarget,
    text: string,
    signal?: AbortSignal,
    expectedAccountId?: string,
  ): Promise<SendReceipt> {
    const t = douyinTarget(raw);
    if (!this.posting()) throw new PlatformError('抖音公开发布已关闭。', 'rejected');
    if (!text.trim() || text.length > 1000)
      throw new PlatformError('评论内容应为1–1000字。', 'rejected');
    if (!expectedAccountId) throw new PlatformError('尚未核对抖音账号，未提交。', 'auth');
    let sendClicked = false;
    let stage = '核对账号';
    try {
      return await this.visit(
        playerUrl(t.oid),
        async (p, data) => {
          // Verify in the same authenticated context without destroying the prepared comment page.
          const check = await this.context!.newPage(),
            identity = this.capture(check);
          check.setDefaultTimeout(6500);
          try {
            await check.goto(ORIGIN + '/user/self', {
              waitUntil: 'domcontentloaded',
              timeout: 18000,
            });
            await this.settle(
              check,
              identity,
              async () => {
                await this.selfReady(check, identity);
                return Boolean(
                  identity.self &&
                  (identity.self.id === expectedAccountId ||
                    validSecUid(identity.self.id) === validSecUid(expectedAccountId)),
                );
              },
              12000,
            );
            if (identity.self?.id !== expectedAccountId)
              throw new PlatformError('抖音发评账号与准备记录不一致，未提交。', 'auth');
          } finally {
            await check.close().catch(() => {});
          }
          stage = '加载评论区';
          await this.commentArea(p, data, t.oid);
          if (t.root !== '0') {
            stage = '展开指定楼层';
            await this.revealThread(p, data, t);
            const observed = data.rows.find((c) => c.id === t.parent);
            if (observed?.target.root !== t.root)
              throw new PlatformError(
                '评论所属主楼已更新，请使用本次读取返回的target再准备回复。',
                'rejected',
              );
            const row = await this.rowFor(p, data, t.parent),
              reply = await this.ownAction(row, t.parent, '回复');
            if (!reply)
              throw new PlatformError('这条评论的回复入口暂未显示，未改发其他位置。', 'rejected');
            stage = '打开子回复输入框';
            await reply.click();
          }
          stage = '填写评论';
          const editors = p.locator('[contenteditable="true"]:visible');
          if (!(await editors.count())) {
            const placeholder = p
              .getByText('留下你的精彩评论吧', { exact: true })
              .filter({ visible: true });
            if ((await placeholder.count()) === 1) {
              await placeholder.click();
              await editors.first().waitFor({ state: 'visible', timeout: 5000 });
            }
          }
          await editors.first().waitFor({ state: 'visible', timeout: 6500 });
          if ((await editors.count()) !== 1)
            throw new PlatformError('未找到唯一的抖音评论输入框，尚未提交。', 'rejected');
          const editor = editors.first();
          await editor.fill(text);
          // The narrowest ancestor containing one visible send button avoids the video danmaku sender.
          let container = editor.locator('..');
          let send = container.getByText('发送', { exact: true }).filter({ visible: true });
          for (let i = 0; i < 4 && (await send.count()) !== 1; i++) {
            container = container.locator('..');
            send = container.getByText('发送', { exact: true }).filter({ visible: true });
          }
          if ((await send.count()) === 0) {
            const commentBox = p.locator('.comment-input-inner-container').filter({ has: editor });
            send = commentBox
              .locator('.commentInput-right-ct span')
              .filter({ has: p.locator('svg path[fill="#FE2C55"]') })
              .filter({ visible: true });
          }
          if ((await send.count()) !== 1)
            throw new PlatformError('评论发送按钮不唯一，尚未提交。', 'rejected');
          let submitted = false,
            blocked = false;
          let rejectRequest: () => void = () => {};
          const rejectedRequest = new Promise<undefined>((resolve) => {
            rejectRequest = () => resolve(undefined);
          });
          const allow = async (route: Route) => {
            const request = route.request();
            let form: URLSearchParams;
            try {
              form = new URLSearchParams(request.postData() || '');
            } catch {
              blocked = true;
              rejectRequest();
              await route.abort();
              return;
            }
            if (submitted) {
              await route.abort();
              return;
            }
            const url = new URL(request.url());
            if (
              url.origin !== ORIGIN ||
              url.pathname.replace(/\/$/, '') !== '/aweme/v1/web/comment/publish' ||
              request.method() !== 'POST' ||
              !this.enabled() ||
              !this.posting() ||
              signal?.aborted ||
              !matchesDouyinPublish(form, t, text)
            ) {
              blocked = true;
              rejectRequest();
              await route.abort();
              return;
            }
            submitted = true;
            this.allowedRequest = request;
            await route.fallback();
          };
          await p.route(PUBLISH_ROUTE, allow);
          const response = p
            .waitForResponse(
              (r) =>
                new URL(r.url()).origin === ORIGIN &&
                new URL(r.url()).pathname.replace(/\/$/, '') === '/aweme/v1/web/comment/publish' &&
                r.request().method() === 'POST',
              { timeout: 12000 },
            )
            .catch(() => undefined);
          try {
            sendClicked = true;
            await send.click();
            const result = await Promise.race([response, rejectedRequest]);
            if (blocked)
              throw new PlatformError('提交的目标或文字与准备记录不一致，已阻止提交。', 'rejected');
            if (!result) {
              if (submitted) throw new Error('提交后未取得回执；请核实原记录，禁止自动重发。');
              throw new Error('点击发送后未取得回执，结果待核对；禁止自动重发。');
            }
            if (!result.ok()) throw new Error('HTTP response could not confirm submission');
            const body = parseDouyinResponse(await result.text());
            if (Number(body.status_code) !== 0)
              throw new PlatformError(
                '抖音未接受这条评论；请检查网页提示，不自动重试。',
                'rejected',
              );
            const receiptId = numericId(body.comment?.cid);
            this.detail = '抖音已返回评论编号；尚未核验访客可见性。';
            return { receiptId, transport: 'browser' };
          } catch (e) {
            if (submitted && !(e instanceof PlatformError))
              throw new Error('抖音发送结果不明；请核对原记录，禁止自动重发。');
            throw e;
          } finally {
            this.allowedRequest = undefined;
            await p.unroute(PUBLISH_ROUTE, allow);
          }
        },
        signal,
        false,
        45000,
        'send',
      );
    } catch (e) {
      if (
        !sendClicked &&
        !(e instanceof PlatformError && ['auth', 'rejected', 'invalid'].includes(e.kind))
      )
        throw new PlatformError(
          '尚未点击发送：' + stage + '未完成，请稍后重新读取该楼层。',
          'rejected',
        );
      throw e;
    }
  }
  async findOwnComment(
    target: CommentTarget,
    text: string,
    accountId: string,
    signal?: AbortSignal,
  ) {
    if (target.root !== '0' || !validSecUid(accountId)) return undefined;
    const page = await this.comments(target, 1, signal);
    const matching = page.items.filter(
      (c) =>
        c.authorId === accountId &&
        c.text.trim() === text.trim() &&
        c.target.oid === target.oid &&
        c.target.root === c.id,
    );
    return matching.length === 1 ? matching[0].id : undefined;
  }
  async checkVisibility(): Promise<VisibilityReport> {
    return {
      status: 'unconfirmed',
      checkedAt: new Date().toISOString(),
      detail: '本版尚未验证抖音访客可见性；收到评论编号不代表别人已看到，不自动重发。',
    };
  }
  async clearCache() {
    return this.serial(async () => {
      if (this.loginOpen || !this.context) {
        this.clearCachePending = true;
        return { detail: '抖音网络缓存将在下次普通访问时清理；登录资料保留。' };
      }
      await clearNetworkCache(this.context);
      this.lastCacheClear = Date.now();
      this.clearCachePending = false;
      return { detail: '抖音网络缓存已清理；登录资料保留。' };
    });
  }
  async stop() {
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.context?.close().catch(() => {});
    await this.queue;
    this.loginOpen = false;
  }
}

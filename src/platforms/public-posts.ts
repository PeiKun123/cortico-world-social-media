import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type BrowserContext, type Page, type Request, type Response } from 'playwright-core';
import { findBrowserExecutable } from './bilibili-browser.ts';

import { PlatformError, type Account, type CommentTarget, type PublicComment, type SendReceipt, type SocialPlatform, type Video } from '../platform.ts';
import { POST_ORIGINS, PUBLIC_POST_NAMES, PUBLIC_POST_TYPES, profileId, profileUrl, tiebaForumUrl, type PublicPostPlatform } from '../public-post-policy.ts';
export { isPublicPostPlatform, PUBLIC_POST_NAMES, type PublicPostPlatform } from '../public-post-policy.ts';

interface PublicPageOptions {
  media?: boolean;
  checkConnection?: boolean;
  reuseLogin?: boolean;
  showWorkWindow?: boolean;
  allowWrite?: (request: Request) => boolean;
  readNote?: () => { id: string; ownerId: string } | undefined;
}
const PUBLIC_POST_LOGIN_URLS = {
  tieba: 'https://tieba.baidu.com/',
  xiaohongshu: 'https://www.xiaohongshu.com/login',
} as const;

function publicBrowserExecutable() {
  const installs = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA];
  if (process.platform === 'win32') {
    for (const directory of installs) {
      if (!directory) continue;
      const executable = findBrowserExecutable(join(directory, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      if (executable) return executable;
    }
  }
  return findBrowserExecutable();
}

export function publicPostUrl(platform: PublicPostPlatform, input: string) {
  const url = URL.parse(input);
  const spec = platform === 'tieba'
    ? { host: 'tieba.baidu.com', path: /^\/p\/\d+\/?$/ }
    : { host: 'www.xiaohongshu.com', path: /^\/(?:explore|discovery\/item|user\/profile\/[a-f0-9]{24})\/[a-f0-9]{24}\/?$/i };
  if (!url || url.origin !== 'https://' + spec.host || url.username || url.password || !spec.path.test(url.pathname))
    throw Error('请在官网打开' + PUBLIC_POST_NAMES[platform] + '原帖，再复制地址栏里的完整链接。');
  url.hash = '';
  if (platform === 'tieba') url.search = '';
  return url;
}
export class PublicPostBrowser {
  private readonly reading = new Set<PublicPostPlatform>();
  private readonly blocked = new Map<PublicPostPlatform, PlatformError>();
  private restrictedNote?: { id: string; ownerId: string };
  recoveryNote(platform: PublicPostPlatform) { return platform === 'xiaohongshu' && this.restrictedNote ? { ...this.restrictedNote } : undefined; }
  private readonly loginWindows = new Map<PublicPostPlatform, BrowserContext>();
  constructor(private readonly profileRoot: string) {}

  loginOpen(platform: PublicPostPlatform) { return this.loginWindows.has(platform); }
  paused(platform: PublicPostPlatform) { return this.blocked.get(platform)?.message; }

  private async launch(platform: PublicPostPlatform, headless: boolean, manualLogin = false) {
    const executablePath = publicBrowserExecutable();
    if (!executablePath) throw Error('未找到 Microsoft Edge 或 Chrome。');
    return chromium.launchPersistentContext(join(this.profileRoot, platform), {
      executablePath, headless, chromiumSandbox: true, timeout: 15000,
      ...(!manualLogin ? { serviceWorkers: 'block' as const } : {}),
      locale: 'zh-CN', args: ['--disable-notifications', '--disable-background-mode'],
    }).catch(() => {
      throw Error(PUBLIC_POST_NAMES[platform] + '专用 Edge 启动失败，请检查是否还有旧版的专用窗口打开。');
    });
  }

  async openLogin(platform: PublicPostPlatform, signal?: AbortSignal) {
    if (this.reading.has(platform)) throw Error(PUBLIC_POST_NAMES[platform] + '正在读取，请稍后再试。');
    const existing = this.loginWindows.get(platform);
    if (existing) {
      await (existing.pages().at(-1) ?? await existing.newPage()).bringToFront();
      return;
    }
    this.reading.add(platform);
    let context: BrowserContext | undefined;
    try {
      context = await this.launch(platform, false, true);
      signal?.throwIfAborted();
      this.loginWindows.set(platform, context);
      context.once('close', () => {
        if (this.loginWindows.get(platform) === context) this.loginWindows.delete(platform);
      });
      const page = context.pages()[0] ?? await context.newPage();
      const note = this.recoveryNote(platform);
      await page.goto(note ? profileUrl(platform, note.ownerId).href : PUBLIC_POST_LOGIN_URLS[platform], { waitUntil: 'domcontentloaded', timeout: 16000 });
      await page.bringToFront();
    } catch (error) {
      if (signal?.aborted) await context?.close().catch(() => {});
      if (context && !signal?.aborted) throw Error('专用 Edge 已打开，但官网没有及时加载，请在窗口中检查网页。');
      throw error;
    } finally { this.reading.delete(platform); }
  }

  async closeLogin(platform: PublicPostPlatform) {
    await this.loginWindows.get(platform)?.close().catch(() => {});
  }

  async close() {
    await Promise.all([...this.loginWindows.keys()].map(platform => this.closeLogin(platform)));
  }

  async withPublicPage<T>(platform: PublicPostPlatform, signal: AbortSignal, run: (page: Page) => Promise<T>, options: PublicPageOptions = {}) {
    signal.throwIfAborted();
    // A background read may briefly own the same profile. Wait only before a new
    // operation opens its browser, then recheck the login and restriction state.
    if (platform === 'xiaohongshu' && options.allowWrite && this.reading.has(platform)) {
      const until = Date.now() + 8000;
      while (this.reading.has(platform) && !this.blocked.has(platform) &&
             !this.loginWindows.has(platform) && Date.now() < until) {
        await delay(200, undefined, { signal });
      }
      signal.throwIfAborted();
    }
    const login = this.loginWindows.get(platform);
    if (login && !options.reuseLogin)
      throw Error(PUBLIC_POST_NAMES[platform] + '专用窗口等待核对账号，请先完成绑定或关闭专用窗口。');
    const blocked = this.blocked.get(platform);
    if (blocked && !options.checkConnection) throw new PlatformError('已沿用上次的暂停记录，本次未访问官网。' + blocked.message, blocked.kind);
    if (this.reading.has(platform)) throw Error(PUBLIC_POST_NAMES[platform] + '正在读取，请稍后再试。');
    this.reading.add(platform);
    let context: BrowserContext | undefined = login;
    let verified = false;
    const abort = () => { if (!login) void context?.close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      context ??= await this.launch(platform, !options.showWorkWindow);
      signal.throwIfAborted();
      if (!login) await context.route('**/*', route => {
        const request = route.request();
        const address = new URL(request.url());
        let tiebaRead = false;
        if (platform === 'tieba' && request.method() === 'POST' && request.resourceType() === 'xhr' && address.origin === POST_ORIGINS.tieba) {
          const frame = URL.parse(request.frame().url());
          if (frame?.origin === POST_ORIGINS.tieba) {
            tiebaRead = address.pathname === '/c/f/pb/page_pc' && /^\/p\/\d+\/?$/.test(frame.pathname);
            // The forum UI loads its header and thread cards in parallel, with the same encoded bar name.
            if (['/c/f/frs/frsBottom_pc', '/c/f/frs/page_pc'].includes(address.pathname) && frame.pathname === '/f') {
              const forum = frame.searchParams.get('kw');
              try {
                const posted = request.postDataJSON()?.kw;
                tiebaRead = Boolean(forum && typeof posted === 'string' &&
                  (posted === forum || decodeURIComponent(posted) === forum));
              } catch { /* unrelated request */ }
            }
          }
        }
        let noteRead = false;
        const noteId = options.readNote?.()?.id;
        if (platform === 'xiaohongshu' && noteId && request.method() === 'POST' &&
            address.origin === 'https://edith.xiaohongshu.com' && address.pathname === '/api/sns/web/v1/feed') {
          try { noteRead = request.postDataJSON()?.source_note_id === noteId; } catch { /* unrelated request */ }
        }
        if (!tiebaRead && !noteRead && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !options.allowWrite?.(request)) return route.abort();
        if (request.resourceType() === 'font' || (!options.media && ['media', 'image'].includes(request.resourceType()))) return route.abort();
        if (address.protocol !== 'https:' || address.port || address.username || address.password) return route.abort();
        const site = platform === 'tieba' ? /(?:^|\.)(?:baidu\.com|bdstatic\.com|baidubce\.com)$/i : /(?:^|\.)(?:xiaohongshu\.com|xhscdn\.com|rednote\.com)$/i;
        const tiebaFrontend = platform === 'tieba' && request.method() === 'GET' &&
          request.resourceType() === 'script' && address.hostname === 'banti-static.cdn.bcebos.com';
        if (!site.test(address.hostname) && !tiebaFrontend) return route.abort();
        if (request.isNavigationRequest() && !['tieba.baidu.com', 'passport.baidu.com', 'wappass.baidu.com', 'www.xiaohongshu.com', 'www.rednote.com'].includes(address.hostname)) return route.abort();
        return route.continue();
      });
      const openPages = context.pages();
      const page = login
        ? openPages.find(tab => profileId(platform, tab.url())) ??
          openPages.find(tab => URL.parse(tab.url())?.origin === POST_ORIGINS[platform]) ?? openPages.at(-1)
        : openPages[0];
      const result = await run(page ?? await context.newPage());
      signal.throwIfAborted();
      verified = true;
      if (options.checkConnection) {
        const pending = this.recoveryNote(platform), checked = options.readNote?.();
        if (!pending || (checked?.id === pending.id && checked.ownerId === pending.ownerId)) {
          this.blocked.delete(platform);
          if (platform === 'xiaohongshu') this.restrictedNote = undefined;
        }
      }
      return result;
    } catch (error) {
      if (error instanceof PlatformError && ['auth', 'rate'].includes(error.kind)) {
        this.blocked.set(platform, error);
        const note = options.readNote?.();
        if (platform === 'xiaohongshu' && note) this.restrictedNote = { ...note };
      }
      if (signal.aborted) throw Error('本次读取已取消。');
      if (error instanceof Error && !/^(?:page|locator|browserContext)\./.test(error.message)) throw error;
      const action = error instanceof Error ? error.message.match(/^(page|locator|browserContext)\.([A-Za-z]+)/)?.[2] : undefined;
      const stage = action === 'goto' ? '打开官网页面' : action === 'fill' ? '填写评论' : action === 'click' ? '点击网页控件' : '操作官网页面';
      throw Error(stage + '失败或超时，请检查专用窗口中的页面状态。');
    } finally {
      signal.removeEventListener('abort', abort);
      if (!login || verified) await context?.close().catch(() => {});
      this.reading.delete(platform);
    }
  }

  async read(platform: PublicPostPlatform, input: string, signal: AbortSignal, latestReplies = false) {
    const url = publicPostUrl(platform, input);
    return this.withPublicPage(platform, signal, async page => {
      const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 18000 });
      await verifyPublicPage(page, response?.status(), url);
      const ui = POST_UI[platform];
      const postSelector = ui.content;
      await page.locator(postSelector).first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
      signal.throwIfAborted();
      await verifyPublicPage(page, response?.status(), url);
      const title = (await page.locator(ui.title)
        .first().textContent({ timeout: 1500 }).catch(() => ''))?.trim().slice(0, 160) || (await page.title()).slice(0, 160);
      const texts = await page.locator(postSelector).filter({ visible: true }).evaluateAll(nodes =>
        nodes.slice(0, 9).map(node => (node as HTMLElement).innerText.trim().slice(0, 700)));
      const titleOnlyTieba = platform === 'tieba' && (await page.locator('.image-text .pb-title, .core_title_txt')
        .filter({ visible: true }).count()) === 1;
      if (!texts[0] && !titleOnlyTieba) {
        await checkAccessNotice(page);
        throw Error('官网没有展示可识别的原帖正文，可能已删除或页面结构有变化。');
      }
      const newest = latestReplies && platform === 'tieba' && await newestTiebaComments(page, url.pathname.split('/').at(-1)!);
      const modernTieba = page.locator('.pb-comment-item[data-id] > .comment-content .pb-rich-text');
      const comments = platform === 'tieba' && !await modernTieba.count() ? texts.slice(1) :
        await (platform === 'tieba' ? modernTieba : page.locator('.comments-container .comment-item .content'))
          .filter({ visible: true }).evaluateAll(nodes =>
            nodes.slice(0, 8).map(node => (node as HTMLElement).innerText.trim().slice(0, 500)));
      return { title, text: texts[0] || '此帖没有额外的正文文字。', comments: comments.filter(Boolean), url: url.origin + url.pathname,
        detail: comments.some(Boolean)
          ? newest ? '按官网倒序读取最新楼层。' : '读取首屏公开内容；未加载隐藏或更多回复。'
          : '当前公开页面未展示可读评论。', latestReplies: newest, externalContent: true };
    });
  }
}

async function verifyPublicPage(page: import('playwright-core').Page, status: number | undefined, expected: URL) {
  const current = new URL(page.url());
  if (current.hostname === 'www.xiaohongshu.com' && current.pathname === '/website-login/error') {
    const notice = page.getByText(/安全限制|检测到异常访问/).first();
    if (/安全限制/.test(await page.title()) || await notice.waitFor({ state: 'visible', timeout: 1800 }).then(() => true, () => false))
      throw new PlatformError('小红书提示「安全限制」，本次访问已暂停。请在专用窗口查看官网提示；若只提供反馈入口，请等待平台解除限制。', 'rate');
  }
  if (/login|passport/i.test(current.hostname + current.pathname)) throw new PlatformError('平台要求登录。请在配置页打开该平台的专用登录窗口。', 'auth');
  if (/captcha|verify|security/i.test(current.pathname) || /安全验证|人机验证/.test(await page.title()))
    throw new PlatformError('平台要求人工验证。请在专用登录窗口处理，完成后关闭窗口再试。', 'auth');
  if (status && status >= 400) throw new PlatformError('平台返回 HTTP ' + status + '，当前无法读取。', status === 429 ? 'rate' : 'network');
  if (current.origin === expected.origin && current.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, '')) return;
  if (current.origin === POST_ORIGINS.xiaohongshu && expected.origin === current.origin) {
    try {
      const from = publicPostUrl('xiaohongshu', expected.href);
      const to = publicPostUrl('xiaohongshu', current.href);
      if (from.pathname.split('/').filter(Boolean).at(-1) === to.pathname.split('/').filter(Boolean).at(-1)) return;
    } catch { /* A generic page redirect is not evidence of the same work. */ }
  }
  throw Error('官网跳离了指定页面，可能需要登录或完整原帖链接。');
}
async function checkAccessNotice(page: import('playwright-core').Page) {
  const visible = (await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')).slice(0, 4000);
  if (/安全验证|请完成验证|访问异常/.test(visible))
    throw new PlatformError('平台要求人工验证。请在专用登录窗口处理，完成后关闭窗口再试。', 'auth');
  if (/登录后查看|请先登录|登录后继续|登录后搜索/.test(visible))
    throw new PlatformError('平台要求登录。请在配置页打开该平台的专用登录窗口。', 'auth');
}

function tiebaReadResponse(page: Page, path: string, matches: (data: Record<string, unknown>) => boolean) {
  return page.waitForResponse(response => {
    const url = new URL(response.url());
    if (url.origin !== POST_ORIGINS.tieba || url.pathname !== path || !response.ok()) return false;
    try { return matches(response.request().postDataJSON() ?? {}); } catch { return false; }
  }, { timeout: 9500 }).catch(() => undefined);
}

async function tiebaPayload(response: Response | undefined) {
  const raw = await response?.json().catch(() => undefined);
  return raw?.data ?? raw;
}

async function newestTiebaComments(page: Page, oid: string) {
  const newest = page.locator('.sub-tab-item').filter({ hasText: /^\s*倒序\s*$/, visible: true });
  await newest.first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  if (await newest.count() !== 1) return false;
  const active = newest.and(page.locator('.sub-tab-item-active'));
  if (await active.count() === 1) return true;
  const pending = tiebaReadResponse(page, '/c/f/pb/page_pc', data => String(data.kz) === oid && String(data.r) === '1');
  await newest.click({ timeout: 2800 });
  const data = await tiebaPayload(await pending);
  if (Number(data?.error_code) !== 0 || String(data?.thread?.id) !== oid || !Array.isArray(data.post_list)) return false;
  if (!data.post_list.length) return await active.count() === 1;
  const latestId = String(data.post_list[0]?.id);
  if (!/^\d+$/.test(latestId)) return false;
  const rendered = await page.waitForFunction(id =>
    document.querySelector('.pb-comment-item[data-id]')?.getAttribute('data-id') === id,
  latestId, { timeout: 3000 }).then(() => true, () => false);
  return rendered && await active.count() === 1;
}

const POST_UI = {
  tieba: {
    home: '/',
    links: 'a[href^="/p/"], a[href^="https://tieba.baidu.com/p/"]',
    self: '#com_userbar a[href*="/home/main"], #head a[href*="/home/main"], nav a[aria-label="个人主页"]',
    content: '.image-text .pb-content-wrap, .d_post_content',
    title: '.image-text .pb-title, .core_title_txt, h1',
    comments: '.pb-comment-item[data-id], .l_post[data-field]',
    commentText: '.pb-comment-item > .comment-content .pb-rich-text, .d_post_content',
    commentImages: '.pb-comment-item > .comment-content .pb-rich-text img:not(.emoji-img), .d_post_content img.BDE_Image, .d_post_content img[data-src], .d_post_content img[src*="/forum/"], .d_post_content img[src*="/pic/item/"]',
    author: 'a.head-name[href*="/home/main"], a.p_author_name[href], .d_author a[href*="/home/main"]',
    media: '.image-text .pb-content-wrap img:not(.emoji-img), .l_post:first-of-type .d_post_content img',
    video: '.image-text .pb-content-wrap video, .l_post:first-of-type .d_post_content video',
  },
  xiaohongshu: {
    home: '/explore',
    links: 'a[href^="/explore/"], a[href^="/discovery/item/"], a[href^="https://www.xiaohongshu.com/explore/"], a[href^="/user/profile/"], a[href^="https://www.xiaohongshu.com/user/profile/"]',
    self: 'aside a[href*="/user/profile/"], #userSideBar a[href*="/user/profile/"], nav a[aria-label="我的主页"], .side-bar a[href*="/user/profile/"]',
    content: '#detail-desc, .note-content .desc',
    title: '#detail-title, h1',
    comments: '.comments-container .comment-item[id], .comments-container .comment-item[data-id]',
    commentText: '.content',
    commentImages: '.comment-image img, img.comment-image, .comment-image-container img, .comment-images img, .comment-pictures img, .comment-image-list img, .content img[data-src]',
    author: 'a[href*="/user/profile/"]',
    media: '.media-container .swiper-slide img, .note-detail-mask .swiper-slide img, .img-container .swiper-slide img',
    video: '.note-container video',
  },
} as const;

function publicPostId(platform: PublicPostPlatform, value: string) {
  const valid = platform === 'tieba' ? /^[1-9][0-9]{0,21}$/ : /^[a-f0-9]{24}$/i;
  if (!valid.test(value)) throw new PlatformError('作品编号无效，请使用官网读取结果。');
  return value;
}

function defaultSignal(signal?: AbortSignal) {
  return signal ?? AbortSignal.timeout(35000);
}

class PostPageRoutes {
  private readonly addresses = new Map<string, URL>();
  constructor(private readonly platform: PublicPostPlatform) {}
  remember(href: string) {
    const url = publicPostUrl(this.platform, href);
    const id = publicPostId(this.platform, url.pathname.split('/').filter(Boolean).at(-1)!);
    if (!this.addresses.has(id) || url.search) this.addresses.set(id, url);
    if (this.addresses.size > 150) this.addresses.delete(this.addresses.keys().next().value!);
    return { id, url: url.origin + url.pathname };
  }
  get(id: string) {
    return this.addresses.get(id) ??
      new URL((this.platform === 'tieba' ? '/p/' : '/explore/') + id, POST_ORIGINS[this.platform]);
  }
}

export class PublicPostAdapter implements SocialPlatform {
  private readonly paths: PostPageRoutes;
  private readonly profiles = new Map<string, URL>();
  constructor(readonly id: PublicPostPlatform, private readonly browser: PublicPostBrowser) {
    this.paths = new PostPageRoutes(id);
  }

  private get ui() { return POST_UI[this.id]; }
  private get origin() { return POST_ORIGINS[this.id]; }
  private get type() { return PUBLIC_POST_TYPES[this.id]; }

  validRecipientId(value: string) {
    return value === value.trim() && profileId(this.id, profileUrl(this.id, value).href)?.id === value;
  }

  normalizeTarget(value: unknown): CommentTarget {
    if (!value || typeof value !== 'object') throw new PlatformError('缺少评论目标。');
    const { oid, type, root, parent } = value as Partial<CommentTarget>;
    const commentId = this.id === 'tieba' ? /^(?:0|[1-9][0-9]{0,21})$/ : /^(?:0|[a-f0-9]{24})$/i;
    if (type !== this.type || typeof oid !== 'string' || typeof root !== 'string' ||
      typeof parent !== 'string' || !commentId.test(root) || !commentId.test(parent) ||
      (root === '0') !== (parent === '0'))
      throw new PlatformError('目标与当前平台不匹配，请使用原楼层的 target。');
    return { oid: publicPostId(this.id, oid), type, root, parent };
  }

  async account(signal?: AbortSignal) {
    return this.run(new URL(this.ui.home, this.origin), signal, page => this.accountOnPage(page, true), { media: true });
  }

  async reconnect(signal?: AbortSignal) {
    const pending = this.browser.recoveryNote(this.id);
    const account = await this.checkLogin(signal);
    if (pending) {
      await this.run(profileUrl(this.id, pending.ownerId), signal, async page => {
        await this.openOwnerNote(page, pending.id);
        const work = await this.readPost(page, pending.id);
        if (work.ownerId !== pending.ownerId || (await this.accountForReply(page)).id !== account.id)
          throw new PlatformError('当前笔记或账号与复查目标不符，保留暂停。', 'auth');
        await checkAccessNotice(page);
        await page.locator('.engage-bar .input-box, #content-textarea, .comment-input [contenteditable="true"]').filter({ visible: true }).first().waitFor({ timeout: 5000 });
      }, { checkConnection: true, media: true, showWorkWindow: true, readNote: () => pending });
    }
    return account;
  }

  private async checkLogin(signal?: AbortSignal) {
    if (this.browser.loginOpen(this.id)) {
      return this.browser.withPublicPage(this.id, defaultSignal(signal), async page => {
        const current = URL.parse(page.url());
        if (current?.origin !== this.origin || /login|passport|captcha|verify|security/i.test(current.pathname)) {
          if (current?.origin === this.origin) await checkAccessNotice(page);
          throw new PlatformError('专用窗口尚未回到官网首页或个人主页，请先完成登录或人工验证。', 'auth');
        }
        return this.accountOnPage(page, true);
      }, { checkConnection: true, reuseLogin: true });
    }
    return this.run(new URL(this.ui.home, this.origin), signal, page => this.accountOnPage(page, true), { checkConnection: true, media: true });
  }

  private async ownLinks(page: Page) {
    const selfPath = this.id === 'tieba' ? '/home/main' : '/user/profile/';
    const ownLabel = /^(?:我|我的|我的主页|个人主页|我的贴吧)$/u;
    const navigation = page.locator('header, aside, nav, [role="navigation"], #head, #com_userbar, #userSideBar, .side-bar, .sidebar');
    const named = navigation.getByRole('link', { name: ownLabel }).and(page.locator('a[href*="' + selfPath + '"]'));
    const self = page.locator(this.ui.self).or(named).filter({ visible: true });
    await self.first().waitFor({ timeout: 2000 }).catch(() => {});
    const profiles = new Map<string, Account>();
    const links = await self.evaluateAll(nodes => nodes.map(el => ({
      href: (el as HTMLAnchorElement).href, label: (el.textContent || '').trim(),
    })));
    for (const row of links) {
      const parsed = row.href && profileId(this.id, row.href);
      if (parsed) profiles.set(parsed.id, { id: parsed.id, name: row.label.slice(0, 80) || parsed.id });
    }
    return profiles;
  }

  private async tiebaProfileFromMenu(page: Page): Promise<Account | undefined> {
    const header = page.locator('header, #com_userbar, #head, [class*="header" i], [class*="navbar" i]');
    const currentAvatar = page.locator('.user-or-login img.user-avatar').filter({ visible: true });
    await currentAvatar.first().waitFor({ state: 'visible', timeout: 2200 }).catch(() => {});
    const avatar = await currentAvatar.count() === 1 ? currentAvatar :
      header.locator('img[class*="avatar" i], [class*="avatar" i] img, img[src*="/sys/portrait/"]').filter({ visible: true });
    const entry = page.getByRole('listitem').filter({ hasText: /^\s*个人主页\s*$/u }).filter({ visible: true });
    if (!(await entry.count())) {
      if (await avatar.count() !== 1) return;
      await avatar.hover({ timeout: 1500 }).catch(() => {});
      await entry.first().waitFor({ state: 'visible', timeout: 1200 }).catch(() => {});
      if (!await entry.count()) {
        await avatar.click({ timeout: 1500 }).catch(() => {});
        await entry.first().waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
      }
    }
    if (await entry.count() !== 1) return;
    const links = await this.ownLinks(page);
    if (links.size) return links.size === 1 ? links.values().next().value : undefined;
    const isProfile = (url: URL) => Boolean(profileId('tieba', url.href));
    const opened = Promise.any([
      page.waitForURL(isProfile, { waitUntil: 'commit', timeout: 10000 }).then(() => page),
      page.waitForEvent('popup', { timeout: 10000 }).then(async popup => {
        await popup.waitForURL(isProfile, { waitUntil: 'commit', timeout: 10000 });
        return popup;
      }),
    ]).catch(() => undefined);
    await entry.click({ timeout: 1500 }).catch(() => {});
    const profilePage = await opened;
    if (!profilePage) return;
    const profile = profileId('tieba', profilePage.url());
    if (!profile) return;
    await checkAccessNotice(profilePage);
    const name = (await profilePage.locator('.userinfo_username, .user_name, h1')
      .filter({ visible: true }).first().textContent({ timeout: 1000 }).catch(() => ''))?.trim();
    return { id: profile.id, name: name?.slice(0, 80) || profile.id };
  }

  private async accountOnPage(page: Page, allowMenu = false): Promise<Account> {
    const profiles = await this.ownLinks(page);
    if (profiles.size === 1) return profiles.values().next().value!;
    await checkAccessNotice(page);
    const ownProfile = allowMenu ? profileId(this.id, page.url()) : undefined;
    if (!profiles.size && ownProfile) {
      const editLabel = /^(?:编辑资料|编辑个人资料|编辑主页)$/u;
      const edit = page.getByRole('button', { name: editLabel }).or(page.getByRole('link', { name: editLabel })).filter({ visible: true });
      if (await edit.count() === 1) return { id: ownProfile.id, name: ownProfile.id };
    }
    if (!profiles.size && allowMenu && this.id === 'tieba') {
      const profile = await this.tiebaProfileFromMenu(page);
      if (profile) return profile;
    }
    throw new PlatformError(profiles.size > 1
      ? '官网展示了多个个人主页，无法唯一核对当前账号。'
      : '后台网页未显示可核对的个人主页。若专用窗口已登录，可能是官网入口调整或后台加载不完整。', 'auth');
  }

  get paused() { return this.browser.paused(this.id); }

  private async run<T>(
    url: URL, signal: AbortSignal | undefined, read: (page: Page) => Promise<T>,
    options?: PublicPageOptions,
  ) {
    const abort = defaultSignal(signal);
    return this.browser.withPublicPage(this.id, abort, async page => {
      const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 16000 });
      await verifyPublicPage(page, response?.status(), url);
      abort.throwIfAborted();
      return read(page);
    }, options);
  }

  private async listed(page: Page, limit: number) {
    const links = page.locator(this.ui.links).filter({ visible: true });
    await links.first().waitFor({ timeout: 5000 }).catch(() => {});
    const entries = await links.evaluateAll(nodes => nodes.slice(0, 140).map(el => ({
      href: (el as HTMLAnchorElement).href,
      title: (el.textContent || el.querySelector('img')?.alt || '').trim().slice(0, 160),
    })));
    const results = new Map<string, { id: string; aid: string; title: string; url: string }>();
    for (const entry of entries) {
      try {
        const route = this.paths.remember(entry.href);
        const old = results.get(route.id);
        if (!old || (!old.title && entry.title)) results.set(route.id, { ...route, aid: route.id, title: entry.title });
      } catch { /* Only exact post addresses from the active platform. */ }
    }
    if (!results.size) await checkAccessNotice(page);
    return [...results.values()].slice(0, limit);
  }

  private async tiebaRows(page: Page, mode: 'search' | 'forum' | 'feed') {
    const selector = mode === 'search'
      ? '.thread-content-box:has(.search-action-bar), .s_post'
      : mode === 'forum'
        ? '.frs-feed-list a.thread-content-link, #thread_list .threadlist_title a.j_th_tit'
        : 'a.thread-content-link, #thread_list .threadlist_title a.j_th_tit';
    const rows = page.locator(selector).filter({ visible: true });
    await rows.first().waitFor({ timeout: 7000 }).catch(() => {});
    const entries = await rows.evaluateAll(nodes => nodes.slice(0, 60).map(row => {
      const anchor = row instanceof HTMLAnchorElement
        ? row : row.querySelector<HTMLAnchorElement>('.search-action-bar a.action-link-bg[href], .p_title a.bluelink[href]');
      const title = row.querySelector('.title-wrap, .thread-title, .p_title a.bluelink')?.textContent ||
        (row instanceof HTMLAnchorElement && row.matches('.j_th_tit') ? row.textContent : '');
      return {
        href: anchor?.href,
        title: title?.trim().slice(0, 160),
        snippet: row.querySelector('.abstract-wrap, .p_content')?.textContent?.trim().slice(0, 200),
        forum: row.querySelector('.forum-name-text')?.textContent?.trim().slice(0, 60),
        replies: row.closest('.thread-card, .j_thread_list')?.querySelector('.comment-link-zone, .threadlist_rep_num')?.textContent?.trim(),
      };
    }));
    const ids = new Set<string>();
    const items = entries.flatMap(row => {
      if (!row.href || !row.title) return [];
      try {
        const route = this.paths.remember(row.href);
        if (ids.has(route.id)) return [];
        ids.add(route.id);
        return [{ ...route, aid: route.id, title: row.title, snippet: row.snippet, forum: row.forum,
          replies: /^\d+$/.test(row.replies ?? '') ? Number(row.replies) : undefined }];
      } catch { return []; }
    });
    if (!items.length) await checkAccessNotice(page);
    return items;
  }

  async search(query: string, page: number, signal?: AbortSignal) {
    if (page !== 1) throw new PlatformError('当前平台支持读取官网搜索首屏。');
    const search = new URL(this.id === 'tieba' ? '/f/search/res' : '/search_result', this.origin);
    if (this.id !== 'tieba') {
      search.searchParams.set('keyword', query);
      const items = await this.run(search, signal, tab => this.listed(tab, 8));
      return { items, externalContent: true, detail: items.length ? '官网搜索首屏。' : '官网当前未展示可识别结果。' };
    }
    search.searchParams.set('ie', 'utf-8');
    search.searchParams.set('qw', query);
    const items = await this.run(search, signal, async tab => {
      if (new URL(tab.url()).searchParams.get('qw') !== query)
        throw new PlatformError('贴吧跳转到了不同的搜索词。', 'network');
      const rows = await this.tiebaRows(tab, 'search');
      const clean = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
      const phrase = clean(query);
      const terms = query.split(/\s+/).map(clean).filter(Boolean);
      const score = (row: typeof rows[number]) => {
        const title = clean(row.title);
        const evidence = title + clean(row.snippet ?? '') + clean(row.forum ?? '');
        return (phrase && title.includes(phrase) ? 4 : 0) +
          (phrase && evidence.includes(phrase) ? 2 : 0) +
          (terms.length > 1 && terms.every(term => evidence.includes(term)) ? 1 : 0);
      };
      return rows.map(row => ({ row, score: score(row) }))
        .filter(candidate => candidate.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8).map(candidate => candidate.row);
    });
    return { items, externalContent: true, detail: items.length ? '贴吧搜索首屏，仅保留标题、摘要或吧名与检索词相符的结果。' : '贴吧搜索首屏没有可核对的相关帖子，可换一个更短的关键词。' };
  }

  private async withLatestForum<T>(input: string, signal: AbortSignal | undefined,
    work: (page: Page, forum: string, items: Awaited<ReturnType<PublicPostAdapter['tiebaRows']>>) => Promise<T>) {
    if (this.id !== 'tieba') throw new PlatformError('指定吧名仅适用于百度贴吧。');
    const { name, url } = tiebaForumUrl(input);
    url.searchParams.set('tab', '503');
    return this.browser.withPublicPage('tieba', defaultSignal(signal), async page => {
      const latest = tiebaReadResponse(page, '/c/f/frs/page_pc', data => String(data.tab_id) === '503' &&
        typeof data.kw === 'string' && (data.kw === name || decodeURIComponent(data.kw) === name));
      const opened = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 16000 });
      await verifyPublicPage(page, opened?.status(), url);
      const heading = await page.locator('.frs-search-tag-wraper .forum-name, .card_title_fname')
        .filter({ visible: true }).first().textContent({ timeout: 7000 }).catch(() => '');
      if (new URL(page.url()).searchParams.get('kw') !== name ||
          ![name, name + '吧'].includes((heading ?? '').trim()))
        throw new PlatformError('官网未显示「' + name + '」的吧首页。', 'network');
      const active = page.locator('.frs-bar .tab-item.active').filter({ hasText: /^\s*最新\s*$/, visible: true });
      const selected = await active.first().waitFor({ timeout: 5000 }).then(() => true, () => false);
      const data = await tiebaPayload(await latest);
      if (!selected || Number(data?.error_code) !== 0)
        throw new PlatformError('官网「最新」列表暂未加载。', 'network');
      // The virtual list displays a different slice from the IDs returned for the next batch.
      return work(page, name, await this.tiebaRows(page, 'forum'));
    }, { media: true });
  }

  async latestForum(input: string, signal?: AbortSignal) {
    return this.withLatestForum(input, signal, async (_page, forum, items) => ({
      forum: forum + '吧', items: items.slice(0, 8), externalContent: true,
    }));
  }

  async nextVideo(seen: string[], signal?: AbortSignal, forum?: string) {
    const readNext = async (page: Page, latest?: Awaited<ReturnType<PublicPostAdapter['tiebaRows']>>) => {
      const list = (limit: number) => this.id === 'tieba' ? this.tiebaRows(page, 'feed') : this.listed(page, limit);
      const unseen = (latest ?? await list(40)).filter(item => !seen.includes(item.id));
      if (latest) unseen.sort((a, b) => Number('replies' in b && Boolean(b.replies)) - Number('replies' in a && Boolean(a.replies)));
      if (!latest && !unseen.length) {
        const count = await page.locator(this.ui.links).count();
        await page.mouse.wheel(0, 900);
        await page.waitForFunction(({ selector, count }) => document.querySelectorAll(selector).length > count,
          { selector: this.ui.links, count }, { timeout: 3000 }).catch(() => {});
        unseen.push(...(await list(80)).filter(item => !seen.includes(item.id)));
      }
      if (!unseen.length) throw new PlatformError(latest ? '这个吧的最新列表没有本轮可继续读取的帖子。' : '当前推荐页没有可读取的新作品，可尝试按兴趣搜索。');
      let failure: unknown;
      for (const candidate of unseen.slice(0, 3)) {
        try {
          const url = this.paths.get(candidate.id);
          const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 9000 });
          await verifyPublicPage(page, response?.status(), url);
          return await this.readPost(page, candidate.id);
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof PlatformError && ['auth', 'rate'].includes(error.kind)) throw error;
          failure = error;
        }
      }
      throw failure instanceof Error ? failure : new PlatformError('当前推荐没有可读取的内容。');
    };
    return forum === undefined
      ? this.run(new URL(this.ui.home, this.origin), signal, page => readNext(page), { media: true })
      : this.withLatestForum(forum, signal, (page, _name, items) => readNext(page, items));
  }

  readOriginal(input: string, signal: AbortSignal, latestReplies = false) {
    const { id } = this.paths.remember(input);
    return this.browser.read(this.id, this.paths.get(id).href, signal, latestReplies);
  }

  async resolveCreator(input: string, signal?: AbortSignal): Promise<Account> {
    const profile = profileId(this.id, input, true);
    if (!profile) throw new PlatformError('请输入主人在官网的完整个人主页链接。');
    return this.run(profile.url, signal, async page => {
      if (profileId(this.id, page.url())?.id !== profile.id)
        throw new PlatformError('官网跳转到了不同的个人主页。');
      const label = page.locator(this.id === 'tieba' ? '.userinfo_username, .user_name, h1' : '.user-name, h1').filter({ visible: true });
      const name = (await label.first().textContent({ timeout: 6000 }).catch(() => ''))?.trim();
      if (!name) {
        await checkAccessNotice(page);
        throw new PlatformError('官网未显示可核实的个人主页，暂时无法绑定特别关注。');
      }
      this.profiles.set(profile.id, profile.url);
      if (this.profiles.size > 32) this.profiles.delete(this.profiles.keys().next().value!);
      return { id: profile.id, name: name.slice(0, 80) };
    });
  }

  private async openOwnerNote(page: Page, id: string) {
    const card = page.locator('a[href*="/' + id + '"]').filter({ visible: true }).first();
    const href = await card.getAttribute('href', { timeout: 7000 });
    if (!href || publicPostUrl(this.id, new URL(href, page.url()).href).pathname.split('/').filter(Boolean).at(-1) !== id)
      throw new PlatformError('主人主页未找到对应笔记。', 'rejected');
    // A server-rendered cover is already clickable before the site's note viewer is mounted.
    // Following its raw href at that point causes a different, full-document navigation.
    try {
      await page.waitForFunction(() => {
        const root = document.getElementById('app');
        return !root || Boolean((root as HTMLElement & { __vue_app__?: unknown }).__vue_app__);
      }, undefined, { timeout: 10000 });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
      await checkAccessNotice(page);
      throw new PlatformError('作者主页已显示封面，但笔记交互尚未就绪，未点击封面。', 'rejected');
    }
    await card.click({ timeout: 5000 });
    await page.waitForURL(u => u.pathname.split('/').filter(Boolean).at(-1) === id || u.pathname.startsWith('/website-login/'),
      { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
    await verifyPublicPage(page, undefined, this.paths.get(id));
  }

  async creatorVideos(ownerId: string, limit: number, signal?: AbortSignal) {
    let wantedNote: string | undefined;
    const url = this.profiles.get(ownerId) ?? profileUrl(this.id, ownerId);
    return this.run(url, signal, async page => {
      const identity = profileId(this.id, page.url());
      if (identity?.id !== ownerId) throw new PlatformError('官网个人主页与主人绑定不一致。');
      // Profile feeds can include collections, pinned posts or replies to other authors.
      // Confirm each original author before offering a focus opportunity.
      const items = await this.listed(page, limit);
      const verified = [];
      for (const item of items.slice(0, 3)) {
        try {
          if (this.id === 'xiaohongshu') {
            if (page.url() !== url.href) {
              const res = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 9000 });
              await verifyPublicPage(page, res?.status(), url);
            }
            wantedNote = item.id;
            await this.openOwnerNote(page, item.id);
          } else {
            const target = this.paths.get(item.id);
            const res = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 9000 });
            await verifyPublicPage(page, res?.status(), target);
          }
          const detail = await this.readPost(page, item.id);
          if (detail.ownerId === ownerId) verified.push(detail);
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof PlatformError && ['auth', 'rate'].includes(error.kind)) throw error;
        }
      }
      if (items.length && !verified.length) throw new PlatformError('已找到主人主页的作品列表，但还未核实其中的原作者。');
      return { items: verified };
    }, { media: true, readNote: () => wantedNote ? { id: wantedNote, ownerId } : undefined });
  }

  private async readPost(page: Page, id: string): Promise<Video> {
    const content = page.locator(this.ui.content).filter({ visible: true });
    const title = page.locator(this.ui.title).filter({ visible: true });
    const firstPost = this.id === 'tieba'
      ? page.locator('.image-text:has(.pb-title), .l_post[data-field]').first()
      : page.locator('.note-container, .note-detail-mask, .note-content').first();
    const description = (await content.first().innerText({ timeout: 3500 }).catch(() => '')).trim().slice(0, 1800);
    const name = (await title.first().innerText({ timeout: 2500 }).catch(() => '')).trim().slice(0, 160);
    const author = firstPost.locator(this.ui.author).first();
    const authorHref = await author.evaluate(el => (el as HTMLAnchorElement).href, undefined, { timeout: 1000 }).catch(() => '');
    const authorName = (await author.innerText({ timeout: 600 }).catch(() => '')).trim().slice(0, 80);
    const slider = page.locator('.note-container .media-container .swiper-slide[data-index]:not(.swiper-slide-duplicate)');
    if (this.id === 'xiaohongshu' && await slider.count()) {
      await page.locator('.note-container .media-container img, .note-container .media-container video')
        .first().waitFor({ state: 'attached', timeout: 4300 }).catch(() => {});
    }
    const video = page.locator(this.ui.video).filter({ visible: true });
    const hasVideoMarker = this.id === 'xiaohongshu' &&
      Boolean(await page.locator('meta[property="og:type"][content="video.other"], .note-container .media-container .player-container').count());
    if (hasVideoMarker) await video.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    const playerCount = await video.count();
    const hasVideo = hasVideoMarker || playerCount > 0;
    if (playerCount === 1) {
      await page.waitForFunction(selector => [...document.querySelectorAll<HTMLVideoElement>(selector)].some(el =>
        el.getClientRects().length && Number.isFinite(el.duration) && el.duration > 0), this.ui.video, { timeout: 3500 }).catch(() => {});
    }
    const durationSec = playerCount === 1
      ? await video.evaluate(el => { const d = (el as HTMLVideoElement).duration; return Number.isFinite(d) ? d : 0; }).catch(() => 0)
      : 0;
    const imageCount = this.id === 'xiaohongshu'
      ? (hasVideo ? 0 : (await slider.count()) || await page.locator(this.ui.media).count())
      : await page.locator(this.ui.media).count();
    if (!description && !imageCount && !hasVideo && !(this.id === 'tieba' && await firstPost.count() && name)) {
      await checkAccessNotice(page);
      throw new PlatformError('官网没有显示可核实的作品正文或画面。');
    }
    return {
      id, aid: id, cid: id, title: name || description.slice(0, 50) || PUBLIC_POST_NAMES[this.id] + '作品',
      description, author: authorName, ownerId: profileId(this.id, authorHref)?.id,
      kind: hasVideo ? 'video' : 'images', imageCount, durationSec,
      cover: '', url: this.paths.get(id).origin + this.paths.get(id).pathname, parts: [],
    };
  }

  async video(input: string, part: number, signal?: AbortSignal) {
    if (part !== 1) throw new PlatformError('帖子仅支持当前作品，无分集。');
    const id = input.includes('://') ? this.paths.remember(input).id : publicPostId(this.id, input);
    return this.run(this.paths.get(id), signal, page => this.readPost(page, id), { media: true });
  }

  async subtitles() {
    return { available: false, reason: '这两个平台尚无可核实的字幕。' };
  }

  async notifications() { return { items: [], done: true }; }

  private async rows(page: Page, oid: string, roots?: string[]): Promise<PublicComment[]> {
    const platform = this.id;
    const data = await page.locator(this.ui.comments).filter({ visible: true }).evaluateAll((nodes, ui) => (ui.roots ? nodes : nodes.slice(0, 30)).flatMap(el => {
      let field: {content?: {post_id?: string; post_no?: number; date?: string}} = {};
      try { field = JSON.parse(el.getAttribute('data-field') || '{}'); } catch { /* Missing public metadata. */ }
      const original = el.closest('.parent-comment')?.querySelector(':scope > .comment-item');
      const rootEl = original ?? el.parentElement?.closest('.comment-item[id], .comment-item[data-id]');
      const publicId = field.content?.post_id || el.getAttribute('data-id') || el.id.replace(/^comment-/, '');
      const parentId = rootEl?.getAttribute('data-id') || rootEl?.id.replace(/^comment-/, '') || publicId;
      if (ui.roots && !ui.roots.includes(parentId)) return [];
      const author = el.querySelector<HTMLAnchorElement>(ui.author);
      const content = el.querySelector<HTMLElement>(ui.commentText);
      return [{
        id: String(publicId ?? ''), root: String(parentId ?? ''), floor: field.content?.post_no,
        legacyTieba: el.matches('.l_post[data-field]'),
        author: (author?.innerText || '').trim().slice(0, 80), href: author?.href || '',
        text: (content?.innerText || '').trim().slice(0, 600),
        imageCount: [...el.querySelectorAll(ui.commentImages)]
          .filter(image => image.closest(ui.comments) === el).slice(0, 12).length,
      }];
    }), { author: this.ui.author, commentText: this.ui.commentText, commentImages: this.ui.commentImages, comments: this.ui.comments, roots });
    return data.flatMap((row, index) => {
      if ((!row.text && !row.imageCount) || (row.legacyTieba && (row.floor === 1 || (index === 0 && row.floor === undefined)))) return [];
      const authorId = profileId(platform, row.href)?.id;
      try {
        const target = this.normalizeTarget({ oid, type: this.type, root: row.root, parent: row.id });
        return [{ id: row.id, author: row.author || '评论者', authorId, text: row.text, target,
          ...(row.imageCount ? { imageCount: row.imageCount } : {}) }];
      } catch { return []; }
    });
  }

  private xiaohongshuCommentRow(page: Page, id: string) {
    return page.locator('[id="comment-' + id + '"], .comment-item[id="' + id + '"], .comment-item[data-id="' + id + '"]');
  }

  private xiaohongshuTopRows(page: Page) {
    return page.locator('.comments-container :is(.comment-item[id], .comment-item[data-id]):not(.reply-container *, .comment-item .comment-item)')
      .filter({ visible: true });
  }

  private async loadXiaohongshuRoots(page: Page) {
    const scroller = page.locator('.note-scroller').filter({ has: page.locator('.comments-container') });
    if (await scroller.count() !== 1 ||
        await scroller.locator('.end-container').filter({ hasText: /THE END|没有更多|已显示全部/i, visible: true }).count()) return false;
    const rows = this.xiaohongshuTopRows(page);
    const count = await rows.count();
    await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
    return rows.nth(count).waitFor({ state: 'attached', timeout: 1800 }).then(() => true, () => false);
  }

  private async findXiaohongshuRoot(page: Page, root: string, signal?: AbortSignal) {
    const topRows = this.xiaohongshuTopRows(page);
    // The note body may be ready while the comment list is still mounting.
    if (!await topRows.count()) await topRows.first().waitFor({ state: 'visible', timeout: 4500 }).catch(() => {});
    const row = topRows.and(this.xiaohongshuCommentRow(page, root));
    for (let load = 0; load < 8 && !await row.count(); load++) {
      signal?.throwIfAborted();
      if (!await this.loadXiaohongshuRoots(page)) break;
    }
    return await row.count() === 1;
  }

  private async expandXiaohongshuReplies(page: Page, root: string, until?: string, maxLoads = 4, signal?: AbortSignal) {
    const rootRow = this.xiaohongshuCommentRow(page, root);
    const thread = page.locator('.comments-container .parent-comment').filter({ has: rootRow });
    const more = thread.locator(':scope > .reply-container .show-more').filter({ visible: true });
    const replies = thread.locator(':scope > .reply-container .comment-item').filter({ visible: true });
    if (until) {
      const target = replies.and(this.xiaohongshuCommentRow(page, until));
      await more.or(target).first().waitFor({ state: 'visible', timeout: 3500 }).catch(() => {});
    }
    for (let load = 0; load < maxLoads && await more.count() === 1; load++) {
      signal?.throwIfAborted();
      if (until && await replies.and(this.xiaohongshuCommentRow(page, until)).count()) break;
      const count = await replies.count();
      try {
        await more.click({ timeout: 1800 });
        await replies.nth(count).waitFor({ state: 'visible', timeout: 1800 });
      } catch { break; }
    }
    return await more.count() === 1;
  }

  private async xiaohongshuCommentPage(page: Page, target: CommentTarget, cursor?: string, signal?: AbortSignal) {
    if (target.root !== '0') {
      if (!await this.findXiaohongshuRoot(page, target.root, signal)) return { items: [] };
      const until = target.parent !== target.root && target.parent !== '0' ? target.parent : undefined;
      await this.expandXiaohongshuReplies(page, target.root, until, 8, signal);
      return { items: await this.rows(page, target.oid, [target.root]) };
    }

    const [anchor, child, overflow] = cursor?.split(':') ?? [];
    if (overflow !== undefined || (anchor && !/^[a-f0-9]{24}$/i.test(anchor)) ||
        (child !== undefined && !/^[a-f0-9]{24}$/i.test(child)))
      throw new PlatformError('评论续读位置无效，请从第一页刷新。');
    const anchorVisible = anchor && await this.findXiaohongshuRoot(page, anchor, signal);
    const roots = this.xiaohongshuTopRows(page);
    const ids = () => roots.evaluateAll(nodes => nodes.map(el => el.getAttribute('data-id') || el.id.replace(/^comment-/, '')));
    let known = await ids();
    const start = anchorVisible ? known.indexOf(anchor) + (child ? 0 : 1) : 0;
    // Keep room in the polling budget for other works and continue at the exact last root.
    for (let load = 0; load < 2 && known.length < start + 7; load++) {
      signal?.throwIfAborted();
      if (!await this.loadXiaohongshuRoots(page)) break;
      known = await ids();
    }

    const items: PublicComment[] = [];
    const batch = known.slice(start, start + 6).filter(id => /^[a-f0-9]{24}$/i.test(id));
    const deadline = Date.now() + 8500;
    for (const root of batch) {
      if (root === anchor && child && child !== root)
        await this.expandXiaohongshuReplies(page, root, child, 8, signal);
      const more = await this.expandXiaohongshuReplies(page, root, undefined, 3, signal);
      const rows = await this.rows(page, target.oid, [root]);
      const from = root === anchor && child ? rows.findIndex(row => row.id === child) + 1 : 0;
      items.push(...rows.slice(from));
      const last = rows.at(-1)?.id;
      if (more && last && (root !== anchor || last !== child)) return { items, nextCursor: root + ':' + last };
      if (Date.now() >= deadline && root !== known.at(-1)) return { items, nextCursor: root };
    }
    return { items, nextCursor: known.length > start + 6 ? batch.at(-1) : undefined };
  }

  async comments(value: CommentTarget, index: number, signal?: AbortSignal, cursor?: string, latestReplies = false) {
    const target = this.normalizeTarget(value);
    if (index !== 1 && !(this.id === 'xiaohongshu' && target.root === '0' && cursor))
      throw new PlatformError('请使用上一页提供的评论续读位置。');
    return this.run(this.paths.get(target.oid), signal, async page => {
      await page.locator(this.ui.comments).first().waitFor({ timeout: 5000 }).catch(() => {});
      const newest = latestReplies && this.id === 'tieba' && target.root === '0' && await newestTiebaComments(page, target.oid);
      const result = this.id === 'xiaohongshu'
        ? await this.xiaohongshuCommentPage(page, target, cursor, signal)
        : { items: (await this.rows(page, target.oid)).filter(row => target.root === '0' || row.target.root === target.root) };
      if (!result.items.length) await checkAccessNotice(page);
      return { ...result, detail: newest ? '按官网倒序读取最新的可核对楼层。' : '只返回官网当前页面中能核实楼层编号的评论。', externalContent: true };
    });
  }

  async commentImages(raw: CommentTarget, limit: number, signal?: AbortSignal) {
    const target = this.normalizeTarget(raw);
    if (target.parent === '0') throw new PlatformError('只取指定评论楼层里的配图。');
    return this.run(this.paths.get(target.oid), signal, async page => {
      const visible = page.locator(this.ui.comments).filter({ visible: true });
      await visible.first().waitFor({ timeout: 4000 }).catch(() => {});
      if (this.id === 'xiaohongshu') {
        await this.findXiaohongshuRoot(page, target.root, signal);
        if (target.parent !== target.root)
          await this.expandXiaohongshuReplies(page, target.root, target.parent, 8, signal);
      }
      const comments = await this.rows(page, target.oid, this.id === 'xiaohongshu' ? [target.root] : undefined);
      const match = comments.filter(row => row.target.parent === target.parent && row.target.root === target.root);
      if (match.length !== 1 || !match[0].imageCount) throw new PlatformError('官网当前未显示该楼层或它的配图。');
      const rows = this.id === 'xiaohongshu'
        ? await visible.and(this.xiaohongshuCommentRow(page, target.parent)).elementHandles()
        : (await visible.elementHandles()).slice(0, 30);
      const hits = await Promise.all(rows.map(async row => {
        const id = await row.evaluate(node => {
          const el = node as Element;
          try {
            const postId = JSON.parse(el.getAttribute('data-field') || '{}').content?.post_id;
            if (postId) return String(postId);
          } catch { /* Use the rendered comment identity. */ }
          return el.getAttribute('data-id') || el.id.replace(/^comment-/, '');
        }).catch(() => '');
        return id === target.parent ? row : undefined;
      }));
      const matches = hits.filter(row => row !== undefined);
      if (matches.length !== 1) throw new PlatformError('评论配图的楼层已变化，未交付画面。');
      const images = await matches[0].$$(this.ui.commentImages);
      const frames = [];
      for (const [index, image] of images.slice(0, 12).entries()) {
        if (frames.length >= limit) break;
        signal?.throwIfAborted();
        await image.scrollIntoViewIfNeeded({ timeout: 1200 }).catch(() => {});
        if (!await image.evaluate((el, selected) => {
          const img = el as HTMLImageElement;
          const parent = img.closest(selected.comments);
          if (!parent || !img.complete || img.naturalWidth < 24 || img.naturalHeight < 24) return false;
          let postId: string | undefined;
          try { postId = JSON.parse(parent.getAttribute('data-field') || '{}').content?.post_id; } catch { /* DOM id fallback. */ }
          return String(postId || parent.getAttribute('data-id') || parent.id.replace(/^comment-/, '')) === selected.id;
        }, { comments: this.ui.comments, id: target.parent }).catch(() => false)) continue;
        const bytes = await image.screenshot({ type: 'jpeg', quality: 70, timeout: 1800 }).catch(() => undefined);
        if (bytes) frames.push({ atSec: index + 1, bytes });
      }
      if (!frames.length) throw new PlatformError('指定评论的配图未加载成功。');
      return frames;
    }, { media: true });
  }

  async gallery(video: Video, indices: number[], signal?: AbortSignal) {
    return this.run(this.paths.get(video.id), signal, async page => {
      const carousel = page.locator('.note-container .media-container')
        .filter({ has: page.locator('.swiper-slide[data-index]') });
      if (this.id === 'xiaohongshu' && (video.imageCount ?? 1) > 1) {
        await carousel.first().waitFor({ state: 'attached', timeout: 5500 });
        const list = await this.xiaohongshuGallery(carousel, indices, signal);
        if (!list.length) throw new PlatformError('小红书轮播当前未加载可核实的图片。');
        return list;
      }
      const media = page.locator(this.ui.media);
      await media.first().waitFor({ state: 'attached', timeout: 6000 });
      const frames = [];
      for (const number of indices) {
        signal?.throwIfAborted();
        const image = media.nth(number - 1);
        if (!await image.count()) continue;
        await image.scrollIntoViewIfNeeded({ timeout: 1900 }).catch(() => {});
        if (this.id === 'xiaohongshu' && !await image.isVisible()) {
          const carousel = image.locator('xpath=ancestor::*[contains(@class, "swiper") and not(contains(@class, "swiper-slide"))][1]');
          const next = carousel.locator('.swiper-button-next, [aria-label="Next slide"]').filter({ visible: true });
          if (await next.count() === 1) {
            await next.click({ timeout: 1500 }).catch(() => {});
            await image.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {});
          }
        }
        if (!await image.isVisible() || !await image.evaluate(el => {
          const img = el as HTMLImageElement;
          const box = img.getBoundingClientRect();
          return img.naturalWidth > 0 && box.right > 0 && box.left < innerWidth &&
            box.bottom > 0 && box.top < innerHeight;
        })) continue;
        const bytes = await image.screenshot({ type: 'jpeg', quality: 70, timeout: 2500 }).catch(() => undefined);
        if (bytes) frames.push({ atSec: number, bytes });
      }
      if (!frames.length) throw new PlatformError('当前图文页面未交付可核实的可见图片。');
      return frames;
    }, { media: true });
  }

  private async xiaohongshuGallery(
    carousel: ReturnType<Page['locator']>, indices: number[], signal?: AbortSignal,
  ) {
    const current = carousel.locator('.swiper-slide-active');
    await current.first().waitFor({ state: 'attached', timeout: 5500 });
    const pictures = [];
    for (const number of indices) {
      for (let step = 0; step < 20; step++) {
        signal?.throwIfAborted();
        if (await current.count() !== 1) break;
        const slideIndex = await current.getAttribute('data-swiper-slide-index', { timeout: 2800 });
        if (slideIndex === null || !/^\d+$/.test(slideIndex)) break;
        const index = Number(slideIndex);
        if (index === number - 1) {
          const image = current.and(carousel.locator('[data-swiper-slide-index="' + index + '"]'))
            .locator('img').filter({ visible: true });
          // The active slide can mount before its lazy image. Leave time for the image itself.
          try { await image.waitFor({ state: 'visible', timeout: 3000 }); }
          catch { break; }
          const loaded = await image.evaluate(async el => {
            const img = el as HTMLImageElement;
            if (!img.complete) await Promise.race([img.decode(), new Promise(resolve => setTimeout(resolve, 2600))]);
            return img.naturalWidth > 0;
          }, undefined, { timeout: 2900 }).catch(() => false);
          if (!loaded) break;
          const bytes = await image.screenshot({ type: 'jpeg', quality: 70, timeout: 3600 }).catch(() => undefined);
          if (bytes) pictures.push({ atSec: number, bytes });
          break;
        }
        const direction = index < number - 1 ? 'right' : 'left';
        const arrow = carousel.locator('.arrow-controller.' + direction + ':not(.forbidden)');
        try {
          await carousel.hover({ timeout: 1900 });
          if (await arrow.count() !== 1) break;
          await arrow.click({ timeout: 2500 });
          const selected = current.and(carousel.locator('[data-swiper-slide-index="' + (index + (direction === 'right' ? 1 : -1)) + '"]'));
          await selected.waitFor({ state: 'attached', timeout: 2600 });
          // The active class changes at the start of the slide transition. The site ignores clicks until it finishes.
          await selected.evaluate(async slide => {
            await new Promise(resolve => requestAnimationFrame(resolve));
            const moving = slide.parentElement?.getAnimations().filter(animation => animation.playState === 'running') ?? [];
            if (moving.length) await Promise.race([
              Promise.allSettled(moving.map(animation => animation.finished)),
              new Promise(resolve => setTimeout(resolve, 1300)),
            ]);
          }, undefined, { timeout: 1600 });
        } catch { break; }
      }
    }
    return pictures;
  }

  async frames(video: Video, times: number[], signal?: AbortSignal) {
    return this.run(this.paths.get(video.id), signal, async page => {
      const player = page.locator(this.ui.video).filter({ visible: true });
      try {
        await player.waitFor({ state: 'visible', timeout: 4500 });
      } catch {
        throw new PlatformError('官网播放器未能唯一确认。');
      }
      const loaded = await player.evaluate(async element => {
        const video = element as HTMLVideoElement;
        if (video.readyState < 2 || !video.videoWidth || !Number.isFinite(video.duration)) {
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, 5000);
            video.addEventListener('loadeddata', () => {
              clearTimeout(timer);
              resolve();
            }, { once: true, signal: AbortSignal.timeout(5000) });
          });
        }
        return video.readyState >= 2 && video.videoWidth > 0 && Number.isFinite(video.duration);
      });
      if (!loaded) throw new PlatformError('官网播放器没有加载出可读取的画面。');
      const frames = [];
      for (const atSec of times) {
        signal?.throwIfAborted();
        const ready = await player.evaluate(async (el, seconds) => {
          const v = el as HTMLVideoElement;
          v.pause();
          if (!Number.isFinite(v.duration) || !v.videoWidth || v.readyState < 2) return false;
          const time = Math.min(seconds, Math.max(v.duration - 0.08, 0));
          if (Math.abs(v.currentTime - time) < 0.04) return true;
          return new Promise<boolean>(resolve => {
            const timer = setTimeout(resolve, 1800, false);
            v.addEventListener('seeked', () => {
              clearTimeout(timer);
              resolve(Math.abs(v.currentTime - time) < 0.25 && v.readyState >= 2);
            }, { once: true, signal: AbortSignal.timeout(1800) });
            v.currentTime = time;
          });
        }, atSec);
        if (ready) {
          const bytes = await player.screenshot({ type: 'jpeg', quality: 70, timeout: 2300 }).catch(() => undefined);
          if (bytes) frames.push({ atSec, bytes });
        }
      }
      if (!frames.length) throw new PlatformError('官网没有返回可采样的播放器画面。');
      return frames;
    }, { media: true });
  }

  private async tiebaReplyRow(page: Page, id: string) {
    const modern = page.locator('.pb-comment-item[data-id="' + id + '"]').filter({ visible: true });
    await page.locator(this.ui.comments).first().waitFor({ state: 'attached', timeout: 6000 }).catch(() => {});
    if (await modern.count() === 1) return modern;
    const rows = page.locator(this.ui.comments).filter({ visible: true });
    const fields = await rows.evaluateAll((nodes, targetId) => nodes.slice(0, 30).flatMap(row => {
      const field = row.getAttribute('data-field');
      if (!field) return [];
      try { return String(JSON.parse(field).content?.post_id) === targetId ? [field] : []; }
      catch { return []; }
    }), id);
    if (fields.length !== 1) throw new PlatformError('官网未能唯一核对原楼层编号；未提交。', 'rejected');
    return rows.and(page.locator('[data-field=' + JSON.stringify(fields[0]) + ']'));
  }

  private async accountForReply(page: Page) {
    const matches = await this.ownLinks(page);
    if (matches.size === 1) return matches.values().next().value!;
    if (matches.size > 1) throw new PlatformError('评论页账号标记不唯一。', 'auth');
    await checkAccessNotice(page);
    const tab = await page.context().newPage();
    try {
      const home = new URL(this.ui.home, this.origin);
      const response = await tab.goto(home.href, { waitUntil: 'domcontentloaded', timeout: 10000 });
      await verifyPublicPage(tab, response?.status(), home);
      return await this.accountOnPage(tab, true);
    } finally { await tab.close().catch(() => {}); }
  }

  private async openReplyBox(page: Page, reply: CommentTarget, expectedAccountId: string) {
    if (this.id === 'xiaohongshu') {
      await this.findXiaohongshuRoot(page, reply.root);
      if (reply.root !== reply.parent) await this.expandXiaohongshuReplies(page, reply.root, reply.parent, 8);
    }
    const row = this.id === 'tieba'
      ? await this.tiebaReplyRow(page, reply.parent)
      : this.xiaohongshuCommentRow(page, reply.parent);
    try {
      await row.waitFor({ state: 'visible', timeout: 5500 });
      await row.locator(this.ui.author).first().waitFor({ state: 'attached', timeout: 2500 });
    } catch {
      throw new PlatformError('官网没有加载出唯一的原楼层及作者；未提交。', 'rejected');
    }
    const rows = await this.rows(page, reply.oid, this.id === 'xiaohongshu' ? [reply.root] : undefined);
    const original = rows.filter(entry => entry.id === reply.parent && entry.target.root === reply.root &&
      entry.authorId && entry.authorId !== expectedAccountId);
    if (original.length !== 1) throw new PlatformError('官网未能唯一确认原评论和作者；未提交。', 'rejected');
    const modernTieba = this.id === 'tieba' && await row.getAttribute('data-id') === reply.parent;
    if (this.id === 'tieba' && !modernTieba) {
      const data = JSON.parse(await row.getAttribute('data-field') || '{}');
      if (String(data.content?.post_id) !== reply.parent)
        throw new PlatformError('原楼层编号无法核实；未提交。', 'rejected');
    }
    const replyText = row.getByText('回复', { exact: true });
    const replyControl = this.id === 'xiaohongshu'
      ? replyText.and(row.locator(':not(.interactions .reply.icon-container:has(svg.reply-icon) *)'))
        .or(row.locator('.interactions .reply.icon-container:has(svg.reply-icon)'))
      : modernTieba ? row.locator(':scope > .comment-content .pc-pb-comments-desc .reply-container .reply').and(replyText)
        .and(page.locator(':not(.pb-lzl-item *, .sub-comment-item *, .sub-comment-list *)')) : replyText;
    const button = replyControl.filter({ visible: true });
    if (await button.count() !== 1) throw new PlatformError('原楼层没有唯一的回复入口；未提交。', 'rejected');
    await button.click({ timeout: 3000 });
    return row;
  }

  async send(target: CommentTarget, text: string, signal?: AbortSignal, expectedAccountId?: string, _mention?: unknown, verifiedWorkOwner?: string): Promise<SendReceipt> {
    const reply = this.normalizeTarget(target);
    const standalone = reply.parent === '0';
    if (this.id === 'tieba' && (standalone || reply.root !== reply.parent))
      throw new PlatformError('仅支持官网已核实的评论目标；未提交。', 'rejected');
    if (!expectedAccountId) throw new PlatformError('缺少预先核对的发送账号；未提交。', 'rejected');
    let clicked = false;
    let dispatched = false;
    const startedAt = Math.floor(Date.now() / 1000);
    let responseIssue = '';
    const matches = (request: Request) => exactReplyRequest(this.id, request, reply, text);
    try {
      const note = this.paths.get(reply.oid);
      const owner = this.id === 'xiaohongshu' && verifiedWorkOwner && (standalone || !note.search)
        ? profileUrl(this.id, verifiedWorkOwner) : undefined;
      return await this.run(owner ?? note, signal, async page => {
        if (owner) {
          await this.openOwnerNote(page, reply.oid);
          const displayed = await this.readPost(page, reply.oid);
          if (displayed.ownerId !== verifiedWorkOwner)
            throw new PlatformError('笔记中显示的作者与已核实的主人不一致，未提交。', 'rejected');
        }
        if ((await this.accountForReply(page)).id !== expectedAccountId)
          throw new PlatformError('网页账号已更换；未提交。', 'rejected');
        const scope = standalone ? page : await this.openReplyBox(page, reply, expectedAccountId);
        const composer = this.id === 'tieba'
          ? scope.locator('textarea, [contenteditable="true"]').filter({ visible: true })
          : page.locator('#content-textarea, .comment-input [contenteditable="true"]').filter({ visible: true });
        const send = (this.id === 'tieba'
          ? scope.getByText(/^(发送|发表|发布)$/)
          : page.getByRole('button', { name: /^(发送|发表|发布)$/ })
            .and(page.locator('button.submit, .comment-input button, .interactions button')))
          .filter({ visible: true });
        if (standalone && (!(await composer.count()) || !(await send.count()))) {
          const entry = page.locator('.engage-bar .input-box').filter({ visible: true });
          try {
            await entry.click({ timeout: 5000 });
            await composer.waitFor({ state: 'visible', timeout: 4000 });
            await send.waitFor({ state: 'visible', timeout: 4000 });
          } catch {
            await verifyPublicPage(page, undefined, this.paths.get(reply.oid));
            await checkAccessNotice(page);
            throw new PlatformError('一级评论框没有展开或未显示发送按钮，未提交。', 'rejected');
          }
        }
        if (this.id === 'tieba') {
          // The inline editor mounts asynchronously after the verified floor's reply button is clicked.
          await Promise.all([
            composer.first().waitFor({ state: 'visible', timeout: 4000 }).catch(() => {}),
            send.first().waitFor({ state: 'visible', timeout: 4000 }).catch(() => {}),
          ]);
        }
        if (await composer.count() !== 1 || await send.count() !== 1)
          throw new PlatformError('官网回复编辑框或发送按钮无法唯一核实；未提交。', 'rejected');
        const old = await composer.evaluate(el => (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : el.textContent) || '');
        if (old.trim()) throw new PlatformError('回复框已有草稿；未提交。', 'rejected');
        await composer.fill(text, { timeout: 3000 });
        const entered = await composer.evaluate(el => (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : el.textContent) || '');
        if (entered !== text) throw new PlatformError('官网输入框正文发生变化；未提交。', 'rejected');
        signal?.throwIfAborted();
        await checkAccessNotice(page);
        await verifyPublicPage(page, undefined, this.paths.get(reply.oid));
        const response = page.waitForResponse(res => matches(res.request()), { timeout: 9000 }).catch(() => undefined);
        clicked = true;
        try {
          await send.click({ timeout: 4000 });
        } catch (error) {
          if (!standalone || dispatched) throw error;
          await verifyPublicPage(page, undefined, this.paths.get(reply.oid));
          await checkAccessNotice(page);
          const disabled = await send.isDisabled({ timeout: 500 }).catch(() => false);
          throw new PlatformError(disabled ? '官网没有启用一级评论发送按钮，未提交。' : '一级评论发送按钮无法点击，未观察到提交请求。', 'rejected');
        }
        const receipt = await response;
        const data = await receipt?.json().catch(() => undefined);
        let id = this.id === 'tieba' ? data?.data?.post_id ?? data?.data?.pid : data?.data?.comment?.id;
        const accepted = receipt?.ok() && (this.id === 'tieba' ? Number(data?.no ?? data?.error_code) === 0 : data?.success === true);
        if (!dispatched) throw new PlatformError('官网未生成与原评论和正文一致的回复请求，未提交。', 'rejected');
        if (accepted && !id && this.id === 'tieba' && expectedAccountId) {
          // The modern editor can return success without a comment ID. Only reread the thread.
          const loaded = page.waitForResponse(res => res.url().split('?')[0] === POST_ORIGINS.tieba + '/c/f/pb/page_pc'
            && res.request().frame() === page.mainFrame() && res.ok(), { timeout: 9000 }).catch(() => undefined);
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
          const thread = await (await loaded)?.json().catch(() => undefined);
          id = findTiebaReceipt(thread, reply, text, expectedAccountId, startedAt);
        }
        if (!accepted || !id || !/^[a-z0-9_-]{1,64}$/i.test(String(id))) {
          const code = data?.code ?? data?.no ?? data?.error_code;
          const platformCode = /^-?\d{1,10}$/.test(String(code)) ? '，平台代码 ' + code : '';
          responseIssue = receipt
            ? '官网已响应（HTTP ' + receipt.status() + platformCode + '），未核实受理编号'
            : '已观察到提交请求，等待官网回执超时';
          throw new PlatformError(responseIssue, 'network');
        }
        return { receiptId: String(id), transport: 'browser' };
      }, { showWorkWindow: Boolean(owner), media: Boolean(owner), readNote: verifiedWorkOwner && owner ? () => ({ id: reply.oid, ownerId: verifiedWorkOwner }) : undefined, allowWrite: request => {
        if (!clicked || dispatched || !matches(request)) return false;
        dispatched = true;
        return true;
      } });
    } catch (error) {
      if (dispatched) throw new PlatformError((responseIssue || '点发送后未能确认结果') + '，请核对原楼层；请勿重复发送。', 'network');
      throw new PlatformError(error instanceof Error ? error.message : '回复页面准备失败；未提交。', 'rejected');
    }
  }
}

interface TiebaPublicThread {
  thread?: { id?: number | string };
  user_list?: { id?: number | string; portrait?: string }[];
  post_list?: { id?: number | string; sub_post_list?: { sub_post_list?: {
    id?: number | string; author_id?: number | string; time?: number; content?: { type?: number; text?: string }[]
  }[] } }[];
}
export function findTiebaReceipt(thread: TiebaPublicThread | undefined, target: CommentTarget, text: string, account: string, since: number) {
  if (target.root !== target.parent || String(thread?.thread?.id) !== target.oid ||
      !Array.isArray(thread?.user_list) || !Array.isArray(thread.post_list)) return;
  const authors = new Set(thread.user_list.filter(u => u.id != null && u.portrait?.split('?')[0] === account).map(u => String(u.id)));
  const floor = thread.post_list.filter(p => String(p.id) === target.parent);
  const children = floor.length === 1 && floor[0].sub_post_list?.sub_post_list;
  if (!Array.isArray(children) || authors.size !== 1) return;
  const matches = children.filter(c => authors.has(String(c.author_id)) &&
    Number(c.time) >= since - 5 && Number(c.time) <= Date.now() / 1000 + 5 &&
    Array.isArray(c.content) && c.content.length === 1 && c.content[0].text === text &&
    (typeof c.id === 'string' || Number.isSafeInteger(c.id)) && /^[1-9]\d*$/.test(String(c.id)));
  return matches.length === 1 ? String(matches[0].id) : undefined;
}

function exactReplyRequest(platform: PublicPostPlatform, req: Request, target: CommentTarget, text: string) {
  if (req.method() !== 'POST') return false;
  const url = new URL(req.url());
  if (platform === 'xiaohongshu') {
    if (url.origin !== 'https://edith.xiaohongshu.com' && url.origin !== POST_ORIGINS.xiaohongshu) return false;
    if (url.pathname !== '/api/sns/web/v1/comment/post') return false;
    try {
      const body = req.postDataJSON();
      const recipient = body.target_comment_id;
      const exactTarget = target.parent === '0' ? recipient == null || recipient === '' : recipient === target.parent;
      return body.note_id === target.oid && exactTarget && body.content === text;
    } catch { return false; }
  }
  if (url.origin !== POST_ORIGINS.tieba || !['/f/commit/post/add', '/c/c/post/add_pc'].includes(url.pathname)) return false;
  try {
    const fields = req.postDataJSON();
    const parents = [fields.quote_id, fields.reply_to_pid, fields.repostid].filter(v => v != null && v !== '');
    return String(fields.tid) === target.oid && parents.length > 0 && parents.every(id => String(id) === target.parent) &&
      fields.content === text;
  } catch { return false; }
}

import type { DynamicPost, DynamicPostResult } from '../dynamic-publishing.ts';
import { submitDynamicPage, matchesPostedDynamic } from './bilibili-dynamic-publish.ts';
import { browserCacheArgs, clearNetworkCache } from '../resources.ts';
import { readDynamicPage, dynamicId } from './bilibili-dynamics.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  chromium,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
  type Route,
} from 'playwright-core';
import { PlatformError, type CommentTarget, type SendReceipt } from '../platform.ts';
import { cleanCookie, normalizeTarget, numericId, parsePlatformJson } from './bilibili.ts';

const ORIGIN = 'https://www.bilibili.com';
const ADD = 'https://api.bilibili.com/x/v2/reply/add';
const EDITORS = 'bili-comment-box';
export function mergeBrowserDeviceCookies(
  source: string,
  cookies: Array<{ name: string; value: string }>,
) {
  const parts = new Map(
    cleanCookie(source)
      .split(';')
      .map((part) => {
        const index = part.trim().indexOf('=');
        return [part.trim().slice(0, index), part.trim().slice(index + 1)];
      }),
  );
  // A cookie query for www may omit API-scoped login fields. Never treat it as a full login replacement.
  for (const cookie of cookies)
    if (['buvid3', 'buvid4'].includes(cookie.name) && cookie.value)
      parts.set(cookie.name, cookie.value);
  return cleanCookie([...parts].map(([name, value]) => name + '=' + value).join('; '));
}
export function findBrowserExecutable(configured = ''): string | undefined {
  if (configured) return existsSync(configured) ? configured : undefined;
  const candidates =
    process.platform === 'win32'
      ? [
          join(
            process.env.PROGRAMFILES || 'C:/Program Files',
            'Google/Chrome/Application/chrome.exe',
          ),
          join(
            process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)',
            'Microsoft/Edge/Application/msedge.exe',
          ),
          join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/microsoft-edge',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
          ];
  return candidates.find((p) => existsSync(p));
}
export function commentPageUrl(input: CommentTarget, dynamicUrl?: string) {
  const t = normalizeTarget(input);
  if (t.type !== 1 && !dynamicUrl)
    throw new PlatformError('请先读取原动态，取得准确动态链接和评论目标；未提交。', 'rejected');
  const url =
    t.type === 1
      ? new URL('/video/av' + t.oid + '/', ORIGIN)
      : new URL('https://t.bilibili.com/' + dynamicId(dynamicUrl!));
  if (t.type === 1) url.searchParams.set('autoplay', '0');
  if (t.root !== '0') {
    url.searchParams.set('comment_root_id', t.root);
    url.searchParams.set('comment_secondary_id', t.parent);
    url.hash = 'reply' + t.parent;
  }
  return url.href;
}
export function matchesCommentRequest(form: URLSearchParams, t: CommentTarget, message: string) {
  return (
    !['is_sync', 'sync', 'sync_to_dynamic', 'sync_dynamic'].some((k) => {
      const v = form.get(k);
      return v !== null && !['', '0', 'false'].includes(v);
    }) &&
    form.get('oid') === t.oid &&
    form.get('type') === String(t.type) &&
    (form.get('root') || '0') === t.root &&
    (form.get('parent') || '0') === t.parent &&
    form.get('message') === message
  );
}

export async function prepareCommentArea(page: Page) {
  const comments = page.locator('bili-comments').first();
  const container = page.locator('#commentapp, .bili-comment-container, .comment-wrap').first();
  if (await container.count()) {
    // A mounted shell may still defer its content until scrolled into view, especially below long descriptions.
    await container.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  } else {
    await comments.waitFor({ state: 'attached', timeout: 15000 });
    await comments.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  }
  await comments.waitFor({ state: 'attached', timeout: 20000 });
  // Hydration can reflow a long description and move the actual component away from the scrolled placeholder.
  await comments.evaluate((el) => el.scrollIntoView({ block: 'center' }));
}

async function editorFor(page: Page, t: CommentTarget): Promise<Locator> {
  if (t.parent !== '0') {
    const rows = page.locator('bili-comment-renderer, bili-comment-reply-renderer');
    await rows.first().waitFor({ state: 'attached', timeout: 20000 });
    const ids = await rows.evaluateAll((elements) =>
      elements.map((el) => {
        const data = (el as HTMLElement & { data?: { rpid_str?: string; rpid?: string } }).data;
        return String(data?.rpid_str ?? data?.rpid ?? '');
      }),
    );
    const index = ids.indexOf(t.parent);
    if (index < 0)
      throw new PlatformError('网页尚未展示目标评论；未改用其他楼层，也未提交。', 'rejected');
    await rows.nth(index).locator('bili-comment-action-buttons-renderer #reply button').click();
  }
  // The page keeps an unused, hidden reply box even when no thread is being answered.
  const boxes =
    t.parent === '0'
      ? page.locator('bili-comments-header-renderer').locator(EDITORS)
      : page.locator(EDITORS);
  await boxes.first().waitFor({ state: 'attached', timeout: 15000 });
  const candidates = await boxes.evaluateAll((elements) =>
    elements.map((el) => {
      const reply = (
        el as HTMLElement & {
          reply?: { rpid_str?: string; rpid?: string; root_str?: string; root?: string };
        }
      ).reply;
      return {
        parent: String(reply?.rpid_str ?? reply?.rpid ?? '0'),
        root: String(reply?.root_str ?? reply?.root ?? '0'),
      };
    }),
  );
  const index = candidates.findIndex((r) =>
    t.parent === '0'
      ? r.parent === '0'
      : r.parent === t.parent && (r.root === t.root || (r.root === '0' && r.parent === t.root)),
  );
  if (index < 0) throw new PlatformError('网页回复框与目标楼层不符，未提交。', 'rejected');
  return boxes.nth(index);
}

/** Click only the official page button. Never synthesize its risk tokens or replay a POST. */
export async function submitCommentPage(
  page: Page,
  input: CommentTarget,
  text: string,
  signal?: AbortSignal,
  timeout = 15000,
  sessionCurrent: () => boolean | Promise<boolean> = () => true,
): Promise<SendReceipt> {
  const t = normalizeTarget(input);
  const message = text.trim();
  if (!message || message.length > 1000) throw new PlatformError('评论应为 1–1000 字');
  const currentUrl = new URL(page.url());
  if (
    t.type === 1
      ? currentUrl.origin !== ORIGIN
      : !['https://t.bilibili.com', ORIGIN].includes(currentUrl.origin)
  )
    throw new PlatformError('当前不是B站官方作品页，未提交。', 'rejected');
  if (t.type !== 1) {
    dynamicId(page.url());
    const params = await page.locator('bili-comments').first().getAttribute('data-params');
    if (params !== t.type + ',' + t.oid)
      throw new PlatformError('动态评论区与目标编号不符，未提交。', 'rejected');
  }
  let stage = '定位评论输入框';
  let clicked = false,
    forwarded = false,
    finished = false;
  let blocked: (error: PlatformError) => void = () => {};
  const blockedResult = new Promise<PlatformError>((resolve) => {
    blocked = resolve;
  });
  let expectedMessage = message;
  const guard = async (route: Route, request: Request) => {
    const valid =
      request.method() === 'POST' &&
      matchesCommentRequest(new URLSearchParams(request.postData() || ''), t, expectedMessage);
    if (!valid || forwarded || finished || signal?.aborted || !(await sessionCurrent())) {
      if (!forwarded)
        blocked(
          new PlatformError(
            '已拦下网页的重复请求或不匹配的正文、楼层；不会换接口重发。',
            'rejected',
          ),
        );
      await route.abort().catch(() => {});
      return;
    }
    forwarded = true;
    await route.fallback();
  };
  await page.route(ADD + '**', guard);
  try {
    signal?.throwIfAborted();
    const box = await editorFor(page, t);
    const sync = box.locator('bili-checkbox[value="sync"]');
    if (await sync.count()) {
      const checked = () =>
        sync.evaluate(
          (el) =>
            Boolean((el as HTMLElement & { checked?: boolean }).checked) ||
            el.getAttribute('checked') === 'true',
        );
      if (await checked()) await sync.click();
      if (await checked())
        throw new PlatformError('未能关闭同时转发到动态，本次未提交。', 'rejected');
    }
    const editor = box.locator('textarea, [contenteditable="true"]').first();
    stage = '填写评论输入框';
    await editor.fill(message);
    // The official component prepends its visible reply placeholder for a nested reply.
    const prefix = await box.evaluate((el) => {
      const box = el as HTMLElement & { reply?: { root?: string | number }; placeholder?: string };
      return box.reply?.root && String(box.reply.root) !== '0' ? String(box.placeholder || '') : '';
    });
    expectedMessage = prefix + message;
    signal?.throwIfAborted();
    if (!(await sessionCurrent()))
      throw new PlatformError('发评前登录或发布开关已变化，尚未提交。', 'rejected');
    const response = page.waitForResponse(
      (r) => r.url().split('?')[0] === ADD && r.request().method() === 'POST',
      { timeout },
    );
    // Attach immediately so an abort during the click cannot leave an unhandled rejection.
    const outcome = Promise.race([response, blockedResult]);
    void outcome.catch(() => {});
    clicked = true;
    await box.locator('#pub button').click({ timeout });
    const result = await outcome;
    if (result instanceof PlatformError) throw result;
    if (!result.ok()) throw Error('No valid server receipt');
    const data = parsePlatformJson(await result.text());
    if (data.code !== 0)
      throw new PlatformError(
        'B站网页返回 ' +
          data.code +
          '：' +
          String(data.message || '未获准')
            .replace(/<[^>]*>/g, '')
            .slice(0, 160),
        [-101, -111].includes(data.code) ? 'auth' : 'rejected',
      );
    const d = data.data ?? {};
    const id = d.rpid_str ?? d.rpid ?? d.reply?.rpid_str ?? d.reply?.rpid;
    if (!id) throw Error('Missing receipt');
    return {
      receiptId: numericId(id),
      transport: 'browser',
      ...(typeof d.reply?.state === 'number' ? { platformState: d.reply.state } : {}),
    };
  } catch (e) {
    if (e instanceof PlatformError) throw e;
    throw new PlatformError(
      clicked
        ? '网页已触发发布，但未取得可确认的回执；请核实评论，禁止自动重发。'
        : stage + '未完成（页面未就绪或等待超时），尚未提交；这不是平台审核回执。',
      clicked ? 'network' : 'rejected',
    );
  } finally {
    // This page is single-use. Keep denying further POSTs until its owner closes it.
    finished = true;
  }
}

export class BilibiliBrowserSender {
  private context?: BrowserContext;
  private busy = false;
  private lastCacheClear = 0;
  private clearCachePending = false;
  private controller = new AbortController();
  private loginOpen = false;
  private lastResult?: { ready: boolean; detail: string; checkedAt: string };
  constructor(
    private profileDir: string,
    private cookie: () => string,
    private saveCookie: (cookie: string) => void,
    private executable: () => string,
    private canPublish: () => boolean = () => true,
    private background: () => boolean = () => true,
    private cacheMB: () => number = () => 128,
  ) {}
  reset() {
    if (this.controller.signal.aborted) this.controller = new AbortController();
  }
  status() {
    return {
      available: Boolean(findBrowserExecutable(this.executable())),
      background: this.background(),
      running: Boolean(this.context),
      loginOpen: this.loginOpen,
      ...this.lastResult,
    };
  }
  async openLogin() {
    if (this.busy) throw new PlatformError('B站正在处理操作，请完成后再登录。', 'rejected');
    if (this.loginOpen) return { detail: 'B站官网登录窗口已打开，请在该窗口完成登录。' };
    const executablePath = findBrowserExecutable(this.executable());
    if (!executablePath) throw new PlatformError('未找到Chrome或Edge，请在配置中填写浏览器程序。');
    this.busy = true;
    try {
      const context = await chromium.launchPersistentContext(this.profileDir, {
        executablePath,
        headless: false,
        viewport: { width: 1120, height: 800 },
        timeout: 20000,
        args: browserCacheArgs(this.cacheMB()),
      });
      this.context = context;
      this.loginOpen = true;
      context.once('close', () => {
        if (this.context === context) {
          this.context = undefined;
          this.loginOpen = false;
        }
      });
      try {
        const p = context.pages()[0] ?? (await context.newPage());
        await p.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 25000 });
      } catch {
        await context.close().catch(() => {});
        this.context = undefined;
        this.loginOpen = false;
        throw new PlatformError('B站官网登录窗口未就绪；可稍后重试。', 'network');
      }
      return {
        detail:
          '请在独立B站官网窗口正常登录，再点“完成B站网页登录”。仅支持bilibili.com账号；Bstation/bilibili.tv暂未接入。',
      };
    } finally {
      this.busy = false;
    }
  }
  async finishLogin() {
    const context = this.context;
    if (!context || !this.loginOpen) throw new PlatformError('请先打开B站官网登录窗口。', 'auth');
    const response = await context.request.get('https://api.bilibili.com/x/web-interface/nav', {
      headers: { Referer: ORIGIN },
      timeout: 15000,
      maxRedirects: 0,
    });
    if (!response.ok())
      throw new PlatformError('网页登录尚未核实，请在官网完成验证后再点完成。', 'auth');
    const d = parsePlatformJson(await response.text()).data;
    if (!d?.isLogin) throw new PlatformError('官网尚未确认登录，窗口已保留，请完成登录。', 'auth');
    const account = { id: numericId(d.mid), name: String(d.uname ?? '').slice(0, 80) };
    const cookies = await context.cookies([ORIGIN, 'https://api.bilibili.com']);
    const allowed = new Map(
      cookies
        .filter((c) => ['SESSDATA', 'bili_jct', 'DedeUserID', 'buvid3', 'buvid4'].includes(c.name))
        .map((c) => [c.name, c.value]),
    );
    if (allowed.get('DedeUserID') !== account.id)
      throw new PlatformError('官网账号与登录资料不一致，未保存，请核对登录。', 'auth');
    const cookie = cleanCookie([...allowed].map(([k, v]) => k + '=' + v).join(';'));
    this.saveCookie(cookie);
    await context.close();
    this.context = undefined;
    this.loginOpen = false;
    return { account, detail: '已核对并保存B站网页登录；不代表支持Bstation账号。' };
  }
  async closeLogin() {
    if (this.loginOpen) {
      await this.context?.close().catch(() => {});
      this.context = undefined;
      this.loginOpen = false;
    }
    return { detail: 'B站登录窗口已关闭；原已保存登录资料保留。' };
  }
  private async open(signal: AbortSignal, requiredAccountId?: string) {
    const executablePath = findBrowserExecutable(this.executable());
    if (!executablePath)
      throw new PlatformError(
        '未找到Chrome或Edge；请在设置中填写浏览器程序路径。尚未提交。',
        'rejected',
      );
    const source = this.cookie();
    const allowed = cleanCookie(source)
      .split(';')
      .map((s) => {
        const index = s.trim().indexOf('=');
        const part = s.trim();
        return { name: part.slice(0, index), value: part.slice(index + 1) };
      });
    const expectedId = allowed.find((c) => c.name === 'DedeUserID')?.value;
    if (!expectedId) throw new PlatformError('登录缺少账号编号，请重新扫码。尚未提交。', 'auth');
    if (requiredAccountId && requiredAccountId !== expectedId)
      throw new PlatformError('发评期间登录账号发生变化，尚未提交。', 'auth');
    signal.throwIfAborted();
    const context =
      this.context ??
      (await chromium.launchPersistentContext(this.profileDir, {
        executablePath,
        headless: this.background(),
        viewport: { width: 1280, height: 900 },
        timeout: 20000,
        args: [
          ...browserCacheArgs(this.cacheMB()),
          '--mute-audio',
          '--disable-notifications',
          ...(!this.background() ? ['--start-minimized'] : []),
        ],
      }));
    this.context = context;
    if (this.clearCachePending || Date.now() - this.lastCacheClear > 86400000) {
      try {
        await clearNetworkCache(context);
        this.lastCacheClear = Date.now();
        this.clearCachePending = false;
      } catch {}
    }
    // Posting does not require playing video; keep its media downloads out of the background browser.
    await context.route('**/*', (route) => {
      const request = route.request();
      const host = new URL(request.url()).hostname;
      return request.resourceType() === 'media' || /(^|\.)bilivideo\.(com|cn)$/.test(host)
        ? route.abort()
        : route.fallback();
    });
    context.once('close', () => {
      if (this.context === context) this.context = undefined;
    });
    // Let the official browser obtain its own device session; only transfer the approved account login.
    await context.addCookies(
      allowed
        .filter((c) => !c.name.startsWith('buvid'))
        .map((c) => ({
          ...c,
          domain: '.bilibili.com',
          path: '/',
          secure: true,
          httpOnly: c.name === 'SESSDATA',
          sameSite: 'Lax' as const,
        })),
    );
    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(15000);
    await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 25000 });
    const accountText = await page.evaluate(async () =>
      (
        await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' })
      ).text(),
    );
    const account = parsePlatformJson(accountText).data;
    if (!account?.isLogin || String(account.mid) !== expectedId || this.cookie() !== source)
      throw new PlatformError('网页登录账号与World当前账号不符，尚未提交；请重新扫码。', 'auth');
    // No values leave the secret store; public state contains only readiness and account name.
    const current = await context.cookies(ORIGIN);
    this.saveCookie(mergeBrowserDeviceCookies(source, current));
    return { context, page, account: { id: expectedId, name: String(account.uname || '') } };
  }
  async publishDynamic(
    draft: DynamicPost,
    signal?: AbortSignal,
    permission: () => boolean = this.canPublish,
  ): Promise<DynamicPostResult> {
    if (this.loginOpen || this.busy)
      return { status: 'rejected', detail: 'B站正在登录或处理其他操作，本次未提交。' };
    if (!permission()) return { status: 'rejected', detail: '动态发布已关闭，尚未提交。' };
    this.busy = true;
    const combined = AbortSignal.any([
      this.controller.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(90000),
    ]);
    const abort = () => {
      void this.context?.close().catch(() => {});
    };
    combined.addEventListener('abort', abort, { once: true });
    let stage = '浏览器与登录核验';
    let submitted = false;
    let isolated: BrowserContext | undefined;
    try {
      const opened = await this.open(combined, draft.accountId);
      const account = opened.account;
      // A fresh in-memory context keeps the user's native pending draft untouched.
      stage = '建立独立发布环境';
      isolated = await opened.context
        .browser()!
        .newContext({ viewport: { width: 1280, height: 900 } });
      await isolated.addCookies(
        await opened.context.cookies([
          ORIGIN,
          'https://t.bilibili.com',
          'https://api.bilibili.com',
        ]),
      );
      const context = isolated,
        page = await context.newPage();
      const session = this.cookie();
      await context.route('**/*', (r) =>
        r.request().method() === 'GET' ? r.fallback() : r.abort(),
      );
      stage = '读取本人动态基线';
      const before = await readDynamicPage(page, { ownerId: account.id, limit: 5 }, combined);
      const oldIds = new Set(before.items.map((x) => x.id));
      stage = '加载动态发布页';
      await readDynamicPage(page, { limit: 5 }, combined);
      const current = async () =>
        this.cookie() === session &&
        permission() &&
        (await context.cookies(ORIGIN)).find((c) => c.name === 'DedeUserID')?.value === account.id;
      stage = '官网正文与提交检查';
      const result = await submitDynamicPage(page, draft, combined, current);
      submitted = result.forwarded;
      if (result.rejected && !submitted) return { status: 'rejected', detail: result.rejected };
      if (!submitted)
        return {
          status: 'rejected',
          detail: result.rejected ?? '官网内容检查或提交未完成，未发出动态。',
        };
      // Once forwarded, deny every further write before attempting a read-back. Never click again.
      await page.route('**/*', (r) => (r.request().method() === 'GET' ? r.fallback() : r.abort()));
      let found;
      try {
        const read = await readDynamicPage(page, { ownerId: account.id, limit: 5 }, combined);
        found = read.items.find(
          (x) =>
            !oldIds.has(x.id) &&
            matchesPostedDynamic(x, draft) &&
            x.publishedAt >=
              Math.floor(Date.parse(draft.attemptedAt ?? draft.createdAt) / 1000) - 5,
        );
      } catch {}
      if (!(await current()))
        return { status: 'unknown', detail: '提交后账号或权限发生变化，结果待核实，不补发。' };
      if (found)
        return {
          status: 'sent',
          dynamicId: found.id,
          url: found.url,
          detail: '官网提交后已从本人动态列表读到准确编号和正文；访客可见性及@通知送达另行核验。',
        };
      if (result.id)
        return {
          status: 'sent',
          dynamicId: result.id,
          url: 'https://t.bilibili.com/' + result.id,
          detail: '官网返回动态编号；列表回读、公开可见性与@通知尚未核实，不补发。',
        };
      return {
        status: 'unknown',
        detail: result.rejected ?? '官网已触发提交，尚未核实编号；保留记录，禁止自动重发。',
      };
    } catch (e) {
      return {
        status: submitted ? 'unknown' : 'rejected',
        detail: submitted
          ? '提交后核验未完成，结果待核实，不补发。'
          : e instanceof PlatformError
            ? e.message
            : stage + '未完成（' + (e instanceof Error ? e.name : 'Error') + '），尚未提交。',
      };
    } finally {
      combined.removeEventListener('abort', abort);
      await isolated?.close().catch(() => {});
      await this.context?.close().catch(() => {});
      this.context = undefined;
      this.busy = false;
    }
  }
  async readDynamics(
    options: { ownerId?: string; id?: string; limit?: number },
    signal?: AbortSignal,
    expectedAccountId?: string,
  ) {
    if (this.loginOpen)
      throw new PlatformError('B站官网登录窗口尚待确认，请先完成或关闭登录。', 'auth');
    if (this.busy) throw new PlatformError('B站网页正在处理其他操作，本次未读取。', 'rejected');
    this.busy = true;
    const combined = AbortSignal.any([
      this.controller.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(45000),
    ]);
    const abort = () => {
      void this.context?.close().catch(() => {});
    };
    combined.addEventListener('abort', abort, { once: true });
    try {
      const { context, page, account } = await this.open(combined, expectedAccountId);
      this.context = context;
      const session = this.cookie();
      // Read-only means all POSTs are denied, including opaque gateway envelopes.
      await context.route('**/*', (r) =>
        r.request().method() === 'GET' ? r.fallback() : r.abort(),
      );
      const result = await readDynamicPage(page, options, combined);
      if (this.cookie() !== session)
        throw new PlatformError('读取期间账号发生变化，本次内容未交付。', 'auth');
      return { ...result, accountId: account.id };
    } catch (e) {
      if (e instanceof PlatformError) throw e;
      throw new PlatformError(
        '官网动态读取未完成，请检查登录或验证提示；未绕过限制，也未进行发布。',
        'network',
      );
    } finally {
      combined.removeEventListener('abort', abort);
      await this.context?.close().catch(() => {});
      this.context = undefined;
      this.busy = false;
    }
  }
  async check(target: CommentTarget, signal?: AbortSignal, dynamicUrl?: string) {
    return this.run(target, undefined, signal, undefined, dynamicUrl);
  }
  async send(
    target: CommentTarget,
    text: string,
    signal?: AbortSignal,
    expectedAccountId?: string,
    dynamicUrl?: string,
  ): Promise<SendReceipt> {
    return (await this.run(target, text, signal, expectedAccountId, dynamicUrl)) as SendReceipt;
  }
  private async run(
    target: CommentTarget,
    text?: string,
    signal?: AbortSignal,
    expectedAccountId?: string,
    dynamicUrl?: string,
  ) {
    if (this.loginOpen)
      throw new PlatformError('B站官网登录窗口尚待确认，请先完成或关闭登录。', 'auth');
    if (this.busy)
      throw new PlatformError('网页正在处理另一项操作，请稍后继续；本次未提交。', 'rejected');
    this.busy = true;
    const combined = AbortSignal.any([
      this.controller.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(60000),
    ]);
    const abort = () => {
      void this.context?.close().catch(() => {});
    };
    combined.addEventListener('abort', abort, { once: true });
    let stage = '浏览器启动与网页登录核验';
    try {
      const url = commentPageUrl(target, dynamicUrl);
      if (text !== undefined && !this.canPublish())
        throw new PlatformError('公开发布已关闭，尚未提交。', 'rejected');
      const { context, page, account } = await this.open(combined, expectedAccountId);
      const currentSession = this.cookie();
      if (text === undefined) await page.route(ADD + '**', (route) => route.abort());
      await page.route('https://api.bilibili.com/x/dynamic/feed/create/**', (r) => r.abort());
      await page.route('https://api.bilibili.com/x/internal/gaia-gateway/**', (r) => r.abort());
      stage = '目标作品页面加载';
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      stage = '评论区加载';
      await prepareCommentArea(page);
      if (text === undefined) {
        // A diagnostic never types or clicks the publish button.
        stage = '评论输入框检查';
        const box = await editorFor(page, target);
        await box
          .locator('textarea, [contenteditable="true"]')
          .first()
          .waitFor({ state: 'visible', timeout: 15000 });
        await box.locator('#pub button').waitFor({ state: 'attached', timeout: 15000 });
        this.lastResult = {
          ready: true,
          detail: '官方评论组件已就绪；此检查没有发评论。',
          checkedAt: new Date().toISOString(),
        };
        return { ...this.lastResult, account };
      }
      const receipt = await submitCommentPage(
        page,
        target,
        text,
        combined,
        15000,
        async () =>
          this.cookie() === currentSession &&
          this.canPublish() &&
          (await context.cookies(ORIGIN)).find((cookie) => cookie.name === 'DedeUserID')?.value ===
            account.id,
      );
      this.lastResult = {
        ready: true,
        detail: '官方网页已返回发布回执；是否公开请查看该条评论的核验状态。',
        checkedAt: new Date().toISOString(),
      };
      return receipt;
    } catch (e) {
      this.lastResult = {
        ready: false,
        detail:
          e instanceof PlatformError
            ? e.message
            : stage + '未完成（页面未就绪或等待超时），尚未提交；这不是平台审核回执。',
        checkedAt: new Date().toISOString(),
      };
      if (e instanceof PlatformError) throw e;
      throw new PlatformError(this.lastResult.detail, 'rejected');
    } finally {
      combined.removeEventListener('abort', abort);
      await this.context?.close().catch(() => {});
      this.context = undefined;
      this.busy = false;
    }
  }
  async clearCache() {
    if (this.busy || !this.context) {
      this.clearCachePending = true;
      return { detail: 'B站网络缓存将在下次浏览器访问时清理；登录资料保留。' };
    }
    await clearNetworkCache(this.context);
    this.lastCacheClear = Date.now();
    return { detail: 'B站网络缓存已清理；登录资料保留。' };
  }
  async stop() {
    this.controller.abort();
    await this.context?.close().catch(() => {});
    this.context = undefined;
  }
}

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright-core';
import { findBrowserExecutable } from './bilibili-browser.ts';

export type PublicPostPlatform = 'tieba' | 'xiaohongshu';
export const isPublicPostPlatform = (value: unknown): value is PublicPostPlatform =>
  value === 'tieba' || value === 'xiaohongshu';
export const PUBLIC_POST_NAMES = { tieba: '百度贴吧', xiaohongshu: '小红书' } as const;
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
    : { host: 'www.xiaohongshu.com', path: /^\/(?:explore|discovery\/item)\/[a-f0-9]{24}\/?$/i };
  if (!url || url.origin !== 'https://' + spec.host || url.username || url.password || !spec.path.test(url.pathname))
    throw Error('请在官网打开' + PUBLIC_POST_NAMES[platform] + '原帖，再复制地址栏里的完整链接。');
  url.hash = '';
  if (platform === 'tieba') url.search = '';
  return url;
}
export class PublicPostBrowser {
  private readonly reading = new Set<PublicPostPlatform>();
  private readonly loginWindows = new Map<PublicPostPlatform, ChildProcess>();
  constructor(private readonly profileRoot: string) {}

  private checkAvailable(platform: PublicPostPlatform) {
    const window = this.loginWindows.get(platform);
    if (window && window.exitCode === null && window.signalCode === null)
      throw Error(PUBLIC_POST_NAMES[platform] + '专用登录窗口已打开，请完成登录并关闭窗口。');
    if (this.reading.has(platform)) throw Error(PUBLIC_POST_NAMES[platform] + '正在读取，请稍后再试。');
  }

  async openLogin(platform: PublicPostPlatform) {
    this.checkAvailable(platform);
    const executable = publicBrowserExecutable();
    if (!executable) throw Error('未找到 Microsoft Edge 或 Chrome。');
    const window = spawn(executable, [
      '--user-data-dir=' + join(this.profileRoot, platform),
      '--new-window', '--disable-background-mode', PUBLIC_POST_LOGIN_URLS[platform],
    ], { detached: true, stdio: 'ignore' });
    this.loginWindows.set(platform, window);
    const release = () => { if (this.loginWindows.get(platform) === window) this.loginWindows.delete(platform); };
    window.once('exit', release);
    await new Promise<void>((resolve, reject) => {
      window.once('spawn', resolve);
      window.on('error', () => { release(); reject(Error('打开专用登录窗口失败。')); });
    });
    window.unref();
  }

  private async withPublicPage<T>(platform: PublicPostPlatform, signal: AbortSignal, run: (page: import('playwright-core').Page) => Promise<T>) {
    signal.throwIfAborted();
    this.checkAvailable(platform);
    const executablePath = publicBrowserExecutable();
    if (!executablePath) throw Error('未找到 Microsoft Edge 或 Chrome。');
    this.reading.add(platform);
    let context: BrowserContext | undefined;
    const abort = () => { void context?.close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      context = await chromium.launchPersistentContext(join(this.profileRoot, platform), {
        executablePath, headless: true, chromiumSandbox: true, timeout: 15000,
        serviceWorkers: 'block', locale: 'zh-CN', args: ['--disable-notifications'],
      }).catch(() => { throw Error('后台浏览器启动失败。请先关闭该平台的专用登录窗口，再试读。'); });
      signal.throwIfAborted();
      await context.route('**/*', route => {
        const request = route.request();
        if (!['GET', 'HEAD'].includes(request.method())) return route.abort();
        if (['media', 'image', 'font'].includes(request.resourceType())) return route.abort();
        const address = new URL(request.url());
        if (address.protocol !== 'https:' || address.port || address.username || address.password || !/(?:^|\.)(?:baidu\.com|bdstatic\.com|xiaohongshu\.com|xhscdn\.com|rednote\.com)$/i.test(address.hostname)) return route.abort();
        if (request.isNavigationRequest() && !['tieba.baidu.com', 'passport.baidu.com', 'wappass.baidu.com', 'www.xiaohongshu.com', 'www.rednote.com'].includes(address.hostname)) return route.abort();
        return route.continue();
      });
      return await run(context.pages()[0] ?? await context.newPage());
    } catch (error) {
      if (signal.aborted) throw Error('本次读取已取消。');
      if (error instanceof Error && !/^(?:page|locator|browserContext)\./.test(error.message)) throw error;
      throw Error('官网页面连接失败或超时，请用专用登录窗口检查站点能否正常打开。');
    } finally {
      signal.removeEventListener('abort', abort);
      await context?.close().catch(() => {});
      this.reading.delete(platform);
    }
  }

  search(platform: PublicPostPlatform, query: string, signal: AbortSignal) {
    query = query.trim();
    if (!query) throw Error('先输入想搜的话题。');
    const url = new URL(platform === 'tieba' ? 'https://tieba.baidu.com/f/search/res' : 'https://www.xiaohongshu.com/search_result');
    url.searchParams.set(platform === 'tieba' ? 'qw' : 'keyword', query);
    return this.withPublicPage(platform, signal, async page => {
      const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 18000 });
      await page.locator(platform === 'tieba' ? 'a[href*="/p/"]' : 'a[href*="/explore/"], a[href*="/discovery/item/"]')
        .first().waitFor({ timeout: 6000 }).catch(() => {});
      signal.throwIfAborted();
      await verifyPublicPage(page, response?.status(), url);
      const links = await page.locator('a[href]').evaluateAll(nodes => nodes
        .slice(0, 400).map(node => ({ url: (node as HTMLAnchorElement).href, title: (node as HTMLElement).innerText.trim().slice(0, 160) })));
      const posts = new Map<string, { url: string; title: string }>();
      for (const link of links) {
        if (!link.title) continue;
        try {
          const target = publicPostUrl(platform, link.url);
          const key = target.pathname.replace(/\/$/, '');
          if (!posts.has(key)) posts.set(key, { title: link.title, url: target.href });
          if (posts.size >= 5) break;
        } catch { /* Skip navigation links and results from other sites. */ }
      }
      if (!posts.size) await checkAccessNotice(page);
      return { items: [...posts.values()], externalContent: true, detail: posts.size ? '只读取官网展示的首屏结果。' : '官网当前没有展示可识别的公开搜索结果。' };
    });
  }

  async read(platform: PublicPostPlatform, input: string, signal: AbortSignal) {
    const url = publicPostUrl(platform, input);
    return this.withPublicPage(platform, signal, async page => {
      const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 18000 });
      await verifyPublicPage(page, response?.status(), url);
      const postSelector = platform === 'tieba' ? '.d_post_content' : '#detail-desc, .note-content .desc';
      await page.locator(postSelector).first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
      signal.throwIfAborted();
      await verifyPublicPage(page, response?.status(), url);
      const title = (await page.locator(platform === 'tieba' ? '.core_title_txt, h1' : '#detail-title, h1')
        .first().textContent({ timeout: 1500 }).catch(() => ''))?.trim().slice(0, 160) || (await page.title()).slice(0, 160);
      const texts = await page.locator(postSelector).filter({ visible: true }).evaluateAll(nodes =>
        nodes.slice(0, 9).map(node => (node as HTMLElement).innerText.trim().slice(0, 700)));
      if (!texts[0]) {
        await checkAccessNotice(page);
        throw Error('官网没有展示可识别的原帖正文，可能已删除或页面结构有变化。');
      }
      const comments = platform === 'tieba' ? texts.slice(1) :
        await page.locator('.comments-container .comment-item .content').filter({ visible: true }).evaluateAll(nodes =>
          nodes.slice(0, 8).map(node => (node as HTMLElement).innerText.trim().slice(0, 500)));
      return { title, text: texts[0], comments: comments.filter(Boolean), url: url.origin + url.pathname,
        detail: comments.some(Boolean) ? '读取首屏公开内容；未加载隐藏或更多回复。' : '当前公开页面未展示可读评论。', externalContent: true };
    });
  }
}

async function verifyPublicPage(page: import('playwright-core').Page, status: number | undefined, expected: URL) {
  const current = new URL(page.url());
  if (/login|passport/i.test(current.hostname + current.pathname)) throw Error('平台要求登录。请在配置页打开该平台的专用登录窗口。');
  if (/captcha|verify|security/i.test(current.pathname) || /安全验证|人机验证/.test(await page.title()))
    throw Error('平台要求人工验证。请在专用登录窗口处理，完成后关闭窗口再试。');
  if (status && status >= 400) throw Error('平台返回 HTTP ' + status + '，当前无法公开读取。');
  if (current.origin !== expected.origin || current.pathname.replace(/\/$/, '') !== expected.pathname.replace(/\/$/, ''))
    throw Error('官网跳离了指定页面，可能需要登录或完整原帖链接。');
}
async function checkAccessNotice(page: import('playwright-core').Page) {
  const visible = (await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')).slice(0, 4000);
  if (/安全验证|请完成验证|访问异常/.test(visible))
    throw Error('平台要求人工验证。请在专用登录窗口处理，完成后关闭窗口再试。');
  if (/登录后查看|请先登录|登录后继续|登录后搜索/.test(visible))
    throw Error('平台要求登录。请在配置页打开该平台的专用登录窗口。');
}

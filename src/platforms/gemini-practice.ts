import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';

const origin = 'https://gemini.google.com';
const startUrl = origin + '/app';
const PRACTICE_PAGE_IDLE_MS = 120_000;
export interface PracticeTeacher {
  openLogin(conversation?: string): Promise<void>;
  verifyConversation(url: string): Promise<string>;
  readonly loginOpen?: boolean;
  close(): Promise<void>;
  practice(conversation: string, prompt: string, followup: string | undefined, signal: AbortSignal, report: (text: string) => void, reusePage?: boolean): Promise<void>;
}
export function conversationUrl(value: string) {
  const url = URL.parse(value);
  if (!url) throw Error('请粘贴专用 Gemini 教学会话的完整网址。');
  if (url.origin !== origin || url.username || url.password || !/^\/(?:u\/\d+\/)?app\/[a-z\d_-]{4,100}\/?$/i.test(url.pathname))
    throw Error('请粘贴 Gemini 教学会话网址，不要使用首页或分享链接。');
  return origin + url.pathname.replace(/\/$/, '');
}
function requireConversation(page: Page, expected: string) {
  const current = URL.parse(page.url());
  if (!current || current.origin + current.pathname.replace(/\/$/, '') !== expected)
    throw Error('Gemini 已离开绑定的教学会话，练习暂停。');
}
function onGemini(page: Page) {
  return new URL(page.url()).origin === origin;
}
const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true });
const composer = (page: Page) => visible(page, 'rich-textarea [contenteditable="true"], [contenteditable="true"][role="textbox"]');
const dialogue = (page: Page) => page.locator('user-query, model-response').filter({ visible: true });
// The page may hydrate old messages after the composer first appears.
function submittedExchange(page: Page, prompt: string, previousMatches = 0) {
  return dialogue(page).evaluateAll((nodes, { prompt, previousMatches }) => {
    const expected = prompt.replace(/\s+/gu, ' ').trim();
    let matches = 0;
    let responseIndex: number | undefined;
    let answerIndex = 0;
    let matchedLatestPrompt = false;
    for (const node of nodes) {
      if (node.localName === 'user-query') {
        const lines = [...node.querySelectorAll('.query-text-line')];
        const body = node.querySelector('.query-text') ?? node;
        const text = (lines.length ? lines.map(line => line.textContent || '').join(' ') :
          (body as HTMLElement).innerText || '').replace(/\s+/gu, ' ').trim();
        if (text === expected) matches++;
        matchedLatestPrompt = text === expected && matches > previousMatches;
        responseIndex = undefined;
      } else {
        if (matchedLatestPrompt) responseIndex = answerIndex;
        answerIndex++;
      }
    }
    return { matches, responseIndex };
  }, { prompt, previousMatches });
}
const answers = (page: Page) => visible(page, 'model-response');
function sendButton(page: Page) {
  return page.getByRole('button', { name: /^(?:Send(?: message| prompt)?|Submit|发送(?:消息|提示词)?|提交)$/i }).filter({ visible: true });
}
function stopButton(page: Page) {
  return page.getByRole('button', { name: /^(?:Stop(?: generating| response)?|停止(?:生成|响应)?)$/i }).filter({ visible: true });
}
async function pageIssue(page: Page) {
  if (page.isClosed()) return 'Gemini 窗口已关闭，练习暂停。';
  const host = new URL(page.url()).hostname;
  if (host === 'accounts.google.com') return 'Gemini 登录失效，请从专用窗口重新登录。';
  if (host === 'www.google.com' && new URL(page.url()).pathname.startsWith('/sorry/'))
    return 'Gemini 要求人工验证，请在专用窗口处理。';
  if (!onGemini(page)) return 'Gemini 跳转到其他站点，练习暂停。';
  // Only application notices count, never text from a prompt or an answer.
  const notices = await visible(page, '[role="alert"], mat-snack-bar-container').evaluateAll(nodes =>
    nodes.filter(node => !node.closest('user-query, model-response')).map(node => node.textContent ?? '').join(' '));
  if (/maximum (?:length|number of (?:messages|turns)) (?:of|for) (?:this|the) (?:chat|conversation)|(?:this |the )?(?:chat|conversation) (?:has reached (?:its|the) (?:maximum length|message limit)|is too long)|(?:这[个条]|当前|此)?(?:对话|会话|聊天)(?:已达到|已达|达到)(?:最大长度|长度上限|消息上限)|(?:这[个条]|当前|此)?(?:对话|会话|聊天)太长/iu.test(notices))
    return 'Gemini 提示这条教学会话已到长度上限。请新建教学会话，先完成一轮对话，再复制网址到扩展重新绑定。';
  if (/usage limit|rate limit|用量(?:已达|上限)|达到(?:使用|用量)(?:限制|上限)|请求过于频繁/iu.test(notices))
    return 'Gemini 提示已达使用额度或请求频率限制。等额度恢复后再检查并恢复训练。';
  const signInName = /^(?:sign in(?: to Google)?|登录(?: Google)?|登入)$/i;
  if (await page.getByRole('link', { name: signInName }).or(page.getByRole('button', { name: signInName })).filter({ visible: true }).count())
    return 'Gemini 尚未登录，请从专用窗口登录。';
  if (await visible(page, 'iframe[src*="recaptcha"], iframe[title*="reCAPTCHA"]').count() ||
      /unusual traffic|\/sorry\//i.test(page.url())) return 'Gemini 要求人工验证，请在专用窗口处理。';
  return undefined;
}

export class GeminiPractice implements PracticeTeacher {
  private context?: BrowserContext;
  private launching?: Promise<BrowserContext>;
  private loginWindow?: ChildProcess;
  private practicePage?: Page;
  private idleClose?: ReturnType<typeof setTimeout>;
  get loginOpen() {
    const window = this.loginWindow;
    return Boolean(window && window.exitCode === null && window.signalCode === null);
  }
  constructor(private profile: string) {}
  private async launch() {
    if (this.loginOpen) throw Error('请关闭专用 Edge 登录窗口，再绑定或开始练习。');
    if (this.context) return this.context;
    if (!this.launching) this.launching = (async () => {
      const context = await chromium.launchPersistentContext(this.profile, {
        channel: 'msedge', headless: true, chromiumSandbox: true, timeout: 18000,
        args: ['--disable-notifications'],
      }).catch(error => {
        if (error instanceof Error && /distribution .*not found|executable doesn't exist/i.test(error.message))
          throw Error('未找到 Microsoft Edge，请安装 Edge 后重试。');
        throw Error('后台 Edge 启动失败。请确认专用 Gemini 窗口已关闭，再试一次。');
      });
      this.context = context;
      context.once('close', () => { if (this.context === context) this.context = undefined; });
      return context;
    })();
    try { return await this.launching; } finally { this.launching = undefined; }
  }
  async openLogin(conversation?: string) {
    await this.close();
    if (this.loginOpen) throw Error('专用 Edge 已打开，请切到该窗口继续登录。');
    const candidates = process.platform === 'win32'
      ? [process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)',
        process.env.ProgramFiles || 'C:/Program Files', process.env.LOCALAPPDATA]
        .filter((path): path is string => Boolean(path))
        .map(path => join(path, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
      : process.platform === 'darwin'
        ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
        : ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'];
    const executable = candidates.find(path => existsSync(path));
    if (!executable) throw Error('未找到 Microsoft Edge，请安装 Edge 后重试。');
    // Google sign-in is performed by the user in a regular browser window.
    const url = conversation ? conversationUrl(conversation) : startUrl;
    const window = spawn(executable, [`--user-data-dir=${this.profile}`, '--new-window', url], {
      detached: true,
      stdio: 'ignore',
    });
    this.loginWindow = window;
    window.once('exit', () => { if (this.loginWindow === window) this.loginWindow = undefined; });
    await new Promise<void>((resolve, reject) => {
      window.once('spawn', resolve);
      window.on('error', () => {
        if (this.loginWindow === window) this.loginWindow = undefined;
        reject(Error('无法打开专用 Edge 登录窗口。'));
      });
    });
    window.unref();
  }
  private async openConversation(page: Page, conversation: string) {
    const response = await page.goto(conversation, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {
      throw Error('打开教学会话超时或网络中断。请先用专用 Edge 检查能否打开原会话，再点「检查并恢复训练」。');
    });
    if (response && response.status() >= 400) throw Error('Gemini 网页返回 HTTP ' + response.status() + '。请用专用 Edge 打开会话查看。');
    await composer(page).first().waitFor({ timeout: 10000 }).catch(() => {});
    const initialIssue = await pageIssue(page);
    if (initialIssue) throw Error(initialIssue);
    requireConversation(page, conversation);
    // Gemini can render an empty composer before loading the selected thread.
    const loaded = await page.locator('user-query, model-response').first()
      .waitFor({ state: 'attached', timeout: 20000 }).then(() => true, () => false);
    const issue = await pageIssue(page);
    if (issue) throw Error(issue);
    requireConversation(page, conversation);
    if (!loaded) throw Error('教学会话历史还未加载。请确认这条会话已有至少一轮对话，再检查网络或登录。');
    if (await composer(page).count() !== 1) throw Error('教学会话的输入框未就绪，请确认已登录且有权打开这个会话。');
  }
  async verifyConversation(value: string) {
    const conversation = conversationUrl(value);
    await this.close();
    const context = await this.launch();
    try {
      const page = context.pages()[0] ?? await context.newPage();
      await this.openConversation(page, conversation);
      return conversation;
    } catch (error) {
      if (error instanceof Error && !/^(?:page|locator|browserContext)\./.test(error.message)) throw error;
      throw Error('无法打开教学会话，请检查 Gemini 网页是否能正常访问。');
    } finally {
      await this.close();
    }
  }
  async close() {
    clearTimeout(this.idleClose);
    this.idleClose = undefined;
    this.practicePage = undefined;
    const context = this.context ?? await this.launching?.catch(() => undefined);
    await context?.close().catch(() => {});
  }
  private async ask(page: Page, conversation: string, prompt: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const issue = await pageIssue(page);
    if (issue) throw Error(issue);
    requireConversation(page, conversation);
    const editor = composer(page), send = sendButton(page);
    if (await stopButton(page).count()) throw Error('教学会话还有回复在生成，请等它完成。');
    if (await editor.count() !== 1) throw Error('Gemini 输入框结构有变化，未提交。');
    if ((await editor.innerText({ timeout: 3000 })).trim()) throw Error('教学会话有未发送的文字，已暂停。');
    const before = (await submittedExchange(page, prompt)).matches;
    requireConversation(page, conversation);
    await editor.fill(prompt, { timeout: 5000 }).catch(() => {
      throw Error('Gemini 输入框无法填写，这条没有发送。');
    });
    try {
      await send.waitFor({ state: 'visible', timeout: 5000 });
    } catch { throw Error('Gemini 发送按钮不可用，请检查网页是否要求登录或验证。'); }
    signal.throwIfAborted();
    const changed = await pageIssue(page);
    if (changed) throw Error(changed);
    if (await send.count() !== 1) throw Error('Gemini 发送按钮不唯一，未提交。');
    requireConversation(page, conversation);
    signal.throwIfAborted();
    await send.click({ timeout: 5000 }).catch(() => {
      throw Error('Gemini 发送按钮未确认点击成功。请先查看已绑定会话，避免重复发送。');
    });
    const until = Date.now() + 120000;
    let last = '', stable = 0;
    let sawPrompt = false;
    while (Date.now() < until) {
      signal.throwIfAborted();
      const blocked = await pageIssue(page);
      if (blocked) throw Error(blocked);
      requireConversation(page, conversation);
      const exchange = await submittedExchange(page, prompt, before);
      if (exchange.matches > before) sawPrompt = true;
      if (exchange.responseIndex !== undefined) {
        const answer = answers(page).nth(exchange.responseIndex);
        const body = answer.locator('.markdown, message-content').filter({ visible: true });
        const result = (await body.first().innerText({ timeout: 1200 }).catch(() => '')).trim();
        if (result && result === last) stable++;
        else stable = 0;
        last = result;
        const copy = answer.getByRole('button', { name: /^(?:copy(?: response| text)?|复制(?:回复|回答|文字)?)$/i });
        if (result && stable >= 2 && await stopButton(page).count() === 0 && await copy.count())
          return result.slice(0, 7000);
      } else {
        last = '';
        stable = 0;
      }
      await page.waitForTimeout(600);
    }
    throw Error(sawPrompt ? 'Gemini 已显示本次发问，但未确认对应回复完成。请查看已绑定会话。' :
      '点击发送后，已绑定会话未显示本次发问。请先在专用 Edge 核对消息是否送达，再检查并恢复训练。');
  }
  async practice(boundConversation: string, prompt: string, followup: string | undefined, signal: AbortSignal, report: (text: string) => void, reusePage = false) {
    signal.throwIfAborted();
    const conversation = conversationUrl(boundConversation);
    clearTimeout(this.idleClose);
    this.idleClose = undefined;
    const abort = () => { void this.close(); };
    signal.addEventListener('abort', abort, { once: true });
    let completed = false;
    try {
      const context = await this.launch();
      signal.throwIfAborted();
      let page = this.practicePage;
      if (!page || page.isClosed()) {
        page = context.pages()[0] ?? await context.newPage();
        await this.openConversation(page, conversation);
        this.practicePage = page;
      }
      report(await this.ask(page, conversation, prompt, signal));
      if (followup) report(await this.ask(page, conversation, followup, signal));
      completed = true;
    } catch (error) {
      if (signal.aborted) throw Error('练习已取消。');
      if (error instanceof Error && !/^(?:page|locator|browserContext)\./.test(error.message)) throw error;
      throw Error('Gemini 网页在操作中关闭，或回复区无法读取。请先查看已绑定会话核对这条消息。');
    } finally {
      signal.removeEventListener('abort', abort);
      if (completed && reusePage && !signal.aborted) {
        this.idleClose = setTimeout(() => { void this.close(); }, PRACTICE_PAGE_IDLE_MS);
        this.idleClose.unref();
      } else {
        await this.close();
      }
    }
  }
}

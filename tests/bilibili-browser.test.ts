import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import {
  BilibiliBrowserSender,
  prepareCommentArea,
  mergeBrowserDeviceCookies,
  findBrowserExecutable,
  submitCommentPage,
  commentPageUrl,
  matchesCommentRequest,
} from '../src/platforms/bilibili-browser.ts';

const target = { oid: '99', type: 1, root: '100', parent: '101' };
const text = '你好，这是一次测试。';

it('does not accept a different floor, extra content, or a different comment area', () => {
  const form = new URLSearchParams({ ...target, type: '1', message: text });
  expect(matchesCommentRequest(form, target, text)).toBe(true);
  form.set('parent', '102');
  expect(matchesCommentRequest(form, target, text)).toBe(false);
  form.set('parent', '101');
  form.set('message', text + '多出的内容');
  expect(matchesCommentRequest(form, target, text)).toBe(false);
});
it('builds only official video pages and refuses unsupported comment types', () => {
  const url = new URL(commentPageUrl(target));
  expect(url.origin).toBe('https://www.bilibili.com');
  expect(url.searchParams.get('comment_root_id')).toBe('100');
  expect(url.searchParams.get('comment_secondary_id')).toBe('101');
  expect(() => commentPageUrl({ ...target, type: 11 })).toThrow();
});

// Offline browser fixture: every request is intercepted; no real account or comment is used.
describe.skipIf(!findBrowserExecutable())('official page submission boundaries', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: findBrowserExecutable(), headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  async function fixture(
    options: {
      wrongParent?: boolean;
      reject?: boolean;
      timeout?: boolean;
      dynamic?: boolean;
      wrongResource?: boolean;
      twice?: boolean;
    } = {},
  ) {
    const page = await browser.newPage();
    await page.context().setOffline(true);
    let accepted = 0;
    await page.route('**/*', async (route) => {
      if (route.request().url().includes('/x/v2/reply/add')) {
        accepted++;
        if (options.timeout) return route.abort();
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(
            options.reject
              ? { code: 12015, message: '请完成验证' }
              : { code: 0, data: { rpid_str: '1234567890123456789', reply: { state: 0 } } },
          ),
        });
      }
      await route.fulfill({
        contentType: 'text/html',
        body: `<html><body><bili-comments ${options.dynamic ? 'data-params="11,' + (options.wrongResource ? '98' : '99') + '"' : ''}><bili-comment-renderer></bili-comment-renderer><bili-comment-box></bili-comment-box></bili-comments><script>
        const renderer=document.querySelector('bili-comment-renderer');renderer.data={rpid_str:'101',root_str:'100'};
        renderer.attachShadow({mode:'open'}).innerHTML='<bili-comment-action-buttons-renderer><div id="reply"><button>回复</button></div></bili-comment-action-buttons-renderer>';
        const box=document.querySelector('bili-comment-box');box.reply={rpid_str:'101',root_str:'100'};box.placeholder='';
        box.attachShadow({mode:'open'}).innerHTML='<textarea></textarea><div id="pub"><button>发布</button></div>';
        box.shadowRoot.querySelector('button').onclick=()=>{const request=()=>fetch('https://api.bilibili.com/x/v2/reply/add',{method:'POST',body:new URLSearchParams({oid:'99',type:'${options.dynamic ? 11 : 1}',root:'100',parent:'${options.wrongParent ? '102' : '101'}',message:box.shadowRoot.querySelector('textarea').value})});request();${options.twice ? 'request();' : ''}};
      </script></body></html>`,
      });
    });
    await page.goto(
      commentPageUrl(
        options.dynamic ? { ...target, type: 11 } : target,
        options.dynamic ? 'https://t.bilibili.com/1234567890123456789' : undefined,
      ),
    );
    return { page, accepted: () => accepted };
  }
  it('uses the visible header editor rather than a hidden unused reply box for top-level comments', async () => {
    const page = await browser.newPage();
    await page.context().setOffline(true);
    let sent = 0;
    await page.route('**/*', async (route) => {
      if (route.request().url().includes('/x/v2/reply/add')) {
        sent++;
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ code: 0, data: { rpid_str: '77' } }),
        });
      }
      return route.fulfill({
        contentType: 'text/html',
        body: `<bili-comments><bili-comment-box style="display:none"></bili-comment-box><bili-comments-header-renderer></bili-comments-header-renderer></bili-comments><script>
      const hidden=document.querySelector('bili-comment-box');hidden.attachShadow({mode:'open'}).innerHTML='<textarea></textarea><div id="pub"><button>发布</button></div>';
      const header=document.querySelector('bili-comments-header-renderer');header.attachShadow({mode:'open'}).innerHTML='<bili-comment-box></bili-comment-box>';
      const box=header.shadowRoot.querySelector('bili-comment-box');box.attachShadow({mode:'open'}).innerHTML='<textarea></textarea><div id="pub"><button>发布</button></div>';
      box.shadowRoot.querySelector('button').onclick=()=>fetch('https://api.bilibili.com/x/v2/reply/add',{method:'POST',body:new URLSearchParams({oid:'99',type:'1',root:'0',parent:'0',message:box.shadowRoot.querySelector('textarea').value})});
      </script>`,
      });
    });
    try {
      const top = { oid: '99', type: 1, root: '0', parent: '0' };
      await page.goto(commentPageUrl(top));
      page.setDefaultTimeout(800);
      expect((await submitCommentPage(page, top, text, undefined, 800)).receiptId).toBe('77');
      expect(sent).toBe(1);
    } finally {
      await page.close();
    }
  });
  it('scrolls an already mounted comment shell into view so its deferred content can load', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        '<div style="height:3000px"></div><div id="commentapp" style="height:80px"><bili-comments>评论区</bili-comments></div>',
      );
      await prepareCommentArea(page);
      const visible = await page.locator('#commentapp').evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.top < innerHeight && r.bottom > 0;
      });
      expect(visible).toBe(true);
    } finally {
      await page.close();
    }
  });
  it('loads a lazy comment component by first scrolling its existing container', async () => {
    const page = await browser.newPage();
    await page.context().setOffline(true);
    try {
      await page.setContent(
        '<div style="height:3000px"></div><div id="commentapp" style="height:40px"></div>',
      );
      await page.evaluate(() => {
        const container = document.getElementById('commentapp')!;
        const observer = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            container.append(document.createElement('bili-comments'));
            observer.disconnect();
          }
        });
        observer.observe(container);
      });
      expect(await page.locator('bili-comments').count()).toBe(0);
      await prepareCommentArea(page);
      expect(await page.locator('bili-comments').count()).toBe(1);
    } finally {
      await page.close();
    }
  });
  it('replies in the exact dynamic thread and refuses another dynamic resource', async () => {
    const ok = await fixture({ dynamic: true });
    try {
      expect(
        (await submitCommentPage(ok.page, { ...target, type: 11 }, text, undefined, 1000))
          .receiptId,
      ).toBe('1234567890123456789');
      expect(ok.accepted()).toBe(1);
    } finally {
      await ok.page.close();
    }
    const bad = await fixture({ dynamic: true, wrongResource: true });
    try {
      await expect(
        submitCommentPage(bad.page, { ...target, type: 11 }, text, undefined, 1000),
      ).rejects.toThrow('目标编号');
      expect(bad.accepted()).toBe(0);
    } finally {
      await bad.page.close();
    }
  });
  it('uses the page input and sends exactly one matching request', async () => {
    const x = await fixture();
    try {
      const receipt = await submitCommentPage(x.page, target, text, undefined, 1000);
      expect(receipt).toMatchObject({ receiptId: '1234567890123456789', transport: 'browser' });
      expect(x.accepted()).toBe(1);
    } finally {
      await x.page.close();
    }
  });
  it('blocks a page retry while preserving the first accepted receipt', async () => {
    const x = await fixture({ twice: true });
    try {
      expect((await submitCommentPage(x.page, target, text, undefined, 1000)).receiptId).toBe(
        '1234567890123456789',
      );
      expect(x.accepted()).toBe(1);
    } finally {
      await x.page.close();
    }
  });
  it('blocks a wrong-floor submission before it reaches the server', async () => {
    const x = await fixture({ wrongParent: true });
    try {
      await expect(submitCommentPage(x.page, target, text, undefined, 1000)).rejects.toMatchObject({
        kind: 'rejected',
      });
      expect(x.accepted()).toBe(0);
    } finally {
      await x.page.close();
    }
  });
  it('does not retry when the server asks for human verification', async () => {
    const x = await fixture({ reject: true });
    try {
      await expect(submitCommentPage(x.page, target, text, undefined, 1000)).rejects.toMatchObject({
        kind: 'rejected',
      });
      expect(x.accepted()).toBe(1);
    } finally {
      await x.page.close();
    }
  });
  it('keeps a missing response ambiguous and does not click again', async () => {
    const x = await fixture({ timeout: true });
    try {
      await expect(submitCommentPage(x.page, target, text, undefined, 250)).rejects.toMatchObject({
        kind: 'network',
      });
      expect(x.accepted()).toBe(1);
    } finally {
      await x.page.close();
    }
  });
});

it('refuses a changed account before launching a browser', async () => {
  const sender = new BilibiliBrowserSender(
    '__unused__',
    () => 'SESSDATA=test; bili_jct=test; DedeUserID=42',
    () => {},
    () => process.execPath,
  );
  await expect(sender.send(target, text, undefined, '43')).rejects.toMatchObject({ kind: 'auth' });
  expect(sender.status().running).toBe(false);
});

it('never replaces verified login with an incomplete browser cookie jar', () => {
  const source =
    'SESSDATA=approved-session; bili_jct=approved-csrf; DedeUserID=42; buvid3=old-device';
  const merged = mergeBrowserDeviceCookies(source, [
    { name: 'buvid3', value: 'browser-device' },
    { name: 'bili_jct', value: 'partial-cookie' },
  ]);
  expect(merged).toContain('SESSDATA=approved-session');
  expect(merged).toContain('bili_jct=approved-csrf');
  expect(merged).toContain('buvid3=browser-device');
  expect(merged).not.toContain('partial-cookie');
});

it('resolves a canonical dynamic page only with a trusted URL and refuses synchronization side effects', () => {
  const t = { ...target, type: 11 };
  expect(() => commentPageUrl(t)).toThrow();
  const url = new URL(commentPageUrl(t, 'https://t.bilibili.com/1234567890123456789'));
  expect(url.origin).toBe('https://t.bilibili.com');
  expect(url.pathname).toBe('/1234567890123456789');
  expect(url.searchParams.get('comment_root_id')).toBe('100');
  expect(() => commentPageUrl(t, 'https://evil.test/123')).toThrow();
  const form = new URLSearchParams({ ...target, type: '1', message: text, is_sync: '1' });
  expect(matchesCommentRequest(form, target, text)).toBe(false);
});

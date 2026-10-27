import { describe, expect, it } from 'vitest';
import { dynamicId, mapDynamicPage } from '../src/platforms/bilibili-dynamics.ts';
const row = (id = '1261990610011684873', mid = '7') => ({
  id_str: id,
  type: 'DYNAMIC_TYPE_WORD',
  basic: { comment_type: 17, comment_id_str: id },
  modules: {
    module_author: { mid, name: '朋友', pub_ts: 123 },
    module_dynamic: {
      major: {
        type: 'MAJOR_TYPE_OPUS',
        opus: { title: '今天', summary: { text: '<b>一句动态</b>' }, pics: [{}] },
      },
    },
  },
});
describe('Bilibili dynamic boundaries', () => {
  it('keeps exact identifiers, canonical links and bounded visible text', () => {
    const d = mapDynamicPage({ code: 0, data: { items: [row()], has_more: true } }, 5);
    expect(d.items[0]).toMatchObject({
      id: '1261990610011684873',
      authorId: '7',
      text: '一句动态',
      imageCount: 1,
      url: 'https://t.bilibili.com/1261990610011684873',
      target: { oid: '1261990610011684873', type: 17, root: '0', parent: '0' },
    });
    expect(d.hasMore).toBe(true);
  });
  it('does not substitute recommended works for a requested creator', () => {
    expect(
      mapDynamicPage({ code: 0, data: { items: [row(), row('123', '8')] } }, 5, '8').items.map(
        (x) => x.authorId,
      ),
    ).toEqual(['8']);
  });
  it('rejects unsafe IDs, redirects and server rejections rather than claiming an empty feed', () => {
    expect(() => dynamicId('https://evil.test/123')).toThrow();
    expect(() => dynamicId(1261990610011684873 as never)).toThrow();
    expect(dynamicId('https://www.bilibili.com/opus/1261990610011684873')).toBe(
      '1261990610011684873',
    );
    expect(() => mapDynamicPage({ code: -352, message: '验证' }, 5)).toThrow(/验证/);
  });
  it('limits a huge response and ignores malformed authors and comment targets', () => {
    const bad = row();
    bad.modules.module_author.mid = 'javascript:1';
    const result = mapDynamicPage(
      {
        code: 0,
        data: { items: [bad, ...Array.from({ length: 100 }, (_, i) => row(String(i + 1)))] },
      },
      3,
    );
    expect(result.items).toHaveLength(3);
    expect(JSON.stringify(result).length).toBeLessThan(6500);
  });
});

import { beforeAll, afterAll, vi } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { BilibiliBrowserSender, findBrowserExecutable } from '../src/platforms/bilibili-browser.ts';
describe.skipIf(!findBrowserExecutable())('Bilibili dynamic real-browser read boundaries', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: findBrowserExecutable(), headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  it('blocks opaque gateway and ordinary write requests, reads only the exact creator and releases the context', async () => {
    const context = await browser.newContext();
    await context.setOffline(true);
    const page = await context.newPage();
    let writes = 0;
    await context.route('**/*', async (route) => {
      const r = route.request(),
        u = new URL(r.url());
      if (r.method() !== 'GET') {
        writes++;
        return route.abort();
      }
      if (u.pathname === '/x/polymer/web-dynamic/v1/feed/space')
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ code: 0, data: { items: [row()], has_more: false } }),
        });
      return route.fulfill({
        contentType: 'text/html',
        body: `<html><script>fetch('https://api.bilibili.com/x/internal/gaia-gateway/ExClimbCongLing',{method:'POST',body:'opaque'}).catch(()=>{});fetch('https://api.bilibili.com/x/dynamic/feed/create/dyn',{method:'POST',body:'unsafe'}).catch(()=>{});fetch('https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=7');</script></html>`,
      });
    });
    const sender = new BilibiliBrowserSender(
      'unused',
      () => 'same-session',
      () => {},
      () => '',
      () => false,
    );
    vi.spyOn(sender as any, 'open').mockResolvedValue({
      page,
      context,
      account: { id: '42', name: '测试' },
    });
    const r = await sender.readDynamics({ ownerId: '7', limit: 3 }, undefined, '42');
    expect(r.items[0].id).toBe('1261990610011684873');
    expect(r.accountId).toBe('42');
    expect(writes).toBe(0);
    expect(browser.contexts()).toHaveLength(0);
  });
});

it.skipIf(!findBrowserExecutable())(
  'verifies a manual official website login before saving and does not close it from normal reads',
  async () => {
    const browser = await chromium.launch({
      executablePath: findBrowserExecutable(),
      headless: true,
    });
    const context = await browser.newContext();
    await context.setOffline(true);
    await context.route('**/*', (r) =>
      r.fulfill({ contentType: 'text/html', body: '<title>官方登录夹具</title>' }),
    );
    await context.addCookies([
      { name: 'SESSDATA', value: 'test-session', domain: '.bilibili.com', path: '/' },
      { name: 'bili_jct', value: 'test-csrf', domain: '.bilibili.com', path: '/' },
      { name: 'DedeUserID', value: '42', domain: '.bilibili.com', path: '/' },
    ]);
    const launch = vi.spyOn(chromium, 'launchPersistentContext').mockResolvedValue(context);
    const get = vi
      .spyOn(context.request, 'get')
      .mockResolvedValue({
        ok: () => true,
        text: async () =>
          JSON.stringify({ code: 0, data: { isLogin: true, mid: 42, uname: '测试' } }),
      } as any);
    let saved = '';
    const sender = new BilibiliBrowserSender(
      'unused',
      () => saved,
      (v) => {
        saved = v;
      },
      () => '',
      () => false,
    );
    try {
      await sender.openLogin();
      expect(launch.mock.calls[0][1]?.headless).toBe(false);
      expect(sender.status().loginOpen).toBe(true);
      await expect(sender.readDynamics({})).rejects.toMatchObject({ kind: 'auth' });
      expect(sender.status().loginOpen).toBe(true);
      const result = await sender.finishLogin();
      expect(result.account.id).toBe('42');
      expect(saved).toContain('DedeUserID=42');
      expect(JSON.stringify(result)).not.toMatch(/test-session|test-csrf/);
      expect(browser.contexts()).toHaveLength(0);
    } finally {
      get.mockRestore();
      launch.mockRestore();
      await sender.stop();
      await browser.close();
    }
  },
);

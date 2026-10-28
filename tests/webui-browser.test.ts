import { SOCIALMEDIA_DEFAULTS } from '../src/config.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright-core';
import { findBrowserExecutable } from '../src/platforms/bilibili-browser.ts';
describe.skipIf(!findBrowserExecutable())('timeline in a real browser', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: findBrowserExecutable(), headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  async function fixture(width: number, settings = false) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.context().setOffline(true);
    const outbox = Array.from({ length: 12 }, (_, i) => ({
      id: 'post-' + i,
      platform: 'bilibili',
      accountId: '42',
      text: '一个值得认真回应的小细节。'.repeat(12),
      target: { oid: String(90 + i), type: 1, root: '0', parent: '0' },
      createdAt: new Date(1700000000000 + i * 1000).toISOString(),
      status: 'sent',
      receiptId: String(700 + i),
      visibility: { status: 'public', checkedAt: '2026-01-01', detail: '已核验' },
    }));
    const data = {
      config: structuredClone(SOCIALMEDIA_DEFAULTS),
      resources: {
        todayCalls: 2,
        maxDailyVisualCalls: 20,
        publishedBytes: 1024,
        maxPublishedBytes: 536870912,
        cacheBytes: 1024,
        cacheEntries: 1,
        cacheDays: 7,
        history: { count: 1, sent: 1, bytes: 16384, recent: 12, maxArchiveBytes: 536870912 },
      },
      credentialSaved: true,
      pending: 0,
      unknown: 0,
      platforms: [],
      inbox: [],
      outbox,
      videos: outbox.map((r, i) => ({
        aid: r.target.oid,
        title: '关于小细节的开发日志 ' + i,
        id: 'av' + r.target.oid,
        url: 'https://www.bilibili.com/video/av' + r.target.oid + '/',
        updatedAt: '',
      })),
    };
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/webui.js')
        return route.fulfill({
          contentType: 'application/javascript',
          body: readFileSync(new URL('../dist/webui.js', import.meta.url), 'utf8'),
        });
      if (path === '/style.css')
        return route.fulfill({
          contentType: 'text/css',
          body: readFileSync(new URL('../dist/webui.css', import.meta.url), 'utf8'),
        });
      return route.fulfill({
        contentType: 'text/html',
        body:
          '<html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><style>body{margin:0;overflow:hidden;background:#151515;color:#e8e2dc;font:14px sans-serif;color-scheme:dark}#host{height:100dvh;overflow:auto;padding:28px}</style></head><body><div id="host"><main id="root"></main></div><script type="module">import{mount,mountSettings}from"/webui.js";window.testState=' +
          JSON.stringify(data) +
          ';window.calls=[];window.refreshers=[];' +
          (settings ? 'mountSettings' : 'mount') +
          '({root:document.getElementById("root"),signal:new AbortController().signal,invoke:async(method)=>{window.calls.push(method);if(method==="clearMediaCache")return{removed:1};if(method==="history")return{items:[{...window.testState.outbox[0],id:"archived-old",text:"归档里的原话",target:{oid:"11",type:1,root:"0",parent:"0"}}]};return structuredClone(window.testState)},setConfig:async()=>"",interval:fn=>{window.refreshers.push(fn);return{dispose(){}}}});</script></body></html>',
      });
    });
    await page.goto('http://socialmedia.test/');
    if (settings) await page.getByRole('heading', { name: '观察与资源', exact: true }).waitFor();
    else await page.locator('.sm-video').first().waitFor();
    return page;
  }
  it('keeps the visible reading anchor when a newer video thread arrives', async () => {
    const page = await fixture(1100);
    try {
      await page.locator('.sm-video').nth(5).locator('summary').first().scrollIntoViewIfNeeded();
      const before = await page
        .locator('.sm-video')
        .nth(5)
        .evaluate((n) => ({
          key: (n as HTMLElement).dataset.groupKey,
          offset: n.getBoundingClientRect().top,
        }));
      await page.evaluate(() => {
        const w = window as unknown as {
          testState: { outbox: Array<Record<string, unknown>> };
          refreshers: Array<() => void>;
        };
        w.testState.outbox.push({
          ...w.testState.outbox[0],
          id: 'brand-new',
          target: { oid: '10000', type: 1, root: '0', parent: '0' },
          createdAt: new Date().toISOString(),
        });
        w.refreshers[1]();
      });
      await page.locator('[data-event-id="out:brand-new"]').waitFor({ state: 'attached' });
      const after = await page
        .locator('.sm-video')
        .evaluateAll(
          (nodes, key) =>
            nodes.find((n) => (n as HTMLElement).dataset.groupKey === key)!.getBoundingClientRect()
              .top,
          before.key,
        );
      expect(Math.abs(after - before.offset)).toBeLessThan(3);
      expect(await page.getByRole('button', { name: '有新动态 · 回到最新' }).isVisible()).toBe(
        true,
      );
    } finally {
      await page.close();
    }
  });
  it('scrolls from page margins and card text using the same host scroll area', async () => {
    const page = await fixture(1100);
    try {
      expect(
        await page.locator('.sm-video').first().getAttribute('open', { timeout: 1500 }),
      ).toBeNull();
      await page.mouse.move(1090, 400);
      await page.mouse.wheel(0, 400);
      await page.waitForFunction(() => document.querySelector('#host')!.scrollTop > 50, undefined, {
        timeout: 1500,
      });
      const first = await page.locator('#host').evaluate((n) => n.scrollTop);
      await page.mouse.move(500, 400);
      await page.mouse.wheel(0, 300);
      await page.waitForFunction(
        (old) => document.querySelector('#host')!.scrollTop > old + 50,
        first,
        { timeout: 1500 },
      );
      expect(
        await page.locator('.sm-timeline').evaluate((n) => getComputedStyle(n).overflowY),
      ).toBe('visible');
      await page.locator('input[type=search]').fill('小细节', { timeout: 1500 });
      expect(
        await page.locator('.sm-video').first().getAttribute('open', { timeout: 1500 }),
      ).not.toBeNull();
      await page.locator('input[type=search]').fill('', { timeout: 1500 });
      expect(
        await page.locator('.sm-video').first().getAttribute('open', { timeout: 1500 }),
      ).toBeNull();
    } finally {
      await page.close();
    }
  });
  it('fits a narrow screen without horizontal overflow and can filter sent comments', async () => {
    const page = await fixture(420);
    try {
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      await page.getByRole('button', { name: '待回应', exact: true }).click();
      await page.getByText('暂时没有需要回应的评论。').waitFor();
      await page.getByRole('button', { name: '已发出', exact: true }).click();
      await page.locator('.sm-video').first().waitFor();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
    } finally {
      await page.close();
    }
  });
  it('keeps resource controls usable on a narrow screen and reports cache cleanup without posting', async () => {
    const page = await fixture(420, true);
    try {
      expect(await page.getByText('容量与保留策略', { exact: true }).isVisible()).toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      await page.getByText('缓存与记录维护', { exact: true }).click();
      await page.getByRole('button', { name: '清理图片缓存', exact: true }).click();
      await page
        .getByText('已清理1份本World图片缓存；历史附件与累计预算保留。', { exact: true })
        .waitFor();
      expect(await page.evaluate(() => (window as any).calls.includes('publish'))).toBe(false);
    } finally {
      await page.close();
    }
  });
  it('keeps platform settings together with collapsed focus and distinct soft colors on a narrow screen', async () => {
    const page = await fixture(420, true);
    try {
      const colors = await page.locator('.sm-platform-card').evaluateAll((nodes) =>
        nodes.map((n) => ({
          id: (n as HTMLElement).dataset.platform,
          color: getComputedStyle(n).getPropertyValue('--sm-accent').trim(),
        })),
      );
      expect(colors.map((n) => n.id)).toEqual(['bilibili', 'douyin', 'kuaishou']);
      expect(new Set(colors.map((n) => n.color)).size).toBe(3);
      await page.getByRole('tab', { name: '快手', exact: true }).click();
      const focus = page.locator('.sm-platform-card[data-platform="kuaishou"] .sm-platform-focus');
      expect(await focus.getAttribute('open')).toBeNull();
      await focus.locator(':scope > summary').click();
      const input = focus.locator('[aria-label="快手主人主页或快手号"]');
      await input.fill('custom-owner-123');
      await page.evaluate(() => {
        (window as any).refreshers[1]();
      });
      await page.getByRole('tab', { name: '哔哩哔哩', exact: true }).click();
      await page.getByRole('tab', { name: '快手', exact: true }).click();
      expect(await input.inputValue()).toBe('custom-owner-123');
      expect(await focus.getAttribute('open')).not.toBeNull();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      expect(await page.evaluate(() => (window as any).calls.includes('publish'))).toBe(false);
    } finally {
      await page.close();
    }
  });
  it('carries the platform color through video groups and outgoing replies', async () => {
    const page = await fixture(1100);
    try {
      await page.evaluate(() => {
        const w = window as any;
        for (const [platform, type] of [
          ['douyin', 2],
          ['kuaishou', 3],
        ])
          w.testState.outbox.push({
            ...w.testState.outbox[0],
            id: platform,
            platform,
            target: { oid: platform + 'video123', type, root: '0', parent: '0' },
          });
        w.refreshers[1]();
      });
      await page.locator('.sm-video[data-platform="kuaishou"]').waitFor();
      for (const id of ['bilibili', 'douyin', 'kuaishou']) {
        const group = page.locator('.sm-video[data-platform="' + id + '"]').first();
        await group.locator('summary').first().click();
        const colors = await group.evaluate((n) => ({
          group: getComputedStyle(n).getPropertyValue('--sm-accent'),
          reply: getComputedStyle(n.querySelector('.sm-outgoing')!).getPropertyValue('--sm-accent'),
        }));
        expect(colors.group.trim()).toBeTruthy();
        expect(colors.reply).toBe(colors.group);
      }
    } finally {
      await page.close();
    }
  });
  it('loads archived sends into the existing per-video timeline on demand', async () => {
    const page = await fixture(1100);
    try {
      await page.getByRole('button', { name: /查看较早发言/ }).click();
      await page.locator('[data-event-id="out:archived-old"]').waitFor({ state: 'attached' });
      expect(await page.locator('.sm-video').count()).toBe(13);
    } finally {
      await page.close();
    }
  });

  it('gives expanded settings a distinct surface and keeps nested controls visually inset', async () => {
    const page = await fixture(420, true);
    try {
      const fold = page.locator('.sm-platform-card[data-platform=bilibili] .sm-platform-focus');
      const before = await fold.evaluate((n) => getComputedStyle(n).backgroundColor);
      await fold.locator(':scope > summary').click();
      const after = await fold.evaluate((n) => ({
        background: getComputedStyle(n).backgroundColor,
        padding: parseFloat(getComputedStyle(n).paddingLeft),
        border: parseFloat(getComputedStyle(n).borderLeftWidth),
      }));
      expect(after.background).not.toBe(before);
      expect(after.padding).toBeGreaterThan(0);
      expect(after.border).toBeGreaterThan(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    } finally {
      await page.close();
    }
  });
  it('renders group chats in the same platform cards without narrow-screen overflow or reading jumps', async () => {
    const page = await fixture(420);
    try {
      await page.evaluate(async () => {
        const w = window as any;
        w.testState.groupChat = {
          enabled: true,
          allowSend: true,
          activity: 'active',
          groups: [
            {
              id: '123456',
              name: '示例群聊',
              connection: 'online',
              connected: true,
              checkedAt: Date.now(),
              lastMessageAt: 1000,
              pending: 0,
              messages: Array.from({ length: 20 }, (_, i) => ({
                id: 'm' + i,
                text: '一段可以公开讨论的群聊原话。'.repeat(8),
                time: 1000 + i,
                sender: '群友' + i,
                own: i % 3 === 0,
              })),
            },
          ],
          outbox: [],
        };
        for (const f of w.refreshers) await f();
      });
      const card = page.locator('.sm-group-card');
      await card.waitFor({ state: 'attached' });
      await card.locator('summary').first().click();
      const entry = card.locator('.sm-event').nth(8);
      await entry.scrollIntoViewIfNeeded();
      const before = await entry.boundingBox();
      await page.evaluate(async () => {
        const w = window as any;
        w.savedGroup = document.querySelector('.sm-group-card');
        w.testState.groupChat.groups[0].checkedAt += 1000;
        for (const f of w.refreshers) await f();
      });
      expect(
        await page.evaluate(
          () => (window as any).savedGroup === document.querySelector('.sm-group-card'),
        ),
      ).toBe(true);
      await page.evaluate(async () => {
        const w = window as any;
        w.testState.groupChat.groups[0].messages.push({
          id: 'new',
          text: '新增原话',
          time: 9999,
          sender: '另一位群友',
          own: false,
        });
        for (const f of w.refreshers) await f();
      });
      const after = await card.locator('[data-anchor="group-message:123456:m11"]').boundingBox();
      expect(Math.abs(after!.y - before!.y)).toBeLessThan(3);
      expect(await card.getAttribute('open')).not.toBeNull();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        (await card.evaluate((n) => getComputedStyle(n).getPropertyValue('--sm-accent'))).trim(),
      ).toBeTruthy();
    } finally {
      await page.close();
    }
  });
  it('uses one platform-colored disclosure style for groups, dynamics and nested settings', async () => {
    const page = await fixture(720);
    try {
      await page.evaluate(async () => {
        const w = window as any;
        w.testState.groupChat = {
          enabled: true,
          allowSend: false,
          activity: 'balanced',
          groups: [
            {
              id: '123',
              name: '测试群',
              connected: false,
              connection: 'unbound',
              pending: 0,
              messages: [],
            },
          ],
          outbox: [],
        };
        w.testState.dynamics = {
          enabled: true,
          items: [
            {
              id: '1',
              author: '测试',
              publishedAt: 1,
              text: '动态正文',
              url: 'https://t.bilibili.com/1',
              imageCount: 0,
            },
          ],
          posts: [],
        };
        for (const f of w.refreshers) await f();
      });
      const group = page.locator('.sm-group-records');
      expect(await group.evaluate((n) => n.tagName)).toBe('DETAILS');
      expect(
        (await group.evaluate((n) => getComputedStyle(n).getPropertyValue('--sm-accent'))).trim(),
      ).toBe('#e38eb8');
      for (const summary of await page
        .locator('.sm-group-records > summary,.sm-focus-card[data-platform="bilibili"] > summary')
        .all()) {
        expect(await summary.evaluate((n) => getComputedStyle(n, '::after').content)).toBe('""');
        expect(await summary.evaluate((n) => getComputedStyle(n, '::after').borderRightStyle)).toBe(
          'solid',
        );
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    } finally {
      await page.close();
    }
  });
});

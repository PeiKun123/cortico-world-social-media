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
          body: readFileSync(new URL('../dist/webui-surf-idle-clock.js', import.meta.url), 'utf8'),
        });
      if (path === '/style.css')
        return route.fulfill({
          contentType: 'text/css',
          body: readFileSync(new URL('../dist/webui-surf-idle-clock.css', import.meta.url), 'utf8'),
        });
      return route.fulfill({
        contentType: 'text/html',
        body:
          '<html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><style>body{margin:0;overflow:hidden;background:#151515;color:#e8e2dc;font:14px sans-serif;color-scheme:dark}#host{height:100dvh;overflow:auto;padding:28px}</style></head><body><div id="host"><main id="root"></main></div><script type="module">import{mount,mountSettings}from"/webui.js";window.testState=' +
          JSON.stringify(data) +
          ';window.calls=[];window.refreshers=[];' +
          (settings ? 'mountSettings' : 'mount') +
          '({root:document.getElementById("root"),signal:new AbortController().signal,invoke:async(method,args)=>{window.calls.push(method);if(method==="settings")window.savedSettings=args[0];if(method==="expressionList"){const rows=window.testState.practiceRows??[];const p=args[1]??1;return{settings:window.testState.config.experiments??{},samples:[],practicePage:p,practicePages:Math.max(1,Math.ceil(rows.length/3)),practiceTotal:rows.length,practices:rows.slice((p-1)*3,p*3),handbook:[]};}if(method==="clearMediaCache")return{removed:1};if(method==="history")return{items:[{...window.testState.outbox[0],id:"archived-old",text:"归档里的原话",target:{oid:"11",type:1,root:"0",parent:"0"}}]};return structuredClone(window.testState)},setConfig:async()=>"",interval:fn=>{window.refreshers.push(fn);return{dispose(){}}}});</script></body></html>',
      });
    });
    await page.goto('http://socialmedia.test/');
    if (settings) await page.getByRole('heading', { name: '画面设置', exact: true }).waitFor();
    else await page.locator('.sm-video').first().waitFor();
    return page;
  }
  it.each([false, true])('keeps the current idle time visible in the title on a narrow screen (settings=%s)', async settings => {
    const page = await fixture(390, settings);
    try {
      await page.evaluate(() => {
        const w = window as any;
        w.testState.roaming = { enabled: true, idle: true, idleSeconds: 3661, recent: [], usedToday: 0 };
        w.refreshers.forEach((fn: () => void) => fn());
      });
      const clock = page.locator('.sm-tv-heading [role=timer]');
      await clock.filter({ hasText: '01:01:01' }).waitFor();
      if (!settings) {
        await page.getByRole('button', { name: '待回应', exact: true }).click();
        expect(await clock.isVisible()).toBe(true);
      }
      expect((await clock.boundingBox())!.x).toBeGreaterThan(100);
      await page.evaluate(() => {
        const w = window as any;
        w.testState.roaming.idle = false;
        w.refreshers.forEach((fn: () => void) => fn());
      });
      await clock.filter({ hasText: '忙碌中' }).waitFor();
    } finally { await page.close(); }
  });
  it('shows the renamed settings and a visible experimental entry below platform settings', async () => {
    const page = await fixture(1050, true);
    try {
      const title = page.getByRole('heading', { name: '小鲸鱼爱冲浪', exact: true });
      const experiments = page.locator('.sm-experiments');
      const entry = experiments.getByText('实验功能', { exact: true });
      expect(await title.isVisible()).toBe(true);
      expect((await entry.boundingBox())!.y).toBeGreaterThan((await page.locator('.sm-settings').boundingBox())!.y);
      for (const label of ['小红书', '百度贴吧']) {
        const platformTitle = label === '百度贴吧' ? label + '（实验）' : label;
        await page.getByRole('tab', { name: platformTitle, exact: true }).click();
        const panel = page.getByRole('tabpanel', { name: platformTitle });
        expect(await panel.getByRole('checkbox', { name: '启用' + platformTitle }).isChecked()).toBe(false);
        expect(await panel.getByRole('button', { name: '打开' + label + '专用登录窗口' }).isVisible()).toBe(true);
        await panel.getByText('本站画面设置', { exact: true }).click();
        expect(await panel.getByRole('combobox', { name: '画面档位' }).locator('option').count()).toBe(3);
      }
      expect(await page.getByRole('tab').count()).toBe(4);
      await entry.click();
      await experiments.getByText('表达素材 · 0', { exact: true }).waitFor();
      for (const label of ['人格化练习']) {
        const toggle = experiments.getByRole('checkbox', { name: label, exact: true });
        expect(await toggle.isVisible()).toBe(true);
        expect(await toggle.isChecked()).toBe(false);
      }
      expect(await experiments.getByText('开启「开始训练」后消耗较高，建议按需开启。').isVisible()).toBe(true);
      expect(await experiments.getByText(/账号风险提示/).isVisible()).toBe(true);
      expect(await experiments.locator('textarea').count()).toBe(0);
      expect(await entry.evaluate(element => getComputedStyle(element).color)).toBe('rgb(244, 173, 114)');
      expect(await page.getByText('刷会儿小电视', { exact: true }).count()).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('separates practice instructions from dialogue and pages older records', async () => {
    const page = await fixture(960, true);
    try {
      await page.evaluate(() => {
        const w = window as any;
        w.testState.config.experiments.practice = true;
        w.testState.practiceRows = Array.from({ length: 4 }, (_, i) => ({
          id: 'practice-' + i, original: '练习话题 ' + (i + 1), at: '2026-10-01T12:00:00Z',
          status: 'review', feedback: ['把感想说具体。'],
        }));
      });
      const section = page.locator('.sm-experiments');
      await section.getByText('实验功能', { exact: true }).click();
      await section.getByText(/持续训练 · 高消耗.*Gemini 的回复另占网页额度/).waitFor();
      expect(await section.getByRole('button', { name: '现在邀请小K' }).count()).toBe(0);
      await section.getByText('最近练习 · 4', { exact: true }).click();
      const history = section.locator('.sm-practice-history');
      expect(await history.locator(':scope > .sm-practice-guide').count()).toBe(1);
      expect(await history.locator('.sm-practice-item').count()).toBe(3);
      expect(await history.getByText('把感想说具体。').first().isVisible()).toBe(false);
      await history.getByText('练习话题 1', { exact: true }).first().click();
      await history.getByRole('heading', { name: 'Gemini · 回复 1' }).waitFor();
      expect(await history.getByRole('heading', { name: '小K · 发问' }).isVisible()).toBe(true);
      await history.getByRole('button', { name: '下一页' }).click();
      await history.getByText('第 2 / 2 页', { exact: true }).waitFor();
      expect(await history.locator('.sm-practice-item').count()).toBe(1);
      expect(await history.getByText('练习话题 4', { exact: true }).first().isVisible()).toBe(true);
      expect(await history.getByRole('button', { name: '下一页' }).isDisabled()).toBe(true);
      await history.getByRole('button', { name: '上一页' }).click();
      await history.getByText('第 1 / 2 页', { exact: true }).waitFor();
    } finally {
      await page.close();
    }
  });
  it('bounds initial works and creates only a limited dialogue when a work is expanded', async () => {
    const page = await fixture(1100);
    try {
      await page.evaluate(() => {
        const w = window as any,
          base = w.testState.outbox[0];
        w.testState.outbox = Array.from({ length: 60 }, (_, i) => ({
          ...base,
          id: 'work-' + i,
          text: 'work text ' + i,
          receiptId: String(80000 + i),
          target: { oid: String(9000 + i), type: 1, root: '0', parent: '0' },
          createdAt: new Date(1700000000000 - i * 1000).toISOString(),
        }));
        w.testState.outbox.push(
          ...Array.from({ length: 100 }, (_, i) => ({
            ...base,
            id: 'detail-' + i,
            text: 'detail text ' + i,
            receiptId: String(90000 + i),
            target: { oid: '9000', type: 1, root: '0', parent: '0' },
            createdAt: new Date(1700000000000 + i * 1000).toISOString(),
          })),
        );
        const recent = w.testState.outbox.at(-1);
        recent.target = { oid: '9000', type: 1, root: '777', parent: '777' };
        recent.preparation = {
          purpose: 'test',
          advice: [],
          parent: { id: '777', author: '访客', text: '需要保留的原评论', target: recent.target },
        };
        w.testState.inbox = [
          {
            id: 'old-source',
            platform: 'bilibili',
            accountId: '42',
            authorId: '8',
            author: '访客',
            text: '需要保留的原评论',
            target: recent.target,
            occurredAt: 1,
            status: 'handled',
          },
        ];
        w.refreshers.forEach((fn: () => void) => fn());
      });
      await page.locator('[data-group-key="bilibili:1:9000"]').waitFor();
      expect(await page.locator('.sm-video').count()).toBe(20);
      expect(await page.locator('.sm-event').count()).toBe(0);
      const first = page.locator('[data-group-key="bilibili:1:9000"]');
      await first.locator(':scope > summary').click();
      await first.locator('.sm-event').first().waitFor({ state: 'attached' });
      expect(await first.locator('.sm-event').count()).toBe(40);
      expect(await first.locator('blockquote').count()).toBe(1);
      expect(await first.locator('blockquote').innerText()).toContain('需要保留的原评论');
      expect(await first.locator('nav.sm-entry-pager').count()).toBe(1);
      const originalIds = await first
        .locator('.sm-event')
        .evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.eventId));
      await first
        .locator('.sm-entry-pager')
        .getByRole('button', { name: '2', exact: true })
        .click();
      expect(await first.locator('.sm-event').count()).toBe(40);
      const nextIds = await first
        .locator('.sm-event')
        .evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.eventId));
      expect(nextIds.some((id) => originalIds.includes(id))).toBe(false);
      await first
        .locator('.sm-entry-pager')
        .getByRole('button', { name: '1', exact: true })
        .click();
      expect(await first.locator('blockquote').count()).toBe(1);
      await first.locator(':scope > summary').click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-group-key="bilibili:1:9000"]')
            ?.querySelectorAll('.sm-event').length === 0,
      );
      expect(await first.locator('.sm-event').count()).toBe(0);
      const pager = page.locator('nav.sm-work-pager');
      expect(await pager.count()).toBe(1);
      await pager.getByRole('button', { name: '2', exact: true }).click();
      expect(await page.locator('.sm-video').count()).toBe(20);
      expect(await page.locator('[data-group-key="bilibili:1:9000"]').count()).toBe(0);
      expect(await pager.locator('[aria-current=page]').innerText()).toBe('2');
      const keys = await page
        .locator('.sm-video')
        .evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.groupKey));
      await page.evaluate(() => {
        const w = window as any;
        w.testState.outbox.push({
          ...w.testState.outbox[0],
          id: 'incoming-new-work',
          target: { oid: '12000', type: 1, root: '0', parent: '0' },
          createdAt: new Date().toISOString(),
        });
        w.refreshers.forEach((fn: () => void) => fn());
      });
      await page.waitForFunction(() =>
        document.querySelector('.sm-work-pager')?.textContent?.includes('61个作品'),
      );
      expect(
        await page
          .locator('.sm-video')
          .evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.groupKey)),
      ).toEqual(keys);
      await pager.getByRole('button', { name: '3', exact: true }).click();
      expect(await page.locator('.sm-video').count()).toBe(20);
      await page.getByRole('searchbox', { name: '搜索互动' }).fill('work text 59');
      expect(await page.locator('.sm-video').count()).toBe(1);
      expect(await page.locator('.sm-event').innerText()).toContain('work text 59');
      expect(await pager.locator('[aria-current=page]').innerText()).toBe('1');
      expect(await pager.getByRole('button', { name: '下一页', exact: true }).isDisabled()).toBe(
        true,
      );
      await page.getByRole('searchbox', { name: '搜索互动' }).fill('');
      await pager.getByRole('button', { name: '3', exact: true }).click();
      await page.evaluate(() => {
        const w = window as any;
        w.testState.outbox = w.testState.outbox.filter((r: any) => r.id === 'work-59');
        w.testState.inbox = [];
        w.refreshers.forEach((fn: () => void) => fn());
      });
      await page.waitForFunction(() =>
        document.querySelector('.sm-work-pager')?.textContent?.includes('共1个作品'),
      );
      expect(await pager.locator('[aria-current=page]').innerText()).toBe('1');
      expect(await page.locator('.sm-video').count()).toBe(1);
    } finally {
      await page.close();
    }
  });
  it('keeps numbered pages usable on a narrow screen and bounds the page-number buttons', async () => {
    const page = await fixture(420);
    try {
      await page.evaluate(() => {
        const w = window as any,
          b = w.testState.outbox[0];
        w.testState.outbox = Array.from({ length: 500 }, (_, i) => ({
          ...b,
          id: 'page-test-' + i,
          target: { oid: String(50000 + i), type: 1, root: '0', parent: '0' },
          createdAt: new Date(1700000000000 - i * 1000).toISOString(),
        }));
        w.refreshers.forEach((fn: () => void) => fn());
      });
      const nav = page.getByRole('navigation', { name: '作品分页' });
      await page.waitForFunction(() =>
        document.querySelector('.sm-work-pager')?.textContent?.includes('500个作品'),
      );
      expect(await nav.locator('.sm-page-number').count()).toBeLessThanOrEqual(7);
      await nav.getByRole('button', { name: '25', exact: true }).click();
      expect(await nav.locator('[aria-current=page]').innerText()).toBe('25');
      expect(await nav.getByRole('button', { name: '下一页', exact: true }).isDisabled()).toBe(
        true,
      );
      expect(await page.locator('.sm-video').count()).toBe(20);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await nav.getByRole('button', { name: '上一页', exact: true }).click();
      expect(await nav.locator('[aria-current=page]').innerText()).toBe('24');
    } finally {
      await page.close();
    }
  });
  it('keeps the visible reading anchor when a newer video thread arrives', async () => {
    const page = await fixture(1100);
    try {
      await page.locator('.sm-video').nth(5).evaluate(n => n.scrollIntoView({ block: 'start' }));
      expect(await page.locator('#host').evaluate(n => n.scrollTop)).toBeGreaterThan(24);
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
        w.refreshers.forEach((fn: () => void) => fn());
      });
      await page.locator('[data-group-key="bilibili:1:10000"]').waitFor({ state: 'attached' });
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
      expect(await page.getByText('高级 · 图片大小、缓存和 FFmpeg', { exact: true }).isVisible()).toBe(true);
      await page.getByText('今天已看 2 / 20 次', { exact: true }).waitFor();
      await page.getByRole('button', { name: /高 · 看仔细/ }).click();
      expect(await page.getByRole('button', { name: /高 · 看仔细/ }).getAttribute('aria-pressed')).toBe('true');
      await page.getByText('自定义次数和张数', { exact: true }).click();
      const count = page.getByRole('spinbutton', { name: '每天最多看几次' });
      const frames = page.getByRole('spinbutton', { name: '每批最多看几张图文' });
      expect(await count.inputValue()).toBe('20');
      expect(await frames.inputValue()).toBe('2');
      const unlimited = page.getByRole('checkbox', { name: '取消每日画面次数上限' });
      await unlimited.check();
      await page.getByRole('button', { name: /低 · 扫一眼/ }).click();
      expect(await unlimited.isChecked()).toBe(true);
      expect(await frames.inputValue()).toBe('2');
      expect(await count.inputValue()).toBe('20');
      await page.getByRole('button', { name: /高 · 看仔细/ }).click();
      await unlimited.uncheck();
      await page.getByRole('button', { name: /40 次 · 经常看/ }).click();
      await page.getByRole('button', { name: /6 张 · 多看几张/ }).click();
      expect(await page.getByRole('spinbutton', { name: '每次最多抽几帧视频' }).inputValue()).toBe('12');
      await page.getByRole('checkbox', { name: '取消每日画面次数上限' }).check();
      expect(await count.isDisabled()).toBe(true);
      expect(await frames.isEnabled()).toBe(true);
      await page.getByRole('button', { name: '关闭画面', exact: true }).click();
      expect(await count.inputValue()).toBe('0');
      await page.getByRole('button', { name: '开启画面', exact: true }).click();
      expect(await count.inputValue()).toBe('40');
      await page.getByRole('button', { name: '保存画面设置' }).click();
      expect(await page.evaluate(() => (window as any).savedSettings)).toMatchObject({
        'worlds.socialmedia.media.maxDailyVisualCalls': 40,
        'worlds.socialmedia.media.maxFrames': 6,
        'worlds.socialmedia.media.maxVideoFrames': 12,
        'worlds.socialmedia.media.unlimitedDailyVisualCalls': true,
      });
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
      expect(colors.map((n) => n.id)).toEqual(['bilibili', 'douyin', 'xiaohongshu', 'tieba']);
      expect(new Set(colors.map((n) => n.color)).size).toBe(4);
      const platformTabs = page.getByRole('tab');
      await platformTabs.filter({ has: page.locator('.sm-experimental') })
        .and(page.getByRole('tab', { name: /贴吧（实验）/ })).waitFor();
      expect(await platformTabs.filter({ has: page.locator('.sm-experimental') }).count()).toBe(1);
      await page.getByRole('tab', { name: '小红书', exact: true }).click();
      const focus = page.locator('.sm-platform-card[data-platform="xiaohongshu"] .sm-platform-focus');
      expect(await focus.getAttribute('open')).toBeNull();
      await focus.locator(':scope > summary').click();
      const input = focus.locator('[aria-label="小红书主人个人主页完整链接"]');
      await input.fill('custom-owner-123');
      await page.evaluate(() => {
        (window as any).refreshers.forEach((fn: () => void) => fn());
      });
      await page.getByRole('tab', { name: '哔哩哔哩', exact: true }).click();
      await page.getByRole('tab', { name: '小红书', exact: true }).click();
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
          ['xiaohongshu', 5],
          ['tieba', 4],
        ])
          w.testState.outbox.push({
            ...w.testState.outbox[0],
            id: platform,
            platform,
            target: { oid: platform + 'video123', type, root: '0', parent: '0' },
          });
        w.refreshers.forEach((fn: () => void) => fn());
      });
      await page.locator('.sm-video[data-platform="xiaohongshu"]').waitFor();
      for (const id of ['bilibili', 'douyin', 'xiaohongshu', 'tieba']) {
        const group = page.locator('.sm-video[data-platform="' + id + '"]').first();
        await group.locator('summary').first().click();
        await group.locator('.sm-outgoing').first().waitFor();
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
  it('keeps the adjustable Douyin loading wait inside the collapsed connection options', async () => {
    const page = await fixture(1100, true);
    try {
      await page.getByRole('tab', { name: '抖音', exact: true }).click();
      const options = page.locator('.sm-platform-card[data-platform=douyin] .sm-platform-advanced');
      expect(await options.evaluate((e) => (e as HTMLDetailsElement).open)).toBe(false);
      const field = page.getByRole('spinbutton', { name: '网页加载等待上限（秒）', exact: true });
      expect(await field.isVisible()).toBe(false);
      await options.locator(':scope > summary').click();
      expect(await field.inputValue()).toBe('45');
      expect(await field.getAttribute('min')).toBe('15');
      expect(await field.getAttribute('max')).toBe('120');
      await field.fill('90');
      await page.getByRole('tab', { name: '哔哩哔哩', exact: true }).click();
      await page.getByRole('tab', { name: '抖音', exact: true }).click();
      expect(await field.inputValue()).toBe('90');
      await page.getByRole('button', { name: '保存抖音设置', exact: true }).click();
      expect(await page.evaluate(() => (window as any).savedSettings)).toEqual({
        'worlds.socialmedia.douyinBrowser.pageWaitSeconds': 90,
      });
    } finally {
      await page.close();
    }
  });
  it('shows a retained Douyin failure in a collapsed platform card without narrow-screen overflow', async () => {
    const page = await fixture(420, true);
    try {
      await page.evaluate(() => {
        const w = window as any;
        w.testState.douyin = {
          running: false,
          loginOpen: false,
          detail: '随后读取成功',
          lastFailure: {
            at: '2026-11-03T00:00:00Z',
            stage: '打开网页',
            reason: '连接失败 ERR_CONNECTION_RESET ' + 'x'.repeat(180),
            elapsedMs: 1400,
            waitSeconds: 120,
          },
        };
        w.refreshers.forEach((fn: () => void) => fn());
      });
      await page.getByRole('tab', { name: '抖音', exact: true }).click();
      const box = page.locator('.sm-platform-card[data-platform=douyin] .sm-browser-failure');
      await box.waitFor();
      expect(await box.evaluate((n) => (n as HTMLDetailsElement).open)).toBe(false);
      await box.locator(':scope > summary').click();
      expect(await box.innerText()).toContain('耗时：1.4秒');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      });
      await box.getByRole('button', { name: '复制失败信息', exact: true }).click();
      await page.getByText('未能自动复制，可选中上方文字手动复制。', { exact: true }).waitFor();
      await page.evaluate(() => {
        const w = window as any;
        w.testState.douyin.detail = '已读取官网评论';
        w.refreshers.forEach((fn: () => void) => fn());
      });
      expect(await box.innerText()).toContain('ERR_CONNECTION_RESET');
      expect(await box.evaluate((n) => (n as HTMLDetailsElement).open)).toBe(true);
    } finally {
      await page.close();
    }
  });
  it('shows manual verification beside a logged-in account without overflow or an automatic retry', async () => {
    const page = await fixture(420, true);
    try {
      await page.evaluate(() => {
        const w = window as any;
        w.testState.platforms = [
          { id: 'douyin', enabled: true, posting: true, account: { id: '42', name: '测试' } },
        ];
        w.testState.douyin = {
          running: false,
          loginOpen: false,
          detail: '等待处理',
          verification: {
            paused: true,
            at: '2026-11-04T00:00:00Z',
            pageTitle: '安全验证',
            browserMode: 'windowless',
          },
        };
        w.refreshers.forEach((fn: () => void) => fn());
      });
      await page.getByRole('tab', { name: '抖音', exact: true }).click();
      const panel = page.locator('.sm-platform-card[data-platform=douyin]');
      expect(await panel.locator('.sm-verification').innerText()).toContain('已登录');
      await panel.getByRole('button', { name: '处理人工验证', exact: true }).click();
      expect(await page.evaluate(() => (window as any).calls)).toContain('douyinLogin');
      await panel.getByRole('button', { name: '完成登录并检查后台', exact: true }).click();
      const calls = await page.evaluate(() => (window as any).calls);
      expect(calls).toContain('douyinFinishLogin');
      expect(calls).not.toContain('douyinFeedCheck');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    } finally {
      await page.close();
    }
  });
  it('loads archived sends into the existing per-video timeline on demand', async () => {
    const page = await fixture(1100);
    try {
      await page.getByRole('button', { name: /查看较早发言/ }).click();
      await page.locator('[data-group-key="bilibili:1:11"]').locator(':scope > summary').click();
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

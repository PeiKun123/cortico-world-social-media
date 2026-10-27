import { expect, it } from 'vitest';
import {
  matchesDynamicPayload,
  matchesPostedDynamic,
} from '../src/platforms/bilibili-dynamic-publish.ts';
const text = '今天也要开心呀。';
const content = { contents: [{ raw_text: text, type: 1, biz_id: '' }] };
it('accepts only the exact plain-text dynamic and one optional verified owner mention', () => {
  expect(
    matchesDynamicPayload({ content, scene: 2, attach_card: null, option: { aigc: 2 } }, { text }),
  ).toBe(true);
  expect(
    matchesDynamicPayload(
      {
        content: { contents: [...content.contents, { raw_text: ' @主人', type: 2, biz_id: '7' }] },
        scene: 2,
      },
      { text, mention: { id: '7', name: '主人' } },
    ),
  ).toBe(true);
  expect(
    matchesDynamicPayload(
      {
        content: { contents: [...content.contents, { raw_text: ' @主人', type: 2, biz_id: '8' }] },
        scene: 2,
      },
      { text, mention: { id: '7', name: '主人' } },
    ),
  ).toBe(false);
  for (const extra of [
    { pics: [{}] },
    { attach_card: { type: 1 } },
    { scene: 4 },
    { content: { contents: [{ raw_text: '换正文', type: 1 }] } },
    { option: { private: 1 } },
    { topic: { id: 1 } },
  ])
    expect(matchesDynamicPayload({ content, scene: 2, ...extra }, { text })).toBe(false);
});

import { afterAll, beforeAll, describe } from 'vitest';
import { chromium, type Browser, type Route } from 'playwright-core';
import { findBrowserExecutable } from '../src/platforms/bilibili-browser.ts';
import { submitDynamicPage } from '../src/platforms/bilibili-dynamic-publish.ts';
describe.skipIf(!findBrowserExecutable())('native dynamic editor in an offline browser', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: findBrowserExecutable(), headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  async function fixture(options: { twice?: boolean; wrong?: boolean; noReceipt?: boolean } = {}) {
    const context = await browser.newContext();
    await context.setOffline(true);
    const page = await context.newPage();
    await page.route('**/*', (r) =>
      r.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<div class="bili-dyn-publishing"><div contenteditable="true" style="white-space:pre-wrap;min-height:24px" class="bili-rich-textarea__inner"></div><div class="bili-dyn-publishing__action launcher disabled">发布</div></div><script>
   const editor=document.querySelector('[contenteditable]'),button=document.querySelector('.launcher');
   editor.addEventListener('input',()=>button.classList.toggle('disabled',!editor.innerText.trim()));
   button.onclick=async()=>{const data={content:{contents:[{raw_text:${options.wrong ? "'换正文'" : 'editor.innerText.trim()'},type:1,biz_id:''}]},scene:2,attach_card:null};
   await fetch('https://api.bilibili.com/x/dynamic/feed/create/submit_check',{method:'POST',body:JSON.stringify(data)});
   const send=()=>fetch('https://api.bilibili.com/x/dynamic/feed/create/dyn',{method:'POST',body:JSON.stringify({dyn_req:data})}).catch(()=>{});send();${options.twice ? 'send();' : ''}};
  </script>`,
      }),
    );
    await page.goto('https://t.bilibili.com/');
    let submitted = 0;
    const forward = async (route: Route) => {
      const create = new URL(route.request().url()).pathname.endsWith('/dyn');
      if (create) submitted++;
      if (create && options.noReceipt) return route.abort();
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: create ? { dyn_id_str: '1261990610011684873' } : {},
        }),
      });
    };
    return { context, page, forward, submitted: () => submitted };
  }
  it('forwards one matching native create and blocks its duplicate', async () => {
    const f = await fixture({ twice: true });
    try {
      expect(
        await submitDynamicPage(
          f.page,
          { text },
          AbortSignal.timeout(4000),
          () => true,
          1000,
          f.forward,
        ),
      ).toEqual({ forwarded: true, id: '1261990610011684873' });
      expect(f.submitted()).toBe(1);
    } finally {
      await f.context.close();
    }
  });
  it('does not send a changed account or changed native body', async () => {
    const a = await fixture();
    try {
      await expect(
        submitDynamicPage(a.page, { text }, AbortSignal.timeout(4000), () => false, 300, a.forward),
      ).rejects.toThrow(/登录/);
      expect(a.submitted()).toBe(0);
    } finally {
      await a.context.close();
    }
    const b = await fixture({ wrong: true });
    try {
      expect(
        await submitDynamicPage(
          b.page,
          { text },
          AbortSignal.timeout(4000),
          () => true,
          300,
          b.forward,
        ),
      ).toMatchObject({ forwarded: false });
      expect(b.submitted()).toBe(0);
    } finally {
      await b.context.close();
    }
  });
  it('keeps an unknown forwarded result and never clicks again after receipt loss', async () => {
    const f = await fixture({ noReceipt: true });
    try {
      expect(
        await submitDynamicPage(
          f.page,
          { text },
          AbortSignal.timeout(4000),
          () => true,
          300,
          f.forward,
        ),
      ).toMatchObject({ forwarded: true });
      expect(f.submitted()).toBe(1);
    } finally {
      await f.context.close();
    }
  });
});

import { prepareDynamicPage } from '../src/platforms/bilibili-dynamic-publish.ts';
it.skipIf(!findBrowserExecutable())(
  'does not clear a fresh rich editor and verifies the selected native mention UID',
  async () => {
    const browser = await chromium.launch({
      executablePath: findBrowserExecutable(),
      headless: true,
    });
    try {
      for (const uid of ['7', '8']) {
        const context = await browser.newContext();
        await context.setOffline(true);
        const page = await context.newPage();
        await page.route('**/*', (r) =>
          r.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: `<div class="bili-dyn-publishing"><div contenteditable="true" style="white-space:pre-wrap;min-height:24px" class="bili-rich-textarea__inner"></div><div class="bili-dyn-publishing__tools__item at">@</div><div class="bili-dyn-publishing__action launcher disabled">发布</div></div><div class="bili-at-popup" style="display:none"><div class="bili-at-popup__user"><span>主人</span></div></div><script>
    window.cleared=false;const e=document.querySelector('[contenteditable]'),b=document.querySelector('.launcher'),popup=document.querySelector('.bili-at-popup');e.onkeydown=x=>{if(x.key==='Backspace')window.cleared=true};e.oninput=()=>b.classList.toggle('disabled',!e.innerText.trim());document.querySelector('.at').onclick=()=>{popup.style.display='block'};
    document.querySelector('.bili-at-popup__user').onclick=()=>{const token=document.createElement('span');token.contentEditable='false';token.textContent='@主人';token.dataset.data=JSON.stringify({data:{type:'at',rid:'${uid}'}});e.replaceChildren(token,document.createTextNode(' '));popup.style.display='none';e.focus();const range=document.createRange();range.selectNodeContents(e);range.collapse(false);getSelection().removeAllRanges();getSelection().addRange(range);};
   </script>`,
          }),
        );
        await page.goto('https://t.bilibili.com/');
        if (uid === '7')
          expect(await prepareDynamicPage(page, { text, mention: { id: '7', name: '主人' } })).toBe(
            '@主人 ' + text,
          );
        else
          await expect(
            prepareDynamicPage(page, { text, mention: { id: '7', name: '主人' } }),
          ).rejects.toThrow(/UID/);
        expect(await page.evaluate(() => (window as any).cleared)).toBe(false);
        await context.close();
      }
    } finally {
      await browser.close();
    }
  },

  30000,
);

it('matches official mention serialization without accepting another UID or changed body', () => {
  const draft = { accountId: '42', text: '今天也要开心呀。', mention: { id: '7', name: '主人' } };
  expect(
    matchesPostedDynamic(
      { authorId: '42', text: '@主人今天也要开心呀。', mentions: [{ id: '7', text: '@主人' }] },
      draft,
    ),
  ).toBe(true);
  expect(
    matchesPostedDynamic(
      { authorId: '42', text: '@主人 今天也要开心呀。', mentions: [{ id: '7', text: '@主人' }] },
      draft,
    ),
  ).toBe(true);
  expect(
    matchesPostedDynamic(
      { authorId: '42', text: '@主人今天也要开心呀。', mentions: [{ id: '8', text: '@主人' }] },
      draft,
    ),
  ).toBe(false);
  expect(
    matchesPostedDynamic(
      { authorId: '43', text: '@主人今天也要开心呀。', mentions: [{ id: '7', text: '@主人' }] },
      draft,
    ),
  ).toBe(false);
  expect(
    matchesPostedDynamic(
      {
        authorId: '42',
        text: '@主人今天也要开心呀。多一句',
        mentions: [{ id: '7', text: '@主人' }],
      },
      draft,
    ),
  ).toBe(false);
});

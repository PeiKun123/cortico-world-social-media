import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { DouyinPlatform } from '../src/platforms/douyin.ts';
import { findBrowserExecutable } from '../src/platforms/bilibili-browser.ts';
const id = '7697799441646256819';
const target = { oid: id, type: 2, root: '0', parent: '0' };
// Every request is intercepted and the context is offline: no real account or public comment.
describe.skipIf(!findBrowserExecutable())('Douyin real-browser offline boundaries', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: findBrowserExecutable(), headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  async function fixture(
    options: {
      compatibilityWindow?: boolean;
      coldFeed?: boolean;
      verification?: boolean;
      userSearch?: boolean;
      needsRefresh?: boolean;
      movingIcon?: boolean;
      autoCollapse?: boolean;
      hiddenList?: boolean;
      thread?: boolean;
      wrongReply?: boolean;
      delayedSelf?: boolean;
      noSlash?: boolean;
      collapsed?: boolean;
      images?: boolean;
      feed?: boolean;
      owner?: boolean;
      wrongVideo?: boolean;
      twice?: boolean;
      httpFailure?: boolean;
      uid?: string;
      ssr?: boolean;
      ssrSelf?: boolean;
      releaseAfterTask?: boolean;
      groupListening?: boolean;
    } = {},
  ) {
    let accepted = 0;
    const navigations: string[] = [];
    let launchedHeadless: boolean | undefined;
    let launchArgs: string[] = [];
    let pageLoads = 0;
    let submitted: Record<string, string> | undefined;
    const threadHTML =
      '<div data-e2e="comment-item"><a href="https://www.douyin.com/user/MS4wLjABAAAAtest_person">路人</a><span id="tooltip_88">...</span><div class="FduGc_lz">好可爱<span class="comment-item-tag">作者赞过</span></div><span id="reply-root">回复</span><button id="expand">展开1条回复</button><div class="replyContainer" id="children"></div></div>';
    const childHTML =
      '<div data-e2e="comment-item"><a href="https://www.douyin.com/user/MS4wLjABAAAAtest_person2">路人</a><span id="tooltip_99">...</span><div class="FduGc_lz">好可爱</div><span id="reply-child">回复</span></div>';

    const adapter = new DouyinPlatform(
      'unused-profile',
      () => findBrowserExecutable()!,
      () => true,
      () => true,
      () => true,
      () => 128,
      () => options.groupListening ?? false,
      () => options.releaseAfterTask ?? false,
      () => options.compatibilityWindow ?? false,
    );
    const launch = vi
      .spyOn(chromium, 'launchPersistentContext')
      .mockImplementation(async (_profile, launchOptions) => {
        launchedHeadless = launchOptions?.headless;
        launchArgs = launchOptions?.args ?? [];
        const context = await browser.newContext();
        await context.setOffline(true);
        await context.route('**/*', async (route) => {
          const path = new URL(route.request().url()).pathname;
          if (route.request().isNavigationRequest()) navigations.push(route.request().url());
          if (options.verification)
            return route.fulfill({
              contentType: 'text/html; charset=utf-8',
              body: '<title>验证码中间页</title><body></body>',
            });
          if (
            options.coldFeed &&
            path === '/jingxuan' &&
            !new URL(route.request().url()).searchParams.has('modal_id')
          )
            return route.fulfill({
              contentType: 'text/html; charset=utf-8',
              body: '<a href="/?recommend=1&from_nav=1">推荐</a>',
            });
          if (options.userSearch && path === '/aweme/v1/web/discover/search/')
            return route.fulfill({
              contentType: 'application/json',
              body: JSON.stringify({
                status_code: 0,
                user_list: [
                  {
                    user_info: {
                      sec_uid: 'MS4wLjABAAAAtest_owner_identity',
                      unique_id: '1234567890',
                      short_id: '1234567890',
                      nickname: '主人',
                    },
                  },
                  {
                    user_info: {
                      sec_uid: 'MS4wLjABAAAAdifferent_owner',
                      unique_id: '12345678900',
                      nickname: '同名',
                    },
                  },
                ],
              }),
            });
          if (options.userSearch && path.startsWith('/search/'))
            return route.fulfill({
              contentType: 'text/html',
              body: '<p>抖音号: 12345678906.6万获赞</p><script>fetch("/aweme/v1/web/discover/search/?keyword=1234567890")</script>',
            });
          if (path === '/aweme/v1/web/user/profile/self/')
            return route.fulfill({
              contentType: 'application/json',
              body: JSON.stringify({
                status_code: 0,
                user: { uid: options.uid || '42', nickname: '测试账号' },
              }),
            });
          if (path === '/aweme/v1/web/aweme/detail/')
            return route.fulfill({
              contentType: 'application/json',
              body: JSON.stringify({
                status_code: 0,
                aweme_detail: {
                  aweme_id: id,
                  desc: '游戏创作',
                  author: { nickname: '作者' },
                  video: { duration: 10000 },
                },
              }),
            });
          if (path === '/aweme/v1/web/comment/list/')
            return route.fulfill({
              contentType: 'application/json',
              body: JSON.stringify({
                status_code: 0,
                cursor: 20,
                has_more: 0,
                comments: [
                  {
                    cid: '88',
                    text: '好可爱',
                    ...(options.thread
                      ? {
                          reply_comment: [
                            {
                              cid: '99',
                              text: '好可爱',
                              reply_id: '88',
                              user: {
                                uid: '9',
                                nickname: '路人',
                                sec_uid: 'MS4wLjABAAAAtest_person2',
                              },
                            },
                          ],
                        }
                      : {}),
                    user: { uid: '8', nickname: '路人', sec_uid: 'MS4wLjABAAAAtest_person' },
                  },
                ],
              }),
            });
          if (path.replace(/\/$/, '') === '/aweme/v1/web/comment/publish') {
            accepted++;
            submitted = Object.fromEntries(new URLSearchParams(route.request().postData() || ''));
            return route.fulfill({
              status: options.httpFailure ? 500 : 200,
              contentType: 'application/json',
              body: '{"status_code":0,"comment":{"cid":7697799441646256820}}',
            });
          }
          if (options.needsRefresh && path === '/jingxuan' && ++pageLoads === 1)
            return route.fulfill({
              contentType: 'text/html; charset=utf-8',
              body:
                '<section><div data-e2e="video-desc">游戏创作 <a href="https://www.douyin.com/search/game?aweme_id=' +
                id +
                '">#游戏</a></div></section><script>fetch("/aweme/v1/web/aweme/detail/")</script>',
            });
          return route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body:
              options.owner && path.startsWith('/user/MS4w')
                ? '<link rel="canonical" href="https://www.douyin.com' +
                  path +
                  '"><h1>主人</h1><section data-e2e="user-post-list"><a href="/video/' +
                  id +
                  '" title="主人创作">主人创作</a></section><aside><a href="/video/123" title="其他人的推荐">其他人的推荐</a></aside>'
                : path === '/user/self'
                  ? options.delayedSelf
                    ? '<script>fetch("/aweme/v1/web/user/profile/self/");setTimeout(()=>{document.body.innerHTML="<h1>测试账号</h1><link rel=canonical href=https://www.douyin.com/user/MS4wLjABAAAAtest_owner_identity>"},250)</script>'
                    : options.ssrSelf
                      ? '<h1>测试账号</h1><link rel=canonical href=https://www.douyin.com/user/MS4wLjABAAAAtest_owner_identity>'
                      : '<script>fetch("/aweme/v1/web/user/profile/self/")</script>'
                  : '<html><body><section><video id=placeholder style="width:10px;height:10px"></video><video id=real style="width:320px;height:180px;background:linear-gradient(red,blue)"></video><p>@作者 · 今天</p><div data-e2e="video-desc">游戏创作 <a href="https://www.douyin.com/search/game?aweme_id=' +
                    id +
                    '">#游戏</a></div></section><div data-e2e="feed-comment-icon">评论</div><div id="rows"></div><section><div contenteditable="true"></div><button id="send">发送</button></section><script>' +
                    'for(const v of document.querySelectorAll("video")){let time=0;Object.defineProperties(v,{duration:{get:()=>v.id==="real"?10:2.6},readyState:{get:()=>4},seeking:{get:()=>false},currentTime:{get:()=>time,set:x=>time=x}});v.pause=()=>{};}' +
                    (options.images
                      ? 'document.querySelector("#real").remove();document.querySelector("#placeholder").remove();const image=document.createElement("img");image.style="width:320px;height:180px";Object.defineProperty(image,"naturalWidth",{get:()=>1080});document.querySelector("section").prepend(image);document.querySelector("section").append("图文");'
                      : '') +
                    (options.ssr || options.images ? '' : 'fetch("/aweme/v1/web/aweme/detail/");') +
                    'document.querySelector("[data-e2e=feed-comment-icon]").onclick=async()=>{' +
                    (options.ssr
                      ? ''
                      : 'await fetch("/aweme/v1/web/comment/list/?aweme_id=' + id + '");') +
                    'document.querySelector("#rows").innerHTML="<div data-e2e=comment-item><div class=comment-item-info-wrap><a href=https://www.douyin.com/user/MS4wLjABAAAAtest_person>路人</a><span id=tooltip_88>...</span></div><div class=FduGc_lz>好可爱</div><span>回复</span><span>展开32条回复</span></div>"};' +
                    (options.thread
                      ? 'const oldComment=document.querySelector("[data-e2e=feed-comment-icon]").onclick;document.querySelector("[data-e2e=feed-comment-icon]").onclick=async()=>{await oldComment();document.querySelector("#rows").innerHTML=' +
                        JSON.stringify(threadHTML) +
                        ';document.querySelector("#reply-root").onclick=()=>{window.replyRoot="88";window.replyParent="0";};document.querySelector("#expand").onclick=()=>{document.querySelector("#children").innerHTML=' +
                        JSON.stringify(childHTML) +
                        ';document.querySelector("#expand").remove();document.querySelector("#reply-child").onclick=()=>{window.replyRoot="88";window.replyParent="99";};};};'
                      : '') +
                    (options.hiddenList
                      ? 'document.querySelector("#rows").innerHTML=' +
                        JSON.stringify(threadHTML) +
                        ';document.querySelector("#rows").style.display="none";const showComments=document.querySelector("[data-e2e=feed-comment-icon]").onclick;document.querySelector("[data-e2e=feed-comment-icon]").onclick=async()=>{document.querySelector("#rows").style.display="block";await showComments();};fetch("/aweme/v1/web/comment/list/?aweme_id=' +
                        id +
                        '");'
                      : '') +
                    (options.autoCollapse
                      ? 'let clicks=0;const togglePanel=document.querySelector("[data-e2e=feed-comment-icon]").onclick;document.querySelector("[data-e2e=feed-comment-icon]").onclick=async()=>{await togglePanel();document.querySelector("#rows").style.display=(++clicks===1?"none":"block");};'
                      : '') +
                    (options.movingIcon
                      ? 'const moving=document.querySelector("[data-e2e=feed-comment-icon]");moving.style.display="inline-block";let shift=0;moving.onmouseenter=()=>{moving.style.transform="translateX("+(shift+=200)+"px)";};'
                      : '') +
                    (options.collapsed
                      ? 'document.querySelector("[contenteditable]").outerHTML="<span id=activate>留下你的精彩评论吧</span>";document.querySelector("#activate").onclick=()=>{document.querySelector("#activate").outerHTML="<div contenteditable=true></div>";document.querySelector("[contenteditable]").onkeydown=e=>{if(e.key==="Enter"){e.preventDefault();document.querySelector("#send").click();}};};document.querySelector("#send").parentElement.classList.add("comment-input-inner-container");document.querySelector("#send").outerHTML="<div class=commentInput-right-ct><span id=send><svg width=32 height=32><path fill=#FE2C55 d=M0,0L32,32></path></svg></span></div>";'
                      : '') +
                    (options.feed
                      ? 'document.addEventListener("keydown",()=>{document.querySelector("[data-e2e=video-desc] a").href="https://www.douyin.com/search/game?aweme_id=7697799441646256821";document.querySelector("[data-e2e=video-desc] a").textContent="#新游戏";});'
                      : '') +
                    'document.querySelector("#send").onclick=()=>{const send=()=>fetch("/aweme/v1/web/comment/publish' +
                    (options.noSlash ? '' : '/') +
                    '",{method:"POST",body:new URLSearchParams({aweme_id:"' +
                    (options.wrongVideo ? '123' : id) +
                    '",text:document.querySelector("[contenteditable]").textContent,reply_id:(window.replyRoot||"0"),reply_to_reply_id:' +
                    (options.wrongReply ? '"100"' : '(window.replyParent||"0")') +
                    '})}).catch(()=>{});send();' +
                    (options.twice ? 'send();' : '') +
                    '};</script></body></html>',
          });
        });
        return context;
      });
    return {
      adapter,
      navigations,
      headless: () => launchedHeadless,
      launchArgs: () => launchArgs,
      accepted: () => accepted,
      submitted: () => submitted,
      current: () =>
        (adapter as any).context as import('playwright-core').BrowserContext | undefined,
      cleanup: async () => {
        await adapter.stop();
        launch.mockRestore();
      },
    };
  }
  it('keeps ordinary browsing hidden but explicitly opens a visible login window', async () => {
    const f = await fixture();
    try {
      await f.adapter.video(id);
      expect(f.headless()).toBe(true);
      expect(f.launchArgs()).not.toContain('--start-minimized');
      await f.adapter.openLogin();
      expect(f.headless()).toBe(false);
      await f.adapter.closeLogin();
      await f.adapter.video(id);
      expect(f.headless()).toBe(true);
      expect(f.accepted()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  it('resolves an exact Douyin handle from the official user search response even when DOM numbers are joined', async () => {
    const f = await fixture({ userSearch: true });
    try {
      expect(await f.adapter.resolveCreator('1234567890')).toEqual({
        id: 'MS4wLjABAAAAtest_owner_identity',
        name: '主人',
      });
      expect(f.accepted()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  it('exposes embedded API reply previews with their actual root before expansion', async () => {
    const f = await fixture({ thread: true });
    try {
      expect((await f.adapter.comments(target, 1)).items[0]).toMatchObject({
        id: '88',
        replies: [{ id: '99', target: { ...target, root: '88', parent: '99' } }],
      });
    } finally {
      await f.cleanup();
    }
  });
  it('recovers an initially unmounted comment panel with one read-only refresh', async () => {
    const f = await fixture({ needsRefresh: true, thread: true, ssr: true });
    try {
      const result = await f.adapter.comments({ ...target, root: '88', parent: '99' }, 1);
      expect(result.items).toContainEqual(
        expect.objectContaining({ id: '99', target: { ...target, root: '88', parent: '99' } }),
      );
      expect(f.accepted()).toBe(0);
    } finally {
      await f.cleanup();
    }
  }, 25000);
  it('classifies a detached reply control before send as not submitted', async () => {
    const f = await fixture({ thread: true, ssr: true });
    const action = vi.spyOn(f.adapter as any, 'ownAction').mockRejectedValue(new Error('detached'));
    try {
      await expect(
        f.adapter.send({ ...target, root: '88', parent: '99' }, '这个细节很可爱', undefined, '42'),
      ).rejects.toMatchObject({
        kind: 'rejected',
        message: expect.stringContaining('尚未点击发送'),
      });
      expect(f.accepted()).toBe(0);
    } finally {
      action.mockRestore();
      await f.cleanup();
    }
  });
  it('uses only the root own reply button after nested children are shown', async () => {
    const f = await fixture({ thread: true, ssr: true });
    try {
      expect(
        await f.adapter.send(
          { ...target, root: '88', parent: '88' },
          '喜欢这个细节',
          undefined,
          '42',
        ),
      ).toMatchObject({ receiptId: '7697799441646256820' });
      expect(f.submitted()).toMatchObject({ reply_id: '88', reply_to_reply_id: '0' });
    } finally {
      await f.cleanup();
    }
  });
  it('opens a hidden comment panel even when comment data and hidden rows were prefetched', async () => {
    const f = await fixture({ thread: true, hiddenList: true });
    try {
      expect(
        await f.adapter.send(
          { ...target, root: '88', parent: '99' },
          '这个细节很可爱',
          undefined,
          '42',
        ),
      ).toMatchObject({ receiptId: '7697799441646256820' });
      expect(f.accepted()).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
  it('recovers when the first click races the official panel auto-opening and closes it', async () => {
    const f = await fixture({ thread: true, hiddenList: true, autoCollapse: true });
    try {
      expect(
        await f.adapter.send(
          { ...target, root: '88', parent: '99' },
          '这个细节很可爱',
          undefined,
          '42',
        ),
      ).toMatchObject({ receiptId: '7697799441646256820' });
      expect(f.accepted()).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
  it('checks sender identity without navigating away from the already prepared thread page', async () => {
    const f = await fixture({ thread: true, ssr: true });
    try {
      await f.adapter.comments({ ...target, root: '88', parent: '88' }, 1);
      const current = (f.adapter as any).context.pages()[0];
      let resets = 0;
      current.on('framenavigated', (frame: any) => {
        if (frame === current.mainFrame() && new URL(frame.url()).pathname === '/user/self')
          resets++;
      });
      await f.adapter.send(
        { ...target, root: '88', parent: '99' },
        '这个细节很可爱',
        undefined,
        '42',
      );
      expect(resets).toBe(0);
      expect(f.accepted()).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
  it('opens comments when hover moves the official comment icon away from the mouse target', async () => {
    const f = await fixture({ thread: true, hiddenList: true, movingIcon: true });
    try {
      expect(
        await f.adapter.send(
          { ...target, root: '88', parent: '99' },
          '这个细节很可爱',
          undefined,
          '42',
        ),
      ).toMatchObject({ receiptId: '7697799441646256820' });
    } finally {
      await f.cleanup();
    }
  });
  it('keeps DOM-only replies inside their actual root and excludes author-like badges from text', async () => {
    const f = await fixture({ thread: true, ssr: true });
    try {
      const page = await f.adapter.comments({ ...target, root: '88', parent: '88' }, 1);
      expect(page.root).toMatchObject({ id: '88', text: '好可爱' });
      expect(page.items).toContainEqual(
        expect.objectContaining({
          id: '99',
          authorId: 'MS4wLjABAAAAtest_person2',
          target: { ...target, root: '88', parent: '99' },
        }),
      );
    } finally {
      await f.cleanup();
    }
  });
  it('replies to an exact child even when parent and child have identical names and text', async () => {
    const f = await fixture({ thread: true, ssr: true });
    try {
      expect(
        await f.adapter.send(
          { ...target, root: '88', parent: '99' },
          '这个细节很可爱',
          undefined,
          '42',
        ),
      ).toMatchObject({ receiptId: '7697799441646256820' });
      expect(f.accepted()).toBe(1);
      expect(f.submitted()).toMatchObject({ reply_id: '88', reply_to_reply_id: '99' });
    } finally {
      await f.cleanup();
    }
  });
  it('blocks a reply that the page tries to address to another child', async () => {
    const f = await fixture({ thread: true, ssr: true, wrongReply: true });
    try {
      await expect(
        f.adapter.send({ ...target, root: '88', parent: '99' }, '这个细节很可爱', undefined, '42'),
      ).rejects.toMatchObject({ kind: 'rejected' });
      expect(f.accepted()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  it('waits for a stable own-profile identity after a transient numeric API response', async () => {
    const f = await fixture({ delayedSelf: true });
    try {
      expect(
        await f.adapter.send(
          target,
          '这个细节很可爱',
          undefined,
          'MS4wLjABAAAAtest_owner_identity',
        ),
      ).toMatchObject({ receiptId: '7697799441646256820' });
    } finally {
      await f.cleanup();
    }
  });
  it('recognizes an authenticated server-rendered own profile without a profile API request', async () => {
    const f = await fixture({ ssrSelf: true });
    try {
      expect(await f.adapter.account()).toEqual({
        id: 'MS4wLjABAAAAtest_owner_identity',
        name: '测试账号',
      });
      expect(f.accepted()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  it('reads only matched public details and preserves exact comment identifiers', async () => {
    const f = await fixture();
    try {
      expect(await f.adapter.video(id)).toMatchObject({
        id,
        title: expect.stringContaining('游戏创作'),
      });
      expect(await f.adapter.comments(target, 1)).toMatchObject({
        items: [{ id: '88', authorId: 'MS4wLjABAAAAtest_person', target: { oid: id, type: 2 } }],
      });
      expect(f.accepted()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  it('reads server-rendered facts and exact comment text without a detail or comment API response', async () => {
    const f = await fixture({ ssr: true });
    try {
      const video = await f.adapter.video(id);
      expect(video.title).toBe('游戏创作 #游戏');
      const result = await f.adapter.comments(target, 1);
      expect(result.items).toContainEqual(
        expect.objectContaining({ id: '88', text: '好可爱', authorId: 'MS4wLjABAAAAtest_person' }),
      );
      expect(result.items[0].text).not.toContain('展开');
      const frames = await f.adapter.frames(video, [3]);
      expect(frames[0].atSec).toBe(3);
      expect(frames[0].bytes.length).toBeGreaterThan(1000);
      expect(f.accepted()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  it('recognizes a real image post without requiring a video player or inventing audio duration', async () => {
    const f = await fixture({ images: true });
    try {
      expect(await f.adapter.video(id)).toMatchObject({
        id,
        kind: 'images',
        durationSec: 0,
        title: expect.stringContaining('游戏创作'),
      });
      expect(f.accepted()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  it('advances a real visible player and never invents a new feed id from prefetched records', async () => {
    const f = await fixture({ feed: true });
    try {
      expect((await f.adapter.nextVideo([])).id).toBe(id);
      expect((await f.adapter.nextVideo([id])).id).toBe('7697799441646256821');
      expect(f.accepted()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  it('reads only works from the exact canonical creator page', async () => {
    const f = await fixture({ owner: true });
    try {
      const result = await f.adapter.creatorVideos('MS4wLjABAAAAtest_owner_identity', 12);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        aid: id,
        ownerId: 'MS4wLjABAAAAtest_owner_identity',
        title: '主人创作',
      });
      expect(f.accepted()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  it('activates a collapsed official-style editor and clicks only its scoped unlabeled send icon', async () => {
    const f = await fixture({ collapsed: true });
    try {
      expect(await f.adapter.send(target, '这个细节好可爱', undefined, '42')).toMatchObject({
        receiptId: '7697799441646256820',
      });
      expect(f.accepted()).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
  it('tracks submissions without a trailing slash and still prevents a duplicate', async () => {
    const f = await fixture({ noSlash: true, twice: true });
    try {
      expect(await f.adapter.send(target, '同一条评论', undefined, '42')).toMatchObject({
        receiptId: '7697799441646256820',
      });
      expect(f.accepted()).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
  it('accepts one exact webpage submission and blocks an automatic duplicate', async () => {
    const f = await fixture({ twice: true });
    try {
      expect(await f.adapter.send(target, '这个细节好可爱', undefined, '42')).toEqual({
        receiptId: '7697799441646256820',
        transport: 'browser',
      });
      expect(f.accepted()).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
  it('blocks a mismatched destination before it reaches the network', async () => {
    const f = await fixture({ wrongVideo: true });
    try {
      await expect(f.adapter.send(target, '测试', undefined, '42')).rejects.toMatchObject({
        kind: 'rejected',
      });
      expect(f.accepted()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  it('refuses a changed account before touching the comment form', async () => {
    const f = await fixture({ uid: '43' });
    try {
      await expect(f.adapter.send(target, '测试', undefined, '42')).rejects.toMatchObject({
        kind: 'auth',
      });
      expect(f.accepted()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  it('keeps a submission with an HTTP failure ambiguous rather than safe to retry', async () => {
    const f = await fixture({ httpFailure: true });
    try {
      await expect(f.adapter.send(target, '测试', undefined, '42')).rejects.toMatchObject({
        kind: 'network',
      });
      expect(f.accepted()).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
  it('releases the entire background after sending, including when group polling is enabled', async () => {
    const f = await fixture({
      thread: true,
      ssr: true,
      releaseAfterTask: true,
      groupListening: true,
    });
    try {
      const result = await f.adapter.send(
        { ...target, root: '88', parent: '99' },
        '喜欢这个细节',
        undefined,
        '42',
      );
      expect(result.receiptId).toBe('7697799441646256820');
      expect(Boolean(f.current())).toBe(false);
      expect(f.accepted()).toBe(1);
      await f.adapter.video(id);
      expect(Boolean(f.current())).toBe(false);
    } finally {
      await f.cleanup();
    }
  });
  it('starts a clean send page instead of inheriting a failed draft and its missing reply control', async () => {
    const f = await fixture({ thread: true, ssr: true });
    try {
      await f.adapter.comments({ ...target, root: '88', parent: '99' }, 1);
      const old = f.current()!.pages()[0];
      await old.evaluate(() => {
        document.querySelector('#reply-child')?.remove();
        document.querySelector('[contenteditable]')!.textContent = '遗留草稿';
      });
      const result = await f.adapter.send(
        { ...target, root: '88', parent: '99' },
        '新的回复',
        undefined,
        '42',
      );
      expect(result.receiptId).toBe('7697799441646256820');
      expect(f.submitted()).toMatchObject({
        text: '新的回复',
        reply_id: '88',
        reply_to_reply_id: '99',
      });
      expect(f.accepted()).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
  it('recovers one missing UI reply action before submitting, without duplicating the POST', async () => {
    const f = await fixture({ thread: true, ssr: true, releaseAfterTask: true });
    const adapter = f.adapter as any,
      original = adapter.ownAction.bind(adapter);
    let missing = true;
    const action = vi.spyOn(adapter, 'ownAction').mockImplementation(async (row, id, name) => {
      if (name === '回复' && missing) {
        missing = false;
        return undefined;
      }
      return original(row, id, name);
    });
    try {
      expect(
        (
          await f.adapter.send(
            { ...target, root: '88', parent: '99' },
            '恢复后的回复',
            undefined,
            '42',
          )
        ).receiptId,
      ).toBe('7697799441646256820');
      expect(f.accepted()).toBe(1);
      expect(Boolean(f.current())).toBe(false);
    } finally {
      action.mockRestore();
      await f.cleanup();
    }
  });
  it('initializes recommendations from the official entry in a cold background context', async () => {
    const f = await fixture({ coldFeed: true, feed: true });
    try {
      expect((await f.adapter.nextVideo([])).id).toBe(id);
      expect(new URL(f.navigations[0]).pathname).toBe('/jingxuan');
      expect(f.navigations.some((url) => new URL(url).searchParams.get('from_nav') === '1')).toBe(
        true,
      );
      expect(f.headless()).toBe(true);
      expect(f.accepted()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  it('recognizes explicit verification without calling it a logged-out account or waiting through feed retries', async () => {
    const f = await fixture({ verification: true });
    try {
      await expect(f.adapter.nextVideo([], AbortSignal.timeout(1500))).rejects.toThrow('人工验证');
      expect(f.accepted()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  it.skipIf(process.platform !== 'win32')(
    'keeps compatible Windows background windows offscreen and explicitly restores a visible login',
    async () => {
      const f = await fixture({ compatibilityWindow: true });
      try {
        await f.adapter.video(id);
        expect(f.headless()).toBe(false);
        expect(f.launchArgs()).toContain('--window-position=-32000,-32000');
        expect(f.launchArgs()).toContain('--disable-background-timer-throttling');
        await f.adapter.openLogin();
        expect(f.headless()).toBe(false);
        expect(f.launchArgs()).not.toContain('--window-position=-32000,-32000');
        expect(f.launchArgs()).toContain('--window-position=100,100');
      } finally {
        await f.cleanup();
      }
    },
  );
  it('bootstraps the official entry again after releasing a recommendation browser', async () => {
    const f = await fixture({ coldFeed: true, feed: true, releaseAfterTask: true });
    try {
      expect((await f.adapter.nextVideo([])).id).toBe(id);
      expect((await f.adapter.nextVideo([id])).id).toBe('7697799441646256821');
      expect(f.navigations.filter((url) => new URL(url).pathname === '/jingxuan')).toHaveLength(2);
      expect(f.current()).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  });
});

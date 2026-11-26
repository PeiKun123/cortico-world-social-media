import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { findBrowserExecutable } from '../src/platforms/bilibili-browser.ts';
import { PublicPostAdapter, PublicPostBrowser } from '../src/platforms/public-posts.ts';
import { POST_ORIGINS, POST_VISUAL_LEVELS, profileId } from '../src/public-post-policy.ts';
import { settingsPatch } from '../src/settings.ts';

const work = '0123456789abcdef01234567';
const owner = '1123456789abcdef01234567';
const account = '2123456789abcdef01234567';
const commenter = '3123456789abcdef01234567';
const comment = '4123456789abcdef01234567';
const receipt = '5123456789abcdef01234567';

it('pins a safe profile selector and makes visual budgets distinct', () => {
  const url = POST_ORIGINS.xiaohongshu + '/user/profile/' + owner;
  expect(profileId('xiaohongshu', url + '?xsec_token=private')?.url.href).toBe(url);
  expect(profileId('xiaohongshu', 'https://other.test/user/profile/' + owner)).toBeUndefined();
  expect(settingsPatch({ 'worlds.socialmedia.platforms.xiaohongshu.focus.account': url + '?xsec_token=private' }))
    .toMatchObject({ platforms: { xiaohongshu: { focus: { account: url } } } });
  expect(Object.values(POST_VISUAL_LEVELS).map(x => x.images)).toEqual([1, 3, 6]);
});

it('validates public account ids using the same profile format as the reader', () => {
  const browser = new PublicPostBrowser('unused');
  const rednote = new PublicPostAdapter('xiaohongshu', browser);
  const tieba = new PublicPostAdapter('tieba', browser);
  expect(rednote.validRecipientId(commenter)).toBe(true);
  expect(rednote.validRecipientId('42')).toBe(false);
  expect(rednote.validRecipientId(commenter + '?xsec_token=wrong')).toBe(false);
  expect(tieba.validRecipientId('tb.reader')).toBe(true);
  expect(tieba.validRecipientId('tb.reader ')).toBe(false);
});

describe.skipIf(!findBrowserExecutable())('public post adapter on an offline Chromium fixture', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: findBrowserExecutable(), headless: true });
  });
  afterAll(async () => { await browser?.close(); });

  function fixture(wrongTarget = false, selfLayout?: string, pictures = false, creatorRoute = false, delayedImage = false, delayedComment = false, standaloneComment = false, replyLabel = '1', responseCode?: number) {
    const media = delayedImage
      ? '<div class="media-container"><div class="swiper-slide swiper-slide-active" data-index="0" data-swiper-slide-index="0"></div></div>' +
        '<script>setTimeout(() => {const img=document.createElement("img"); img.width=48; img.height=48; img.src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2248%22 height=%2248%22%3E%3Crect width=%2248%22 height=%2248%22 fill=%22blue%22/%3E%3C/svg%3E"; document.querySelector(".swiper-slide-active").append(img);}, 1700);</script>'
      : '<div class="img-container"><div class="swiper-slide"><img src="/fixture.jpg" /></div></div>';
    const backend = new PublicPostBrowser('unused');
    const writes: unknown[] = [];
    const self = selfLayout ?? '<aside><a href="/user/profile/' + account + '">我的主页</a></aside>';
    const noteRoute = creatorRoute ? '/user/profile/' + owner + '/' + work : '/explore/' + work;
    const list = '<main><a href="' + noteRoute + '?xsec_token=fixture">周末散步</a></main>';
    const newCommentEntry = standaloneComment
      ? '<div class="engage-bar"><div class="input-box" onclick="document.querySelector(\'#fixture-editor\').hidden=false"><input placeholder="说点什么..."/></div></div>'
      : '';
    const post = self + '<div class="note-container"><a href="/user/profile/' + owner + '">主人</a><h1 id="detail-title">雨中散步</h1>' +
      '<div id="detail-desc">先逛公园再去喝茶。</div>' + media + '</div>' +
      '<div class="comments-container"><div class="comment-item" id="comment-' + comment + '">' +
      '<a href="/user/profile/' + commenter + '">路人</a><div class="content">' +
      (pictures ? '' : '这次是几点去的？') + '</div>' +
      (pictures ? '<img class="comment-image" width="48" height="48" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2248%22 height=%2248%22%3E%3Crect width=%2248%22 height=%2248%22 fill=%22blue%22/%3E%3C/svg%3E">' : '') +
      (delayedComment
        ? '<div class="interactions"><div class="reply icon-container" onclick="document.querySelector(\'#fixture-editor\').hidden=false"><svg class="reply-icon"></svg><span>' + replyLabel + '</span></div></div>'
        : '<button onclick="document.querySelector(\'#fixture-editor\').hidden=false">回复</button>') + '</div></div>' +
      '<div class="' + (delayedComment ? 'note-comment-editor' : 'comment-input') +
        '" id="fixture-editor" hidden><textarea id="content-textarea"></textarea><button id="send" class="btn submit">发送</button></div>' + newCommentEntry +
      '<script>document.querySelector("#send").onclick = async () => {' +
      'const body = JSON.stringify({note_id:"' + work + '",' +
      (standaloneComment && !wrongTarget ? '' : 'target_comment_id:"' + (wrongTarget ? commenter : comment) + '",') +
      'content:document.querySelector("textarea").value});' +
      'for(let i=0;i<2;i++) await fetch("/api/sns/web/v1/comment/post",{method:"POST",headers:{"content-type":"application/json"},body}).catch(()=>{});' +
      '};</script>' +
      (delayedComment ? '<script>const thread=document.querySelector(".comments-container"); thread.remove(); setTimeout(() => document.body.append(thread), 1100);</script>' : '') +
      (creatorRoute && delayedComment ? '<script>history.replaceState({}, "", "/explore/' + work + '");</script>' : '');
    vi.spyOn(backend, 'withPublicPage').mockImplementation(async <T>(
      _platform: Parameters<PublicPostBrowser['withPublicPage']>[0],
      _signal: AbortSignal, run: (page: Page) => Promise<T>,
      options?: Parameters<PublicPostBrowser['withPublicPage']>[3],
    ): Promise<T> => {
      const context = await browser.newContext();
      try {
        await context.route('**/*', route => {
          const req = route.request(), at = new URL(req.url());
          if (req.method() === 'POST') {
            if (!options?.allowWrite?.(req)) return route.abort();
            writes.push(req.postDataJSON());
            return route.fulfill({ json: responseCode === undefined ? { success: true, data: { comment: { id: receipt } } } : { success: false, code: responseCode } });
          }
          if (at.origin !== POST_ORIGINS.xiaohongshu || req.resourceType() !== 'document') return route.abort();
          return route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: at.pathname === noteRoute && (!creatorRoute || at.searchParams.get('xsec_token') === 'fixture') ? post :
              at.pathname === '/user/profile/' + owner ? '<h1>主人</h1>' + list : self + list,
          });
        });
        return await run(await context.newPage());
      } finally { await context.close(); }
    });
    return { adapter: new PublicPostAdapter('xiaohongshu', backend), writes };
  }

  it('resumes a Xiaohongshu comment sweep across a long thread and scroll-loaded roots', async () => {
    const backend = new PublicPostBrowser('unused');
    const threadId = 'a'.repeat(24);
    const otherIds = Array.from({ length: 8 }, (_, i) => ((i + 1).toString(16)).repeat(24));
    const photoId = 'f'.repeat(24);
    const row = (id: string, text: string) => '<div class="comment-item" id="comment-' + id + '">' +
      '<a href="/user/profile/' + commenter + '">读者</a><div class="content">' + text + '</div></div>';
    const root = (id: string, text: string) => '<div class="parent-comment">' + row(id, text) + '</div>';
    const html = `<style>.note-scroller{height:140px;overflow-y:scroll}.comment-item{min-height:45px}</style>
      <div class="note-scroller"><div class="comments-container"><div class="list-container">
      <div class="parent-comment">${row(threadId, '第一楼')}
      <div class="reply-container"><button class="show-more">展开回复</button></div></div>
      ${otherIds.slice(0, 6).map((id, i) => root(id, '评论' + i)).join('')}
      </div></div></div><script>
      const list = document.querySelector('.list-container');
      const button = document.querySelector('.show-more');
      let reply = 0;
      button.onclick = () => {
        const next = ['b','c','d','f'][reply++].repeat(24);
        button.insertAdjacentHTML('beforebegin', '<div class="comment-item" id="comment-' + next + '">' +
          '<a href="/user/profile/${commenter}">读者</a>' +
          (reply === 4 ? '<img class="comment-image" width="60" height="60" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2260%22 height=%2260%22%3E%3Crect width=%2260%22 height=%2260%22 fill=%22blue%22/%3E%3C/svg%3E">' : '<div class="content">回复' + reply + '</div>') +
          '</div>');
        if (reply === 4) button.remove();
      };
      document.querySelector('.note-scroller').onscroll = () => {
        if (list.dataset.loaded) return;
        list.dataset.loaded='true';
        list.insertAdjacentHTML('beforeend', ${JSON.stringify(otherIds.slice(6).map((id, i) => root(id, '后来加载' + i)).join(''))});
        list.insertAdjacentHTML('afterend','<div class="end-container">- THE END -</div>');
      };
      </script>`;
    vi.spyOn(backend, 'withPublicPage').mockImplementation(async (_platform, _signal, run) => {
      const context = await browser.newContext();
      try {
        await context.route('https://www.xiaohongshu.com/**', route =>
          route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
        return await run(await context.newPage());
      } finally { await context.close(); }
    });
    const adapter = new PublicPostAdapter('xiaohongshu', backend);
    const target = { oid: work, type: 5, root: '0', parent: '0' };
    const first = await adapter.comments(target, 1);
    expect(first.items.map(x => x.id)).toEqual([threadId, ...['b','c','d'].map(x => x.repeat(24))]);
    expect(first.nextCursor).toBe(threadId + ':' + 'd'.repeat(24));
    const second = await adapter.comments(target, 2, undefined, first.nextCursor);
    expect(second.items[0]).toMatchObject({ id: photoId, imageCount: 1, target: { root: threadId, parent: photoId } });
    const third = await adapter.comments(target, 3, undefined, second.nextCursor);
    expect([...second.items.slice(1), ...third.items].map(x => x.id)).toEqual(otherIds);
    expect(third.nextCursor).toBeUndefined();
    const photo = await adapter.commentImages({ ...target, root: threadId, parent: photoId }, 1);
    expect(photo[0]?.bytes.length).toBeGreaterThan(100);
  }, 18000);

  it('waits for the first active carousel image to mount', async () => {
    const { adapter } = fixture(false, undefined, false, false, true);
    const selection = await adapter.search('散步', 1);
    const post = await adapter.video(selection.items[0].id, 1);
    const frames = await adapter.gallery(post, [1]);
    expect(frames.map(frame => frame.atSec)).toEqual([1]);
  });

  it('waits for the carousel to finish before passing over intermediate pictures', async () => {
    const backend = new PublicPostBrowser('unused');
    vi.spyOn(backend, 'withPublicPage').mockImplementation(async (_platform, _signal, run) => {
      const context = await browser.newContext();
      try {
        await context.route('https://www.xiaohongshu.com/**', route =>
          route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
            <main class="note-container"><div id="detail-desc">三张图</div>
              <div class="media-container"><div class="swiper-wrapper">
                ${['red', 'green', 'blue'].map((color, i) =>
                  '<div class="swiper-slide' + (i === 0 ? ' swiper-slide-active' : '') + '" data-index="' + i +
                  '" data-swiper-slide-index="' + i + '"><img width="48" height="48" src="data:image/svg+xml,' +
                  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="' + color + '"/></svg>') +
                  '"></div>').join('')}
              </div><button class="arrow-controller right">下一张</button></div>
            </main><script>
              const slides = [...document.querySelectorAll('.swiper-slide')];
              let index = 0, animating = false;
              document.querySelector('.arrow-controller').onclick = () => {
                if (animating || index >= slides.length - 1) return;
                slides[index++].classList.remove('swiper-slide-active');
                slides[index].classList.add('swiper-slide-active');
                animating = true;
                document.querySelector('.swiper-wrapper').animate([{ opacity: .9 }, { opacity: 1 }], 570)
                  .finished.then(() => { animating = false; });
              };
            </script>` }));
        return await run(await context.newPage());
      } finally { await context.close(); }
    });
    const adapter = new PublicPostAdapter('xiaohongshu', backend);
    const post = await adapter.video(work, 1);
    const frames = await adapter.gallery(post, [1, 3]);
    expect(frames.map(frame => frame.atSec)).toEqual([1, 3]);
    expect(frames[0].bytes.equals(frames[1].bytes)).toBe(false);
  });

  it('binds the existing login page and keeps it open if verification is still needed', async () => {
    const backend = new PublicPostBrowser('unused');
    const context = await browser.newContext();
    try {
      await context.route('**/*', route => {
        const u = new URL(route.request().url());
        if (u.origin !== POST_ORIGINS.tieba) return route.abort();
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: u.pathname === '/verify'
          ? '<h1>请完成验证</h1>'
          : u.pathname === '/home/main' ? '<button>编辑资料</button>' : '<h1>贴吧</h1>' });
      });
      const launched = vi.spyOn(backend as any, 'launch').mockResolvedValue(context);
      await backend.openLogin('tieba');
      const page = context.pages()[0];
      const adapter = new PublicPostAdapter('tieba', backend);
      await page.goto(POST_ORIGINS.tieba + '/verify');
      await expect(adapter.reconnect()).rejects.toThrow('验证');
      expect(backend.loginOpen('tieba')).toBe(true);
      await page.goto(POST_ORIGINS.tieba + '/home/main?id=tb.bot');
      await expect(adapter.reconnect()).resolves.toMatchObject({ id: 'tb.bot' });
      expect(backend.loginOpen('tieba')).toBe(false);
      expect(launched).toHaveBeenCalledTimes(1);
      expect(launched).toHaveBeenCalledWith('tieba', false);
    } finally { await context.close().catch(() => {}); }
  });

  it('retains an image-only reply and captures its exact comment image', async () => {
    const { adapter } = fixture(false, undefined, true);
    const target = { oid: work, type: 5, root: comment, parent: comment };
    await expect(adapter.comments(target, 1)).resolves.toMatchObject({
      items: [{ target, text: '', imageCount: 1 }],
    });
    const frames = await adapter.commentImages(target, 1);
    expect(frames).toHaveLength(1);
    expect(frames[0].bytes.length).toBeGreaterThan(30);
    await expect(adapter.commentImages({ ...target, root: commenter, parent: commenter }, 1)).rejects.toThrow('楼层');
  });

  it('follows an official creator note route with its page access parameters intact', async () => {
    const { adapter } = fixture(false, undefined, false, true);
    await adapter.resolveCreator(POST_ORIGINS.xiaohongshu + '/user/profile/' + owner);
    const result = await adapter.creatorVideos(owner, 3);
    expect(result.items).toMatchObject([{ id: work, ownerId: owner }]);
    expect(result.items[0].url).not.toContain('xsec_token');
  });

  it('recognizes Xiaohongshu’s own link in the site navigation and ignores lookalike post authors', async () => {
    const { adapter } = fixture(false,
      '<nav><a href="/user/profile/' + account + '">我</a></nav>' +
      '<article><a href="/user/profile/' + owner + '">我</a></article>');
    await expect(adapter.reconnect()).resolves.toMatchObject({ id: account });
  });

  it('opens the Tieba avatar menu and verifies the personal profile navigation', async () => {
    const backend = new PublicPostBrowser('unused');
    vi.spyOn(backend, 'withPublicPage').mockImplementation(async (_platform, _signal, run) => {
      const ctx = await browser.newContext();
      try {
        await ctx.route('**/*', route => {
          const u = new URL(route.request().url());
          if (u.origin !== POST_ORIGINS.tieba) return route.abort();
          return route.fulfill({ contentType: 'text/html; charset=utf-8', body: u.pathname === '/'
            ? '<div class="user-or-login"><button class="user-avatar" onclick="document.querySelector(\'ul\').hidden=false"><img class="user-avatar" style="width:32px;height:32px"></button><ul hidden><li onclick="location.href=\'/home/main?id=tb.bot\'">个人主页</li></ul></div>'
            : '<h1>本人账号</h1>' });
        });
        return await run(await ctx.newPage());
      } finally { await ctx.close(); }
    });
    await expect(new PublicPostAdapter('tieba', backend).reconnect()).resolves.toEqual({ id: 'tb.bot', name: '本人账号' });
  });

  it('discovers posts, pins the owner, and reads a stable reply target without exposing a routing token', async () => {
    const { adapter } = fixture();
    expect(await adapter.account()).toMatchObject({ id: account });
    expect(await adapter.resolveCreator(POST_ORIGINS.xiaohongshu + '/user/profile/' + owner)).toEqual({ id: owner, name: '主人' });
    const listed = await adapter.creatorVideos(owner, 3);
    expect(listed.items).toMatchObject([{
      id: work, aid: work, title: '雨中散步', url: POST_ORIGINS.xiaohongshu + '/explore/' + work, ownerId: owner,
    }]);
    expect(await adapter.nextVideo([])).toMatchObject({ id: work, ownerId: owner, title: '雨中散步' });
    expect((await adapter.comments({ oid: work, type: 5, root: '0', parent: '0' }, 1)).items)
      .toMatchObject([{ id: comment, authorId: commenter, target: { root: comment, parent: comment } }]);
  }, 15000);

  it('confirms a single exact native reply and rejects a mismatched account', async () => {
    const { adapter, writes } = fixture();
    const target = { oid: work, type: 5, root: comment, parent: comment };
    await expect(adapter.send(target, '大约三点去的。', undefined, owner)).rejects.toThrow('账号已更换');
    expect(writes).toHaveLength(0);
    await expect(adapter.send(target, '大约三点去的。', undefined, account))
      .resolves.toEqual({ receiptId: receipt, transport: 'browser' });
    expect(writes).toEqual([{ note_id: work, target_comment_id: comment, content: '大约三点去的。' }]);
  }, 15000);

  it('uses the visible reply icon on a lazy floor after the same note becomes canonical', async () => {
    const { adapter, writes } = fixture(false, undefined, false, true, false, true);
    await adapter.resolveCreator(POST_ORIGINS.xiaohongshu + '/user/profile/' + owner);
    expect((await adapter.creatorVideos(owner, 1)).items).toMatchObject([{ id: work }]);
    const target = { oid: work, type: 5, root: comment, parent: comment };
    await expect(adapter.send(target, '大约三点去的。', undefined, account))
      .resolves.toEqual({ receiptId: receipt, transport: 'browser' });
    expect(writes).toHaveLength(1);
  });

  it('uses the single Xiaohongshu reply control when its icon and text are nested', async () => {
    const { adapter, writes } = fixture(false, undefined, false, false, false, true, false, '回复');
    const target = { oid: work, type: 5, root: comment, parent: comment };
    await expect(adapter.send(target, '大约三点去的。', undefined, account))
      .resolves.toEqual({ receiptId: receipt, transport: 'browser' });
    expect(writes).toEqual([{ note_id: work, target_comment_id: comment, content: '大约三点去的。' }]);
  });

  it('retains the official response code when a submitted reply has no receipt', async () => {
    const { adapter, writes } = fixture(false, undefined, false, false, false, false, true, '1', -102);
    await expect(adapter.send({ oid: work, type: 5, root: '0', parent: '0' }, '回复测试', undefined, account))
      .rejects.toMatchObject({ kind: 'network', message: expect.stringContaining('HTTP 200，平台代码 -102') });
    expect(writes).toHaveLength(1);
  });
  it('creates one independent comment and blocks an unexpected reply target', async () => {
    const root = { oid: work, type: 5, root: '0', parent: '0' };
    const { adapter, writes } = fixture(false, undefined, false, false, false, false, true);
    await expect(adapter.send(root, '雨后的路面画得挺真实。', undefined, account))
      .resolves.toEqual({ receiptId: receipt, transport: 'browser' });
    expect(writes).toEqual([{ note_id: work, content: '雨后的路面画得挺真实。' }]);

    const wrong = fixture(true, undefined, false, false, false, false, true);
    await expect(wrong.adapter.send(root, '雨后的路面画得挺真实。', undefined, account))
      .rejects.toMatchObject({ kind: 'rejected' });
    expect(wrong.writes).toEqual([]);
  }, 15000);

  it('opens only the targeted Xiaohongshu thread and replies to its exact child floor', async () => {
    const child = '6123456789abcdef01234567';
    const body = `<aside><a href="/user/profile/${account}">我的主页</a></aside>
      <div class="comments-container"><div class="parent-comment">
        <div class="comment-item" id="comment-${comment}"><a href="/user/profile/${commenter}">路人</a><div class="content">这条路不错。</div></div>
        <div class="reply-container">
          <div class="show-more" onclick="this.hidden=true;document.querySelector('.comment-item-sub').hidden=false">展开 1 条回复</div>
          <div class="list-container"><div hidden class="comment-item comment-item-sub" id="comment-${child}">
            <a href="/user/profile/${owner}">另一个读者</a><div class="content">下雨以后会不会滑？</div>
            <div class="interactions"><div class="reply icon-container" onclick="document.querySelector('#editor').hidden=false"><svg class="reply-icon"></svg><span>0</span></div></div>
          </div></div>
        </div>
      </div></div>
      <div id="editor" hidden><textarea id="content-textarea"></textarea><button class="btn submit"
        onclick='fetch("/api/sns/web/v1/comment/post",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({note_id:"${work}",target_comment_id:"${child}",content:document.querySelector("textarea").value})})'>发送</button></div>`;
    const writes: unknown[] = [];
    const backend = new PublicPostBrowser('unused');
    vi.spyOn(backend, 'withPublicPage').mockImplementation(async (_platform, _signal, run, options) => {
      const ctx = await browser.newContext();
      try {
        await ctx.route('**/*', route => {
          const req = route.request();
          if (req.method() === 'POST') {
            if (!options?.allowWrite?.(req)) return route.abort();
            writes.push(req.postDataJSON());
            return route.fulfill({ json: { success: true, data: { comment: { id: receipt } } } });
          }
          if (req.resourceType() !== 'document') return route.abort();
          return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
        });
        return await run(await ctx.newPage());
      } finally { await ctx.close(); }
    });
    const adapter = new PublicPostAdapter('xiaohongshu', backend);
    const target = { oid: work, type: 5, root: comment, parent: child };
    const shown = await adapter.comments(target, 1);
    expect(shown.items).toContainEqual(expect.objectContaining({ id: child, authorId: owner, target }));
    await expect(adapter.send(target, '石阶湿了确实得留神。', undefined, account))
      .resolves.toMatchObject({ receiptId: receipt });
    expect(writes).toEqual([{ note_id: work, target_comment_id: child, content: '石阶湿了确实得留神。' }]);
  }, 12000);

  it('waits for a Xiaohongshu player and returns an image for the requested frame', async () => {
    const backend = new PublicPostBrowser('unused');
    vi.spyOn(backend, 'withPublicPage').mockImplementation(async (_platform, _signal, run) => {
      const ctx = await browser.newContext();
      try {
        await ctx.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
          <meta property="og:type" content="video.other">
          <article class="note-container"><h1 id="detail-title">雨天视频</h1>
            <p id="detail-desc">路上的雨声。</p>
          </article>
          <script>
            setTimeout(()=>{
              const v=document.createElement('video');
              v.width=200; v.height=112;
              let isReady=false, position=0;
              Object.defineProperties(v,{
                duration:{get:()=>isReady?8:NaN},readyState:{get:()=>isReady?2:0},videoWidth:{get:()=>isReady?200:0},
                currentTime:{get:()=>position,set:t=>{position=t;setTimeout(()=>v.dispatchEvent(new Event('seeked')),50);}}
              });
              document.querySelector('article').append(v);
              setTimeout(()=>{isReady=true;v.dispatchEvent(new Event('loadeddata'));},300);
            },500);
          </script>` }));
        return await run(await ctx.newPage());
      } finally { await ctx.close(); }
    });
    const adapter = new PublicPostAdapter('xiaohongshu', backend);
    const clip = await adapter.video(work, 1);
    expect(clip).toMatchObject({ kind: 'video', durationSec: 8 });
    const frames = await adapter.frames(clip, [1, 3]);
    expect(frames.map(frame => frame.atSec)).toEqual([1, 3]);
    expect(frames[0].bytes.length).toBeGreaterThan(100);
  });

  it('blocks a reply intended for a different floor', async () => {
    const { adapter, writes } = fixture(true);
    const target = { oid: work, type: 5, root: comment, parent: comment };
    await expect(adapter.send(target, '大约三点去的。', undefined, account)).rejects.toMatchObject({kind:'rejected'});
    expect(writes).toHaveLength(0);
  }, 15000);

  it('reads the newer Tieba original and first public comment as distinct sources', async () => {
    const backend = new PublicPostBrowser('unused');
    const thread = '<div class="image-text"><a class="head-name" href="/home/main?id=tb.owner">楼主</a>' +
      '<span class="pb-title">雨天日记</span><div class="pb-content-wrap">下午开始下雨。</div></div>' +
      '<div class="pb-comment-item" data-id="12"><a class="head-name" href="/home/main?id=tb.reader">读者</a>' +
      '<div class="comment-content"><div class="pb-rich-text">看到小雨了？</div></div>' +
      '<div class="pb-lzl-item"><div class="comment-content"><div class="pb-rich-text">无可核实楼层编号</div></div></div></div>';
    vi.spyOn(backend, 'withPublicPage').mockImplementation(async (_platform, _signal, run) => {
      const context = await browser.newContext();
      try {
        await context.route('https://tieba.baidu.com/**', route =>
          route.fulfill({ contentType: 'text/html; charset=utf-8', body: thread }));
        return await run(await context.newPage());
      } finally { await context.close(); }
    });
    const adapter = new PublicPostAdapter('tieba', backend);
    const url = POST_ORIGINS.tieba + '/p/111';
    await expect(backend.read('tieba', url, AbortSignal.timeout(5000))).resolves.toMatchObject({
      title: '雨天日记', text: '下午开始下雨。', comments: ['看到小雨了？'], url,
    });
    await expect(adapter.video('111', 1)).resolves.toMatchObject({
      title: '雨天日记', description: '下午开始下雨。', author: '楼主', ownerId: 'tb.owner',
    });
    await expect(adapter.comments({ oid: '111', type: 4, root: '0', parent: '0' }, 1)).resolves.toMatchObject({
      items: [{ id: '12', authorId: 'tb.reader', text: '看到小雨了？', target: { root: '12', parent: '12' } }],
    });
  });

  it('excludes the Tieba original post and replies to the exact verified floor', async () => {
    const backend = new PublicPostBrowser('unused');
    const writes: string[] = [];
    const home = '<header id="com_userbar"><a href="/home/main?id=tb.bot">我</a></header>';
    const thread = home + '<h1 class="core_title_txt">雨天日记</h1>' +
      '<div class="l_post" data-field=' + "'" + '{"content":{"post_id":"11","post_no":1}}' + "'" + '>' +
      '<a class="p_author_name" href="/home/main?id=tb.owner">主人</a><div class="d_post_content">三点去的。</div></div>' +
      '<div class="l_post" data-field=' + "'" + '{"content":{"post_id":"12","post_no":2}}' + "'" + '>' +
      '<a class="p_author_name" href="/home/main?id=tb.reader">读者</a><div class="d_post_content">看到小雨了？</div>' +
      '<button onclick="this.nextElementSibling.hidden=false">回复</button><div hidden>' +
      '<textarea></textarea><button id="send">发送</button></div></div>' +
      '<script>document.querySelector("#send").onclick=()=>fetch("/f/commit/post/add",{method:"POST",body:new URLSearchParams({tid:"111",quote_id:"12",content:document.querySelector("textarea").value})});</script>';
    vi.spyOn(backend, 'withPublicPage').mockImplementation(async <T>(
      _platform: Parameters<PublicPostBrowser['withPublicPage']>[0],
      _signal: AbortSignal, run: (page: Page) => Promise<T>,
      options?: Parameters<PublicPostBrowser['withPublicPage']>[3],
    ): Promise<T> => {
      const context = await browser.newContext();
      try {
        await context.route('**/*', route => {
          const req = route.request();
          if (req.method() === 'POST') {
            if (!options?.allowWrite?.(req)) return route.abort();
            writes.push(req.postData() || '');
            return route.fulfill({ json: { no: 0, data: { post_id: '13' } } });
          }
          if (new URL(req.url()).origin !== POST_ORIGINS.tieba || req.resourceType() !== 'document') return route.abort();
          return route.fulfill({ contentType: 'text/html; charset=utf-8', body: thread });
        });
        return await run(await context.newPage());
      } finally { await context.close(); }
    });
    const adapter = new PublicPostAdapter('tieba', backend);
    const work = { oid: '111', type: 4, root: '0', parent: '0' };
    const result = await adapter.comments(work, 1);
    expect(result.items).toMatchObject([{ id: '12', authorId: 'tb.reader', text: '看到小雨了？' }]);
    expect(result.items.map(item => item.id)).not.toContain('11');
    const { target } = result.items[0];
    await expect(adapter.send(target, '看到啦。', undefined, 'tb.bot'))
      .resolves.toEqual({ receiptId: '13', transport: 'browser' });
    expect(writes).toHaveLength(1);
    expect(new URLSearchParams(writes[0]).get('quote_id')).toBe('12');
  }, 15000);

});

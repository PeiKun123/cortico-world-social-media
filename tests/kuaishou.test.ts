import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import {
  KuaishouPlatform,
  kuaishouTarget,
  kuaishouVideoId,
  mapKuaishouComment,
  matchesKuaishouPublish,
} from '../src/platforms/kuaishou.ts';
import { findBrowserExecutable } from '../src/platforms/bilibili-browser.ts';
const id = '3xtestphoto12345',
  owner = '3xtestowner12345',
  bot = '3xtestbot1234567',
  parent = '1188819075821';
const target = { oid: id, type: 3, root: parent, parent };
it('preserves Kuaishou string identifiers and separates its namespace and URL origin', () => {
  expect(kuaishouVideoId('https://www.kuaishou.com/short-video/' + id)).toBe(id);
  expect(() => kuaishouVideoId('https://www.kuaishou.com.evil.test/short-video/' + id)).toThrow();
  expect(() => kuaishouTarget({ ...target, type: 2 })).toThrow();
  expect(
    mapKuaishouComment(
      {
        commentId: parent,
        authorId: owner,
        authorName: '访客',
        content: '好可爱',
        timestamp: 1792784619039,
      },
      id,
    ),
  ).toMatchObject({ id: parent, createdAt: 1792784619.039, target });
});
it('validates the exact Kuaishou recipient, text and photo author rather than just the video', () => {
  const v = {
    photoId: id,
    photoAuthorId: owner,
    content: '喜欢这个细节',
    replyToCommentId: parent,
    replyTo: owner,
  };
  expect(matchesKuaishouPublish(v, target, v.content, owner, owner)).toBe(true);
  expect(
    matchesKuaishouPublish(
      { ...v, replyToCommentId: '1188819075822' },
      target,
      v.content,
      owner,
      owner,
    ),
  ).toBe(false);
  expect(matchesKuaishouPublish({ ...v, replyTo: bot }, target, v.content, owner, owner)).toBe(
    false,
  );
});
describe.skipIf(!findBrowserExecutable())('Kuaishou offline browser boundaries', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: findBrowserExecutable(), headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  async function fixture(
    options: {
      changed?: boolean;
      reject?: boolean;
      empty?: boolean;
      image?: boolean;
      slowProfile?: boolean;
      wrongUid?: boolean;
      wrongTop?: boolean;
      duplicateTop?: boolean;
      missingReceipt?: boolean;
    } = {},
  ) {
    let profiles = 0;
    let launchedHeadless: boolean | undefined;
    let launchArgs: string[] = [];
    let accepted = 0,
      form: any;
    const adapter = new KuaishouPlatform(
      'unused-ks-profile',
      () => findBrowserExecutable()!,
      () => true,
      () => true,
      () => true,
    );
    const launch = vi
      .spyOn(chromium, 'launchPersistentContext')
      .mockImplementation(async (_profile, launchOptions) => {
        launchedHeadless = launchOptions?.headless;
        launchArgs = launchOptions?.args ?? [];
        const context = await browser.newContext();
        await context.setOffline(true);
        await context.route('**/*', async (route) => {
          const req = route.request(),
            url = new URL(req.url());
          let b: any;
          try {
            b = JSON.parse(req.postData() || '{}');
          } catch {
            b = {};
          }
          if (url.pathname === '/graphql') {
            let data: any;
            if (b.operationName === 'userInfo')
              data = {
                userInfo: {
                  id: options.changed ? '3xotherbot12345' : bot,
                  eid: options.changed ? '3xotherbot12345' : bot,
                  name: '测试小号',
                },
              };
            else if (b.operationName === 'visionVideoDetail')
              data = {
                visionVideoDetail: {
                  status: options.image ? 208005 : 1,
                  photo: {
                    id,
                    caption: '游戏创作',
                    timestamp: 1792784000000,
                    duration: 12000,
                    expTag: 'public-tracking',
                  },
                  author: { id: owner, name: '主人' },
                },
              };
            else if (b.operationName === 'commentListQuery')
              data = {
                visionCommentList: {
                  pcursorV2: 'no_more',
                  rootCommentsV2: [
                    {
                      commentId: parent,
                      authorId: owner,
                      authorName: '访客',
                      content: '好可爱',
                      timestamp: 1792784619039,
                    },
                  ],
                },
              };
            else if (b.operationName === 'visionSubCommentList')
              data = {
                visionSubCommentList: {
                  pcursorV2: 'no_more',
                  subCommentsV2: [
                    {
                      commentId: '1188819075822',
                      authorId: '3xvisitor12345',
                      authorName: '子回复访客',
                      content: '接上一句',
                      timestamp: 1792784619040,
                      status: 1,
                    },
                  ],
                  subComments: [],
                },
              };
            else if (b.operationName === 'visionAddComment') {
              accepted++;
              form = { ...b.variables, nativeClient: req.headers().kww === 'native-fixture' };
              data = {
                visionAddComment: {
                  result: options.reject ? 50 : 1,
                  ...(options.missingReceipt ? {} : { commentId: '1188819999999' }),
                },
              };
            } else data = {};
            return route.fulfill({
              contentType: 'application/json',
              body: JSON.stringify({ data }),
            });
          }
          if (url.pathname === '/rest/v/profile/feed') profiles++;
          if (url.pathname === '/rest/v/profile/feed')
            return route.fulfill({
              contentType: 'application/json',
              body: JSON.stringify({
                result: 1,
                feeds: options.empty
                  ? []
                  : [
                      {
                        photo: { id, caption: '游戏创作', duration: 12000 },
                        author: { id: owner, name: '主人' },
                      },
                    ],
              }),
            });
          if (url.pathname === '/rest/v/search/user')
            return route.fulfill({
              contentType: 'application/json',
              body: JSON.stringify({ result: 1, users: [{ user_id: owner, user_name: '主人' }] }),
            });
          const body = url.pathname.startsWith('/profile/')
            ? '<p>主人</p><span class="uid"> 快手号：1234567890 </span><script>fetch("/rest/v/profile/feed",{method:"POST",body:JSON.stringify({user_id:"' +
              owner +
              '",pcursor:"",page:"profile"})})</script>'
            : url.pathname.startsWith('/search/')
              ? '<script>fetch("/rest/v/search/user",{method:"POST",body:JSON.stringify({keyword:"1234567890"})})</script>'
              : url.pathname.startsWith('/short-video/')
                ? '<div class="comment-container"><div class="comment-input"><textarea></textarea><button class="submit-button">发送</button></div></div><script>document.querySelector("button").onclick=async()=>{const variables={photoId:' +
                  JSON.stringify(options.wrongTop ? '3xwrongphoto123' : id) +
                  ',photoAuthorId:' +
                  JSON.stringify(owner) +
                  ',content:document.querySelector("textarea").value,expTag:"native-page-tracking"};const b={operationName:"visionAddComment",query:"mutation visionAddComment($photoId:String,$photoAuthorId:String,$content:String,$replyToCommentId:ID,$replyTo:ID,$expTag:String){visionAddComment(photoId:$photoId,photoAuthorId:$photoAuthorId,content:$content,replyToCommentId:$replyToCommentId,replyTo:$replyTo,expTag:$expTag){result commentId content timestamp status __typename}}",variables};const go=()=>fetch("/graphql",{method:"POST",headers:{"Content-Type":"application/json","kww":"native-fixture"},body:JSON.stringify(b)}).catch(()=>{});await go();' +
                  (options.duplicateTop ? 'await go();' : '') +
                  '};</script>'
                : '<div>快手测试页</div>';
          const html =
            options.slowProfile && url.pathname.startsWith('/profile/')
              ? '<p>正在加载</p><script>setTimeout(()=>{document.body.innerHTML="<p>主人</p><span class=uid> 快手号：1234567890 </span>"},250)</script>'
              : options.wrongUid
                ? body.replace(' 快手号：1234567890 ', ' 快手号：9999999999 ') +
                  '<p>快手号：1234567890</p>'
                : body;
          return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
        });
        return context;
      });
    return {
      adapter,
      headless: () => launchedHeadless,
      launchArgs: () => launchArgs,
      accepted: () => accepted,
      profiles: () => profiles,
      form: () => form,
      cleanup: async () => {
        await adapter.stop();
        launch.mockRestore();
      },
    };
  }
  it('reads the logged-in identity and official comments without sending', async () => {
    const f = await fixture();
    try {
      expect(await f.adapter.account()).toMatchObject({ id: bot });
      expect((await f.adapter.video(id)).ownerId).toBe(owner);
      expect((await f.adapter.comments({ ...target, root: '0', parent: '0' })).items[0].id).toBe(
        parent,
      );
      expect(f.accepted()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  it('resolves a numeric handle only after the public profile displays that exact number', async () => {
    const f = await fixture();
    try {
      expect(await f.adapter.resolveCreator('1234567890')).toMatchObject({
        id: owner,
        name: '主人',
      });
    } finally {
      await f.cleanup();
    }
  });
  it('waits for the public profile handle to render instead of rejecting a still-loading profile', async () => {
    const f = await fixture({ slowProfile: true });
    try {
      expect(await f.adapter.resolveCreator('1234567890')).toMatchObject({ id: owner });
    } finally {
      await f.cleanup();
    }
  });
  it('uses the official handle field instead of a matching account claim in the biography', async () => {
    const f = await fixture({ wrongUid: true });
    try {
      await expect(f.adapter.resolveCreator('1234567890')).rejects.toThrow('精确核对');
    } finally {
      await f.cleanup();
    }
  });
  it('uses observed native profile responses and retains the exact creator identity', async () => {
    const f = await fixture();
    try {
      expect((await f.adapter.creatorVideos(owner, 3)).items[0]).toMatchObject({
        id,
        ownerId: owner,
      });
    } finally {
      await f.cleanup();
    }
  });
  it('refreshes an already open owner profile rather than permanently reusing an old works list', async () => {
    const f = await fixture();
    try {
      await f.adapter.creatorVideos(owner, 3);
      await f.adapter.creatorVideos(owner, 3);
      expect(f.profiles()).toBeGreaterThanOrEqual(2);
    } finally {
      await f.cleanup();
    }
  });
  it('does not interpret an empty official profile response as no published works', async () => {
    const f = await fixture({ empty: true });
    try {
      await expect(f.adapter.creatorVideos(owner, 3)).rejects.toThrow('不代表账号没有作品');
    } finally {
      await f.cleanup();
    }
  });
  it('reports unsupported image details while keeping comments readable and refusing an unverified send', async () => {
    const f = await fixture({ image: true });
    try {
      await expect(f.adapter.video(id)).rejects.toThrow('图文');
      expect((await f.adapter.comments({ ...target, root: '0', parent: '0' })).items).toHaveLength(
        1,
      );
      await expect(
        f.adapter.send(
          { ...target, root: '0', parent: '0' },
          '收到啦，快手回复功能测试中。',
          undefined,
          bot,
        ),
      ).rejects.toMatchObject({ kind: 'rejected' });
      expect(f.accepted()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  it('uses the native webpage composer for a top-level comment without inventing reply fields', async () => {
    const f = await fixture();
    try {
      expect(
        await f.adapter.send({ ...target, root: '0', parent: '0' }, '喜欢这个细节', undefined, bot),
      ).toMatchObject({ receiptId: '1188819999999', transport: 'browser' });
      expect(f.form()).toMatchObject({ content: '喜欢这个细节', nativeClient: true, photoId: id });
      expect(f.form().replyToCommentId).toBeUndefined();
      expect(f.accepted()).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
  it('blocks a native composer request addressed to another work before reaching the server', async () => {
    const f = await fixture({ wrongTop: true });
    try {
      await expect(
        f.adapter.send({ ...target, root: '0', parent: '0' }, '喜欢这个细节', undefined, bot),
      ).rejects.toMatchObject({ kind: 'rejected' });
      expect(f.accepted()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  it('allows only one submission when the native composer tries a duplicate request', async () => {
    const f = await fixture({ duplicateTop: true });
    try {
      await f.adapter.send({ ...target, root: '0', parent: '0' }, '喜欢这个细节', undefined, bot);
      expect(f.accepted()).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
  it('keeps an accepted native submission with a missing receipt uncertain and never resubmits', async () => {
    const f = await fixture({ missingReceipt: true });
    try {
      await expect(
        f.adapter.send({ ...target, root: '0', parent: '0' }, '喜欢这个细节', undefined, bot),
      ).rejects.toMatchObject({ kind: 'network' });
      expect(f.accepted()).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
  it('submits one exact reply with its recipient and retains the returned comment id', async () => {
    const f = await fixture();
    try {
      expect(await f.adapter.send(target, '喜欢这个细节', undefined, bot)).toMatchObject({
        receiptId: '1188819999999',
        transport: 'api',
      });
      expect(f.form()).toMatchObject({
        photoId: id,
        replyToCommentId: parent,
        replyTo: owner,
        content: '喜欢这个细节',
      });
      expect(f.accepted()).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
  it('loads actual child replies through the official separate subcomment read and preserves their root', async () => {
    const f = await fixture();
    try {
      const r = await f.adapter.comments(target);
      expect(r.items[0]).toMatchObject({
        id: '1188819075822',
        target: { oid: id, type: 3, root: parent, parent: '1188819075822' },
      });
      expect(f.accepted()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  it('validates a nested recipient using the separate subcomment read before one exact send', async () => {
    const f = await fixture();
    try {
      expect(
        await f.adapter.send({ ...target, parent: '1188819075822' }, '接住这句', undefined, bot),
      ).toMatchObject({ receiptId: '1188819999999' });
      expect(f.form()).toMatchObject({
        replyToCommentId: '1188819075822',
        replyTo: '3xvisitor12345',
      });
      expect(f.accepted()).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
  it('refuses a changed account before any public submission', async () => {
    const f = await fixture({ changed: true });
    try {
      await expect(f.adapter.send(target, '喜欢这个细节', undefined, bot)).rejects.toMatchObject({
        kind: 'auth',
      });
      expect(f.accepted()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  it('retains an explicit rejection without claiming success or retrying', async () => {
    const f = await fixture({ reject: true });
    try {
      await expect(f.adapter.send(target, '喜欢这个细节', undefined, bot)).rejects.toMatchObject({
        kind: 'rejected',
      });
      expect(f.accepted()).toBe(1);
    } finally {
      await f.cleanup();
    }
  });

  it('uses a headless background context and only shows explicit login', async () => {
    const f = await fixture();
    try {
      await f.adapter.account();
      expect(f.headless()).toBe(true);
      expect(f.launchArgs()).not.toContain('--start-minimized');
      await f.adapter.openLogin();
      expect(f.headless()).toBe(false);
      await f.adapter.closeLogin();
      await f.adapter.account();
      expect(f.headless()).toBe(true);
      expect(f.accepted()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
});

import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocialStore } from '../src/store.ts';
import { SOCIALMEDIA_DEFAULTS } from '../src/config.ts';
import { OwnerFocus, parseFocusAccount } from '../src/focus.ts';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'socialmedia-focus-'));
  dirs.push(dir);
  const cfg = structuredClone(SOCIALMEDIA_DEFAULTS);
  cfg.focus.enabled = true;
  cfg.focus.account = '同名';
  const store = new SocialStore(dir);
  return { dir, cfg, store, focus: new OwnerFocus(cfg, store) };
}
function contact(id: string, at: number) {
  return {
    id: 'i' + id,
    platform: 'bilibili',
    accountId: '42',
    authorId: id,
    author: '同名',
    text: '你好',
    occurredAt: at,
    status: 'pending' as const,
    target: { oid: '99', type: 1, root: '100', parent: id },
  };
}
it('accepts only canonical owner links or a local nickname', () => {
  expect(parseFocusAccount('https://space.bilibili.com/123?x=1')).toEqual({ uid: '123' });
  expect(parseFocusAccount('同名')).toEqual({ name: '同名' });
  expect(() => parseFocusAccount('https://evil.test/123')).toThrow();
});
it('binds earliest observed matching contact and pins its UID across spoofing and restart', () => {
  const x = setup();
  x.store.addInbox(contact('8', 20));
  x.store.addInbox(contact('7', 10));
  expect(x.focus.binding('42')?.ownerId).toBe('7');
  x.store.addInbox(contact('6', 5));
  expect(new OwnerFocus(x.cfg, new SocialStore(x.dir)).binding('42')?.ownerId).toBe('7');
  expect(x.focus.binding('other')).toBeUndefined();
});
it('waits for first contact when a nickname is not yet known, without guessing from global search', () => {
  const x = setup();
  expect(x.focus.binding('42')).toBeUndefined();
  x.store.addInbox(contact('7', 10));
  expect(x.focus.binding('42')?.ownerId).toBe('7');
});
it('queues bounded new-work and comment opportunities once, retaining participation history', async () => {
  const x = setup();
  x.cfg.focus.account = '7';
  let reads = 0;
  const adapter = {
    creatorVideos: async () => {
      reads++;
      return {
        items: [
          {
            aid: '99',
            id: 'BV1',
            title: '创作花絮',
            url: 'https://www.bilibili.com/video/av99/',
            ownerId: '7',
            author: '主人',
            publishedAt: Date.now() / 1000,
          },
        ],
      };
    },
    comments: async () => ({
      items: [
        {
          id: '200',
          authorId: '8',
          author: '观众',
          text: '这个细节很棒',
          target: { oid: '99', type: 1, root: '200', parent: '200' },
        },
      ],
    }),
  };
  await x.focus.poll(adapter, { id: '42', name: 'bot' });
  expect(x.store.inbox().filter((i) => i.focusOwnerId === '7')).toHaveLength(2);
  await x.focus.poll(adapter, { id: '42', name: 'bot' });
  expect(reads).toBe(1);
  expect(x.store.inbox()).toHaveLength(2);
  x.store.reserve({
    id: 'sent',
    platform: 'bilibili',
    accountId: '42',
    focusOwnerId: '7',
    text: '喜欢这个细节',
    target: { oid: '99', type: 1, root: '0', parent: '0' },
  });
  x.store.updateSend('sent', { status: 'sent', receiptId: '888' });
  expect(x.focus.status('42').works[0].participation).toBe('accepted');
});

it('rotates comment inspection across recent works and limits the visible scope', async () => {
  const x = setup();
  x.cfg.focus.account = '7';
  x.cfg.focus.maxVideos = 3;
  const inspected: string[] = [];
  const items = Array.from({ length: 3 }, (_, i) => ({
    aid: String(99 - i),
    id: 'av' + (99 - i),
    title: '创作' + i,
    url: 'https://www.bilibili.com/video/av' + (99 - i) + '/',
    ownerId: '7',
    publishedAt: 100 - i,
  }));
  const adapter = {
    creatorVideos: async () => ({ items }),
    comments: async (t: { oid: string }) => {
      inspected.push(t.oid);
      return { items: [] };
    },
  };
  await x.focus.poll(adapter, { id: '42', name: 'bot' });
  x.store.saveFocusCheck('42:7', { at: 0, nextAt: 0, cursor: 1 });
  await x.focus.poll(adapter, { id: '42', name: 'bot' });
  x.store.saveFocusCheck('42:7', { at: 0, nextAt: 0, cursor: 2 });
  await x.focus.poll(adapter, { id: '42', name: 'bot' });
  expect(inspected).toEqual(['99', '98', '97']);
  x.cfg.focus.maxVideos = 1;
  expect(x.focus.status('42').works).toHaveLength(1);
});
it('does not treat generated opportunities or other platforms as first contact', () => {
  const x = setup();
  x.store.addInbox({ ...contact('7', 10), platform: 'other' });
  expect(x.focus.binding('42')).toBeUndefined();
  x.store.addInbox({ ...contact('8', 1), focusOwnerId: '8' });
  expect(x.focus.binding('42')).toBeUndefined();
});
it('ignores works not owned by the pinned UID and stops a check if settings change', async () => {
  const x = setup();
  x.cfg.focus.account = '7';
  const adapter = {
    creatorVideos: async () => ({
      items: [
        {
          aid: '99',
          id: 'av99',
          title: '陌生作品',
          url: 'https://www.bilibili.com/video/av99/',
          ownerId: '8',
        },
      ],
    }),
    comments: async () => ({ items: [] }),
  };
  await x.focus.poll(adapter, { id: '42', name: 'bot' });
  expect(x.store.inbox()).toHaveLength(0);
  x.store.saveFocusCheck('42:7', { at: 0, nextAt: 0 });
  adapter.creatorVideos = async () => {
    x.cfg.focus.enabled = false;
    return {
      items: [
        {
          aid: '99',
          id: 'av99',
          title: '作品',
          url: 'https://www.bilibili.com/video/av99/',
          ownerId: '7',
        },
      ],
    };
  };
  await x.focus.poll(adapter, { id: '42', name: 'bot' });
  expect(x.store.inbox()).toHaveLength(0);
});

it('does not invite another reply to a comment already present as a notification', async () => {
  const x = setup();
  x.cfg.focus.account = '7';
  x.store.addInbox({
    ...contact('8', 10),
    target: { oid: '99', type: 1, root: '200', parent: '200' },
  });
  await x.focus.poll(
    {
      creatorVideos: async () => ({
        items: [
          {
            aid: '99',
            id: 'av99',
            title: '作品',
            url: 'https://www.bilibili.com/video/av99/',
            ownerId: '7',
          },
        ],
      }),
      comments: async () => ({
        items: [
          {
            id: '200',
            authorId: '8',
            author: '同名',
            text: '你好',
            target: { oid: '99', type: 1, root: '200', parent: '200' },
          },
        ],
      }),
    },
    { id: '42', name: 'bot' },
  );
  expect(x.store.inbox().filter((i) => i.notificationType === 'focus-comment')).toHaveLength(0);
});

it('isolates Douyin owner settings and opportunities from legacy Bilibili bindings', async () => {
  const x = setup();
  x.cfg.focus.account = '7';
  const owner = 'MS4wLjABAAAAfocus_owner',
    bot = 'MS4wLjABAAAAfocus_bot';
  x.cfg.platforms.douyin.focus = {
    ...x.cfg.focus,
    account: 'https://www.douyin.com/user/' + owner,
  };
  const dy = new OwnerFocus(x.cfg, x.store, 'douyin');
  expect(dy.binding(bot)?.ownerId).toBe(owner);
  expect(x.focus.binding('42')?.ownerId).toBe('7');
  await dy.poll(
    {
      creatorVideos: async () => ({
        items: [
          {
            aid: '99',
            id: '99',
            title: '主人作品',
            url: 'https://www.douyin.com/video/99',
            ownerId: owner,
          },
        ],
      }),
      comments: async () => ({ items: [] }),
    },
    { id: bot, name: '小号' },
  );
  expect(x.store.inbox()[0]).toMatchObject({
    platform: 'douyin',
    accountId: bot,
    target: { type: 2 },
  });
  expect(x.focus.status('42').works).toHaveLength(0);
  expect(new OwnerFocus(x.cfg, new SocialStore(x.dir), 'douyin').status(bot).works).toHaveLength(1);
  expect(() =>
    parseFocusAccount('https://www.douyin.com.evil.test/user/' + owner, 'douyin'),
  ).toThrow();
  expect(parseFocusAccount('自填抖音号', 'douyin')).toEqual({ name: '自填抖音号' });
});

it('offers an owner reply inside the bot own Douyin thread while leaving unrelated owner comments alone', async () => {
  const x = setup(),
    owner = 'MS4wLjABAAAAfocus_owner',
    bot = 'MS4wLjABAAAAfocus_bot';
  x.cfg.platforms.douyin.focus = { ...x.cfg.focus, account: owner };
  const focus = new OwnerFocus(x.cfg, x.store, 'douyin');
  x.store.reserve({
    id: 'own',
    platform: 'douyin',
    accountId: bot,
    text: '喜欢这个细节',
    target: { oid: '99', type: 2, root: '0', parent: '0' },
  });
  x.store.updateSend('own', { status: 'sent', receiptId: '100' });
  await focus.poll(
    {
      creatorVideos: async () => ({
        items: [
          {
            aid: '99',
            id: '99',
            title: '创作',
            url: 'https://www.douyin.com/video/99',
            ownerId: owner,
          },
        ],
      }),
      comments: async () => ({
        items: [
          {
            id: '100',
            authorId: bot,
            author: 'bot',
            text: '喜欢这个细节',
            target: { oid: '99', type: 2, root: '100', parent: '100' },
            replies: [
              {
                id: '201',
                authorId: owner,
                author: '主人',
                text: '收到了',
                target: { oid: '99', type: 2, root: '100', parent: '201' },
              },
            ],
          },
          {
            id: '300',
            authorId: owner,
            author: '主人',
            text: '其他话题',
            target: { oid: '99', type: 2, root: '300', parent: '300' },
          },
        ],
      }),
    },
    { id: bot, name: 'bot' },
  );
  expect(
    x.store
      .inbox()
      .filter((i) => i.notificationType === 'focus-comment')
      .map((i) => i.target.parent),
  ).toEqual(['201']);
});

it('retains an actionable resolution error and retries on explicit refresh without binding another account', async () => {
  const x = setup();
  x.cfg.platforms.douyin.focus = { ...x.cfg.focus, account: '1809102273' };
  const f = new OwnerFocus(x.cfg, x.store, 'douyin');
  let attempts = 0;
  const adapter = {
    resolveCreator: async () => {
      attempts++;
      throw Error('用户搜索暂未返回');
    },
    creatorVideos: async () => ({ items: [] }),
    comments: async () => ({ items: [] }),
  };
  await expect(f.poll(adapter, { id: 'bot', name: '小号' })).resolves.toBeUndefined();
  expect(f.status('bot').check?.error).toContain('用户搜索暂未返回');
  await f.poll(adapter, { id: 'bot', name: '小号' });
  expect(attempts).toBe(1);
  expect(f.binding('bot')).toBeUndefined();
});

it('baselines owner comments then queues every newly observed safe comment without a two-item selection cap', async () => {
  const x = setup();
  x.cfg.focus.account = '7';
  x.cfg.focus.autoReplyNewComments = true;
  x.cfg.focus.autoReplyIntervalMinutes = 2;
  let ids = ['100'];
  const adapter = {
    creatorVideos: async () => ({
      items: [
        {
          aid: '99',
          id: 'av99',
          title: '作品',
          url: 'https://www.bilibili.com/video/av99/',
          ownerId: '7',
        },
      ],
    }),
    comments: async () => ({
      items: ids.map((id) => ({
        id,
        author: '访客' + id,
        authorId: id,
        text: '喜欢这个细节',
        target: { oid: '99', type: 1, root: id, parent: id },
      })),
    }),
  };
  await x.focus.poll(adapter, { id: '42', name: 'bot' });
  expect(x.store.inbox().filter((i) => i.ownerAutoReply)).toHaveLength(0);
  const key = '42:7';
  const check = x.store.focusCheck(key)!;
  x.store.saveFocusCheck(key, { ...check, at: Date.now() - 120000, nextAt: 0 });
  ids = ['100', '101', '102', '103'];
  await x.focus.poll(adapter, { id: '42', name: 'bot' });
  expect(
    x.store
      .inbox()
      .filter((i) => i.ownerAutoReply)
      .map((i) => i.target.parent),
  ).toEqual(['101', '102', '103']);
  expect(JSON.stringify(x.focus.status('42'))).not.toContain('autoReplySeen');
  x.store.saveFocusCheck(key, { ...x.store.focusCheck(key)!, nextAt: 0 });
  await x.focus.poll(adapter, { id: '42', name: 'bot' });
  expect(x.store.inbox().filter((i) => i.ownerAutoReply)).toHaveLength(3);
});

it('retains a successful first comment page when a later page fails and reports incomplete coverage', async () => {
  const x = setup();
  x.cfg.focus.account = '7';
  x.cfg.focus.autoReplyNewComments = true;
  const key = '42:7';
  x.store.saveFocusCheck(key, {
    at: 0,
    nextAt: 0,
    autoReplySince: 1,
    autoReplySeen: { '99': ['100'] },
  });
  await x.focus.poll(
    {
      creatorVideos: async () => ({
        items: [
          {
            aid: '99',
            id: 'av99',
            title: '作品',
            url: 'https://www.bilibili.com/video/av99/',
            ownerId: '7',
          },
        ],
      }),
      comments: async (_t, page) => {
        if (page !== 1) throw Error('第二页断开');
        return {
          items: [
            {
              id: '101',
              authorId: '8',
              author: '访客',
              text: '喜欢',
              target: { oid: '99', type: 1, root: '101', parent: '101' },
            },
          ],
          nextCursor: 'next',
        };
      },
    },
    { id: '42', name: 'bot' },
  );
  expect(x.store.inbox().some((i) => i.ownerAutoReply && i.target.parent === '101')).toBe(true);
  expect(x.focus.status('42').check?.error).toContain('后续评论页');
});

it('keeps owner identity distinct from an unavailable Kuaishou work list', async () => {
  const x = setup();
  x.cfg.platforms.kuaishou.focus = { ...x.cfg.focus, account: '123456789' };
  const f = new OwnerFocus(x.cfg, x.store, 'kuaishou');
  await f.poll(
    {
      resolveCreator: async () => ({ id: '3xowner123456', name: '主人的账号' }),
      creatorVideos: async () => {
        throw Error('官网作品列表暂未返回');
      },
      comments: async () => ({ items: [] }),
    },
    { id: 'bot', name: 'bot' },
  );
  expect(f.status('bot')).toMatchObject({
    identity: { state: 'bound', profileUrl: 'https://www.kuaishou.com/profile/3xowner123456' },
    reading: { state: 'incomplete', cachedWorks: 0 },
  });
  expect(f.status('bot').identity.notice).toContain('已绑定');
  expect(f.status('bot').reading.notice).toContain('不代表账号搜不到');
  expect(f.binding('bot')?.name).toBe('主人的账号');
});

it('does not claim identity is resolved when owner lookup itself fails', async () => {
  const x = setup();
  x.cfg.platforms.kuaishou.focus = { ...x.cfg.focus, account: '123456789' };
  const f = new OwnerFocus(x.cfg, x.store, 'kuaishou');
  await f.poll(
    {
      resolveCreator: async () => {
        throw Error('账号搜索尚未完成');
      },
      creatorVideos: async () => ({ items: [] }),
      comments: async () => ({ items: [] }),
    },
    { id: 'bot', name: 'bot' },
  );
  expect(f.status('bot').identity).toMatchObject({ state: 'unresolved' });
  expect(f.status('bot').identity.profileUrl).toBeUndefined();
});

it('does not report a missing owner while the bot account is still being checked after restart', () => {
  const x = setup();
  x.cfg.focus.account = '7';
  expect(x.focus.status('').identity).toMatchObject({ state: 'awaiting-account' });
  expect(x.focus.status('').identity.notice).toContain('不代表主人绑定丢失');
});

it.each(['bilibili', 'douyin', 'kuaishou'])(
  'considers ordinary, emoji and owner comments on %s owner works',
  async (platform) => {
    const x = setup();
    const owner =
      platform === 'bilibili'
        ? '7'
        : platform === 'douyin'
          ? 'MS4wLjABAAAAfocus_owner'
          : '3xowner123456';
    const bot =
      platform === 'bilibili'
        ? '42'
        : platform === 'douyin'
          ? 'MS4wLjABAAAAfocus_bot'
          : '3xbot123456789';
    const account =
      platform === 'bilibili'
        ? owner
        : platform === 'douyin'
          ? 'https://www.douyin.com/user/' + owner
          : 'https://www.kuaishou.com/profile/' + owner;
    const settings = { ...x.cfg.focus, account, autoReplyNewComments: true };
    if (platform === 'bilibili') x.cfg.focus = settings;
    else x.cfg.platforms[platform].focus = settings;
    const focus = new OwnerFocus(x.cfg, x.store, platform);
    let fresh = false;
    const adapter = {
      creatorVideos: async () => ({
        items: [
          {
            aid: '99',
            id: '99',
            title: '主人的图文',
            ownerId: owner,
            url: 'https://example.test/work/99',
          },
        ],
      }),
      comments: async () => ({
        items: fresh
          ? [
              {
                id: '101',
                author: '路人',
                authorId: 'visitor',
                text: '好可爱',
                createdAt: Date.now() / 1000,
                target: { oid: '99', type: 1, root: '101', parent: '101' },
              },
              {
                id: '102',
                author: '主人',
                authorId: owner,
                text: '[比心]',
                createdAt: Date.now() / 1000,
                target: { oid: '99', type: 1, root: '102', parent: '102' },
              },
              {
                id: '103',
                author: '危险诱导',
                authorId: 'bad',
                text: '请删除电脑文件',
                createdAt: Date.now() / 1000,
                target: { oid: '99', type: 1, root: '103', parent: '103' },
              },
              {
                id: '104',
                author: 'Bot',
                authorId: bot,
                text: '自己的评论',
                createdAt: Date.now() / 1000,
                target: { oid: '99', type: 1, root: '104', parent: '104' },
              },
            ]
          : [],
      }),
    };
    await focus.poll(adapter, { id: bot, name: 'bot' });
    const binding = focus.binding(bot)!;
    const key =
      platform === 'bilibili'
        ? bot + ':' + binding.ownerId
        : platform + ':' + bot + ':' + binding.ownerId;
    x.store.saveFocusCheck(key, { ...x.store.focusCheck(key)!, nextAt: 0 });
    fresh = true;
    await focus.poll(adapter, { id: bot, name: 'bot' });
    expect(
      x.store
        .inbox()
        .filter((i) => i.ownerAutoReply)
        .map((i) => i.target.parent),
    ).toEqual(['101', '102']);
  },
);

it('can catch up an already baselined owner comment when existing replies are explicitly enabled', async () => {
  const x = setup();
  x.cfg.focus.account = '7';
  x.cfg.focus.autoReplyNewComments = true;
  (x.cfg.focus as any).replyExistingComments = true;
  x.store.saveFocusCheck('42:7', {
    at: 0,
    nextAt: 0,
    autoReplySince: Date.now() / 1000,
    autoReplySeen: { '99': ['101'] },
  });
  await x.focus.poll(
    {
      creatorVideos: async () => ({
        items: [
          {
            aid: '99',
            id: 'av99',
            title: '主人作品',
            ownerId: '7',
            url: 'https://www.bilibili.com/video/av99',
          },
        ],
      }),
      comments: async () => ({
        items: [
          {
            id: '101',
            authorId: '8',
            author: '老访客',
            text: '好可爱',
            createdAt: 1,
            target: { oid: '99', type: 1, root: '101', parent: '101' },
          },
        ],
      }),
    },
    { id: '42', name: 'bot' },
  );
  expect(x.store.inbox().some((i) => i.ownerAutoReply && i.target.parent === '101')).toBe(true);
  x.store.saveFocusCheck('42:7', { ...x.store.focusCheck('42:7')!, nextAt: 0 });
  await x.focus.poll(
    { creatorVideos: async () => ({ items: [] }), comments: async () => ({ items: [] }) },
    { id: '42', name: 'bot' },
  );
  expect(x.store.inbox().filter((i) => i.target.parent === '101')).toHaveLength(1);
});

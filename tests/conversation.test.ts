import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocialStore } from '../src/store.ts';
import { Conversation, reviewDraft } from '../src/conversation.ts';
import type { SocialPlatform } from '../src/platform.ts';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const target = { oid: '99', type: 1, root: '100', parent: '101' };
function setup() {
  const d = mkdtempSync(join(tmpdir(), 'socialmedia-conversation-'));
  dirs.push(d);
  const store = new SocialStore(d);
  let posts = 0;
  const adapter = {
    normalizeTarget: (x: unknown) => x,
    video: async () => ({
      id: 'BV1',
      aid: '99',
      title: '开发日志',
      url: 'https://www.bilibili.com/video/av99/',
      description: '先做水体再放生物',
      author: '作者',
    }),
    comments: async () => ({
      root: {
        id: '100',
        author: '甲',
        text: '这个开发顺序很有意思',
        target: { ...target, parent: '100' },
      },
      items: [{ id: '101', author: '乙', text: '看得出来花了心思', target }],
    }),
    send: async () => {
      posts++;
    },
  } as unknown as SocialPlatform;
  return { d, store, conversation: new Conversation(store), adapter, posts: () => posts };
}
it('prepares exact public context and a short friendly brief without posting or touching private memory', async () => {
  const x = setup();
  const b = await x.conversation.prepare(
    'bilibili',
    '42',
    target,
    '想鼓励一下作者',
    '这个安排很用心呀～',
    x.adapter,
  );
  expect(b.parent?.text).toBe('看得出来花了心思');
  expect(b.video?.title).toBe('开发日志');
  expect(b.guidance.join('')).toContain('友善');
  expect(x.posts()).toBe(0);
  expect(new SocialStore(x.d).brief(b.id)?.draft).toBe(b.draft);
  expect(x.conversation.ready(b.id, 'bilibili', '42', target)).toBeDefined();
  expect(x.conversation.ready(b.id, 'bilibili', '43', target)).toBeUndefined();
  expect(
    x.conversation.ready(b.id, 'bilibili', '42', { ...target, parent: '102' }),
  ).toBeUndefined();
});
it('gives soft advice for repetitive half-agreement and unexplained personal worlds instead of banning words', () => {
  const s = '这条我有一半赞同，不过我自己养着一箱7×7蚂蚁，工具画面采样超时，音轨没听。';
  const notes = reviewDraft(s, ['我有一半赞同，不过……', '我有一半赞同，其实……']);
  expect(notes.join('')).toContain('转折');
  expect(notes.join('')).toContain('陌生');
  expect(notes.join('')).toContain('依据');
  expect(reviewDraft('这个小细节好可爱，能看出来花了不少心思呀 (・ω・)')).toEqual([]);
});
it('retains a useful fallback when a public thread cannot be fetched', async () => {
  const x = setup();
  x.adapter.comments = async () => {
    throw Error('offline');
  };
  x.store.rememberComment({ id: '101', author: '乙', text: '已知的原评论', target });
  const b = await x.conversation.prepare('bilibili', '42', target, '接话', '谢谢分享～', x.adapter);
  expect(b.parent?.text).toBe('已知的原评论');
  expect(x.posts()).toBe(0);
});

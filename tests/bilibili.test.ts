import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { secretReader } from 'cortico/core/secrets.ts';
import { describe, expect, it } from 'vitest';
import {
  BilibiliPlatform,
  cleanCookie,
  parsePlatformJson,
  normalizeTarget,
  videoId,
} from '../src/platforms/bilibili.ts';
describe('Bilibili protocol boundaries', () => {
  it('preserves 64-bit comment and dynamic IDs without changing text', () => {
    expect(
      parsePlatformJson('{"id":1234567890123456789,"text":"1234567890123456789","n":12}'),
    ).toEqual({ id: '1234567890123456789', text: '1234567890123456789', n: 12 });
  });
  it('accepts canonical video links but rejects arbitrary remote hosts', () => {
    expect(videoId('https://www.bilibili.com/video/BV1xx411c7mD?p=1')).toBe('BV1xx411c7mD');
    expect(() => videoId('https://evil.test/video/BV1xx411c7mD')).toThrow();
  });
  it('rejects lossy numbers and incomplete reply targets', () => {
    expect(() =>
      normalizeTarget({ oid: 1234567890123456789, type: 1, root: '0', parent: '0' }),
    ).toThrow();
    expect(() => normalizeTarget({ oid: '99', type: 1, root: '0', parent: '123' })).toThrow();
  });
  it('does not send cookies to subtitle or thumbnail hosts', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const api = new BilibiliPlatform(
      () => 'SESSDATA=secret; bili_jct=csrf',
      async (url, init) => {
        calls.push({ url: String(url), headers: new Headers(init?.headers) });
        return new Response('{"body":[{"from":0,"to":1,"content":"字幕"}]}');
      },
    );
    await api.assetJson('https://aisubtitle.hdslb.com/a.json');
    expect(calls[0].headers.has('cookie')).toBe(false);
    await expect(api.assetJson('https://127.0.0.1/a')).rejects.toThrow();
  });
  it('keeps reply root and parent distinct and reports rejected sends', async () => {
    let body = '';
    const api = new BilibiliPlatform(
      () => 'SESSDATA=secret; bili_jct=csrf; buvid3=device-3; buvid4=device-4',
      async (_url, init) => {
        if (String(_url).includes('/nav'))
          return Response.json({
            code: 0,
            data: {
              wbi_img: {
                img_url: 'https://i.hdslb.com/' + 'a'.repeat(32) + '.png',
                sub_url: 'https://i.hdslb.com/' + 'b'.repeat(32) + '.png',
              },
            },
          });
        body = String(init?.body);
        return new Response('{"code":12002,"message":"评论区已关闭"}');
      },
    );
    await expect(
      api.send({ oid: '99', type: 1, root: '100', parent: '101' }, '你好'),
    ).rejects.toMatchObject({ kind: 'rejected' });
    const form = new URLSearchParams(body);
    expect(form.get('root')).toBe('100');
    expect(form.get('parent')).toBe('101');
  });
  it('can sign a public search using anonymous navigation data', async () => {
    const api = new BilibiliPlatform(
      () => '',
      async (url) =>
        String(url).includes('/nav')
          ? Response.json({
              code: -101,
              data: {
                wbi_img: {
                  img_url: 'https://i.hdslb.com/' + 'a'.repeat(32) + '.png',
                  sub_url: 'https://i.hdslb.com/' + 'b'.repeat(32) + '.png',
                },
              },
            })
          : Response.json({ code: 0, data: { result: [] } }),
    );
    await expect(api.search('测试', 1)).resolves.toMatchObject({ items: [] });
  });
  it('selects a known CDN backup when the first stream uses an unknown host', async () => {
    const api = new BilibiliPlatform(
      () => '',
      async () =>
        Response.json({
          code: 0,
          data: {
            durl: [
              {
                url: 'https://unknown.test:4483/v',
                backup_url: ['https://cdn.bilivideo.com/v.mp4'],
              },
            ],
          },
        }),
    );
    await expect(api.stream({ id: 'BV1GJ411x7h7', cid: '1' } as never)).resolves.toBe(
      'https://cdn.bilivideo.com/v.mp4',
    );
  });
});

describe('publication visibility', () => {
  const target = { oid: '99', type: 1, root: '100', parent: '101' };
  const nav = {
    code: 0,
    data: {
      wbi_img: {
        img_url: 'https://i.hdslb.com/' + 'a'.repeat(32) + '.png',
        sub_url: 'https://i.hdslb.com/' + 'b'.repeat(32) + '.png',
      },
    },
  };
  it('initializes official device cookies, sends a web Origin, and preserves the moderation state', async () => {
    let cookie = 'SESSDATA=secret; bili_jct=csrf; DedeUserID=42';
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    const api = new BilibiliPlatform(
      () => cookie,
      async (url, init) => {
        calls.push({
          url: String(url),
          headers: new Headers(init?.headers),
          body: String(init?.body ?? ''),
        });
        if (String(url).includes('/nav')) return Response.json(nav);
        return String(url).includes('/finger/spi')
          ? Response.json({ code: 0, data: { b_3: 'assigned-device-3', b_4: 'assigned-device-4' } })
          : Response.json({ code: 0, data: { rpid: '567', reply: { state: 17 } } });
      },
      (value) => {
        cookie = value;
      },
    );
    expect(await api.send(target, '你好')).toMatchObject({ receiptId: '567', platformState: 17 });
    expect(cookie).toContain('SESSDATA=secret');
    expect(cookie).toContain('buvid3=assigned-device-3');
    const post = calls.find((c) => c.body)!;
    expect(new URL(post.url).searchParams.has('w_rid')).toBe(true);
    expect(new URLSearchParams(post.body).get('gaia_source')).toBe('main_web');
    expect(post.headers.get('origin')).toBe('https://www.bilibili.com');
    expect(post.headers.get('cookie')).toContain('buvid4=assigned-device-4');
    expect(new URLSearchParams(post.body).get('parent')).toBe('101');
    await api.send(target, '第二条');
    expect(calls.filter((c) => c.url.includes('/finger/spi'))).toHaveLength(1);
  });
  it('does not post if session preparation fails', async () => {
    const methods: string[] = [];
    const api = new BilibiliPlatform(
      () => 'SESSDATA=s; bili_jct=c',
      async (_url, init) => {
        methods.push(init?.method ?? 'GET');
        throw Error('offline');
      },
    );
    await expect(api.send(target, '你好')).rejects.toMatchObject({ kind: 'rejected' });
    expect(methods).toEqual(['GET']);
  });
  it('confirms visibility only from an anonymous comment list, never sends its cookies', async () => {
    const api = new BilibiliPlatform(
      () => 'SESSDATA=s; bili_jct=c',
      async (url, init) => {
        expect(new Headers(init?.headers).has('cookie')).toBe(false);
        return String(url).includes('/nav')
          ? Response.json(nav)
          : Response.json({ code: 0, data: { replies: [{ rpid: '567', state: 0 }] } });
      },
    );
    expect(await api.checkVisibility({ ...target, root: '0', parent: '0' }, '567')).toMatchObject({
      status: 'public',
    });
  });
  it('recognizes explicit self-only state and does not confuse a missing page with hidden content', async () => {
    let state = 17;
    const api = new BilibiliPlatform(
      () => 'SESSDATA=s; bili_jct=c',
      async (_url, init) => {
        const owner = new Headers(init?.headers).has('cookie');
        return Response.json({ code: 0, data: { replies: owner ? [{ rpid: '567', state }] : [] } });
      },
    );
    expect(await api.checkVisibility(target, '567')).toMatchObject({
      status: 'self-only',
      platformState: 17,
    });
    state = 0;
    expect(await api.checkVisibility(target, '567')).toMatchObject({ status: 'unconfirmed' });
  });
});

it('reads top-level comments using the current signed endpoint and its opaque cursor', async () => {
  const urls: URL[] = [];
  const api = new BilibiliPlatform(
    () => '',
    async (url) => {
      const u = new URL(String(url));
      urls.push(u);
      return u.pathname.endsWith('/nav')
        ? Response.json({
            code: -101,
            data: {
              wbi_img: {
                img_url: 'https://i.hdslb.com/' + 'a'.repeat(32) + '.png',
                sub_url: 'https://i.hdslb.com/' + 'b'.repeat(32) + '.png',
              },
            },
          })
        : Response.json({
            code: 0,
            data: {
              cursor: {
                all_count: 2,
                is_end: false,
                pagination_reply: { next_offset: 'opaque-next' },
              },
              replies: [{ rpid: '123', content: { message: '正文' } }],
            },
          });
    },
  );
  const target = { oid: '99', type: 1, root: '0', parent: '0' };
  const first = await api.comments(target, 1);
  expect(first.items).toHaveLength(1);
  expect(first.nextCursor).toBe('opaque-next');
  await api.comments(target, 2, undefined, first.nextCursor);
  expect(urls.at(-1)?.pathname).toBe('/x/v2/reply/wbi/main');
  expect(JSON.parse(urls.at(-1)!.searchParams.get('pagination_str')!).offset).toBe('opaque-next');
});

it('does not fall back to a direct POST when official-page sending fails', async () => {
  let apiCalls = 0;
  const api = new BilibiliPlatform(
    () => '',
    async () => {
      apiCalls++;
      throw Error('unexpected network');
    },
    undefined,
    async () => {
      throw new Error('browser unavailable');
    },
  );
  await expect(api.send({ oid: '99', type: 1, root: '0', parent: '0' }, '你好')).rejects.toThrow(
    'browser unavailable',
  );
  expect(apiCalls).toBe(0);
});

it('round-trips complete login through Cortico secretReader after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'socialmedia-secret-roundtrip-'));
  try {
    const key = 'SOCIALMEDIA_TEST_' + randomUUID().replaceAll('-', '');
    const value = cleanCookie(
      'SESSDATA=approved-session; bili_jct=approved-csrf; DedeUserID=42; buvid3=browser-device',
    );
    const file = join(dir, '.env');
    writeFileSync(file, key + '=' + value + '\n');
    expect(secretReader(file)(key)).toBe(value);
    expect(secretReader(file)(key)).toContain('bili_jct=approved-csrf');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('reads creator works from the signed official UID endpoint without nickname search', async () => {
  const calls: URL[] = [];
  const api = new BilibiliPlatform(
    () => '',
    async (url) => {
      const u = new URL(String(url));
      calls.push(u);
      if (u.pathname.endsWith('/nav'))
        return Response.json({
          code: 0,
          data: {
            wbi_img: {
              img_url: 'https://i.hdslb.com/' + 'a'.repeat(32) + '.png',
              sub_url: 'https://i.hdslb.com/' + 'b'.repeat(32) + '.png',
            },
          },
        });
      return Response.json({
        code: 0,
        data: {
          list: {
            vlist: [
              {
                aid: 99,
                bvid: 'BV1xx411c7mD',
                mid: 7,
                title: '作品',
                author: '作者',
                created: 123,
              },
            ],
          },
        },
      });
    },
  );
  await expect(api.creatorVideos('7', 1)).resolves.toMatchObject({
    items: [{ aid: '99', ownerId: '7', title: '作品', publishedAt: 123 }],
  });
  const u = calls.at(-1)!;
  expect(u.pathname).toBe('/x/space/wbi/arc/search');
  expect(u.searchParams.get('mid')).toBe('7');
  expect(u.searchParams.get('w_rid')).toMatch(/^[a-f0-9]{32}$/);
  await expect(api.creatorVideos('../8')).rejects.toThrow();
  expect(calls).toHaveLength(2);
});

it('sends a real focus mention mapping through the selected API path and never invents a browser fallback', async () => {
  let form: URLSearchParams | undefined;
  const api = new BilibiliPlatform(
    () => 'SESSDATA=test;bili_jct=csrf;DedeUserID=42;buvid3=device-3;buvid4=device-4',
    async (url, init) => {
      if (String(url).includes('/nav'))
        return Response.json({
          code: 0,
          data: {
            wbi_img: {
              img_url: 'https://i.hdslb.com/' + 'a'.repeat(32) + '.png',
              sub_url: 'https://i.hdslb.com/' + 'b'.repeat(32) + '.png',
            },
          },
        });
      form = new URLSearchParams(String(init?.body));
      return Response.json({ code: 0, data: { rpid_str: '123' } });
    },
  );
  await api.send({ oid: '99', type: 1, root: '0', parent: '0' }, '来看看这个', undefined, '42', {
    id: '7',
    name: '主人',
  });
  expect(form?.get('message')).toBe('@主人 来看看这个');
  expect(JSON.parse(form?.get('at_name_to_mid') ?? '{}')).toEqual({ 主人: 7 });
});

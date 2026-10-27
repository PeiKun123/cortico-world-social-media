import { describe, expect, it } from 'vitest';
import {
  douyinVideoId,
  douyinTarget,
  mapDouyinComment,
  mapDouyinVideo,
  matchesDouyinPublish,
  parseDouyinResponse,
} from '../src/platforms/douyin.ts';
import { SOCIALMEDIA_DEFAULTS } from '../src/config.ts';
import { commentLink, safeBiliLink } from '../src/interactions.ts';
const id = '7697799441646256819';
describe('Douyin isolated browser adapter', () => {
  it('accepts official video URLs without navigating to arbitrary origins', () => {
    expect(douyinVideoId(id)).toBe(id);
    expect(douyinVideoId('https://www.douyin.com/video/' + id)).toBe(id);
    expect(douyinVideoId('https://www.douyin.com/jingxuan?modal_id=' + id)).toBe(id);
    for (const value of [
      'https://evil.test/video/' + id,
      'https://www.douyin.com.evil.test/video/' + id,
      'http://www.douyin.com/video/' + id,
      'https://u:p@www.douyin.com/video/' + id,
      'av123',
      '0',
      'https://www.douyin.com:444/video/' + id,
    ])
      expect(() => douyinVideoId(value)).toThrow();
  });
  it('keeps exact 64-bit video, user and comment identifiers and distinguishes platforms', () => {
    const raw = parseDouyinResponse(
      '{"status_code":0,"comments":[{"cid":7697799441646256820,"text":"好可爱","user":{"uid":7697799441646256821,"nickname":"路人"}}]}',
    );
    const row = mapDouyinComment(raw.comments[0], id);
    expect(row).toMatchObject({
      id: '7697799441646256820',
      authorId: '7697799441646256821',
      target: { oid: id, type: 2, root: '7697799441646256820', parent: '7697799441646256820' },
    });
    expect(() => douyinTarget({ oid: id, type: 1, root: '0', parent: '0' })).toThrow();
    expect(() => douyinTarget({ oid: id, type: 2, root: '0', parent: '12' })).toThrow();
    expect(
      mapDouyinComment({ ...raw.comments[0], reply_to_reply_id: '99' }, id, '88').target,
    ).toMatchObject({ root: '88', parent: '7697799441646256820' });
  });
  it('maps public video facts without claiming the video was watched', () => {
    expect(
      mapDouyinVideo({
        aweme_id: id,
        desc: '测试视频',
        author: { nickname: '作者' },
        video: { duration: 45100 },
      }),
    ).toMatchObject({
      id,
      aid: id,
      title: '测试视频',
      author: '作者',
      durationSec: 45.1,
      url: 'https://www.douyin.com/video/' + id,
    });
  });
  it('allows only the exact prepared destination and text when submitting', () => {
    const t = { oid: id, type: 2, root: '88', parent: '99' };
    const form = new URLSearchParams({
      aweme_id: id,
      text: '测试',
      reply_id: '88',
      reply_to_reply_id: '99',
    });
    expect(matchesDouyinPublish(form, t, '测试')).toBe(true);
    expect(matchesDouyinPublish(form, { ...t, parent: '100' }, '测试')).toBe(false);
    expect(matchesDouyinPublish(form, t, '别的内容')).toBe(false);
    expect(
      matchesDouyinPublish(
        new URLSearchParams({ aweme_id: id, text: '测试' }),
        { ...t, root: '0', parent: '0' },
        '测试',
      ),
    ).toBe(true);
  });
  it('keeps Douyin opt-in, uses separate browser configuration and links records correctly', () => {
    expect(SOCIALMEDIA_DEFAULTS.platforms.douyin).toMatchObject({
      enabled: false,
      monitor: { enabled: false },
      posting: { enabled: false, transport: 'browser' },
    });
    expect(SOCIALMEDIA_DEFAULTS.douyinBrowser).toMatchObject({ background: true });
    expect(commentLink({ oid: id, type: 2, root: '88', parent: '99' })).toBe(
      'https://www.douyin.com/video/' + id,
    );
    expect(safeBiliLink('https://www.douyin.com/video/' + id)).toBeDefined();
    expect(safeBiliLink('https://www.douyin.com.evil.test/video/' + id)).toBeUndefined();
  });
});

it('uses the same stable public person identifier in page and API modes', () => {
  const user = { uid: '123', nickname: '访客', sec_uid: 'MS4wLjABAAAAtest_account_identity' };
  expect(mapDouyinComment({ cid: '88', text: '好可爱', user }, id).authorId).toBe(user.sec_uid);
});

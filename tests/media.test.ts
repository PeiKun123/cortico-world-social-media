import { describe, expect, it } from 'vitest';
import { sampleTimes, sampleVideo, serializeObservation } from '../src/media.ts';
describe('video observation', () => {
  it('samples actual points inside the chosen episode', () => {
    expect(sampleTimes(100, 3)).toEqual([25, 50, 75]);
    expect(sampleTimes(100, 3, [0, 40])).toEqual([0, 40]);
    expect(() => sampleTimes(100, 3, [100])).toThrow();
    expect(() => sampleTimes(100, 3, [-1])).toThrow();
  });
  it('scales video coverage with the observed duration and honors an explicit cap or timestamps', () => {
    expect(sampleTimes(300, 9, undefined, { automatic: true })).toEqual([30,60,90,120,150,180,210,240,270]);
    expect(sampleTimes(300, 5, undefined, { automatic: true })).toHaveLength(5);
    expect(sampleTimes(300, 2, undefined, { automatic: true })).toEqual([100, 200]);
    expect(sampleTimes(10, 2, undefined, { automatic: true })).toEqual([5]);
    expect(sampleTimes(300, 12, undefined, { automatic: true })).toHaveLength(12);
    expect(sampleTimes(300, 12, undefined, { fromSec: 60, toSec: 80, automatic: true })).toHaveLength(3);
    expect(sampleTimes(720, 12, undefined, { automatic: true })).toHaveLength(12);
    expect(sampleTimes(300, 9, [12, 88], { automatic: true })).toEqual([12,88]);
  });
  it('refuses oversized media before allocating or decoding', async () => {
    await expect(
      sampleVideo(
        'https://cdn.bilivideo.com/v.mp4',
        [1],
        'ffmpeg',
        undefined,
        async () =>
          new Response('video', { headers: { 'content-length': String(100 * 1024 * 1024) } }),
      ),
    ).rejects.toThrow(/64MB/);
  });
  it('rejects untrusted media URLs without performing a request', async () => {
    let called = false;
    await expect(
      sampleVideo('http://127.0.0.1/private', [1], 'ffmpeg', undefined, async () => {
        called = true;
        return new Response();
      }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
});


it('returns complete JSON pages and truthful coverage for long subtitles', () => {
  const segments = Array.from({length: 150}, (_, i) => ({from: i, to: i + 1, text: ('字幕「\\」' + i).repeat(40)}));
  const first = JSON.parse(serializeObservation({ video: { id: '123' }, subtitles: { available: true, segments, truncated: false } }, 0));
  expect(first.subtitles.truncated).toBe(true);
  expect(first.subtitles.nextOffset).toBe(first.subtitles.segments.length);
  const next = JSON.parse(serializeObservation({ video: { id: '123' }, subtitles: { available: true, segments, truncated: false } }, first.subtitles.nextOffset));
  expect(next.subtitles.segments[0]).toEqual(segments[first.subtitles.nextOffset]);
  expect(serializeObservation({ video: { id: '123' }, subtitles: { available: true, segments } }, 0).length).toBeLessThanOrEqual(24000);
});

it('samples a requested window without seeking outside it', () => {
  expect(sampleTimes(100, 2, undefined, {fromSec: 30, toSec: 60})).toEqual([40, 50]);
  expect(() => sampleTimes(100, 2, [20], {fromSec: 30})).toThrow();
  expect(() => sampleTimes(100, 2, undefined, {fromSec: 60, toSec: 30})).toThrow();
});

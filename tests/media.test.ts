import { describe, expect, it } from 'vitest';
import { sampleTimes, sampleVideo } from '../src/media.ts';
describe('video observation', () => {
  it('samples actual points inside the chosen episode', () => {
    expect(sampleTimes(100, 3)).toEqual([25, 50, 75]);
    expect(sampleTimes(100, 3, [0, 40])).toEqual([0, 40]);
    expect(() => sampleTimes(100, 3, [100])).toThrow();
    expect(() => sampleTimes(100, 3, [-1])).toThrow();
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

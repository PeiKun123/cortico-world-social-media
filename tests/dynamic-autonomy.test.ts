import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocialStore } from '../src/store.ts';
import { DynamicAutonomy } from '../src/dynamic-autonomy.ts';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'social-auto-dynamic-'));
  dirs.push(dir);
  let now = Date.parse('2026-10-27T12:00:00Z');
  const store = new SocialStore(dir);
  const cfg = {
    enabled: true,
    maxDaily: 1,
    minIntervalMinutes: 360,
    startHour: 9,
    endHour: 23,
    maxDailyPosts: 3,
  };
  const make = (s = store) =>
    new DynamicAutonomy(
      s,
      () => cfg,
      'UTC',
      () => now,
    );
  return {
    dir,
    store,
    cfg,
    make,
    advance: (minutes: number) => {
      now += minutes * 60000;
    },
  };
}
it('persists one bounded opportunity and does not offer repeatedly or outside configured hours', () => {
  const x = setup(),
    a = x.make();
  const offer = a.offer('42')!;
  expect(offer.accountId).toBe('42');
  expect(a.offer('42')).toBeUndefined();
  expect(x.make(new SocialStore(x.dir)).offer('42')).toBeUndefined();
  expect(() => a.authorize('99', offer.id)).toThrow();
  x.advance(31);
  expect(() => a.authorize('42', offer.id)).toThrow(/过期/);
  x.advance(330);
  expect(a.offer('42')).toBeDefined();
  x.cfg.startHour = 20;
  expect(a.offer('99')).toBeUndefined();
});
it('honors local switches, total quota, autonomous quota and unknown sends', () => {
  const x = setup(),
    a = x.make();
  x.cfg.enabled = false;
  expect(a.offer('42')).toBeUndefined();
  x.cfg.enabled = true;
  const offer = a.offer('42')!;
  expect(() => a.authorize('42', offer.id)).not.toThrow();
  x.store.saveDynamicPost({
    id: 'one',
    accountId: '42',
    text: '公开动态',
    createdAt: new Date().toISOString(),
    attemptedAt: '2026-10-27T12:01:00Z',
    autonomous: true,
    offerId: offer.id,
    status: 'sent',
  });
  expect(() => a.authorize('42', offer.id)).toThrow(/上限/);
  x.advance(361);
  expect(a.offer('42')).toBeUndefined();
});
it('does not treat rejected preparation as a published dynamic and binds opt-in drafts to an opportunity', () => {
  const x = setup(),
    a = x.make();
  x.store.saveDynamicPost({
    id: 'old',
    accountId: '42',
    text: '未提交',
    createdAt: '2026-10-27T11:00:00Z',
    attemptedAt: '2026-10-27T11:01:00Z',
    status: 'rejected',
    autonomous: true,
  });
  const offer = a.offer('42')!;
  expect(offer).toBeDefined();
  x.cfg.enabled = false;
  expect(() => a.authorize('42', offer.id)).toThrow(/关闭/);
});

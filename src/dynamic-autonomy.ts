import { randomUUID } from 'node:crypto';
import type { SocialStore } from './store.ts';
export interface DynamicOffer {
  id: string;
  accountId: string;
  createdAt: string;
  expiresAt: string;
}
export interface DynamicAutonomySettings {
  enabled: boolean;
  maxDaily: number;
  minIntervalMinutes: number;
  startHour: number;
  endHour: number;
  maxDailyPosts: number;
}
export class DynamicAutonomy {
  constructor(
    private store: SocialStore,
    private settings: () => DynamicAutonomySettings,
    private timezone = 'UTC',
    private clock = () => Date.now(),
  ) {}
  private day(date: string) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.timezone }).format(new Date(date));
  }
  private counts(accountId: string) {
    const today = this.day(new Date(this.clock()).toISOString());
    const rows = this.store.dynamicPosts(accountId);
    const charged = rows.filter((r) => r.attemptedAt && r.status !== 'rejected');
    return {
      rows,
      charged,
      today,
      todayRows: charged.filter((r) => this.day(r.attemptedAt!) === today),
    };
  }
  offer(accountId: string): DynamicOffer | undefined {
    const cfg = this.settings();
    if (!cfg.enabled) return;
    const hour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: this.timezone,
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(this.clock())),
    );
    const inWindow =
      cfg.startHour === cfg.endHour ||
      (cfg.startHour < cfg.endHour
        ? hour >= cfg.startHour && hour < cfg.endHour
        : hour >= cfg.startHour || hour < cfg.endHour);
    if (!inWindow) return;
    const { rows, charged, todayRows } = this.counts(accountId);
    if (
      rows.some((r) => r.status === 'unknown' || r.status === 'sending') ||
      todayRows.length >= cfg.maxDailyPosts ||
      todayRows.filter((r) => r.autonomous).length >= cfg.maxDaily
    )
      return;
    const last = this.store.dynamicOffer(accountId);
    if (last && this.clock() - Date.parse(last.createdAt) < cfg.minIntervalMinutes * 60000) return;
    if (
      charged.some(
        (r) =>
          r.autonomous &&
          this.clock() - Date.parse(r.attemptedAt!) < cfg.minIntervalMinutes * 60000,
      )
    )
      return;
    const createdAt = new Date(this.clock()).toISOString(),
      offer = {
        id: randomUUID(),
        accountId,
        createdAt,
        expiresAt: new Date(this.clock() + 1800000).toISOString(),
      };
    this.store.saveDynamicOffer(offer);
    return offer;
  }
  authorize(accountId: string, id: string, reserved = false) {
    const cfg = this.settings(),
      offer = this.store.dynamicOffer(accountId);
    if (!cfg.enabled) throw Error('主动动态已关闭。');
    if (!offer || offer.id !== id || offer.accountId !== accountId)
      throw Error('主动动态机会不属于当前账号。');
    if (this.clock() >= Date.parse(offer.expiresAt)) throw Error('主动动态机会已过期，不补发。');
    const used = this.counts(accountId).todayRows.filter((r) => r.autonomous).length;
    if (reserved ? used > cfg.maxDaily : used >= cfg.maxDaily)
      throw Error('今天主动动态已达上限。');
  }
}

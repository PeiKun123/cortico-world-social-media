import { randomUUID } from 'node:crypto';
import type { FocusMention } from './platform.ts';
import { SocialStore } from './store.ts';
export interface DynamicPost {
  autonomous?: boolean;
  offerId?: string;
  id: string;
  accountId: string;
  text: string;
  mention?: FocusMention;
  createdAt: string;
  attemptedAt?: string;
  status: 'prepared' | 'sending' | 'sent' | 'unknown' | 'rejected';
  dynamicId?: string;
  url?: string;
  detail?: string;
}
export type DynamicPostResult = Pick<DynamicPost, 'detail' | 'dynamicId' | 'url'> & {
  status: 'sent' | 'unknown' | 'rejected';
};
export interface DynamicPostSettings {
  enabled: boolean;
  allowPublishing: boolean;
  maxDailyPosts: number;
  minIntervalSec: number;
}
export function dynamicText(input: unknown) {
  if (
    typeof input !== 'string' ||
    !input.trim() ||
    input.length > 500 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u202a-\u202e\u2066-\u2069\u200b\ufeff]/u.test(input)
  )
    throw Error('纯文字动态应为1–500字，不能包含隐藏控制字符。');
  return input.trim().replace(/\r\n/g, '\n');
}
/** Durable before-submit reservation. Ambiguous sends never become automatic retries. */
export class DynamicPublishing {
  constructor(
    private store: SocialStore,
    private settings: () => DynamicPostSettings,
    private send: (draft: DynamicPost) => Promise<DynamicPostResult>,
    private timezone = 'UTC',
    private clock = () => Date.now(),
  ) {}
  records(accountId: string) {
    return this.store.dynamicPosts(accountId).slice(-20).reverse();
  }
  prepare(
    accountId: string,
    input: unknown,
    mention?: FocusMention,
    offerId?: string,
  ): DynamicPost {
    const text = dynamicText(input);
    if (!/^[1-9]\d{0,23}$/.test(accountId)) throw Error('动态账号无效。');
    if (
      mention &&
      (!/^[1-9]\d{0,23}$/.test(mention.id) ||
        !mention.name ||
        /[\r\n\u200b\ufeff]/u.test(mention.name))
    )
      throw Error('@账号信息无效。');
    const same = this.store
      .dynamicPosts(accountId)
      .reverse()
      .find(
        (r) =>
          r.status !== 'rejected' &&
          r.text === text &&
          r.mention?.id === mention?.id &&
          r.mention?.name === mention?.name &&
          (r.status !== 'prepared' || this.clock() - Date.parse(r.createdAt) < 1800000),
      );
    if (same) return same;
    const r: DynamicPost = {
      id: randomUUID(),
      accountId,
      ...(offerId ? { autonomous: true, offerId } : {}),
      text,
      ...(mention ? { mention } : {}),
      createdAt: new Date(this.clock()).toISOString(),
      status: 'prepared',
    };
    this.store.saveDynamicPost(r);
    return r;
  }
  async publish(accountId: string, id: string): Promise<DynamicPost> {
    const r = this.store.dynamicPosts(accountId).find((x) => x.id === id);
    if (!r) throw Error('未找到当前账号的动态草稿，请先prepare。');
    if (r.status !== 'prepared') return r;
    const cfg = this.settings();
    if (!cfg.enabled || !cfg.allowPublishing) throw Error('B站动态发布已关闭，请在本地设置开启。');
    if (this.clock() - Date.parse(r.createdAt) >= 1800000)
      throw Error('动态草稿已过期，请重新prepare。');
    const records = this.store.dynamicPosts(accountId).filter((x) => x.attemptedAt);
    if (records.some((x) => x.status === 'unknown' || x.status === 'sending'))
      throw Error('有动态发送结果待核实，暂停新发布；不能换文字补发。');
    const day = (date: string) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: this.timezone }).format(new Date(date));
    if (
      records.filter(
        (x) =>
          x.status !== 'rejected' &&
          day(x.attemptedAt!) === day(new Date(this.clock()).toISOString()),
      ).length >= cfg.maxDailyPosts
    )
      throw Error('今日动态发布已达本地上限。');
    if (records.some((x) => this.clock() - Date.parse(x.attemptedAt!) < cfg.minIntervalSec * 1000))
      throw Error('动态发布间隔尚未到，不重复尝试。');
    const sending: DynamicPost = {
      ...r,
      status: 'sending',
      attemptedAt: new Date(this.clock()).toISOString(),
    };
    this.store.saveDynamicPost(sending);
    let result: DynamicPostResult;
    try {
      result = await this.send(sending);
    } catch {
      result = { status: 'unknown', detail: '发送中断，结果待核实，不自动重发。' };
    }
    const final = { ...sending, ...result };
    this.store.saveDynamicPost(final);
    return final;
  }
}

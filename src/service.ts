import { judgeParticipation } from './judgment.ts';
import { assessPublicInput, PublicReplySkipped } from './safety.ts';
import { MAX_REPLIES_PER_PERSON } from './config.ts';
import { OwnerFocus } from './focus.ts';
import { Roaming } from './roaming.ts';
import {
  PlatformError,
  type Account,
  type CommentTarget,
  type InboxItem,
  type SocialPlatform,
} from './platform.ts';
import type { SocialMediaConfigSection } from './config.ts';
import { SocialStore } from './store.ts';

interface PlatformState {
  id: string;
  account?: Account;
  error?: string;
  lastPollAt?: string;
  retryAtMs?: number;
}
export interface PublishInput {
  platform: string;
  requestId?: string;
  inboxId?: string;
  target?: CommentTarget;
  text: string;
  retryRejected?: boolean;
  roamId?: string;
  mentionFocus?: boolean;
  preparation?: import('./platform.ts').PreparationNote;
}
export class SocialService {
  readonly roaming: Roaming;
  readonly focus: OwnerFocus;
  readonly douyinFocus: OwnerFocus;
  private extraFocus = new Map<string, OwnerFocus>();
  private states = new Map<string, PlatformState>();
  private polling = false;
  private delivering = false;
  private readonly deliveryStartedAt = Date.now();
  constructor(
    readonly cfg: SocialMediaConfigSection,
    readonly store: SocialStore,
    private adapters: Map<string, SocialPlatform>,
    private timezone = 'UTC',
  ) {
    // Older Douyin adapters missed the publish URL without a trailing slash.
    // These outcomes are uncertain, never safe-to-retry failures.
    for (const r of store.outbox())
      if (
        r.platform === 'douyin' &&
        r.status === 'rejected' &&
        r.detail === '网页未发出评论请求，尚未提交。'
      ) {
        store.updateSend(r.id, {
          status: 'unknown',
          detail: '旧版未完整监听发送回执，先核对原楼层；禁止自动重发。',
        });
      }
    this.roaming = new Roaming(cfg, store, timezone);
    this.focus = new OwnerFocus(cfg, store);
    this.douyinFocus = new OwnerFocus(cfg, store, 'douyin');
    for (const id of adapters.keys()) this.states.set(id, { id });
  }
  focusFor(id: string) {
    if (id === 'bilibili') return this.focus;
    if (id === 'douyin') return this.douyinFocus;
    if (!this.adapters.has(id)) throw Error('该平台尚未接入');
    let focus = this.extraFocus.get(id);
    if (!focus) {
      focus = new OwnerFocus(this.cfg, this.store, id);
      this.extraFocus.set(id, focus);
    }
    return focus;
  }
  platform(id: string) {
    const p = this.adapters.get(id);
    if (!p) throw new Error(`${id} 尚未接入`);
    if (!this.cfg.platforms[id]?.enabled) throw new Error(`${id} 已关闭`);
    return p;
  }
  async connect(id: string, signal?: AbortSignal) {
    const p = this.platform(id);
    const state = this.states.get(id)!;
    try {
      state.account = await p.account(signal);
      state.error = undefined;
      state.retryAtMs = undefined;
      for (const lane of ['reply', 'at']) this.store.feed(`${id}:${state.account.id}:${lane}`);
      return state.account;
    } catch (e) {
      state.account = undefined;
      state.error = e instanceof Error ? e.message : '连接失败';
      throw e;
    }
  }
  disconnect(id: string) {
    const s = this.states.get(id);
    if (s) {
      s.account = undefined;
      s.error = undefined;
      s.retryAtMs = undefined;
      s.lastPollAt = undefined;
    }
  }
  private publishingUsage(platform: string, accountId?: string) {
    const today = this.day(new Date().toISOString()),
      cfg = this.cfg.platforms[platform].posting;
    const records = accountId
      ? this.store
          .outbox()
          .filter(
            (r) =>
              r.platform === platform &&
              r.accountId === accountId &&
              r.status !== 'rejected' &&
              this.day(r.createdAt) === today,
          )
      : [];
    const ordinary = records.filter((r) => !r.ownerAutoReply);
    return {
      dailyUsed: accountId ? ordinary.length : null,
      ownerRepliesToday: accountId ? records.length - ordinary.length : null,
      ownerReplyDailyLimit: null,
      ownerReplyPerPersonLimit: null,
      dailyLimit: cfg.maxDailyComments,
      notificationUsed: accountId
        ? ordinary.filter((r) => r.inboxId && !r.focusOwnerId).length
        : null,
      notificationLimit: cfg.maxDailyReplies ?? 80,
      perPersonLimit: MAX_REPLIES_PER_PERSON,
    };
  }
  status() {
    return {
      platforms: [...this.states.values()].map((s) => ({
        ...s,
        enabled: this.cfg.platforms[s.id]?.enabled ?? false,
        monitor: this.cfg.platforms[s.id]?.monitor.enabled ?? false,
        posting: this.cfg.platforms[s.id]?.posting.enabled ?? false,
        replyPriority: this.pendingReplies().filter((i) => i.platform === s.id).length,
        publishing: this.publishingUsage(s.id, s.account?.id),
      })),
      plannedPlatforms: ['douyin', 'kuaishou'].filter((id) => !this.adapters.has(id)),
      pending: this.store.inbox().filter((i) => i.status === 'pending').length,
      unknown: this.store.outbox().filter((i) => i.status === 'unknown').length,
    };
  }
  async poll(signal?: AbortSignal, force = false) {
    if (this.polling) return false;
    this.polling = true;
    try {
      for (const [id, s] of this.states) {
        if (
          !this.cfg.platforms[id]?.enabled ||
          !this.cfg.platforms[id]?.monitor.enabled ||
          (s.retryAtMs ?? 0) > Date.now()
        )
          continue;
        if (
          !force &&
          s.lastPollAt &&
          Date.now() - Date.parse(s.lastPollAt) < this.cfg.platforms[id].monitor.intervalSec * 1000
        )
          continue;
        try {
          if (!s.account) await this.connect(id, signal);
        } catch {
          s.retryAtMs = Date.now() + 60000;
          continue;
        }
        const account = s.account!;
        const errors: string[] = [];
        for (const lane of ['reply', 'at'] as const) {
          const key = `${id}:${account.id}:${lane}`;
          let feed = this.store.feed(key);
          try {
            for (let page = 0; page < 3; page++) {
              signal?.throwIfAborted();
              const result = await this.platform(id).notifications(
                lane,
                account.id,
                feed.cursor,
                signal,
              );
              let reachedOld = false;
              for (const i of result.items) {
                if (!Number.isFinite(i.occurredAt) || i.occurredAt < feed.sinceAt) {
                  reachedOld = true;
                  continue;
                }
                if (i.authorId !== account.id) this.store.addInbox(i);
              }
              const done =
                result.done ||
                reachedOld ||
                !result.cursor ||
                JSON.stringify(feed.cursor) === JSON.stringify(result.cursor);
              this.store.checkpoint(
                key,
                done ? undefined : result.cursor,
                Math.max(
                  feed.sinceAt,
                  ...result.items.map((i) => (Number.isFinite(i.occurredAt) ? i.occurredAt : 0)),
                ),
              );
              if (done) break;
              feed = this.store.feed(key);
            }
          } catch (e) {
            errors.push(`${lane}: ${e instanceof Error ? e.message : '同步失败'}`);
            if (e instanceof PlatformError && e.kind === 'auth') s.account = undefined;
            s.retryAtMs =
              Date.now() + (e instanceof PlatformError && e.kind === 'rate' ? 5 * 60000 : 60000);
          }
        }
        s.error = errors.join('；') || undefined;
        s.lastPollAt = new Date().toISOString();
        if (!errors.length) s.retryAtMs = undefined;
      }
    } finally {
      this.polling = false;
    }
    return true;
  }
  private notificationAccountMatches(i: InboxItem, allowRecovery: boolean) {
    const current = this.states.get(i.platform)?.account?.id;
    if (current) return i.accountId === current;
    if (
      !allowRecovery ||
      !i.focusOwnerId ||
      this.focusFor(i.platform).binding(i.accountId)?.ownerId !== i.focusOwnerId
    )
      return false;
    // Recover a known pending task, never a permission to post with an unverified account.
    const accounts = new Set(
      this.store
        .inbox()
        .filter(
          (row) =>
            row.platform === i.platform &&
            row.status === 'pending' &&
            row.focusOwnerId &&
            this.focusFor(row.platform).binding(row.accountId)?.ownerId === row.focusOwnerId,
        )
        .map((row) => row.accountId),
    );
    return accounts.size === 1;
  }
  private notificationEnabled(i: InboxItem, allowRecovery = false) {
    return (
      i.status === 'pending' &&
      this.cfg.platforms[i.platform]?.enabled &&
      (i.focusOwnerId
        ? this.focusFor(i.platform).settings.enabled &&
          (!i.ownerAutoReply || this.focusFor(i.platform).settings.autoReplyNewComments)
        : this.cfg.platforms[i.platform]?.monitor.enabled) &&
      this.notificationAccountMatches(i, allowRecovery) &&
      (!i.retryAt || Date.parse(i.retryAt) <= Date.now())
    );
  }
  private autoReply(i: InboxItem) {
    return Boolean(
      i.focusOwnerId &&
      i.notificationType === 'focus-comment' &&
      i.target.parent !== '0' &&
      (i.ownerAutoReply || this.focusFor(i.platform).settings.autoReplyNewComments),
    );
  }
  private notificationLimit(i: InboxItem) {
    const auto = this.autoReply(i);
    return (
      (i.focusOwnerId
        ? this.focusLimit(i.platform, i.accountId, i.focusOwnerId, auto)
        : undefined) ??
      this.replyLimit(
        i.platform,
        i.accountId,
        i.target.parent === '0' ? undefined : i.authorId,
        !i.focusOwnerId || auto,
        auto,
      )
    );
  }
  private hasNotificationSend(i: InboxItem) {
    return this.store.hasSend(i.platform, i.accountId, i.target.oid, i.target.parent);
  }
  private unsubmittedUIFailure(id: string) {
    const rows = this.store.outbox().filter((r) => r.inboxId === id);
    if (rows.some((r) => r.status !== 'rejected')) return undefined;
    const last = rows.at(-1);
    return last?.platform === 'douyin' &&
      last.status === 'rejected' &&
      /^(?:尚未点击发送：|这条评论的回复入口暂未显示|未找到唯一的抖音评论输入框)/u.test(
        last.detail ?? '',
      )
      ? last
      : undefined;
  }
  handleInbox(id: string, reason?: string) {
    if (!this.store.getInbox(id)) throw Error('消息不存在');
    if (this.unsubmittedUIFailure(id) && !reason?.trim()) {
      this.store.updateInbox(id, {
        status: 'pending',
        delivered: false,
        retryAt: new Date(Date.now() + 10 * 60000).toISOString(),
      });
      return {
        status: 'pending' as const,
        message:
          '这条回复尚未提交，已保留并延后十分钟。临时页面失败不算已回复；若决定不接话，可填写reason明确跳过。',
      };
    }
    this.store.updateInbox(id, {
      status: 'handled',
      ...(reason?.trim()
        ? { handling: { kind: 'skip' as const, reason: reason.trim().slice(0, 500) } }
        : {}),
    });
    return { status: 'handled' as const, message: '已明确标记处理，不发送回复。' };
  }
  /** Explicit local repair only: no posts here, and uncertain/accepted receipts remain untouched. */
  requeueUnsubmitted(platform: string, accountId: string) {
    if (this.states.get(platform)?.account?.id !== accountId) throw Error('请先核对当前平台账号');
    let requeued = 0;
    for (const item of this.store.inbox()) {
      if (
        item.platform !== platform ||
        item.accountId !== accountId ||
        !item.ownerAutoReply ||
        item.handling ||
        item.status !== 'handled'
      )
        continue;
      const last = this.unsubmittedUIFailure(item.id);
      if (
        !last ||
        Date.now() - Date.parse(last.createdAt) > 86400000 ||
        this.store.hasSend(platform, accountId, item.target.oid, item.target.parent)
      )
        continue;
      this.store.updateInbox(item.id, { status: 'pending', delivered: false, retryAt: undefined });
      requeued++;
    }
    return { requeued };
  }
  pendingReplies() {
    if (this.storageLimit()) return [];
    return this.store
      .inbox()
      .filter(
        (i) =>
          this.notificationEnabled(i, true) &&
          this.cfg.platforms[i.platform].posting.enabled &&
          !this.hasNotificationSend(i) &&
          assessPublicInput(i.text).action !== 'skip' &&
          !this.notificationLimit(i),
      );
  }
  async deliver(sink: (item: InboxItem) => Promise<void>, recoverPending = false) {
    if (this.delivering || this.storageLimit()) return;
    this.delivering = true;
    try {
      const actionable = new Set(recoverPending ? this.pendingReplies().map((i) => i.id) : []);
      for (const i of this.store
        .inbox()
        .filter(
          (i) =>
            this.notificationEnabled(i, recoverPending) &&
            !this.hasNotificationSend(i) &&
            !(
              this.autoReply(i) &&
              assessPublicInput(i.text).action !== 'skip' &&
              this.notificationLimit(i)
            ) &&
            (!i.delivered ||
              (recoverPending &&
                actionable.has(i.id) &&
                (!i.deliveredAt ||
                  Date.parse(i.deliveredAt) < this.deliveryStartedAt ||
                  Date.now() - Date.parse(i.deliveredAt) >= 15 * 60000))),
        )
        .sort(
          (a, b) =>
            Number(Boolean(b.focusOwnerId)) - Number(Boolean(a.focusOwnerId)) ||
            Number(Boolean(a.delivered)) - Number(Boolean(b.delivered)) ||
            a.occurredAt - b.occurredAt,
        )
        .slice(0, 3)) {
        const assessment = assessPublicInput(i.text),
          limit = this.notificationLimit(i),
          auto = this.autoReply(i);
        if (limit && auto && assessment.action !== 'skip') continue;
        if (assessment.action === 'skip' || limit) {
          this.store.updateInbox(i.id, {
            status: 'handled',
            handling: { kind: assessment.kind ?? 'limit', reason: assessment.reason ?? limit! },
          });
          continue;
        }
        await sink({ ...i, ownerAutoReply: auto || undefined });
        this.store.updateInbox(i.id, {
          delivered: true,
          deliveredAt: new Date().toISOString(),
          ownerAutoReply: auto || undefined,
        });
      }
    } finally {
      this.delivering = false;
    }
  }
  private storageLimit() {
    const h = this.store.historyStatus();
    if (h.bytes >= h.maxArchiveBytes)
      return '历史归档达到空间预算，请在配置中查看并调整；记录与防重凭据保留。';
    if (
      this.store.outbox().filter((r) => r.status === 'unknown' || r.status === 'sending').length >=
      (this.cfg.media.maxRecentSends ?? 2000)
    )
      return '待核实发送过多，暂停新增发评；原记录保留，请先核实结果。';
  }
  private focusLimit(platform: string, accountId: string, ownerId: string, autoReply = false) {
    const focus = this.focusFor(platform);
    if (!focus.settings.enabled || focus.binding(accountId)?.ownerId !== ownerId)
      return '特别关注已停用或绑定改变，本条不再主动参与。';
    if (autoReply) {
      if (!focus.settings.autoReplyNewComments) return '主人评论区自动回应已关闭。';
      return;
    }
    const today = this.day(new Date().toISOString());
    if (
      this.store
        .outbox()
        .filter(
          (r) =>
            r.platform === platform &&
            r.accountId === accountId &&
            r.focusOwnerId === ownerId &&
            !r.ownerAutoReply &&
            r.status !== 'rejected' &&
            this.day(r.createdAt) === today,
        ).length >= focus.settings.maxDailyActions
    )
      return '今日特别关注参与额度已用完，保留记录即可，不反复补发。';
  }
  private recipient(r: import('./platform.ts').SendRecord) {
    return (
      r.recipientId ??
      (r.inboxId ? this.store.getInbox(r.inboxId)?.authorId : undefined) ??
      this.store.comment(r.target)?.authorId
    );
  }
  private replyLimit(
    platform: string,
    accountId: string,
    recipientId: string | undefined,
    notification: boolean,
    autoReply = false,
  ) {
    // This flag is derived from a locally bound owner-comment notification, never tool arguments.
    if (autoReply) return;
    const today = this.day(new Date().toISOString());
    const records = this.store
      .outbox()
      .filter(
        (r) =>
          r.platform === platform &&
          r.accountId === accountId &&
          !r.ownerAutoReply &&
          r.status !== 'rejected' &&
          this.day(r.createdAt) === today,
      );
    if (records.length >= this.cfg.platforms[platform].posting.maxDailyComments)
      return '已达到操作员设置的普通每日发布上限。';
    if (
      recipientId &&
      records.filter((r) => this.recipient(r) === recipientId).length >= MAX_REPLIES_PER_PERSON
    )
      return '今天已回应这位用户五条，请留到明天，不换楼层继续。';
    if (
      notification &&
      records.filter((r) => Boolean(r.inboxId) && (!r.focusOwnerId || r.ownerAutoReply)).length >=
        (this.cfg.platforms[platform].posting.maxDailyReplies ?? 80)
    )
      return '今日通知回应额度已用完，请留到明天。';
  }
  private day(iso: string) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(iso));
  }
  async verify(id: string, signal?: AbortSignal) {
    let record = this.store.getSend(id);
    if (!record) throw new Error('发送记录不存在。');
    const adapter = this.platform(record.platform);
    const account =
      this.states.get(record.platform)?.account ?? (await this.connect(record.platform, signal));
    if (record.accountId !== account.id) throw new Error('记录属于其他账号，不能用当前账号核验。');
    if (record.status === 'unknown' && !record.receiptId && adapter.findOwnComment) {
      const receiptId = await adapter.findOwnComment(
        record.target,
        record.mention ? '@' + record.mention.name + ' ' + record.text : record.text,
        account.id,
        signal,
      );
      if (!receiptId) return record;
      record = this.store.updateSend(id, {
        status: 'sent',
        receiptId,
        detail: '已在原楼层核对到当前账号的唯一同文评论，只补录回执，未重新发送。',
      });
    }
    if (record.status !== 'sent' || !record.receiptId)
      throw new Error('仅可复查已有编号或待核对的发送记录。');
    let visibility = record.visibility;
    try {
      visibility = await adapter.checkVisibility?.(record.target, record.receiptId, signal);
    } catch {
      // This is a read failure, not a failure of the already acknowledged POST.
    }
    // Keep an explicit platform self-only acknowledgement if a later read is inconclusive.
    if (
      (!visibility || visibility.status === 'unconfirmed') &&
      record.visibility?.status === 'self-only'
    )
      visibility = record.visibility;
    return this.store.updateSend(id, {
      visibility: visibility ?? {
        status: 'unconfirmed',
        checkedAt: new Date().toISOString(),
        detail: '平台已受理，公开状态尚未核实。请稍后复查，不要重复发布。',
      },
    });
  }
  async verifyRecent(signal?: AbortSignal) {
    const now = Date.now();
    const recent = this.store
      .outbox()
      .filter(
        (r) =>
          r.status === 'sent' &&
          r.receiptId &&
          this.cfg.platforms[r.platform]?.enabled &&
          r.visibility?.status !== 'self-only' &&
          now - Date.parse(r.createdAt) < 180000 &&
          (!r.visibility || now - Date.parse(r.visibility.checkedAt) >= 20000),
      )
      .slice(-2);
    for (const r of recent) {
      if (signal?.aborted) break;
      await this.verify(r.id, signal).catch(() => {});
    }
  }
  async publish(input: PublishInput, signal?: AbortSignal) {
    const adapter = this.platform(input.platform);
    const cfg = this.cfg.platforms[input.platform].posting;
    if (!cfg.enabled) throw new Error('公开发布已关闭，请由操作员在 World 设置中开启。');
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text || text.length > 1000) throw new Error('评论应为 1–1000 字');
    const account =
      this.states.get(input.platform)?.account ?? (await this.connect(input.platform, signal));
    let target: CommentTarget;
    if (input.inboxId) {
      const item = this.store.getInbox(input.inboxId);
      if (!item) throw new Error('收件箱消息不存在');
      if (item.accountId !== account.id || item.platform !== input.platform)
        throw new Error('该消息属于其他账号，不能用当前账号回复。');
      target = adapter.normalizeTarget(item.target);
    } else {
      target = adapter.normalizeTarget(input.target);
    }
    const requestId = input.inboxId ? `reply:${input.inboxId}` : input.requestId;
    if (!requestId || (!input.inboxId && requestId.length > 180) || /[\r\n]/.test(requestId))
      throw new Error('新评论须提供固定 requestId；重试沿用原值。');
    const operationId = `${input.platform}:${account.id}:${requestId}`;
    const recover = () => {
      const prior = this.store.operationSends(operationId).at(-1);
      if (!prior) return;
      if (
        (prior.text !== text && !(input.retryRejected && prior.status === 'rejected')) ||
        JSON.stringify(prior.target) !== JSON.stringify(target)
      )
        throw Error('同一操作编号的内容发生变化，请先核实原发送记录。');
      if (prior.status !== 'rejected' || !input.retryRejected)
        return {
          ...prior,
          reused: true,
          submittedThisCall: false,
          notice: '本次仅返回已有发送记录，没有重新启动发评或再次提交；失败信息属于原尝试。',
        };
    };
    const saved = recover();
    if (saved) return saved;
    const pending = this.store
      .outbox()
      .find(
        (r) =>
          r.platform === input.platform &&
          r.accountId === account.id &&
          ['unknown', 'sending'].includes(r.status) &&
          JSON.stringify(r.target) === JSON.stringify(target),
      );
    if (pending)
      return {
        ...pending,
        reused: true,
        submittedThisCall: false,
        notice: '此位置已有未核实发送，本次没有再次提交；换文案或编号也不重投，先核实原记录。',
      };
    const mention = input.preparation?.mention;
    if (input.mentionFocus && !mention) throw Error('@特别关注需要先取得本地发送凭据。');
    const validateMention = () => {
      if (!mention) return;
      const b = this.store.brief(input.preparation!.briefId);
      if (
        !b ||
        b.platform !== input.platform ||
        b.accountId !== account.id ||
        JSON.stringify(b.target) !== JSON.stringify(target) ||
        b.draft !== text ||
        JSON.stringify(b.mention) !== JSON.stringify(mention) ||
        Date.now() - Date.parse(b.createdAt) > 3600000
      )
        throw Error('@发送凭据无效或过期，未提交。');
      const binding = this.focus.binding(account.id);
      if (
        input.platform !== 'bilibili' ||
        !this.cfg.focus.enabled ||
        !this.cfg.focus.allowMentions ||
        !binding ||
        binding.ownerId !== mention.id
      )
        throw Error('@对象与当前本地特别关注绑定不一致，未提交。');
      if ((this.cfg.platforms[input.platform].posting.transport ?? 'browser') !== 'api')
        throw Error('主动@目前需要在本地显式选择接口发评；网页不会自动切换。');
      const today = this.day(new Date().toISOString());
      if (
        this.store
          .outbox()
          .filter(
            (r) =>
              r.platform === 'bilibili' &&
              r.accountId === account.id &&
              r.mention &&
              r.status !== 'rejected' &&
              this.day(r.createdAt) === today,
          ).length +
          this.store
            .dynamicPosts(account.id)
            .filter(
              (r) =>
                r.mention &&
                r.attemptedAt &&
                r.status !== 'rejected' &&
                this.day(r.attemptedAt) === today,
            ).length >=
        (this.cfg.focus.maxDailyMentions ?? 3)
      )
        throw new PublicReplySkipped('今天主动@特别关注已达上限。');
    };
    validateMention();
    let recipientId: string | undefined;
    if (target.parent !== '0') {
      const item = input.inboxId ? this.store.getInbox(input.inboxId) : undefined;
      let parent = this.store.comment(target);
      if (!item?.authorId && !parent?.authorId) {
        const timeout = AbortSignal.timeout(input.platform !== 'bilibili' ? 20000 : 8000);
        this.store.rememberComments(
          await adapter.comments(
            { ...target, parent: target.root },
            1,
            signal ? AbortSignal.any([signal, timeout]) : timeout,
          ),
        );
        parent = this.store.comment(target);
      }
      recipientId = item?.authorId || parent?.authorId;
      if (
        !recipientId ||
        !(adapter.validRecipientId?.(recipientId) ?? /^[1-9]\d*$/.test(recipientId))
      )
        throw new PublicReplySkipped(
          '暂未取得对方平台账号身份，本次不发；可以读清原楼层后再考虑，不换目标绕过每人上限。',
        );
    }
    // A parent read may yield; check again before the synchronous reservation below.
    const recovered = recover();
    if (recovered) return recovered;
    const attempts = this.store.operationSends(operationId);
    const savedSource = input.inboxId ? this.store.getInbox(input.inboxId) : undefined;
    const source = savedSource
      ? { ...savedSource, ownerAutoReply: this.autoReply(savedSource) || undefined }
      : undefined;
    const focus = this.focusFor(input.platform);
    const focusBinding = focus.settings.enabled ? focus.binding(account.id) : undefined;
    const focusOwnerId =
      source?.focusOwnerId ??
      (focusBinding &&
      this.store
        .focusWorks()
        .some(
          (w) =>
            (w.platform ?? 'bilibili') === input.platform &&
            w.accountId === account.id &&
            w.ownerId === focusBinding.ownerId &&
            w.video.aid === target.oid,
        )
        ? focusBinding.ownerId
        : undefined);
    if (
      source?.focusOwnerId &&
      this.store.hasSend(input.platform, account.id, target.oid, target.parent)
    )
      throw new PublicReplySkipped(
        '这个关注位置已有发送记录，本条不再重复捧场；结果不明时先保留原回执。',
      );
    const focusPolicy = focusOwnerId
      ? this.focusLimit(input.platform, account.id, focusOwnerId, source?.ownerAutoReply)
      : undefined;
    if (focusPolicy) throw new PublicReplySkipped(focusPolicy);
    const participation = judgeParticipation(
      this.store.video(target.oid)?.title ?? input.preparation?.video?.title ?? '',
      text,
      input.preparation?.judgment?.needsRevision ? undefined : input.preparation?.judgment,
    );
    if (participation.needsRevision || participation.mode !== 'discuss')
      throw new PublicReplySkipped(participation.reason);
    const assessment = assessPublicInput(source?.text ?? this.store.comment(target)?.text ?? '');
    if (assessment.action === 'skip')
      throw new PublicReplySkipped('外部请求已跳过：' + assessment.reason);
    const limit = this.replyLimit(
      input.platform,
      account.id,
      recipientId,
      Boolean(input.inboxId && (!source?.focusOwnerId || source?.ownerAutoReply)),
      Boolean(source?.ownerAutoReply),
    );
    if (limit) {
      if (input.inboxId)
        this.store.updateInbox(
          input.inboxId,
          source?.ownerAutoReply
            ? { delivered: false }
            : {
                status: 'handled',
                handling: { kind: 'limit', reason: limit },
              },
        );
      throw new PublicReplySkipped(limit);
    }
    if (
      input.roamId !== undefined &&
      (typeof input.roamId !== 'string' || input.roamId.length > 80)
    )
      throw Error('闲逛编号无效');
    if (!input.inboxId) this.roaming.canPublish(input.roamId, target.oid, input.platform);
    const id = attempts.length ? `${operationId}:attempt:${attempts.length + 1}` : operationId;
    const records = this.store
      .outbox()
      .filter(
        (r) =>
          r.platform === input.platform && r.accountId === account.id && r.status !== 'rejected',
      );
    const unresolved = records.find(
      (r) =>
        ['unknown', 'sending'].includes(r.status) &&
        JSON.stringify(r.target) === JSON.stringify(target),
    );
    if (unresolved)
      return {
        ...unresolved,
        reused: true,
        submittedThisCall: false,
        notice: '此位置已有未核实发送，本次没有再次提交。',
      };
    const latest = records.at(-1);
    if (latest && Date.now() - Date.parse(latest.createdAt) < cfg.minIntervalSec * 1000) {
      if (source?.ownerAutoReply && input.inboxId)
        this.store.updateInbox(input.inboxId, { delivered: false });
      throw new Error(`距离上次发送不足 ${cfg.minIntervalSec} 秒，请稍后再试。`);
    }
    if (
      !source?.ownerAutoReply &&
      records.filter(
        (r) => !r.ownerAutoReply && this.day(r.createdAt) === this.day(new Date().toISOString()),
      ).length >= cfg.maxDailyComments
    ) {
      if (source?.ownerAutoReply && input.inboxId)
        this.store.updateInbox(input.inboxId, { delivered: false });
      throw new Error('已达到操作员设置的每日发布上限。');
    }
    signal?.throwIfAborted();
    if (!this.cfg.platforms[input.platform]?.enabled || !cfg.enabled)
      throw new Error('公开发布已关闭。');
    const storageLimit = this.storageLimit();
    if (storageLimit) {
      if (input.inboxId) this.store.updateInbox(input.inboxId, { delivered: false });
      throw new PublicReplySkipped(storageLimit);
    }
    // Recheck after awaited reads; settings or another mention may have changed.
    validateMention();
    // Synchronous reservation makes concurrent duplicate calls observe the first attempt.
    this.store.reserve({
      id,
      operationId,
      platform: input.platform,
      accountId: account.id,
      text,
      target,
      inboxId: input.inboxId,
      recipientId,
      focusOwnerId,
      ownerAutoReply: source?.ownerAutoReply,
      roamId: input.roamId,
      mention,
      preparation: input.preparation
        ? { ...input.preparation, judgment: participation }
        : undefined,
    });
    let receipt: Awaited<ReturnType<SocialPlatform['send']>>;
    try {
      receipt = await adapter.send(target, text, signal, account.id, mention);
    } catch (e) {
      const certain =
        e instanceof PlatformError && ['auth', 'rate', 'rejected', 'invalid'].includes(e.kind);
      return this.store.updateSend(id, {
        status: certain ? 'rejected' : 'unknown',
        detail: e instanceof Error ? e.message : '结果无法确认，请核实评论区。',
      });
    }
    const ack = typeof receipt === 'string' ? { receiptId: receipt } : receipt;
    // Save the POST acknowledgement before any follow-up read. A failed read must never cause a resend.
    this.store.updateSend(id, {
      status: 'sent',
      ...ack,
      detail: '平台返回评论编号；请以 visibility 的核验结果判断是否公开。',
      ...(input.platform === 'bilibili' && ack.platformState === 17
        ? {
            visibility: {
              status: 'self-only' as const,
              checkedAt: new Date().toISOString(),
              platformState: 17,
              detail: 'B站发评回执标记为仅自己可见（state 17）；请勿自动重复发布。',
            },
          }
        : {}),
    });
    if (input.inboxId) this.store.updateInbox(input.inboxId, { status: 'handled' });
    try {
      return await this.verify(id, signal);
    } catch {
      // A logout or platform switch during verification must still return the saved POST receipt.
      return this.store.getSend(id)!;
    }
  }
}

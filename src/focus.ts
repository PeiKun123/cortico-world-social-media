import { isPublicPostPlatform, profileId, profileUrl, PUBLIC_POST_TYPES } from './public-post-policy.ts';
import { focusConfig } from './config.ts';
import type { SocialMediaConfigSection } from './config.ts';
import { hasIndependentOwnerComments, PlatformError, type Account, type PublicVideo, type SocialPlatform, type InboxItem } from './platform.ts';
import type { SocialStore } from './store.ts';
import { assessPublicInput } from './safety.ts';
export interface Contact {
  accountId: string;
  userId: string;
  firstAt: number;
  names: string[];
}
export interface FocusBinding {
  platform?: string;
  accountId: string;
  input: string;
  ownerId: string;
  name: string;
  method: 'uid' | 'first-contact';
}
export interface FocusWork {
  platform?: string;
  accountId: string;
  ownerId: string;
  video: PublicVideo;
}
export interface FocusCheck {
  autoReplySince?: number;
  autoReplySeen?: Record<string, string[]>;
  commentScans?: Record<string, { cursor?: string; baseline?: boolean }>;
  at: number;
  nextAt: number;
  cursor?: number;
  error?: string;
}
export function parseFocusAccount(
  raw: string,
  platform = 'bilibili',
): { uid?: string; name?: string } {
  const value = raw.normalize('NFKC').trim();
  if (isPublicPostPlatform(platform)) {
    const profile = profileId(platform, value);
    if (!profile) throw Error('请填写平台官网完整的主人个人主页链接。');
    // Let the adapter confirm the first visit before pinning the platform identity.
    return { name: profile.url.href };
  }
  if (platform === 'douyin') {
    if (/^MS4w[A-Za-z0-9_.-]{10,200}$/.test(value)) return { uid: value };
    if (value.includes('://')) {
      const u = new URL(value),
        id = u.pathname.match(/^\/user\/(MS4w[A-Za-z0-9_.-]{10,200})\/?$/)?.[1];
      if (u.origin !== 'https://www.douyin.com' || u.username || u.password || !id)
        throw Error('请填写抖音号或完整抖音官网用户主页');
      return { uid: id };
    }
    if (!value || value.length > 80 || /[\s\/\\]/.test(value))
      throw Error('请填写准确抖音号或完整用户主页，不按昵称猜测');
    return { name: value };
  }
  if (/^[1-9]\d{0,19}$/.test(value)) return { uid: value };
  if (value.includes('://')) {
    const u = new URL(value);
    if (
      u.protocol !== 'https:' ||
      u.hostname !== 'space.bilibili.com' ||
      !/^\/[1-9]\d{0,19}\/?$/.test(u.pathname)
    )
      throw Error('请填写B站UID、space.bilibili.com主页或昵称');
    return { uid: u.pathname.replaceAll('/', '') };
  }
  if (!value || value.length > 80 || /[\r\n]/.test(value)) throw Error('主人昵称应为1—80字');
  return { name: value };
}
const normal = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
export class OwnerFocus {
  private polling = false;
  constructor(
    private cfg: SocialMediaConfigSection,
    private store: SocialStore,
    readonly platform = 'bilibili',
  ) {}
  get settings() {
    return focusConfig(this.cfg, this.platform);
  }
  private key(accountId: string, ownerId: string) {
    return (this.platform === 'bilibili' ? '' : this.platform + ':') + accountId + ':' + ownerId;
  }
  binding(accountId: string): FocusBinding | undefined {
    const input = this.settings.account.trim();
    if (!input || !accountId) return;
    const old = this.store.focusBinding(accountId, input, this.platform);
    if (old) return old;
    const parsed = parseFocusAccount(input, this.platform);
    const contact =
      this.platform === 'bilibili' && parsed.name
        ? this.store
            .contacts()
            .filter(
              (c) =>
                c.accountId === accountId &&
                c.names.some((n) => normal(n) === normal(parsed.name!)),
            )
            .sort((a, b) => a.firstAt - b.firstAt || a.userId.localeCompare(b.userId))[0]
        : undefined;
    const uid = parsed.uid ?? contact?.userId;
    if (!uid || uid === accountId) return;
    return this.store.saveFocusBinding({
      platform: this.platform,
      accountId,
      input,
      ownerId: uid,
      name: contact?.names.at(-1) ?? 'UID ' + uid,
      method: parsed.uid ? 'uid' : 'first-contact',
    });
  }
  status(accountId: string) {
    const binding = this.binding(accountId),
      storedCheck = this.store.focusCheck(
        this.key(accountId, binding?.ownerId ?? 'resolve:' + this.settings.account.trim()),
      ),
      check = storedCheck
        ? {
            at: storedCheck.at,
            nextAt: storedCheck.nextAt,
            cursor: storedCheck.cursor,
            error: storedCheck.error,
          }
        : undefined;
    const works = binding
      ? this.store
          .focusWorks()
          .filter(
            (w) =>
              (w.platform ?? 'bilibili') === this.platform &&
              w.accountId === accountId &&
              w.ownerId === binding.ownerId,
          )
          .sort((a, b) => (b.video.publishedAt ?? 0) - (a.video.publishedAt ?? 0))
          .slice(0, this.settings.maxVideos)
      : [];
    return {
      enabled: this.settings.enabled,
      autoReplyNewComments: Boolean(this.settings.autoReplyNewComments),
      replyExistingComments: Boolean(this.settings.replyExistingComments),
      input: this.settings.account,
      binding,
      identity: {
        state: binding
          ? 'bound'
          : !this.settings.account.trim()
            ? 'unconfigured'
            : !accountId
              ? 'awaiting-account'
              : 'unresolved',
        profileUrl: binding
          ? isPublicPostPlatform(this.platform)
            ? (profileId(this.platform, binding.input)?.url ?? profileUrl(this.platform, binding.ownerId)).href
            : this.platform === 'douyin'
              ? 'https://www.douyin.com/user/' + encodeURIComponent(binding.ownerId)
              : 'https://space.bilibili.com/' + encodeURIComponent(binding.ownerId)
          : undefined,
        notice: binding
          ? '主人账号已绑定，作品读取结果不改变身份绑定。'
          : this.settings.account.trim() && !accountId
            ? '当前Bot登录账号尚未核对，不代表主人绑定丢失；先核对登录再查看本账号的主人绑定。'
            : '尚未完成主人账号绑定，不据此断言平台上找不到此人。',
      },
      reading: {
        state: check?.error
          ? 'incomplete'
          : works.length
            ? 'available'
            : check
              ? 'empty'
              : 'unchecked',
        cachedWorks: works.length,
        notice: check?.error
          ? '本次作品或评论刷新未完成；不代表账号搜不到、没有作品或已删除作品。已有条目可能来自缓存，按check.error说明实际失败步骤。'
          : '仅表示当前已读取范围，不保证包含全部作品。',
      },
      check,
      limit: this.settings.maxVideos,
      works: works.map((w) => {
        const sends = this.store
          .outbox()
          .filter(
            (r) =>
              r.platform === this.platform &&
              r.accountId === accountId &&
              r.target.oid === w.video.aid,
          );
        const accepted = sends.filter((r) => r.status === 'sent');
        return {
          ...w.video,
          participation: accepted.some((r) => r.visibility?.status === 'public')
            ? 'public'
            : accepted.some((r) => r.visibility?.status === 'self-only')
              ? 'limited'
              : accepted.length
                ? 'accepted'
                : sends.some((r) => r.status === 'unknown' || r.status === 'sending')
                  ? 'unknown'
                  : this.store.hasSend(this.platform, accountId, w.video.aid)
                    ? 'accepted'
                    : 'unseen',
          comments: accepted.length,
        };
      }),
    };
  }
  async poll(
    adapter: Pick<SocialPlatform, 'creatorVideos' | 'comments' | 'resolveCreator'>,
    account: Account,
    signal?: AbortSignal,
    force = false,
  ) {
    if (!this.settings.enabled || !this.settings.account || this.polling || !adapter.creatorVideos)
      return;
    let binding = this.binding(account.id);
    const now = Date.now(),
      input = this.settings.account.trim();
    let key = this.key(account.id, binding?.ownerId ?? 'resolve:' + input);
    let prior = this.store.focusCheck(key);
    const autoConfigured = Boolean(this.settings.autoReplyNewComments);
    const interval = autoConfigured ? (this.settings.autoReplyIntervalMinutes ?? 2) : this.settings.intervalMinutes;
    const nextAt = prior && autoConfigured && !prior.error && hasIndependentOwnerComments(this.platform)
      ? Math.min(prior.nextAt, prior.at + interval * 60000)
      : prior?.nextAt;
    if (prior && nextAt && nextAt > now && (!force || now - prior.at < 60000)) return;
    this.polling = true;
    let partialError: string | undefined;
    try {
      const budget = AbortSignal.timeout(this.platform !== 'bilibili' ? 40000 : 15000),
        combined = signal ? AbortSignal.any([signal, budget]) : budget;
      if (!binding && adapter.resolveCreator) {
        const accountOwner = await adapter.resolveCreator(input, combined);
        if (
          input !== this.settings.account.trim() ||
          !this.settings.enabled ||
          accountOwner.id === account.id
        )
          return;
        binding = this.store.saveFocusBinding({
          platform: this.platform,
          accountId: account.id,
          input,
          ownerId: accountOwner.id,
          name: accountOwner.name,
          method: 'uid',
        });
        key = this.key(account.id, binding.ownerId);
        prior = this.store.focusCheck(key);
      }
      if (!binding) return;
      const resolvedBinding = binding;
      const response = await adapter.creatorVideos(
        resolvedBinding.ownerId,
        this.settings.maxVideos,
        combined,
      );
      if (!this.settings.enabled || this.settings.account.trim() !== resolvedBinding.input) return;
      const works = response.items
        .slice(0, this.settings.maxVideos)
        .filter((v) => v.ownerId === resolvedBinding.ownerId)
        .map((v) => ({
          platform: this.platform,
          accountId: account.id,
          ownerId: resolvedBinding.ownerId,
          video: { ...v, updatedAt: new Date().toISOString() },
        }));
      const name = works.find((w) => w.video.author)?.video.author;
      if (name && this.platform !== 'bilibili')
        this.store.saveFocusBinding({ ...resolvedBinding, name });
      this.store.saveFocusWorks(works);
      for (const w of works) this.store.rememberVideo({ ...w.video });
      const target = (aid: string) => ({
        oid: aid,
        type: isPublicPostPlatform(this.platform) ? PUBLIC_POST_TYPES[this.platform] : this.platform === 'douyin' ? 2 : 1,
        root: '0',
        parent: '0',
      });
      // At most one new-work invitation plus two public thread opportunities per check.
      const fresh = works.find(
        (w) =>
          !this.store.hasSend(this.platform, account.id, w.video.aid) &&
          !this.store.getInbox(
            'focus:' + this.key(account.id, resolvedBinding.ownerId) + ':video:' + w.video.aid,
          ),
      );
      if (fresh)
        this.store.addInbox({
          id:
            'focus:' + this.key(account.id, resolvedBinding.ownerId) + ':video:' + fresh.video.aid,
          platform: this.platform,
          accountId: account.id,
          authorId: resolvedBinding.ownerId,
          author: name ?? resolvedBinding.name,
          text:
            '特别关注的新作品：' +
            fresh.video.title +
            (isPublicPostPlatform(this.platform)
              ? '。先读正文，用 watch 看图文或视频，再读原评论。' +
                (this.platform === 'xiaohongshu' && this.cfg.platforms.xiaohongshu.posting.allowTopLevelComments
                  ? '有具体想说的内容时，可用本条机会准备一条独立评论，也可以在精确楼层接话。'
                  : '有合适的原评论时，按准确楼层回复。')
              : '。先了解作品，再决定是否真诚捧场；无需硬夸或补发。'),
          target: target(fresh.video.aid),
          occurredAt: now / 1000,
          status: 'pending',
          notificationType: 'focus-video',
          focusOwnerId: resolvedBinding.ownerId,
        });
      const auto = Boolean(this.settings.autoReplyNewComments);
      const autoReplySeen = Object.fromEntries(
        Object.entries(prior?.autoReplySeen ?? {}).filter(([id]) =>
          works.some((w) => w.video.aid === id),
        ),
      );
      const autoReplySince = prior?.autoReplySince ?? now / 1000;
      const scanAllComments = auto && this.platform === 'xiaohongshu';
      const commentScans = Object.fromEntries(Object.entries(prior?.commentScans ?? {})
        .filter(([id]) => works.some(w => w.video.aid === id)));
      const recent = works.slice(0, auto ? this.settings.maxVideos : 3),
        selected = (this.platform === 'xiaohongshu' ? fresh : undefined) ??
          (recent.length ? recent[(prior?.cursor ?? 0) % recent.length] : undefined);
      const scan = auto
        ? [
            ...new Map(
              [recent[0], selected, recent[((prior?.cursor ?? 0) + 1) % Math.max(1, recent.length)]]
                .filter(Boolean)
                .map((w) => [w!.video.aid, w!]),
            ).values(),
          ]
        : selected
          ? [selected]
          : [];
      for (const selected of scan) {
        const workId = selected.video.aid;
        const previousScan = scanAllComments ? commentScans[workId] : undefined;
        const firstAutoScan = !autoReplySeen[workId] || (scanAllComments && !previousScan);
        const seen = new Set(autoReplySeen[workId] ?? []);
        type CommentPage = { items?: Array<
          import('./platform.ts').PublicComment & { replies?: import('./platform.ts').PublicComment[] }
        >; nextCursor?: string };
        const head = await adapter.comments(target(workId), 1, combined) as CommentPage;
        const pages = [{ data: head, baseline: firstAutoScan }];
        // Check the head on every round, then use the remaining slots to continue the previous sweep.
        let cursor = previousScan?.cursor ?? head.nextCursor;
        const baseline = previousScan?.cursor ? Boolean(previousScan.baseline) : firstAutoScan;
        if (auto) for (let page = 2; page <= 3 && cursor; page++) {
          try {
            const data = await adapter.comments(target(workId), page, combined, cursor) as CommentPage;
            pages.push({ data, baseline });
            cursor = data.nextCursor === cursor ? undefined : data.nextCursor;
          } catch (error) {
            if (combined.aborted && !scanAllComments) throw error;
            partialError = '后续评论页未读全，保留本次已读评论，下次继续检查。';
            break;
          }
        }
        if (scanAllComments) commentScans[workId] = cursor ? { cursor, baseline } : {};
        for (const { data } of pages) this.store.rememberComments(data);
        const comments = pages.flatMap(({ data, baseline }) =>
          (data.items ?? []).flatMap(c => [c, ...(c.replies ?? [])]).map(c => ({ c, baseline })));
        let queued = 0;
        for (const { c, baseline } of comments) {
          if ((!auto || (isPublicPostPlatform(this.platform) && !scanAllComments)) && queued >= 2) break;
          if (auto) {
            const fresh =
              Boolean(this.settings.replyExistingComments) ||
              (!seen.has(c.id) && (c.createdAt ? c.createdAt >= autoReplySince : !baseline));
            seen.add(c.id);
            if (!fresh) continue;
          }
          if (
            !c.authorId ||
            c.authorId === account.id ||
            (!auto &&
              c.authorId === resolvedBinding.ownerId &&
              !(
                this.platform === 'douyin' &&
                c.id !== c.target.root &&
                this.store.hasReceipt(this.platform, account.id, c.target.root)
              )) ||
            this.store
              .inbox()
              .some(
                (i) =>
                  i.platform === this.platform &&
                  i.accountId === account.id &&
                  i.target.oid === c.target.oid &&
                  i.target.parent === c.id,
              ) ||
            assessPublicInput(c.text).action === 'skip' ||
            this.store.hasSend(this.platform, account.id, c.target.oid, c.id)
          )
            continue;
          const id =
            'focus:' +
            this.key(account.id, resolvedBinding.ownerId) +
            ':comment:' +
            c.target.oid +
            ':' +
            c.id;
          if (this.store.getInbox(id)) continue;
          const item: InboxItem = {
            id,
            platform: this.platform,
            accountId: account.id,
            authorId: c.authorId,
            author: c.author,
            text: c.text.slice(0, 1500),
            ...(c.imageCount ? { imageCount: c.imageCount } : {}),
            target: c.target,
            occurredAt: now / 1000,
            status: 'pending',
            ownerAutoReply: auto || undefined,
            notificationType: 'focus-comment',
            focusOwnerId: resolvedBinding.ownerId,
          };
          this.store.addInbox(item);
          queued++;
        }
        if (auto) {
          autoReplySeen[selected.video.aid] = [...seen].slice(-1000);
          prior = { ...(prior ?? { at: now, nextAt: now }), autoReplySince, autoReplySeen,
            ...(scanAllComments ? { commentScans } : {}) };
          this.store.saveFocusCheck(key, prior);
        }
        if (scanAllComments && combined.aborted) break;
      }
      this.store.saveFocusCheck(key, {
        ...prior,
        at: now,
        nextAt: now + interval * 60000,
        cursor: (prior?.cursor ?? 0) + 1,
        error: partialError,
      });
    } catch (e) {
      if (signal?.aborted) return;
      const protectedFailure = e instanceof PlatformError && ['auth', 'rate'].includes(e.kind);
      const retryMinutes = autoConfigured && hasIndependentOwnerComments(this.platform) && !protectedFailure
        ? Math.min(interval, 5)
        : Math.max(10, this.settings.intervalMinutes);
      this.store.saveFocusCheck(key, {
        ...prior,
        at: now,
        nextAt: Date.now() + retryMinutes * 60000,
        cursor: prior?.cursor ?? 0,
        error: e instanceof Error ? e.message.slice(0, 200) : '关注读取暂不可用',
      });
    } finally {
      this.polling = false;
    }
  }
}

import { focusConfig } from './config.ts';
import type { SocialMediaConfigSection } from './config.ts';
import type { Account, PublicVideo, SocialPlatform, InboxItem } from './platform.ts';
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
  if (platform === 'kuaishou') {
    if (value.includes('://')) {
      const u = new URL(value),
        id = u.pathname.match(/^\/profile\/([A-Za-z0-9_-]{5,80})\/?$/)?.[1];
      if (u.origin !== 'https://www.kuaishou.com' || u.username || u.password || !id)
        throw Error('请填写快手官网完整主页');
      return { uid: id };
    }
    if (/^3x[a-z0-9]{10,30}$/i.test(value)) return { uid: value };
    if (!value || value.length > 80 || /[\s/\\]/.test(value))
      throw Error('请填写准确快手号或完整用户主页');
    return { name: value };
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
          ? this.platform === 'kuaishou'
            ? 'https://www.kuaishou.com/profile/' + encodeURIComponent(binding.ownerId)
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
    if (prior && prior.nextAt > now && (!force || now - prior.at < 60000)) return;
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
        type: this.platform === 'douyin' ? 2 : this.platform === 'kuaishou' ? 3 : 1,
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
            '。先了解作品，再决定是否真诚捧场；无需硬夸或补发。',
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
      const recent = works.slice(0, auto ? this.settings.maxVideos : 3),
        selected = recent.length ? recent[(prior?.cursor ?? 0) % recent.length] : undefined;
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
        const firstAutoScan = !autoReplySeen[selected.video.aid];
        const seen = new Set(autoReplySeen[selected.video.aid] ?? []);
        const pages = [
          await adapter.comments(target(selected.video.aid), 1, combined),
        ] as Array<any>;
        if (auto)
          for (let page = 2; page <= 3 && pages.at(-1)?.nextCursor; page++) {
            try {
              pages.push(
                await adapter.comments(
                  target(selected.video.aid),
                  page,
                  combined,
                  pages.at(-1).nextCursor,
                ),
              );
            } catch (e) {
              if (combined.aborted) throw e;
              partialError = '后续评论页未读全，保留本次已读评论，下次继续检查。';
              break;
            }
          }
        for (const page of pages) this.store.rememberComments(page);
        const p = { items: pages.flatMap((page) => page.items ?? []) } as {
          items?: Array<
            import('./platform.ts').PublicComment & {
              createdAt?: number;
              replies?: import('./platform.ts').PublicComment[];
            }
          >;
        };
        const comments = (p.items ?? []).flatMap((c) => [c, ...(c.replies ?? [])]);
        let queued = 0;
        for (const c of comments) {
          if (!auto && queued >= 2) break;
          if (auto) {
            const fresh =
              Boolean(this.settings.replyExistingComments) ||
              (!seen.has(c.id) && (c.createdAt ? c.createdAt >= autoReplySince : !firstAutoScan));
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
          prior = { ...(prior ?? { at: now, nextAt: now }), autoReplySince, autoReplySeen };
          this.store.saveFocusCheck(key, prior);
        }
      }
      this.store.saveFocusCheck(key, {
        ...prior,
        at: now,
        nextAt:
          now +
          (auto ? (this.settings.autoReplyIntervalMinutes ?? 2) : this.settings.intervalMinutes) *
            60000,
        cursor: (prior?.cursor ?? 0) + 1,
        error: partialError,
      });
    } catch (e) {
      this.store.saveFocusCheck(key, {
        ...prior,
        at: now,
        nextAt: now + Math.max(10, this.settings.intervalMinutes) * 60000,
        cursor: prior?.cursor ?? 0,
        error: e instanceof Error ? e.message.slice(0, 200) : '关注读取暂不可用',
      });
    } finally {
      this.polling = false;
    }
  }
}

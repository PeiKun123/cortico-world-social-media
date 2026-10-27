import { randomUUID } from 'node:crypto';
import { ROAMING_PLATFORMS, roamingConfig, type SocialMediaConfigSection } from './config.ts';
import type { SocialStore } from './store.ts';
export interface RoamSession {
  id: string;
  createdAt: string;
  expiresAt?: string;
  platform?: string;
  yieldRequestedAt?: string;
  yieldReason?: string;
  status: 'offered' | 'active' | 'finished' | 'skipped' | 'expired';
  searches: number;
  totalVideos?: number;
  videos: Array<{ id: string; aid: string; title: string; url: string; commentsRead: number }>;
  summary?: string;
  completedAt?: string;
}
/** Local opportunities and budgets only; the host Persona chooses all content and speech. */
export class Roaming {
  constructor(
    private cfg: SocialMediaConfigSection,
    private store: SocialStore,
    private timezone: string,
    private now = () => Date.now(),
  ) {}
  private day(time: string) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(time));
  }
  private platformOf(r: RoamSession) {
    return (
      r.platform ??
      (r.videos[0]?.url.includes('douyin.com')
        ? 'douyin'
        : r.videos[0]?.url.includes('kuaishou.com')
          ? 'kuaishou'
          : 'bilibili')
    );
  }
  private policy(r: RoamSession) {
    return roamingConfig(this.cfg, this.platformOf(r));
  }
  private expire() {
    for (const r of this.store.roams())
      if (
        ['offered', 'active'].includes(r.status) &&
        !(r.status === 'active' && this.policy(r).mode === 'free') &&
        Date.parse(
          r.expiresAt ??
            new Date(
              Date.parse(r.createdAt) + this.policy(r).maxSessionMinutes * 60000,
            ).toISOString(),
        ) <= this.now()
      ) {
        r.status = 'expired';
        r.completedAt = new Date(this.now()).toISOString();
        this.store.saveRoam(r);
      }
  }
  status() {
    this.expire();
    const all = this.store.roams(),
      today = this.day(new Date(this.now()).toISOString());
    const platforms = Object.fromEntries(
      ROAMING_PLATFORMS.map((id) => [
        id,
        {
          limits: roamingConfig(this.cfg, id),
          usedToday:
            this.store.roamCount(today, id) ??
            all.filter((r) => this.platformOf(r) === id && this.day(r.createdAt) === today).length,
        },
      ]),
    );
    return {
      enabled: this.cfg.roaming.enabled,
      limits: this.cfg.roaming,
      platforms,
      usedToday: Object.values(platforms).reduce((sum, p) => sum + p.usedToday, 0),
      active: (() => {
        const r = all
          .slice()
          .reverse()
          .find((r) => ['offered', 'active'].includes(r.status));
        return r
          ? { ...r, totalVideos: r.totalVideos ?? r.videos.length, videos: r.videos.slice(-10) }
          : undefined;
      })(),
      recent: all
        .slice(-5)
        .reverse()
        .map((r) => ({
          ...r,
          totalVideos: r.totalVideos ?? r.videos.length,
          videos: r.videos.slice(-10),
        })),
    };
  }
  offer(preferred?: string, allowed?: string[]) {
    const status = this.status();
    if (status.active) return;
    const all = this.store.roams();
    const candidates = ROAMING_PLATFORMS.filter((id) => {
      const { limits: c, usedToday } = status.platforms[id];
      if (
        !c.enabled ||
        (preferred && preferred !== id) ||
        (allowed && !allowed.includes(id)) ||
        (c.mode !== 'free' && usedToday >= c.maxDailySessions)
      )
        return false;
      const last = all
        .slice()
        .reverse()
        .find((r) => this.platformOf(r) === id);
      return (
        !last ||
        this.now() - Date.parse(last.completedAt ?? last.createdAt) >= c.minIntervalMinutes * 60000
      );
    }).sort((a, b) => {
      const last = (id: string) =>
        Date.parse(
          all
            .slice()
            .reverse()
            .find((r) => this.platformOf(r) === id)?.createdAt ?? '1970-01-01',
        );
      return last(a) - last(b);
    });
    const platform = candidates[0];
    if (!platform) return;
    const c = status.platforms[platform].limits;
    const r: RoamSession = {
      id: randomUUID(),
      platform,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + c.maxSessionMinutes * 60000).toISOString(),
      status: 'offered',
      searches: 0,
      videos: [],
    };
    this.store.saveRoam(r, {
      day: this.day(r.createdAt),
      platform,
      count: status.platforms[platform].usedToday + 1,
    });
    return r;
  }
  usePlatform(id: string, platform: string) {
    const r = this.session(id);
    if (r.platform && r.platform !== platform)
      throw Error('本轮闲逛已选择其他平台；先收尾，再等该平台的机会');
    if (!r.platform) {
      if (r.videos.length && this.platformOf(r) !== platform)
        throw Error('本轮已有其他平台的阅读进度');
      r.platform = platform;
      this.store.saveRoam(r);
    }
    if (!this.policy(r).enabled) throw Error('此平台闲逛已关闭，请保存进度并结束本轮');
    return r;
  }
  session(id: string, allowDisabled = false) {
    if (!allowDisabled && !this.cfg.roaming.enabled) throw Error('闲逛已关闭');
    this.expire();
    const r = this.store.roams().find((r) => r.id === id);
    if (!r) throw Error('闲逛记录不存在');
    if (r.status === 'expired') throw Error('本轮闲逛已超时，请留待下一次机会');
    if (!['offered', 'active'].includes(r.status)) throw Error('本轮闲逛已结束');
    return r;
  }
  begin(id: string) {
    const r = this.session(id);
    r.status = 'active';
    if (this.policy(r).mode === 'free') delete r.expiresAt;
    this.store.saveRoam(r);
    return { ...r, limits: this.policy(r) };
  }
  finish(id: string, summary: string, skip = false) {
    const r = this.session(id, true);
    r.status = skip ? 'skipped' : 'finished';
    r.summary = String(summary || '')
      .trim()
      .slice(0, 1000);
    r.completedAt = new Date(this.now()).toISOString();
    this.store.saveRoam(r);
    return r;
  }
  requestYield(id: string, reason = '有新消息，当前操作结束后先回应') {
    const r = this.store
      .roams()
      .find((r) => r.id === id && ['offered', 'active'].includes(r.status));
    if (!r) return;
    if (!r.yieldRequestedAt) {
      r.yieldRequestedAt = new Date(this.now()).toISOString();
      r.yieldReason = reason;
      this.store.saveRoam(r);
    }
    return r;
  }
  finishYield(id: string) {
    const r = this.store.roams().find((r) => r.id === id);
    if (!r?.yieldRequestedAt) return;
    if (!['offered', 'active'].includes(r.status)) return r;
    return this.finish(
      id,
      '有新消息，本轮已保存。最近读到：' +
        (r.videos.at(-1)?.title ?? '尚未开始阅读') +
        '。先回应新消息；不自动重发任何评论。',
    );
  }
  search(id: string) {
    const r = this.session(id);
    if (this.policy(r).mode !== 'free' && r.searches >= this.policy(r).maxVideosPerSession * 2)
      throw Error('本轮搜索预算已用完，可以从已读结果选择或结束');
    r.searches++;
    this.store.saveRoam(r);
  }
  nextVideo(id: string) {
    const r = this.session(id);
    if (this.policy(r).mode !== 'free' && r.videos.length >= this.policy(r).maxVideosPerSession)
      throw Error('本轮视频预算已用完，请整理心得并结束');
    this.search(id); // Bound failed/duplicate feed attempts as well as successful reads.
    return r.videos.map((v) => v.aid);
  }
  recordVideo(id: string, video: { id: string; aid: string; title: string; url: string }) {
    const r = this.session(id);
    if (!r.videos.some((v) => v.aid === video.aid)) {
      if (this.policy(r).mode !== 'free' && r.videos.length >= this.policy(r).maxVideosPerSession)
        throw Error('本轮视频预算已用完，请整理心得并结束');
      r.totalVideos = (r.totalVideos ?? r.videos.length) + 1;
      r.videos.push({
        id: video.id,
        aid: video.aid,
        title: video.title.slice(0, 200),
        url: video.url,
        commentsRead: 0,
      });
      r.videos = r.videos.slice(-100);
      this.store.saveRoam(r);
    }
    return r;
  }
  remainingComments(id: string, aid: string) {
    const r = this.session(id),
      v = r.videos.find((v) => v.aid === aid);
    if (!v) throw Error('请先读取本轮视频，再读其评论');
    const left =
      this.policy(r).mode === 'free'
        ? Infinity
        : this.policy(r).maxCommentsPerVideo - v.commentsRead;
    if (left <= 0) throw Error('本视频评论阅读预算已用完，可表达观点或结束');
    return left;
  }
  comments(id: string, aid: string, input: unknown) {
    let left = this.remainingComments(id, aid);
    let consumed = 0;
    type Node = { replies?: Node[]; [key: string]: unknown };
    const trim = (list: Node[]): Node[] => {
      const out: Node[] = [];
      for (const raw of list) {
        if (left <= 0) break;
        left--;
        consumed++;
        const copy = { ...raw };
        if (Array.isArray(copy.replies)) copy.replies = trim(copy.replies);
        out.push(copy);
      }
      return out;
    };
    const page = input as { items: Node[]; root?: Node; [key: string]: unknown };
    const root = page.root ? trim([page.root])[0] : undefined;
    const items = trim(page.items || []);
    const r = this.session(id);
    r.videos.find((v) => v.aid === aid)!.commentsRead += consumed;
    this.store.saveRoam(r);
    return { ...page, root, items, readingRemaining: Number.isFinite(left) ? left : null };
  }
  canPublish(id: string | undefined, oid: string, platform?: string) {
    if (!id) return;
    const round = platform ? this.usePlatform(id, platform) : this.session(id);
    const c = this.policy(round);
    if (id) {
      const r = this.session(id);
      if (!r.videos.some((v) => v.aid === oid)) throw Error('闲逛发言须指向本轮读过的视频');
      const count = this.store
        .outbox()
        .filter((s) => s.roamId === id && s.status !== 'rejected').length;
      if (count >= c.maxCommentsPerSession) throw Error('本轮主动发言预算已用完');
    }
    const today = this.day(new Date(this.now()).toISOString());
    const count = this.store
      .outbox()
      .filter(
        (s) =>
          Boolean(s.roamId) &&
          s.platform === this.platformOf(round) &&
          !s.inboxId &&
          s.status !== 'rejected' &&
          this.day(s.createdAt) === today,
      ).length;
    if (count >= c.maxDailyComments) throw Error('今日主动发言预算已用完；不影响通知回复');
  }
}

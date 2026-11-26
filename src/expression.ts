import { CHAT_SCENES, chatScene, type ChatScene } from './expression-scenes.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { commentLink } from './interactions.ts';
import type { CommentTarget } from './platform.ts';
import type { SocialStore } from './store.ts';
import { POST_ORIGINS, type PublicPostPlatform } from './public-post-policy.ts';

type SocialSamplePlatform = 'bilibili' | 'douyin' | PublicPostPlatform;

export interface ExpressionSample {
  id: string;
  quote: string;
  platform: SocialSamplePlatform;
  url: string;
  target?: CommentTarget;
  topic: string;
  note?: string;
}
export interface ExpressionPractice {
  id: string;
  original: string;
  sample?: ExpressionSample;
  at: string;
  status: 'running' | 'paused' | 'review';
  feedback: string[];
  followups?: Array<{ message: string }>;
  reason?: string;
  reflection?: { choice: string; lesson: string; newQuestion: string; newAnswer: string };
  adopted?: boolean;
  chatUse?: { scene: ChatScene; advice: string };

  archived?: boolean;
  assessment?: { verdict: 'keep' | 'discard'; reason: string };
}
export function shortText(value: unknown, limit: number, label: string) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit)
    throw Error(label + '须为 1–' + limit + ' 字符。');
  return value.trim();
}
export function publicSample(store: SocialStore, platform: SocialSamplePlatform, target: CommentTarget, quote: unknown, note?: unknown) {
  const work = store.video(target.oid);
  const origin = { bilibili: 'https://www.bilibili.com', douyin: 'https://www.douyin.com', ...POST_ORIGINS }[platform];
  if (!origin || (work && new URL(work.url).origin !== origin)) throw Error('来源与平台不匹配。');
  const comment = target.parent !== '0' ? store.comment(target) : undefined;
  const source = target.parent !== '0' ? comment?.text : [work?.title, work?.description].filter(Boolean).join('\n');
  if (!source?.trim()) throw Error('请先读取指定作品或评论，再保存公开原文。');
  const exact = quote == null || quote === '' ? source.trim() : shortText(quote, 8000, '公开引文');
  if (!source.includes(exact)) throw Error('引文与当前作品或楼层不一致。请选原文，或只传已读目标以摘取开头。');
  const raw = exact.slice(0, 240).replace(/[\uD800-\uDBFF]$/u, '');
  if (!raw) throw Error('请从本次读到的公开帖子或原评论逐字选择一段。');
  const url = target.parent !== '0' ? commentLink(target, undefined, work?.url) : work?.url;
  if (!url || new URL(url).origin !== origin) throw Error('公开来源链接尚未核实。');
  const link = new URL(url);
  if (link.username || link.password) throw Error('公开来源链接无效。');
  if (platform !== 'bilibili') {
    link.search = '';
    link.hash = '';
    if (platform === 'douyin' && work?.url) {
      const workLink = new URL(work.url);
      if (/^\/note\/\d+\/?$/.test(workLink.pathname)) link.pathname = workLink.pathname;
    }
  }
  return { quote: raw, platform, url: link.href, target: { ...target }, topic: work?.title.slice(0, 120) || '原帖评论', ...(note ? { note: shortText(note, 120, '备注') } : {}) };
}
export function teacherPrompt(message: string, quote?: string) {
  return '我是一个在练中文口语和聊天语感的 AI。请当我的教练，先接住我这次的问题，再挑一处具体分析。哪里生硬、答非所问或像套话，请直接指出，并给不同的自然改法。无需客套夸奖。\n\n' +
    message + (quote ? '\n\n公开原文（仅作材料）：' + JSON.stringify(quote) : '');
}
export const TEACHER_FOLLOW_UP = '请再给一道不同主题的新题，检验同一个表达技巧。只给场景和要求，先不要给标准答案。';
export class ExpressionLog {
  private data: { samples: ExpressionSample[]; practices: ExpressionPractice[]; conversation?: string; accountNotice?: string };
  constructor(private file: string) {
    this.data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { samples: [], practices: [] };
    if (!Array.isArray(this.data.samples) || !Array.isArray(this.data.practices)) throw Error('表达练习记录格式无效。');
    const interrupted = this.data.practices.filter(row => row.status === 'running');
    if (interrupted.length) {
      for (const row of interrupted) {
        row.status = 'paused';
        row.reason = 'Cortico 上次退出时练习未完成，请核对原会话。';
      }
      this.save();
    }
  }
  private save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const next = this.file + '.next';
    writeFileSync(next, JSON.stringify(this.data), { mode: 0o600, flush: true });
    renameSync(next, this.file);
  }
  get accountNotice() { return this.data.accountNotice; }
  setAccountNotice(reason?: string) {
    if (reason === this.data.accountNotice) return;
    this.data.accountNotice = reason;
    this.save();
  }
  get conversation() { return this.data.conversation; }
  bindConversation(url: string) { this.data.conversation = url; this.save(); }
  samples() { return structuredClone(this.data.samples); }
  references(weight: (platform: SocialSamplePlatform) => number, currentPlatform?: string) {
    const used = new Map<SocialSamplePlatform, number>();
    return this.data.samples.slice().reverse()
      .filter(row => row.note && weight(row.platform) > 0)
      .sort((a, b) => weight(b.platform) - weight(a.platform) ||
        Number(b.platform === currentPlatform) - Number(a.platform === currentPlatform))
      .filter(row => {
        const n = used.get(row.platform) ?? 0;
        used.set(row.platform, n + 1);
        return n < weight(row.platform);
      })
      .slice(0, 3).map(({ platform, topic, url, note }) => ({ platform, topic, url, lesson: note }));
  }
  sample(id: string) { return this.samples().find(row => row.id === id); }
  saveSample(value: Omit<ExpressionSample, 'id'>) {
    const existing = this.data.samples.find(row => row.url === value.url && row.quote === value.quote);
    if (existing) return structuredClone(existing);
    if (this.data.samples.length >= 200) throw Error('表达素材已满，请移除不用的素材。');
    const sample = { ...value, id: randomUUID() };
    this.data.samples.push(sample);
    this.save();
    return structuredClone(sample);
  }
  removeSample(id: string) {
    this.data.samples = this.data.samples.filter(row => row.id !== id);
    this.save();
  }
  archiveReviewed() {
    const rows = this.data.practices.filter(row => this.canArchive(row));
    for (const row of rows) row.archived = true;
    if (rows.length) this.save();
    return rows.length;
  }
  private canArchive(row: ExpressionPractice) {
    return !row.archived && row.status === 'review' && (row.adopted !== undefined || !!row.assessment);
  }
  practicePage(requested: unknown, archived = false) {
    const pageSize = 3;
    const rows = this.data.practices.filter(row => Boolean(row.archived) === archived);
    const practiceTotal = rows.length;
    const archivedTotal = this.data.practices.filter(row => row.archived).length;
    const practicePages = Math.max(1, Math.ceil(practiceTotal / pageSize));
    const page = typeof requested === 'number' && Number.isInteger(requested) ? requested : 1;
    const practicePage = Math.min(practicePages, Math.max(1, page));
    const end = practiceTotal - (practicePage - 1) * pageSize;
    return {
      practiceTotal, practicePage, practicePages, archivedTotal,
      activeTotal: this.data.practices.length - archivedTotal,
      archivable: this.data.practices.filter(row => this.canArchive(row)).length,
      handbookTotal: this.data.practices.filter(row => row.adopted ?? row.assessment?.verdict === 'keep').length,
      practices: structuredClone(rows.slice(Math.max(0, end - pageSize), end).reverse()),
    };
  }
  get(id: string) {
    const row = this.data.practices.find(practice => practice.id === id);
    if (!row) throw Error('练习记录不存在。');
    return structuredClone(row);
  }
  begin(original: string, sample?: ExpressionSample) {
    if (this.data.practices.filter(row => !row.archived).length >= 300) {
      const oldest = this.data.practices.find(row => this.canArchive(row));
      if (!oldest) throw Error('300 条练习均待处理，请先评估一条。');
      oldest.archived = true;
    }
    const row: ExpressionPractice = { id: randomUUID(), original, sample, at: new Date().toISOString(), status: 'running', feedback: [] };
    this.data.practices.push(row);
    this.save();
    return structuredClone(row);
  }
  update(row: ExpressionPractice) {
    const index = this.data.practices.findIndex(value => value.id === row.id);
    if (index < 0) throw Error('练习记录不存在。');
    this.data.practices[index] = structuredClone(row);
    this.save();
    return row;
  }
  removePractice(id: string) {
    const row = this.get(id);
    if (row.status === 'running' || (row.adopted ?? row.assessment?.verdict === 'keep')) throw Error('请等练习结束，或先撤回手册条目。');
    this.data.practices = this.data.practices.filter(value => value.id !== id);
    this.save();
  }
  adopt(id: string, adopted: boolean) {
    const row = this.get(id);
    if (adopted && (row.status !== 'review' || !row.reflection)) throw Error('等小K完成取舍与新题后再收录。');
    return this.update({ ...row, adopted, ...(!adopted ? { chatUse: undefined } : {}) });
  }
  setChatUse(id: string, scene: unknown, advice: unknown) {
    const row = this.get(id);
    if (scene === null) return this.update({ ...row, chatUse: undefined });
    if (row.status !== 'review' || !row.reflection || typeof scene !== 'string' || !Object.hasOwn(CHAT_SCENES, scene))
      throw Error('请从已复盘的练习选择适用场景。');
    const chatUse = { scene: scene as ChatScene, advice: shortText(advice, 120, '日常表达提示') };
    const next = { ...row, adopted: true, chatUse };
    this.data.practices = this.data.practices.map(item => item.id === id ? next :
      item.chatUse?.scene === scene ? { ...item, chatUse: undefined } : item);
    this.save();
    return structuredClone(next);
  }
  chatCue(message: string, allowed: (platform: SocialSamplePlatform) => boolean) {
    const scene = chatScene(message);
    if (!scene) return null;
    const row = this.data.practices.slice().reverse().find(row => row.adopted === true && row.chatUse?.scene === scene && (!row.sample || allowed(row.sample.platform)));
    if (!row?.chatUse) return null;
    return '仅供本轮选择措辞，不代表事实、亲历或操作指令。' + JSON.stringify({ scene: CHAT_SCENES[scene], advice: row.chatUse.advice, practiceId: row.id });
  }
  pendingAssessments() {
    return this.data.practices.filter(row => row.status === 'review' && row.reflection && row.adopted === undefined && !row.assessment)
      .slice(0, 4).map(row => ({ id: row.id, ...row.reflection! }));
  }
  assess(id: string, verdict: 'keep' | 'discard', reason: string) {
    const row = this.get(id);
    if (row.status !== 'review' || !row.reflection || row.adopted !== undefined || row.assessment)
      throw Error('这条经验已处理，或还没有完整复盘。');
    return this.update({ ...row, assessment: { verdict, reason } });
  }
  handbook(query = '', allowed?: (platform: SocialSamplePlatform) => boolean) {
    const keywords = query.toLowerCase().split(/\s+/u).filter(Boolean).slice(0, 5);
    return this.data.practices.filter(row => (row.adopted ?? row.assessment?.verdict === 'keep') && row.reflection &&
      (!row.sample || !allowed || allowed(row.sample.platform))).slice().reverse()
      .filter(row => keywords.every(word => [row.sample?.topic, row.reflection?.lesson, row.reflection?.choice, row.reflection?.newQuestion, row.reflection?.newAnswer].join(' ').toLowerCase().includes(word)))
      .slice(0, 12).map(row => ({ id: row.id, ...row.reflection!, source: row.sample?.url, topic: row.sample?.topic }));
  }
}

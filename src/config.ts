import { POST_PLATFORMS, PUBLIC_POST_NAMES, type PostVisualLevel } from './public-post-policy.ts';
import { GROUP_DEFAULTS, type GroupConfig } from './group-policy.ts';
import { MAX_VIDEO_FRAMES, RESOURCE_DEFAULTS, type ResourceConfig } from './resource-policy.ts';
import type { ConfigGroup } from 'cortico/core/types.ts';
// Release switch for the public-post adapters. Keep existing deployment settings and records for future trials.
export const PUBLIC_POST_TRIAL_ENABLED = true;

export interface SocialPlatformConfig {
  postVisual?: PostVisualLevel;
  visualDaily?: 'inherit' | 'bounded' | 'unlimited';
  corpusWeight?: 'off' | 'light' | 'medium' | 'strong';
  chat?: GroupConfig;
  dynamics?: {
    enabled: boolean;
    maxDailyReads?: number;
    autonomousEnabled?: boolean;
    autoMaxDaily?: number;
    autoMinIntervalMinutes?: number;
    autoIdleMinutes?: number;
    autoStartHour?: number;
    autoEndHour?: number;
    allowPublishing?: boolean;
    maxDailyPosts?: number;
    minIntervalSec?: number;
  };
  focus?: FocusConfig;
  roaming?: Partial<RoamingConfig>;
  enabled: boolean;
  monitor: { enabled: boolean; intervalSec: number };
  posting: {
    enabled: boolean;
    allowTopLevelComments?: boolean;
    minIntervalSec: number;
    maxDailyComments: number;
    maxDailyReplies: number;
    transport: 'browser' | 'api';
  };
}
export interface RoamingConfig {
  enabled: boolean;
  mode?: 'bounded' | 'free';
  maxDailySessions: number;
  maxVideosPerSession: number;
  maxCommentsPerVideo: number;
  maxCommentsPerSession: number;
  maxDailyComments: number;
  minIntervalMinutes: number;
  idleMinutes: number;
  maxSessionMinutes: number;
  maxTextChars: number;
}
export const ROAMING_PRESETS = {
  light: {
    mode: 'bounded',
    maxDailySessions: 4,
    maxVideosPerSession: 2,
    maxCommentsPerVideo: 20,
    maxCommentsPerSession: 3,
    maxDailyComments: 8,
    minIntervalMinutes: 120,
    idleMinutes: 10,
    maxSessionMinutes: 30,
    maxTextChars: 8000,
  },
  balanced: {
    mode: 'bounded',
    maxDailySessions: 8,
    maxVideosPerSession: 3,
    maxCommentsPerVideo: 40,
    maxCommentsPerSession: 5,
    maxDailyComments: 24,
    minIntervalMinutes: 60,
    idleMinutes: 8,
    maxSessionMinutes: 30,
    maxTextChars: 10000,
  },
  active: {
    mode: 'bounded',
    maxDailySessions: 12,
    maxVideosPerSession: 5,
    maxCommentsPerVideo: 60,
    maxCommentsPerSession: 8,
    maxDailyComments: 60,
    minIntervalMinutes: 40,
    idleMinutes: 5,
    maxSessionMinutes: 30,
    maxTextChars: 12000,
  },
  free: {
    mode: 'free',
    maxDailySessions: 12,
    maxVideosPerSession: 5,
    maxCommentsPerVideo: 60,
    maxCommentsPerSession: 8,
    maxDailyComments: 60,
    minIntervalMinutes: 10,
    idleMinutes: 5,
    maxSessionMinutes: 30,
    maxTextChars: 12000,
  },
} satisfies Record<string, Omit<RoamingConfig, 'enabled'>>;
export const ROAMING_PLATFORMS = ['bilibili', 'douyin', ...POST_PLATFORMS] as const;
export function roamingConfig(cfg: SocialMediaConfigSection, platform: string): RoamingConfig {
  const local = cfg.platforms[platform]?.roaming;
  return {
    mode: 'bounded',
    ...cfg.roaming,
    ...local,
    enabled:
      cfg.roaming.enabled && Boolean(cfg.platforms[platform]?.enabled) && (local?.enabled ?? true),
  };
}
export function corpusWeight(cfg: SocialMediaConfigSection, platform: string) {
  if (!cfg.enabled || !cfg.platforms[platform]?.enabled || !ROAMING_PLATFORMS.some(id => id === platform)) return 0;
  const weight = cfg.platforms[platform].corpusWeight ?? (cfg.experiments?.corpus ? 'medium' : 'off');
  return { off: 0, light: 1, medium: 2, strong: 3 }[weight] ?? 0;
}
export const REPLY_PRESETS = { light: 40, balanced: 80, active: 120 };
export const MAX_REPLIES_PER_PERSON = 5;
export interface FocusConfig {
  outsideReplyLimit?: number;
  allowMentions?: boolean;
  maxDailyMentions?: number;
  autoReplyNewComments?: boolean;
  replyExistingComments?: boolean;
  autoReplyIntervalMinutes?: number;
  enabled: boolean;
  account: string;
  intervalMinutes: number;
  maxDailyActions: number;
  maxVideos: number;
}
export const DEFAULT_ACTIVE_HOURS = { enabled: false, start: '09:00', end: '23:00' };
export const clockTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export function withinActiveHours(hours: typeof DEFAULT_ACTIVE_HOURS | undefined, timezone?: string, now = new Date()) {
  if (!hours?.enabled || hours.start === hours.end) return true;
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(now);
  return hours.start < hours.end ? time >= hours.start && time < hours.end : time >= hours.start || time < hours.end;
}

export interface SocialMediaConfigSection {
  activeHours?: typeof DEFAULT_ACTIVE_HOURS;
  focus: FocusConfig;
  enabled: boolean;
  roaming: RoamingConfig;
  experiments?: { corpus?: boolean; practice?: boolean; training?: boolean; tieba?: boolean; xiaohongshu?: boolean };
  platforms: Record<string, SocialPlatformConfig>;
  publicAccounts?: Partial<Record<typeof POST_PLATFORMS[number], string>>;
  media: { ffmpegFile: string; maxFrames: number } & Partial<ResourceConfig>;
  browser: { executableFile: string; background: boolean };
  douyinBrowser?: {
    executableFile: string;
    background: boolean;
    releaseAfterTask?: boolean;
    compatibilityWindow?: boolean;
    hideCompatibilityWindow?: boolean;
    pageWaitSeconds?: number;
  };
}
export function douyinPageWaitMs(seconds?: number) {
  return (Number.isFinite(seconds) ? Math.max(15, Math.min(120, seconds!)) : 45) * 1000;
}
export function douyinOperationBudgetMs(seconds?: number) {
  return douyinPageWaitMs(seconds) * 3 + 30000;
}
export const SOCIALMEDIA_SECRET = 'SOCIALMEDIA_BILIBILI_COOKIE';
export const SOCIALMEDIA_DEFAULTS: SocialMediaConfigSection = {
  enabled: false,
  focus: {
    outsideReplyLimit: 5,
    allowMentions: false,
    maxDailyMentions: 3,
    enabled: false,
    account: '',
    intervalMinutes: 30,
    maxDailyActions: 8,
    maxVideos: 12,
    autoReplyNewComments: false,
    replyExistingComments: false,
    autoReplyIntervalMinutes: 2,
  },
  activeHours: { ...DEFAULT_ACTIVE_HOURS },
  roaming: { enabled: false, ...ROAMING_PRESETS.active },
  experiments: { corpus: false, practice: false, training: false, tieba: false, xiaohongshu: false },
  platforms: {
    ...Object.fromEntries(POST_PLATFORMS.map(id => [id, {
      enabled: false,
      postVisual: 'medium',
      roaming: { enabled: true, ...ROAMING_PRESETS.light },
      focus: { enabled: false, account: '', intervalMinutes: 30, maxDailyActions: 8, maxVideos: 3,
        autoReplyNewComments: false, autoReplyIntervalMinutes: id === 'xiaohongshu' ? 5 : 20, replyExistingComments: false },
      monitor: { enabled: false, intervalSec: 300 },
      posting: { enabled: false, minIntervalSec: 90, maxDailyComments: 10, maxDailyReplies: 10, transport: 'browser' },
    } satisfies SocialPlatformConfig])),
    douyin: {
      chat: structuredClone(GROUP_DEFAULTS),
      focus: {
        autoReplyNewComments: false,
        replyExistingComments: false,
        autoReplyIntervalMinutes: 2,
        enabled: false,
        account: '',
        intervalMinutes: 30,
        maxDailyActions: 8,
        maxVideos: 12,
      },
      enabled: false,
      monitor: { enabled: false, intervalSec: 300 },
      posting: {
        enabled: false,
        minIntervalSec: 60,
        maxDailyComments: 30,
        maxDailyReplies: 20,
        transport: 'browser',
      },
    },
    bilibili: {
      dynamics: {
        enabled: false,
        maxDailyReads: 20,
        autonomousEnabled: false,
        autoMaxDaily: 1,
        autoMinIntervalMinutes: 360,
        autoIdleMinutes: 20,
        autoStartHour: 9,
        autoEndHour: 23,
        allowPublishing: false,
        maxDailyPosts: 3,
        minIntervalSec: 300,
      },
      enabled: true,
      monitor: { enabled: false, intervalSec: 60 },
      posting: {
        enabled: false,
        minIntervalSec: 30,
        maxDailyComments: 200,
        maxDailyReplies: 80,
        transport: 'browser',
      },
    },
  },
  media: { ffmpegFile: 'ffmpeg', maxFrames: 2, ...RESOURCE_DEFAULTS },
  browser: { executableFile: '', background: true },
  douyinBrowser: {
    executableFile: '',
    background: true,
    releaseAfterTask: true,
    compatibilityWindow: false,
    hideCompatibilityWindow: false,
    pageWaitSeconds: 45,
  },
};
export const SOCIALMEDIA_CONFIG_GROUP: ConfigGroup = {
  id: 'world:socialmedia',
  owner: 'world:socialmedia',
  schema: {
    type: 'object',
    title: '小鲸鱼爱冲浪',
    properties: {
      'worlds.socialmedia.experiments.corpus': { type: 'boolean', title: '语料学习' },
      'worlds.socialmedia.experiments.practice': { type: 'boolean', title: '人格化练习', description: 'Gemini 网页陪练易风控，连续访问可能触发验证或限流。' },
      'worlds.socialmedia.experiments.training': { type: 'boolean', title: '开始训练', description: '高消耗。空闲时持续发问、追问与复盘，消耗小K的模型用量及 Gemini 网页额度。建议短时开启。' },
      ...(PUBLIC_POST_TRIAL_ENABLED ? {
        'worlds.socialmedia.experiments.tieba': { type: 'boolean', title: '百度贴吧公开帖' },
        'worlds.socialmedia.experiments.xiaohongshu': { type: 'boolean', title: '小红书公开帖' },
      } : {}),
      ...Object.fromEntries(
        Object.entries({
          enabled: { type: 'boolean', title: '优先关注抖音主人作品与评论区' },
          autoReplyNewComments: {
            type: 'boolean',
            title: '自动回应抖音主人评论区的新评论',
            description:
              '默认关闭；首次扫描记录旧评论，此后新增的普通评论逐条入队。只监测最近作品范围，主人评论自动回应不占普通日配额及每人五条；保留发送间隔与安全判断。',
          },
          replyExistingComments: {
            type: 'boolean',
            title: '也考虑抖音已有未回复评论',
            description:
              '需开启自动回应；在已读取的主人作品范围内补看旧评论，已有发送记录的位置不重复发。',
          },
          autoReplyIntervalMinutes: {
            type: 'integer',
            title: '抖音新评论检查间隔（分钟）',
            minimum: 2,
            maximum: 60,
            description: '开启自动回应后使用，建议2—5分钟；定时检查，不是实时推送。',
          },
          account: {
            type: 'string',
            title: '抖音主人账号（抖音号或主页链接）',
            description:
              '以这里填写的账号为准。优先使用完整 www.douyin.com/user/ 主页；抖音号须在官网精确核对后固定账号，不按昵称猜测。',
          },
          intervalMinutes: {
            type: 'integer',
            title: '抖音关注检查间隔（分钟）',
            description: '隔多久去看一次特别关注的近期作品。',
            minimum: 10,
            maximum: 1440,
          },
          maxDailyActions: {
            type: 'integer',
            title: '抖音关注参与次数（旧设置）',
            description: '保留旧版配置兼容。已核实的主人作品评论区使用独立计数。',
            minimum: 0,
            maximum: 30,
          },
          maxVideos: { type: 'integer', title: '抖音最近查看的作品数量', minimum: 1, maximum: 30 },
        }).map(([key, value]) => [
          'worlds.socialmedia.platforms.douyin.focus.' + key,
          { ...value, 'x-hot': true },
        ]),
      ),
      'worlds.socialmedia.focus.outsideReplyLimit': {
        type: 'integer', title: '主人在其他作品下的每日通知回复上限', minimum: -1, maximum: 100,
        description: '默认 5 次。0 关闭这类回复，1–100 同时受普通发布和通知总额度限制。-1 让绑定主人独立计数，回复次数不限。', 'x-hot': true,
      },
      'worlds.socialmedia.focus.autoReplyNewComments': {
        type: 'boolean',
        title: '自动回应B站主人评论区的新评论',
        description:
          '默认关闭；首次扫描记录旧评论，此后新增的普通评论逐条入队。只监测最近作品范围，主人评论自动回应不占普通日配额及每人五条；保留发送间隔与安全判断。',
        'x-hot': true,
      },
      'worlds.socialmedia.focus.replyExistingComments': {
        type: 'boolean',
        title: '也考虑B站已有未回复评论',
        description:
          '需开启自动回应；在已读取的主人作品范围内补看旧评论，已有发送记录的位置不重复发。',
        'x-hot': true,
      },
      'worlds.socialmedia.focus.autoReplyIntervalMinutes': {
        type: 'integer',
        title: 'B站新评论检查间隔（分钟）',
        minimum: 2,
        maximum: 60,
        description: '建议2—5分钟；定时检查，不是实时推送。',
        'x-hot': true,
      },
      'worlds.socialmedia.focus.enabled': {
        type: 'boolean',
        title: '优先关注主人作品与评论区',
        description: '由本地设置绑定；不会关注账号、点赞或替主人执行其他操作。',
        'x-hot': true,
      },
      'worlds.socialmedia.focus.account': {
        type: 'string',
        title: '主人账号（UID、主页链接或昵称）',
        description:
          '昵称重名时选择最早主动联系本bot的账号，并固定UID。没有联系记录就等待识别；UID和主页链接可直接确定。',
        'x-hot': true,
      },
      'worlds.socialmedia.focus.intervalMinutes': {
        type: 'integer',
        title: '关注检查间隔（分钟）',
        minimum: 10,
        maximum: 1440,
        'x-hot': true,
      },
      'worlds.socialmedia.focus.maxDailyActions': {
        type: 'integer',
        title: 'B站关注参与次数（旧设置）',
        minimum: 0,
        maximum: 30,
        description: '保留旧版配置兼容。已核实的主人作品评论区使用独立计数。',
        'x-hot': true,
      },
      'worlds.socialmedia.focus.maxVideos': {
        type: 'integer',
        title: '最近查看的作品数量',
        minimum: 1,
        maximum: 30,
        description: '只检查这个范围，未显示的历史作品不代表已经参与。',
        'x-hot': true,
      },
      'worlds.socialmedia.activeHours.enabled': { type: 'boolean', title: '限制自动社交的活跃时段', 'x-hot': true },
      'worlds.socialmedia.activeHours.start': { type: 'string', title: '活跃开始时间', 'x-hot': true },
      'worlds.socialmedia.activeHours.end': { type: 'string', title: '活跃结束时间', 'x-hot': true },
      'worlds.socialmedia.roaming.enabled': {
        type: 'boolean',
        title: '允许闲时自主看视频',
        description:
          '有空时提供阅读机会，由Persona自行选择视频和评论；不会强迫发言。停用后不再发起机会。',
        'x-hot': true,
      },
      ...Object.fromEntries(
        [
          [
            'maxDailySessions',
            '每日最多闲逛机会',
            1,
            20,
            '包括选择跳过的机会，避免反复唤醒；均衡参考8次。',
          ],
          [
            'maxVideosPerSession',
            '每轮最多视频',
            1,
            5,
            '均衡参考3条；重复读取同一视频不重复计数。',
          ],
          [
            'maxCommentsPerVideo',
            '每条视频最多读取评论',
            1,
            100,
            '包含楼中楼，总量合计；均衡参考40条。',
          ],
          [
            'maxCommentsPerSession',
            '每轮最多主动发言',
            0,
            10,
            '0为只看不说；独立评论和楼中楼接话合计，均衡参考1条。',
          ],
          [
            'maxDailyComments',
            '每日闲逛最多主动发言',
            0,
            100,
            '仅计算本轮编号下的主动评论和接楼；不占通知或主人直接要求的发言额度。0为只看不说，均衡参考24条。',
          ],
          ['minIntervalMinutes', '两轮最小间隔（分钟）', 10, 1440, '均衡参考60分钟，重启不清零。'],
          [
            'idleMinutes',
            '连续空闲多久再闲逛（分钟）',
            1,
            180,
            '主循环空闲，最近没有私聊或群聊时才考虑，均衡参考8分钟。',
          ],
          ['maxSessionMinutes', '每轮最长时间（分钟）', 5, 60, '超过后释放本轮，均衡参考30分钟。'],
          [
            'maxTextChars',
            '单视频字幕文字预算（字符）',
            2000,
            24000,
            '减少字幕挤占上下文，均衡参考10000字符。',
          ],
        ].map(([key, title, minimum, maximum, description]) => [
          'worlds.socialmedia.roaming.' + key,
          { type: 'integer', title, minimum, maximum, description, 'x-hot': true },
        ]),
      ),
      'worlds.socialmedia.platforms.douyin.enabled': {
        type: 'boolean',
        title: '启用抖音',
        description: '使用独立Edge读取视频和评论；不会读取日常浏览器账号。',
        'x-hot': true,
      },
      'worlds.socialmedia.platforms.douyin.posting.enabled': {
        type: 'boolean',
        title: '允许抖音公开发评（待登录验收）',
        description: '默认关闭；开启后复用发言整理、每日限额与发送回执，不代表公开可见性已验证。',
        'x-hot': true,
      },
      'worlds.socialmedia.platforms.douyin.posting.minIntervalSec': {
        type: 'integer',
        title: '抖音发布最小间隔（秒）',
        minimum: 30,
        maximum: 3600,
        'x-hot': true,
      },
      'worlds.socialmedia.platforms.douyin.posting.maxDailyComments': {
        type: 'integer',
        title: '抖音每日普通发布上限',
        minimum: 1,
        maximum: 200,
        'x-hot': true,
      },
      'worlds.socialmedia.douyinBrowser.executableFile': {
        type: 'string',
        title: '抖音浏览器程序',
        description: '留空优先使用Edge，再寻找Chrome；与B站设置独立。',
        'x-hot': true,
      },
      'worlds.socialmedia.douyinBrowser.pageWaitSeconds': {
        type: 'integer',
        title: '网页加载等待上限（秒）',
        description:
          '作品、评论区和指定楼层各阶段的等待上限。页面加载成功就继续；网络慢可以选更长的等待。',
        minimum: 15,
        maximum: 120,
        'x-hot': true,
      },
      'worlds.socialmedia.douyinBrowser.releaseAfterTask': {
        type: 'boolean',
        title: '抖音任务结束立即释放浏览器',
        description: '读取或回复结束后收回浏览器内存，保留登录。关闭可减少下次启动等待，浏览器会多驻留一段时间。',
        'x-hot': true,
      },
      'worlds.socialmedia.douyinBrowser.compatibilityWindow': {
        type: 'boolean',
        title: '兼容窗口模式（Windows）',
        description:
          '默认关闭。无窗口模式无法正常加载时可主动开启，并保留后台运行开关。使用普通Edge渲染，独立窗口放到屏幕外而非当前工作区；单独使用时可能出现Edge任务栏图标，可另开“隐藏兼容窗口（试验）”减少干扰。资源占用仍是完整浏览器。不会自动切换、代做验证或改变登录资料。非Windows不支持。',
        'x-hot': true,
      },
      'worlds.socialmedia.douyinBrowser.hideCompatibilityWindow': {
        type: 'boolean',
        title: '隐藏兼容窗口（试验）',
        description:
          '仅Windows兼容模式生效。隐藏本World的浏览器窗口与任务栏入口，保持普通浏览器渲染；辅助程序按需运行后退出，不额外常驻。启动瞬间仍可能短暂闪现图标。登录/验证窗口仍可见；失败回退原兼容方式，可关闭此项。',
        'x-hot': true,
      },
      'worlds.socialmedia.douyinBrowser.background': {
        type: 'boolean',
        title: '抖音浏览器后台运行',
        description:
          '默认无窗口后台运行，保留登录态和网页交互；官网可能单独要求后台会话人工验证，登录正常不等于推荐流可用。可在连接检查中测试推荐流；需验证时主动打开独立Edge。不会自动弹窗回退。',
        'x-hot': true,
      },
      'worlds.socialmedia.platforms.bilibili.enabled': {
        type: 'boolean',
        title: 'B站',
        description: '启用 B站的工具与连接。',
        'x-hot': true,
      },
      'worlds.socialmedia.platforms.bilibili.monitor.enabled': {
        type: 'boolean',
        title: '接收评论回复和 @通知',
        description: '首次连接只接收此后的通知；关闭时不唤醒模型。',
        'x-hot': true,
      },
      'worlds.socialmedia.platforms.bilibili.monitor.intervalSec': {
        type: 'integer',
        title: '通知检查间隔（秒）',
        description: '控制多久查看一次新回复和 @。频率越高，后台请求越多。',
        minimum: 30,
        maximum: 3600,
        'x-hot': true,
      },
      'worlds.socialmedia.platforms.bilibili.dynamics.enabled': {
        type: 'boolean',
        title: '允许读取B站动态（实验）',
        description:
          '通过独立官网登录态读取关注流、指定账号或动态正文；每次最多五条，只含可核实的文字和图片数量，不代表已观看图片。动态发布使用下方独立开关。',
        'x-hot': true,
      },
      'worlds.socialmedia.platforms.bilibili.dynamics.maxDailyReads': {
        type: 'integer',
        title: '每天最多读取动态次数',
        minimum: 1,
        maximum: 200,
        description: '默认20次，每次最多五条；失败尝试也计数，已读缓存不重复占次数，重启不清零。',
        'x-hot': true,
      },
      'worlds.socialmedia.platforms.bilibili.dynamics.allowPublishing': {
        type: 'boolean',
        title: '允许发布纯文字动态（实验）',
        description:
          '默认关闭；Bot先准备草稿，再从官网发布。每条最多500字，可选择@本地特别关注；不支持图片、转发、私信。用完立即关闭浏览器，结果不明不补发。',
        'x-hot': true,
      },
      'worlds.socialmedia.platforms.bilibili.dynamics.maxDailyPosts': {
        type: 'integer',
        title: '每天最多发布动态数',
        minimum: 1,
        maximum: 20,
        description:
          '默认3条；已受理和结果不明占额度，明确未提交的失败不消耗发布份额。重启不清零；与评论配额分开。',
        'x-hot': true,
      },
      'worlds.socialmedia.platforms.bilibili.dynamics.minIntervalSec': {
        type: 'integer',
        title: '动态发布最短间隔（秒）',
        minimum: 60,
        maximum: 86400,
        'x-hot': true,
      },
      'worlds.socialmedia.platforms.bilibili.dynamics.autonomousEnabled': {
        type: 'boolean',
        title: '空闲时主动发动态',
        description:
          '需同时允许发布动态。安静空闲时给Bot一次可放弃的创作机会，不照搬私聊和其他World的私密内容；不会强制发文。',
        'x-hot': true,
      },
      'worlds.socialmedia.platforms.bilibili.dynamics.autoMaxDaily': {
        type: 'integer',
        title: '每天最多主动动态数',
        minimum: 1,
        maximum: 20,
        description: '默认1条，仍受每日动态总量限制。',
        'x-hot': true,
      },
      'worlds.socialmedia.platforms.bilibili.dynamics.autoMinIntervalMinutes': {
        type: 'integer',
        title: '主动机会最短间隔（分钟）',
        minimum: 30,
        maximum: 1440,
        description: '默认360分钟；选择不发也会等待，避免反复打扰和唤醒。',
        'x-hot': true,
      },
      'worlds.socialmedia.platforms.bilibili.dynamics.autoIdleMinutes': {
        type: 'integer',
        title: '安静空闲多久再考虑（分钟）',
        minimum: 1,
        maximum: 240,
        description: '默认20分钟；有人聊天、有待回应评论或正在闲逛时先处理原来的事。',
        'x-hot': true,
      },
      'worlds.socialmedia.platforms.bilibili.dynamics.autoStartHour': {
        type: 'integer',
        title: '主动动态开始时段（小时）',
        minimum: 0,
        maximum: 23,
        description: '按Bot时区，默认9时；开始与结束相同表示全天。',
        'x-hot': true,
      },
      'worlds.socialmedia.platforms.bilibili.dynamics.autoEndHour': {
        type: 'integer',
        title: '主动动态结束时段（小时）',
        minimum: 0,
        maximum: 23,
        description: '按Bot时区，默认23时；支持跨午夜。',
        'x-hot': true,
      },
      'worlds.socialmedia.focus.allowMentions': {
        type: 'boolean',
        title: '允许主动 @ B站特别关注（接口实验）',
        description:
          '默认关闭；仅在Bot明确选择时@本地已绑定的主人，视频评论须显式选择接口；纯文字动态使用官网原生@选择器。普通网页评论不自动改走接口，也不会每条都@。',
        'x-hot': true,
      },
      'worlds.socialmedia.focus.maxDailyMentions': {
        type: 'integer',
        title: '每天最多主动 @ 特别关注次数',
        minimum: 1,
        maximum: 20,
        description: '独立于主人评论自动回应的上限；发送间隔、防重和普通发布额度仍生效。默认3次。',
        'x-hot': true,
      },
      'worlds.socialmedia.platforms.bilibili.posting.enabled': {
        type: 'boolean',
        title: '允许公开发布评论',
        description: '开启后，Persona 可自行决定回复或发评论，所有人都可能看到。',
        'x-hot': true,
      },
      'worlds.socialmedia.platforms.bilibili.posting.transport': {
        type: 'string',
        enum: ['browser', 'api'],
        title: '评论发送方式',
        description:
          'browser 使用官网评论框；api 是可选的接口实验路径，支持显式@本地特别关注。接口发评并非必然仅自己可见，但两种方式的受理都不保证公开；失败不自动切换或重发。',
        'x-hot': true,
      },
      'worlds.socialmedia.browser.background': {
        type: 'boolean',
        title: '后台运行发评浏览器',
        description:
          '默认不显示浏览器窗口；仍通过官方网页评论框发送。关闭后以最小化窗口运行，便于排查页面问题。',
        'x-hot': true,
      },
      'worlds.socialmedia.browser.executableFile': {
        type: 'string',
        title: '网页发评浏览器程序',
        description:
          '留空自动寻找本机Chrome或Edge。登录资料独立保存在本部署，不接触日常浏览器。无需开启远程调试或Browser World。',
        'x-hot': true,
      },
      'worlds.socialmedia.platforms.bilibili.posting.minIntervalSec': {
        type: 'integer',
        title: '两次发布的最小间隔（秒）',
        minimum: 0,
        maximum: 3600,
        'x-hot': true,
      },
      'worlds.socialmedia.platforms.bilibili.posting.maxDailyComments': {
        type: 'integer',
        title: '每日最多普通发布评论',
        minimum: 1,
        maximum: 1000,
        'x-hot': true,
      },
      'worlds.socialmedia.platforms.bilibili.posting.maxDailyReplies': {
        type: 'integer',
        title: '每日最多回应通知',
        minimum: 0,
        maximum: 300,
        description:
          '收到回复和@的独立额度，不占闲逛主动发言额度；普通回复仍计入普通发布上限；已核实的主人作品评论区单独计数。普通渠道同一人每天最多五条（B站绑定主人在其他作品下的通知可单独调高），跨视频累计，重启不重置。',
        'x-hot': true,
      },
      'worlds.socialmedia.media.textFirst': {
        type: 'boolean',
        title: '默认优先读文字与评论',
        description: '不要求每个视频抽帧；回应原评论时先读上文，涉及画面或主动评价作品时按需采样。',
        'x-hot': true,
      },
      'worlds.socialmedia.media.maxDailyVisualCalls': {
        type: 'integer',
        title: '每天最多看几次',
        minimum: 0,
        maximum: 200,
        description: '各站分别计数。选择限额的站点使用此上限。一次抽帧或翻一批图算一次。设为 0 关闭全部画面。',
        'x-hot': true,
      },
      'worlds.socialmedia.media.unlimitedDailyVisualCalls': {
        type: 'boolean',
        title: '取消每日画面次数上限',
        description: '沿用全局设置的平台每日画面观察不限次数，图片输入和本机取图开销可能增加。各平台的发评额度单独计算。单次张数、单张体积与累计交付限制仍生效。次数设为 0 仍会关闭画面。',
        'x-hot': true,
      },
      'worlds.socialmedia.media.maxImageKB': {
        type: 'integer',
        title: '单张图片大小上限（KB）',
        description: '影响送给模型的单张图片体积。压缩太多时，分镜里的小字更难读。',
        minimum: 64,
        maximum: 2048,
        'x-hot': true,
      },
      'worlds.socialmedia.media.maxPublishedMediaMB': {
        type: 'integer',
        title: '累计图片交付预算（MB）',
        minimum: 1,
        maximum: 16384,
        description:
          '自资源记录启用后，保守累计交给Cortico的新图片字节，达到后继续文字交流。缓存清理不重置；不是宿主附件库实际用量。',
        'x-hot': true,
      },
      'worlds.socialmedia.media.cacheDays': {
        type: 'integer',
        title: '图片缓存保留天数',
        description: '期间回看同一画面可以复用本地图片，减少重复下载和抽帧。',
        minimum: 1,
        maximum: 30,
        'x-hot': true,
      },
      'worlds.socialmedia.media.maxCacheMB': {
        type: 'integer',
        title: '图片缓存容量上限（MB）',
        description: '空间用完会淘汰旧缓存。常回看的作品多，可以留更大空间。',
        minimum: 1,
        maximum: 1024,
        'x-hot': true,
      },
      'worlds.socialmedia.media.browserCacheMB': {
        type: 'integer',
        title: '浏览器网络缓存参考上限（MB）',
        minimum: 16,
        maximum: 512,
        description: '交给浏览器控制缓存，不是整个登录资料目录的硬上限。清理网络缓存保留登录。',
        'x-hot': true,
      },
      'worlds.socialmedia.media.historyDays': {
        type: 'integer',
        title: '近期详细发言保留天数',
        description: '决定详细发言在近期区停留多久。更早的记录会移到归档。',
        minimum: 2,
        maximum: 365,
        'x-hot': true,
      },
      'worlds.socialmedia.media.maxRecentSends': {
        type: 'integer',
        title: '近期详细发言参考条数',
        minimum: 100,
        maximum: 10000,
        description: '更早记录完整归档；最近48小时、待处理和结果不明记录继续留在近期区。',
        'x-hot': true,
      },
      'worlds.socialmedia.media.maxArchiveMB': {
        type: 'integer',
        title: '历史归档空间预算（MB）',
        minimum: 16,
        maximum: 4096,
        description: '达到预算后停止新增公开发言，保留历史和防重凭据；可提高预算继续。',
        'x-hot': true,
      },
      'worlds.socialmedia.media.ffmpegFile': {
        type: 'string',
        title: 'FFmpeg 程序',
        description: 'B站视频抽帧需要 FFmpeg，可填可执行文件路径或 PATH 中的 ffmpeg。留空时抖音仍可通过网页取图或抽帧，多帧返回为独立图片。',
        'x-hot': true,
      },
      'worlds.socialmedia.media.maxVideoFrames': {
        type: 'integer',
        title: '每次最多抽几帧视频',
        description: '按观察时段自动决定帧数，短片少取，较长视频多取。最多 9 帧可拼成一张，更多会分成两张。',
        minimum: 1,
        maximum: MAX_VIDEO_FRAMES,
        'x-hot': true,
      },
      'worlds.socialmedia.media.maxFrames': {
        type: 'integer',
        title: '每批最多看几张图文',
        description: '一次送给模型的图文张数。多图长帖可以继续翻下一批。',
        minimum: 1,
        maximum: 6,
        'x-hot': true,
      },
    },
  },
};

/** Preserve persisted Bilibili settings without a shadowing platform default. */
export function focusConfig(cfg: SocialMediaConfigSection, platform: string): FocusConfig {
  return platform === 'bilibili'
    ? cfg.focus
    : (cfg.platforms[platform]?.focus ?? {
        enabled: false,
        account: '',
        intervalMinutes: 30,
        maxDailyActions: 8,
        maxVideos: 12,
      });
}

// Local overrides inherit the shared policy until a platform is customized.
SOCIALMEDIA_CONFIG_GROUP.schema.properties['worlds.socialmedia.roaming.mode'] = {
  type: 'string',
  title: '闲逛模式',
  enum: ['bounded', 'free'],
  description: '放养不限制阅读轮数与数量；等待、公开发言额度和资源保护仍生效。',
  'x-hot': true,
};
for (const id of ROAMING_PLATFORMS) {
  const label = { bilibili: 'B站', douyin: '抖音', ...PUBLIC_POST_NAMES }[id];
  const path = 'worlds.socialmedia.platforms.' + id + '.';
  SOCIALMEDIA_CONFIG_GROUP.schema.properties[path + 'visualDaily'] = {
    type: 'string', enum: ['inherit', 'bounded', 'unlimited'], title: label + '每日画面次数',
    description: '按本站独立计数。不限次数仍使用每次取图、图片大小及总交付限制。', 'x-hot': true,
  };
  SOCIALMEDIA_CONFIG_GROUP.schema.properties[path + 'corpusWeight'] = {
    type: 'string', enum: ['off', 'light', 'medium', 'strong'], title: label + '语料学习权重',
    description: '决定本站经验被参考的优先级。关闭后停止学习和参考，已存素材可继续管理。', 'x-hot': true,
  };
  for (const [path, prop] of Object.entries(SOCIALMEDIA_CONFIG_GROUP.schema.properties).filter(
    ([key]) => key.startsWith('worlds.socialmedia.roaming.'),
  )) {
    const key = path.slice('worlds.socialmedia.roaming.'.length);
    SOCIALMEDIA_CONFIG_GROUP.schema.properties[
      'worlds.socialmedia.platforms.' + id + '.roaming.' + key
    ] = { ...prop, title: label + '闲逛 · ' + prop.title };
  }
}

for (const id of POST_PLATFORMS) {
  const key = 'worlds.socialmedia.platforms.' + id + '.';
  const label = PUBLIC_POST_NAMES[id];
  Object.assign(SOCIALMEDIA_CONFIG_GROUP.schema.properties, {
    [key + 'enabled']: { type: 'boolean', title: '启用' + label, 'x-hot': true },
    [key + 'posting.enabled']: { type: 'boolean', title: '允许' + label + '公开发言', 'x-hot': true },
    ...(id === 'xiaohongshu' ? {
      [key + 'focus.autoReplyIntervalMinutes']: {
        type: 'integer', title: '小红书新评论检查间隔（分钟）', minimum: 2, maximum: 60,
        description: '默认 5 分钟。主人评论区单独检查，普通闲逛关闭也可以回应。', 'x-hot': true,
      },
      [key + 'focus.replyExistingComments']: {
        type: 'boolean', title: '也考虑小红书主人作品已有的评论',
        description: '开启后按现有视野和发言额度分批处理旧评论。默认只处理新评论。',
        'x-hot': true,
      },
      [key + 'posting.allowTopLevelComments']: {
        type: 'boolean', title: '允许在主人小红书作品下新发评论',
        description: '需同时开启公开发言，并核实作品作者与特别关注绑定一致。每条作品至多一条主动评论。',
        'x-hot': true,
      },
    } : {}),
    [key + 'postVisual']: { type: 'string', title: label + '画面档位', enum: ['low', 'medium', 'high'], 'x-hot': true },
    [key + 'focus.account']: { type: 'string', title: label + '主人官网主页', 'x-hot': true },
    [key + 'focus.enabled']: { type: 'boolean', title: label + '特别关注', 'x-hot': true },
    [key + 'focus.autoReplyNewComments']: { type: 'boolean', title: label + '回应主人作品下的新评论', 'x-hot': true },
  });
}

for (const [key, prop] of Object.entries({
  enabled: { type: 'boolean', title: '监听指定抖音群' },
  activity: {
    type: 'string',
    title: '群聊活跃度',
    enum: ['quiet', 'balanced', 'active'] as string[],
    description: '安静优先接直接提及，均衡也会挑合适的普通话题，活跃更容易接到提问或闲聊。',
  },
  proactiveEnabled: {
    type: 'boolean',
    title: '空闲时主动开启群话题',
    description: '默认关闭；9至23点、安静空闲且没有待办时给一次可放弃的机会，不强制发送。',
  },
  proactiveIntervalMinutes: {
    type: 'integer',
    title: '主动群话题最小间隔（分钟）',
    description: '控制同一个群连续收到主动开话题机会的频率。',
    minimum: 30,
    maximum: 1440,
  },
  proactiveMaxDaily: { type: 'integer', title: '每群每日主动话题机会', minimum: 0, maximum: 10 },
  proactiveIdleMinutes: {
    type: 'integer',
    title: '主动群话题前安静空闲（分钟）',
    description: '群里安静了多久，才考虑主动开一个话题。',
    minimum: 5,
    maximum: 180,
  },
  allowSend: {
    type: 'boolean',
    title: '允许在这些群自然接话',
    description: '与评论发布开关独立；只对本地名单中的群生效。',
  },
  groups: {
    type: 'string',
    title: '监听群（群号|准确群名）',
    description:
      '例如 123456789|我的群；多个群以分号分隔，最多十个。首次保存后点检查，固定真实会话。',
  },
  intervalSec: { type: 'integer', title: '群消息检查间隔（秒）', description: '越短越早看到新消息，后台网页读取也更频繁。', minimum: 30, maximum: 600 },
  minIntervalSec: { type: 'integer', title: '群发言最小间隔（秒）', description: '拉长两次群发言之间的间隔。', minimum: 10, maximum: 600 },
  maxDailyMessages: { type: 'integer', title: '每日群发言上限', description: '约束 Bot 一天最多在群里发多少条。', minimum: 1, maximum: 500 },
} as const))
  SOCIALMEDIA_CONFIG_GROUP.schema.properties['worlds.socialmedia.platforms.douyin.chat.' + key] = {
    ...prop,
    'x-hot': true,
  };

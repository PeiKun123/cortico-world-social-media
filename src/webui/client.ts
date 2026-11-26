import { POST_PLATFORMS, PUBLIC_POST_NAMES, isPublicPostPlatform, type PublicPostPlatform } from '../public-post-policy.ts';
import { expressionSettings, type PublicPlatformSettings } from './expression.ts';
import type { DouyinFailure, DouyinVerification } from '../platforms/douyin.ts';
import type { GroupChats } from '../group-chat.ts';
import type { DynamicPost } from '../dynamic-publishing.ts';
import type { PublicDynamic } from '../platforms/bilibili-dynamics.ts';
import { focusView, focusStatus, type FocusSnapshot } from './focus.ts';
import {
  buildInteractions,
  filterInteractions,
  safeBiliLink,
  type InteractionFilter,
} from '../interactions.ts';
import {
  DEFAULT_ACTIVE_HOURS,
  ROAMING_PLATFORMS,
  ROAMING_PRESETS,
  roamingConfig,
  SOCIALMEDIA_CONFIG_GROUP,
  type SocialMediaConfigSection,
  type RoamingConfig,
} from '../config.ts';
import { RESOURCE_DEFAULTS } from '../resource-policy.ts';
import type { RoamSession } from '../roaming.ts';
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { InboxItem, SendRecord, PublicVideo, PublicComment } from '../platform.ts';
import './style.css';
interface Snapshot {
  activeHours?: { open: boolean; timezone: string };
  recordsRevision?: string;
  dynamics?: {
    enabled: boolean;
    allowPublishing?: boolean;
    posts?: DynamicPost[];
    readsToday: number;
    limit: number;
    items: PublicDynamic[];
  };
  groupChat?: ReturnType<GroupChats['status']> & { error?: string };
  resources?: {
    todayCalls: number;
    byPlatform?: Record<string, number>;
    maxDailyVisualCalls: number;
    unlimitedDailyVisualCalls?: boolean;
    publishedBytes: number;
    maxPublishedBytes: number;
    cacheBytes: number;
    cacheEntries: number;
    cacheDays: number;
    history: {
      count: number;
      sent: number;
      bytes: number;
      recent: number;
      maxArchiveBytes: number;
    };
  };
  publicPlatforms?: PublicPlatformSettings;
  focus?: FocusSnapshot;
  focusPlatforms?: Record<string, FocusSnapshot>;
  config?: SocialMediaConfigSection;
  videos?: PublicVideo[];
  comments?: PublicComment[];
  stats?: { sent: number; unconfirmed: number };
  douyin?: {
    running: boolean;
    loginOpen: boolean;
    detail: string;
    lastFailure?: DouyinFailure;
    windowHiding?: { enabled: boolean; state: string; active: boolean; detail?: string };
    verification?: DouyinVerification;
  };
  credentialSaved: boolean;
  publishing?: {
    transport: string;
    browser: {
      available: boolean;
      running: boolean;
      ready?: boolean;
      detail?: string;
      checkedAt?: string;
    };
  };
  roaming?: {
    idleSeconds?: number;
    idle?: boolean;
    enabled: boolean;
    usedToday: number;
    limits: RoamingConfig;
    recent: RoamSession[];
    platforms?: Record<string, { limits: RoamingConfig; usedToday: number }>;
  };
  lastError?: string;
  pending: number;
  unknown: number;
  platforms: Array<{
    id: string;
    enabled: boolean;
    monitor: boolean;
    posting: boolean;
    account?: { id: string; name: string };
    error?: string;
    lastPollAt?: string;
    publishing?: { ownerCommentsToday: number | null };
  }>;
  inbox: InboxItem[];
  outbox: SendRecord[];
}
interface CommentReadProof {
  accountId?: string;
  at: string;
  commentCount: number;
}
export function connectionEvidence(state: Snapshot, platform: string, read?: CommentReadProof) {
  const account = state.platforms.find((p) => p.id === platform)?.account?.id;
  const own = account
    ? state.outbox.filter(
        (r) =>
          r.platform === platform && r.accountId === account && r.status === 'sent' && r.receiptId,
      )
    : [];
  const comment = own.find((r) => r.target.root === '0'),
    reply = own.find((r) => r.target.root !== '0'),
    visible = own.find((r) => r.visibility?.status === 'public');
  const received = account
    ? state.inbox.filter((i) => i.platform === platform && i.accountId === account)
    : [];
  const proof = read?.accountId === account ? read : undefined;
  const stamp = (at?: string) => (at ? '最近记录 ' + prettyTime(at) : '');
  const p = state.platforms.find((p) => p.id === platform);
  const rows = [
    {
      key: 'account',
      label: '登录账号',
      state: p?.error ? 'attention' : account ? 'confirmed' : 'pending',
      value: p?.error ? '需要检查' : account ? '账号已核对' : '尚未核对',
      detail: p?.error ?? p?.account?.name ?? '登录后检查；已登录不代表所有读写都已通过。',
    },
    {
      key: 'read',
      label: '评论读取',
      state: proof?.commentCount || received.length ? 'confirmed' : 'pending',
      value: proof?.commentCount
        ? '已读到评论'
        : received.length
          ? '有评论通知记录'
          : proof
            ? '页面已读 · 暂无评论'
            : '尚未验证',
      detail: proof
        ? stamp(proof.at) + ' · ' + proof.commentCount + '条评论'
        : received.length
          ? '依据当前账号收到的评论通知，当前连接仍以检查结果为准。'
          : '抖音可填作品链接测试；B站可先同步评论通知。',
    },
    {
      key: 'comment',
      label: '主评论发送',
      state: comment ? 'confirmed' : 'pending',
      value: comment ? '平台已受理' : '尚无成功记录',
      detail: comment
        ? stamp(comment.createdAt) + '；不等于其他账号可见。'
        : '不会为检查自动公开发评。正常发送后显示结果。',
    },
    {
      key: 'reply',
      label: '回复评论',
      state: reply ? 'confirmed' : 'pending',
      value: reply ? '回复已受理' : '尚无回复成功记录',
      detail: reply
        ? stamp(reply.createdAt) + '；回复和主评论分别判断。'
        : '需要实际楼层回复的成功回执，仅有主评论不算。',
    },
    {
      key: 'visibility',
      label: '他人可见',
      state: visible ? 'confirmed' : 'pending',
      value: visible ? '有公开核验记录' : '尚未验证',
      detail: visible
        ? stamp(visible.visibility?.checkedAt) + '；仅代表当时这条评论。'
        : '平台受理不等于公开。请用其他账号查看原评论，不要反复重发。',
    },
  ];
  if (platform === 'bilibili') {
    const posts = account
      ? (state.dynamics?.posts ?? []).filter(
          (p) => p.accountId === account && p.status === 'sent' && p.dynamicId,
        )
      : [];
    const post = posts[0],
      mention = own.find((r) => r.mention) || posts.find((p) => p.mention);
    rows.push(
      {
        key: 'dynamic',
        label: '发布动态',
        state: post ? 'confirmed' : 'pending',
        value: post ? '动态已受理' : '尚无发布成功记录',
        detail: post
          ? stamp(post.attemptedAt ?? post.createdAt) + '；公开状态需从其他账号核对。'
          : '先开启动态发布；读取动态或开启开关不等于发布已验证。',
      },
      {
        key: 'mention',
        label: '@特别关注',
        state: mention ? 'confirmed' : 'pending',
        value: mention ? '已提交含@内容' : '尚未验证',
        detail: mention
          ? '已有带@内容的成功回执；对方是否收到通知仍未验证。'
          : '先绑定主人并开启允许主动@。动态内原生@与评论接口@路径不同。',
      },
    );
  }
  return rows;
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
function prettyTime(value: string | number) {
  return new Date(value).toLocaleString();
}
export function mount(ctx: WebUiPanelContext, settingsMode = false) {
  const root = ctx.root;
  const saveConfig = async (_group: string, values: Record<string, unknown>) => {
    const result = await ctx.invoke<{ message: string }>('settings', [values]);
    feedback.textContent = result.message ?? '已保存，即时生效';
    feedback.hidden = false;
  };
  const feedback = el('p', '', 'sm-feedback');
  feedback.hidden = true;
  feedback.setAttribute('role', 'status');
  const expanded = new Set<string>(ctx.memo?.get<string[]>('expanded-videos', []) ?? []);
  function scrollHost(): HTMLElement {
    let n = root.parentElement;
    while (n) {
      if (/(auto|scroll)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight)
        return n;
      n = n.parentElement;
    }
    return (document.scrollingElement ?? document.documentElement) as HTMLElement;
  }
  root.classList.add('socialmedia-desk');
  let evidenceSnapshot: Snapshot | undefined;
  const readProofs = new Map<string, CommentReadProof>(
    Object.entries(ctx.memo?.get<Record<string, CommentReadProof>>('read-checks', {}) ?? {}),
  );
  const evidenceViews = new Map<string, { summary: HTMLElement; body: HTMLDListElement }>();
  function usageChecks(id: string) {
    const box = fold('使用检查', 'sm-subsection sm-readiness');
    box.dataset.platform = id;
    const count = el('span', '', 'sm-fold-status'),
      body = el('dl');
    box.querySelector('summary')!.append(count);
    box.append(
      body,
      el(
        'p',
        '依据当前账号的检查与历史回执显示。“已受理”不代表公开或通知已送达；这里不会自动发送测试内容。',
        'sm-muted',
      ),
    );
    evidenceViews.set(id, { summary: count, body });
    return box;
  }
  function loginGuide(id: string) {
    const box = fold('登录、验证码与验证结果', 'sm-subsection sm-setup-guide'),
      list = el('ol');
    const steps =
      id === 'bilibili'
        ? [
            '扫码登录后在手机确认；App不兼容时，可用“打开B站登录窗口”在官网完成登录。',
            '官网要求滑块、验证码或安全检查时，请在登录窗口手动完成，再点“完成B站网页登录”并检查登录。不要把验证码或Cookie发给Bot。',
            '“检查网页发评”只检查网页和评论框，不会真实发送。“立即同步”读取评论通知，不代表已经回复。',
            '动态发布和主动@的开关只是授权。实际发送后才有回执；公开可见与@通知送达还需单独核对。',
          ]
        : [
            '点击“打开登录／验证窗口”，在独立 Edge 登录。',
            '在官网手动完成验证后，回到这里点“完成登录并检查后台”。',
            '在“读取与连接检查”检查推荐流，或填作品链接测试评论。后台遇到验证时可在连接选项中使用兼容窗口模式。',
            '读取检查不会公开发送。正常发评后查看回执；结果未知时不要重复提交，先去原作品或其他账号核对。',
          ];
    for (const step of steps) list.append(el('li', step));
    box.append(list);
    return box;
  }
  function renderEvidence(state: Snapshot) {
    evidenceSnapshot = state;
    for (const [id, view] of evidenceViews) {
      const rows = connectionEvidence(state, id, readProofs.get(id));
      view.summary.textContent =
        rows.filter((r) => r.state === 'confirmed').length + '项已有结果 / ' + rows.length + '项';
      view.body.replaceChildren();
      for (const row of rows) {
        const term = el('dt', row.label),
          value = el('dd');
        value.dataset.state = row.state;
        value.append(el('span', row.value, 'sm-evidence-value'), el('small', row.detail));
        view.body.append(term, value);
      }
    }
  }

  function fold(title: string, cls = 'sm-subsection') {
    const details = el('details', undefined, cls);
    details.append(el('summary', title));
    return details;
  }
  const header = el('header', undefined, 'sm-tv-heading');
  const headingText = el('div');
  headingText.append(el('h2', '小鲸鱼爱冲浪'), el('p', settingsMode ? '平台与画面设置' : '互动记录', 'sm-muted'));
  const idleClock = el('div', undefined, 'sm-idle-clock');
  const clockLabel = el('span', '本轮空闲时长', 'sm-clock-label');
  const clockValue = el('strong', '等待同步', 'sm-clock-value');
  clockValue.setAttribute('role', 'timer');
  clockValue.setAttribute('aria-label', '本轮空闲时长');
  idleClock.append(clockLabel, clockValue);
  header.append(headingText, idleClock);
  let idleSample: { seconds: number; at: number; idle: boolean } | undefined;
  function updateIdleClock() {
    const age = idleSample ? Math.max(0, Math.floor((Date.now() - idleSample.at) / 1000)) : 0;
    const state = !idleSample || age > 30 ? 'waiting' : idleSample.idle ? 'idle' : 'busy';
    idleClock.dataset.state = state;
    const seconds = (idleSample?.seconds ?? 0) + age;
    const display = state === 'idle'
      ? [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
        .map(v => String(v).padStart(2, '0')).join(':')
      : state === 'busy' ? '忙碌中' : '等待同步';
    if (clockValue.textContent !== display) clockValue.textContent = display;
  }
  ctx.interval(updateIdleClock, 1000);
  const capabilities = fold('平台能力与限制 · B站 / 抖音 / 小红书 / 贴吧', 'sm-subsection sm-capabilities');
  capabilities.append(
    el(
      'p',
      '各平台的能力不同。展开查看当前支持范围；开启平台或发布权限不会解锁尚未接入的功能。',
      'sm-muted',
    ),
  );
  for (const [id, title, rows] of [
    [
      'bilibili',
      '哔哩哔哩',
      [
        ['可用', '视频详情、评论与楼中楼；可用字幕、可选画面采样；回复及@通知、特别关注与闲逛。'],
        [
          '边界',
          '动态读取、纯文字动态发布和主动 @ 为实验功能。发布回执、访客可见和 @ 通知送达需分别核对。画面采样另需 FFmpeg。',
        ],
      ],
    ],
    [
      'douyin',
      '抖音',
      [
        [
          '可用',
          '官网可访问的视频、图文与评论；精确楼中楼回复、推荐流闲逛、特别关注；本地指定群的监听与发言。',
        ],
        ['边界', '完整字幕、全站回复及@通知未接入。群聊须单独启用并核对目标；不是监听所有群。'],
      ],
    ],
    ...(['xiaohongshu', 'tieba'] as const).map(id => [
      id,
      id === 'xiaohongshu' ? '小红书' : '百度贴吧 · 实验',
      [
        ['可用', '登录绑定后可自动刷帖、浏览主人作品，以及读取官网可见的正文和评论。'],
        ['边界', id === 'xiaohongshu' ? '易风控：已有用户反馈账号被限制发言。公开评论和回复可能受限，可只开启浏览。' : '部分作品或功能会受登录、验证和官网页面影响。评论回复需单独授权。'],
      ],
    ] as const),
  ] as const) {
    const section = el('article', undefined, 'sm-platform sm-capability-platform');
    section.dataset.platform = id;
    const list = el('dl');
    for (const [label, description] of rows) list.append(el('dt', label), el('dd', description));
    section.append(el('h3', title), list);
    capabilities.append(section);
  }
  capabilities.append(
    el(
      'p',
      '使用须知：各平台分别登录、设置特别关注并授权发评。新评论采用有限范围轮询，不是全量实时推送；返回评论编号只代表平台受理，不保证其他账号可见。浏览器后台模式仍会占用资源；抖音默认任务结束立即释放，登录资料保留。',
      'sm-muted',
    ),
  );
  const alert = el('p', '', 'sm-alert');
  alert.setAttribute('role', 'status');
  alert.setAttribute('aria-live', 'polite');
  alert.hidden = true;
  const summary = el('p', '正在读取连接状态…', 'sm-summary');
  const controls = el('div', undefined, 'sm-controls');
  function toggle(label: string, key: string) {
    const wrap = el('label', undefined, 'sm-toggle');
    const input = el('input');
    input.type = 'checkbox';
    input.addEventListener(
      'change',
      () =>
        void perform(async () => {
          await saveConfig('world:socialmedia', { [key]: input.checked });
          await refresh();
        }),
      { signal: ctx.signal },
    );
    wrap.append(input, document.createTextNode(label));
    controls.append(wrap);
    return input;
  }
  const enabled = toggle('启用 B站', 'worlds.socialmedia.platforms.bilibili.enabled');
  const monitor = toggle('接收评论通知', 'worlds.socialmedia.platforms.bilibili.monitor.enabled');
  const posting = toggle('允许公开发评论', 'worlds.socialmedia.platforms.bilibili.posting.enabled');
  const roamingEnabled = toggle('允许空闲时闲逛（全部平台）', 'worlds.socialmedia.roaming.enabled');
  const hint = el('p', '允许发评论后，Bot可自行决定回应；内容会发布到B站。', 'sm-muted');
  const accountSection = el('section', undefined, 'sm-config-section sm-platform-card');
  accountSection.dataset.platform = 'bilibili';
  const connectionSummary = el('p', '正在读取连接状态…', 'sm-summary');
  accountSection.append(el('h3', '哔哩哔哩 · 账号与交流'), connectionSummary, controls, hint);
  const connectionResults = el('div', undefined, 'sm-connection-results');
  connectionResults.setAttribute('aria-label', '连接检查结果');
  connectionResults.setAttribute('aria-live', 'polite');
  const diagnosticRows = new Map<string, HTMLParagraphElement>();
  function diagnosticButton(
    label: string,
    working: string,
    action: () => Promise<{ detail: string; status?: string }>,
  ) {
    const row = el('p');
    row.hidden = true;
    row.setAttribute('role', 'status');
    diagnosticRows.set(label, row);
    connectionResults.append(row);
    const b = button(label, async () => {
      row.hidden = false;
      row.dataset.state = 'checking';
      row.textContent = label + ' · ' + working;
      b.textContent = label + '…';
      b.setAttribute('aria-busy', 'true');
      try {
        const result = await action();
        if (!ctx.signal.aborted) {
          row.dataset.state = result.status ?? 'success';
          row.textContent = label + ' · ' + result.detail + ' · ' + new Date().toLocaleTimeString();
        }
      } catch (e) {
        if (!ctx.signal.aborted) {
          row.dataset.state = 'error';
          row.textContent =
            label + ' · ' + (e instanceof Error ? e.message : '检查未完成，请稍后重试');
        }
      } finally {
        b.textContent = label;
        b.removeAttribute('aria-busy');
      }
    });
    return b;
  }
  const toolbar = el('div', undefined, 'sm-toolbar');
  function button(label: string, action: () => Promise<void>, parent: HTMLElement = toolbar) {
    const b = el('button', label);
    b.type = 'button';
    b.addEventListener('click', () => void perform(action, b), { signal: ctx.signal });
    parent.append(b);
    return b;
  }
  const loginBox = el('section', undefined, 'sm-login');
  loginBox.hidden = true;
  const qrImage = el('img');
  qrImage.alt = '使用哔哩哔哩手机客户端扫码登录';
  qrImage.width = 220;
  qrImage.height = 220;
  const qrHint = el('p', '请用 B站 App 扫码，并在手机上确认。');
  loginBox.append(qrImage, qrHint);
  let qrActive = false;
  let qrPolling = false;
  let refreshing = false;
  button('扫码登录', async () => {
    const q = await ctx.invoke<{ image: string }>('login');
    if (!q.image.startsWith('data:image/png;base64,')) throw new Error('二维码格式异常');
    qrImage.src = q.image;
    loginBox.hidden = false;
    qrHint.textContent = '请用 B站 App 扫码，并在手机上确认。';
    qrActive = true;
  });
  diagnosticButton('检查登录', '正在核对登录…', async () => {
    const account = await ctx.invoke<{ id: string; name: string }>('connect');
    await refresh();
    return { detail: '登录有效 · ' + account.name + '（UID ' + account.id + '）' };
  });
  const browserDiagnostic = diagnosticButton(
    '检查网页发评',
    '正在打开官方页面并检查评论框，最多约60秒；不会发送评论…',
    async () => {
      const result = await ctx.invoke<{ detail: string }>('browserCheck');
      await refresh();
      return result;
    },
  );
  diagnosticButton('立即同步', '正在读取评论通知…', async () => {
    const result = await ctx.invoke<{ operation: { status: string; detail: string } }>('sync');
    await refresh();
    return result.operation;
  });
  const logoutButton = button('退出登录', async () => {
    await ctx.invoke('logout');
    qrActive = false;
    loginBox.hidden = true;
    await refresh();
  });
  const credentials = el('details');
  credentials.append(el('summary', '已有登录 Cookie（可选）'));
  const secret = el('textarea');
  secret.setAttribute('aria-label', 'B站登录 Cookie');
  secret.autocomplete = 'off';
  secret.spellcheck = false;
  secret.placeholder = '仅在本机保存，不会进入模型上下文';
  credentials.append(secret);
  button(
    '保存并检查',
    async () => {
      const value = secret.value;
      secret.value = '';
      await ctx.invoke('cookie', [value]);
      await refresh();
    },
    credentials,
  );
  credentials.append(
    el('p', '优先使用扫码登录。Cookie 等同账号凭证，不要发到聊天或截图里。', 'sm-muted'),
  );
  const roamSection = el('section', undefined, 'sm-roaming sm-roaming-master');
  const roamSummary = el('p', '', 'sm-muted');
  roamSummary.setAttribute('aria-live', 'polite');
  const roamPlatformStates = el('div', undefined, 'sm-roaming-states');
  const roundCounts = fold('各平台今日轮次');
  roundCounts.append(roamPlatformStates);
  roamSection.append(
    el('h3', '闲逛总开关'),
    roamingEnabled.parentElement!,
    roamSummary,
    roundCounts,
  );
  const hoursBox = fold('全平台活跃时段', 'sm-subsection sm-active-hours');
  const hoursBadge = el('span', '', 'sm-fold-status');
  hoursBox.querySelector('summary')!.append(hoursBadge);
  const hoursLabel = el('label', undefined, 'sm-toggle');
  const hoursOn = el('input');
  hoursOn.type = 'checkbox';
  hoursLabel.append(hoursOn, document.createTextNode('限制自动社交时段'));
  const hoursStatus = el('p', '', 'sm-muted');
  const hoursFields = el('div', undefined, 'sm-hours-fields');
  function clockInput(label: string) {
    const field = el('label', label);
    const input = el('input');
    input.type = 'time';
    field.append(input);
    hoursFields.append(field);
    return input;
  }
  const startTime = clockInput('开始');
  const endTime = clockInput('结束');
  const hoursSave = button('保存时段', async () => {
    if (!startTime.value || !endTime.value) throw Error('请填写开始和结束时间。');
    await saveConfig('world:socialmedia', {
      'worlds.socialmedia.activeHours.enabled': hoursOn.checked,
      'worlds.socialmedia.activeHours.start': startTime.value,
      'worlds.socialmedia.activeHours.end': endTime.value,
    });
    hoursDirty = false;
    await refresh();
  }, hoursBox);
  let hoursDirty = false;
  function hoursEdited() {
    hoursDirty = true;
    hoursSave.disabled = false;
    hoursFields.hidden = !hoursOn.checked;
  }
  hoursOn.addEventListener('change', hoursEdited, { signal: ctx.signal });
  for (const input of [startTime, endTime]) input.addEventListener('input', hoursEdited, { signal: ctx.signal });
  hoursSave.before(hoursLabel, hoursStatus, hoursFields);
  hoursBox.append(el('small', '支持跨午夜，起止相同表示全天。休息时保留评论待办，暂停新的闲逛、群聊通知和主动动态。'));
  function browserPlatform(id: 'douyin', title: string, description: string) {
    const section = el('section', undefined, 'sm-config-section sm-platform-card');
    section.dataset.platform = id;
    section.append(el('h3', title + ' · 账号与交流'), el('p', description, 'sm-muted'));
    const enabled = toggle(
      '启用' + title,
      'worlds.socialmedia.platforms.' + id + '.enabled',
    );
    const posting = toggle(
      '允许' + title + '公开发评',
      'worlds.socialmedia.platforms.' + id + '.posting.enabled',
    );
    const status = el('p', '尚未检查' + title + '连接', 'sm-summary');
    status.setAttribute('aria-live', 'polite');
    const hidingNote = el('p', '', 'sm-muted');
    hidingNote.hidden = true;
    const verificationNote = el('p', '', 'sm-summary sm-verification');
    verificationNote.hidden = true;
    verificationNote.setAttribute('role', 'status');
    const failureBox = fold('最近一次失败', 'sm-subsection sm-browser-failure');
    failureBox.hidden = true;
    const failureReport = el('pre', undefined, 'sm-failure-report');
    const copyStatus = el('small', '', 'sm-muted');
    copyStatus.setAttribute('aria-live', 'polite');
    failureBox.append(failureReport);
    button(
      '复制失败信息',
      async () => {
        try {
          if (!navigator.clipboard?.writeText) throw Error('Clipboard unavailable');
          await navigator.clipboard.writeText(failureReport.textContent ?? '');
          copyStatus.textContent = '已复制；不包含登录资料和本机路径。';
        } catch {
          copyStatus.textContent = '未能自动复制，可选中上方文字手动复制。';
        }
      },
      failureBox,
    );
    failureBox.append(
      copyStatus,
      el(
        'p',
        '等待设置是上限，不是窗口最短停留时间。这里保留最近失败，后续读取成功也不会抹掉；重启后重新记录。',
        'sm-muted',
      ),
    );
    const input = el('input');
    input.type = 'url';
    input.placeholder = '粘贴' + title + '完整作品链接或作品编号';
    input.setAttribute('aria-label', title + '读取测试的视频');
    const buttons = el('div', undefined, 'sm-toolbar');
    let hasFeedback = false;
    const action = (label: string, method: string, read = false) =>
      button(
        label,
        async () => {
          hasFeedback = true;
          if (method !== id + 'Close' && !enabled.checked) {
            status.textContent = '请先开启上方“启用' + title + '”，开关会立即保存。';
            return;
          }
          if (read && !input.value.trim()) {
            status.textContent = '请先粘贴' + title + '作品链接或作品编号，再检查读取。';
            input.focus();
            return;
          }
          status.textContent = read ? '正在读取指定作品和评论…' : label + '…';
          try {
            const accountId = evidenceSnapshot?.platforms.find((p) => p.id === id)?.account?.id;
            const r = await ctx.invoke<{ detail: string; commentCount?: number }>(
              method,
              read ? [input.value.trim()] : [],
            );
            if (read && typeof r.commentCount === 'number') {
              readProofs.set(id, {
                accountId,
                at: new Date().toISOString(),
                commentCount: r.commentCount,
              });
              ctx.memo?.set('read-checks', Object.fromEntries(readProofs));
            }
            status.textContent = r.detail;
            await refresh();
          } catch (e) {
            status.textContent = e instanceof Error ? e.message : '操作未完成';
            throw e;
          }
        },
        buttons,
      );
    const loginButton = action(
      id === 'douyin' ? '打开登录／验证窗口' : '打开' + title + '登录窗口',
      id + 'Login',
    );
    action(id === 'douyin' ? '完成登录并检查后台' : '完成' + title + '登录', id + 'FinishLogin');
    action('关闭' + title + '登录窗口', id + 'Close');
    const readButton = action('测试' + title + '读取', id + 'Check', true);
    const checks = fold('读取与连接检查', 'sm-subsection sm-connection-check');
    checks.append(el('p', '检查指定作品和评论，不会发布内容。', 'sm-muted'), input, readButton);
    if (id === 'douyin') {
      const feedButton = action('检查抖音推荐流', 'douyinFeedCheck');
      checks.append(
        feedButton,
        el(
          'p',
          '使用当前后台设置检查推荐流，不需要填写链接，不会发评。已登录不代表后台可用；官网要求验证时，点击上方“处理人工验证”。完成后检查后台，若仍被拦可在连接选项主动选择兼容窗口模式。兼容模式可能显示任务栏图标。',
          'sm-muted',
        ),
      );
    }
    const switches = el('div', undefined, 'sm-controls');
    switches.append(enabled.parentElement!, posting.parentElement!);
    section.append(
      status,
      switches,
      verificationNote,
      hidingNote,
      buttons,
      failureBox,
    );
    return {
      section,
      checks,
      status,
      input,
      enabled,
      posting,
      render(state: Snapshot) {
        const hiding = id === 'douyin' ? state.douyin?.windowHiding : undefined;
        hidingNote.hidden = !hiding?.enabled;
        if (hiding?.enabled)
          hidingNote.textContent =
            hiding.state === 'failed'
              ? (hiding.detail ?? '隐藏失败，已使用原兼容方式。')
              : hiding.active
                ? '兼容浏览器窗口已隐藏；任务结束仍退出。'
                : state.douyin?.loginOpen
                  ? '登录／验证窗口保持可见。'
                  : '隐藏兼容窗口已开启，浏览器按任务启动和退出。';
        const verification = id === 'douyin' ? state.douyin?.verification : undefined;
        verificationNote.hidden = !verification;
        if (id === 'douyin') {
          loginButton.textContent = verification ? '处理人工验证' : '打开登录／验证窗口';
          if (verification)
            verificationNote.textContent =
              '已登录也可能被要求人工验证。检测到“' +
              verification.pageTitle +
              '”。' +
              (verification.paused ? '同类自动访问已暂停。' : '已允许检查，原受阻页面仍待核对。') +
              '点击“处理人工验证”打开上次受阻页面；已登录无需重复扫码。若可见窗口没有验证，点击“完成登录并检查后台”核对实际结果。推荐流通过不代表原作品和评论已恢复。';
        }
        const failure = id === 'douyin' ? state.douyin?.lastFailure : undefined;
        failureBox.hidden = !failure;
        if (failure) {
          const report = [
            title + '最近失败',
            '时间：' + prettyTime(failure.at),
            '环节：' + failure.stage,
            '原因：' + failure.reason,
            '耗时：' + (Math.max(0, failure.elapsedMs) / 1000).toFixed(1) + '秒',
            '加载等待上限：' + failure.waitSeconds + '秒',
          ].join('\n');
          if (failureReport.textContent !== report) {
            failureReport.textContent = report;
            copyStatus.textContent = '';
          }
        }
        const p = state.platforms.find((p) => p.id === id);
        enabled.checked = p?.enabled ?? state.config?.platforms[id]?.enabled ?? false;
        posting.checked = p?.posting ?? state.config?.platforms[id]?.posting.enabled ?? false;
        if (!hasFeedback)
          status.textContent = !enabled.checked
            ? '未启用 · 开启上方开关后即可登录和读取'
            : p?.account
              ? '已登录 ' + p.account.name + ' · 浏览器按需启动，空闲后自动关闭'
              : '已启用 · 尚未确认登录；可打开登录窗口或检查读取';
      },
    };
  }
  const dyControls = browserPlatform(
    'douyin',
    '抖音',
    '视频、官网可访问的图文与评论；支持本地指定群监听和发言。全站通知与完整字幕未接入。',
  );
  const douyinSection = dyControls.section;
  const settings = el('div', undefined, 'sm-settings');
  accountSection.append(
    toolbar,
    connectionResults,
    loginBox,

  );
  const extraInputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
  const dirtyExtras = new Set<string>();
  type SaveScope = 'bilibili' | 'douyin' | PublicPostPlatform | 'resources';
  const saveHints = new Map<string, HTMLElement>();
  function settingScope(key: string): SaveScope {
    if (key.startsWith('worlds.socialmedia.media.')) return 'resources';
    if (
      key.startsWith('worlds.socialmedia.platforms.douyin.') ||
      key.startsWith('worlds.socialmedia.douyinBrowser.')
    )
      return 'douyin';
    const platform = key.split('.')[3];
    return isPublicPostPlatform(platform) ? platform : 'bilibili';
  }
  function refreshSaveHints() {
    for (const [id, hint] of saveHints) {
      const n = [...dirtyExtras].filter((k) => settingScope(k) === id).length;
      if (hint.parentElement) hint.parentElement.dataset.dirty = String(n > 0);
      hint.textContent = n ? n + '项修改待保存' : '无待保存修改';
    }
  }

  const ownerReplySection = el('section', undefined, 'sm-subsection');
  ownerReplySection.append(el('h4', '主人 @ 我的回复额度'),
    el('p', '按 B 站特别关注绑定的账号识别。主人在别人作品下 @ 我或回复我时共用此限额；普通用户每人每天最多 5 条。主人自己作品的评论区单独计数。', 'sm-muted'));
  const extraSection = el('details', undefined, 'sm-subsection sm-platform-limits');
  extraSection.append(
    el('summary', '回应与发布额度'),
    el(
      'p',
      '主人评论自动回应单独计账，不占这里的普通额度；普通通知与闲逛分别计数，共用普通发布上限，普通渠道同一人每天最多五条（B站绑定主人在其他作品下的通知可单独调高）。',
      'sm-muted',
    ),
  );
  const focusSection = el('details', undefined, 'sm-subsection sm-platform-focus');
  focusSection.append(
    el('summary', 'B站特别关注'),
    el(
      'p',
      '自己填写主人账号。昵称重名时按最早主动联系记录固定UID；绑定不授予评论者额外权限。',
      'sm-muted',
    ),
  );
  const biliFocusStatus = el('p', '', 'sm-muted');
  focusSection.append(biliFocusStatus);
  const douyinFocusSection = el('details', undefined, 'sm-subsection sm-platform-focus');
  douyinFocusSection.append(
    el('summary', '抖音特别关注'),
    el(
      'p',
      '填写你自己的主人抖音号或完整主页，与B站独立。更换Bot小号不会改变这里指定的主人；评论者不能修改绑定。',
      'sm-muted',
    ),
  );
  const douyinFocusStatus = el('p', '', 'sm-muted');
  douyinFocusSection.append(douyinFocusStatus);
  const resourceSection = el('section', undefined, 'sm-config-section sm-visual-card');
  const visualKeys = {
    calls: 'worlds.socialmedia.media.maxDailyVisualCalls',
    frames: 'worlds.socialmedia.media.maxFrames',
    video: 'worlds.socialmedia.media.maxVideoFrames',
    unlimited: 'worlds.socialmedia.media.unlimitedDailyVisualCalls',
  };
  const videoModes = [
    {
      label: '低 · 扫一眼', video: 2, detail: '最多 2 帧 · 快速省钱',
      use: '看题材或认个场景，适合去评论区接句话。容易漏掉剧情转折。',
    },
    {
      label: '中 · 日常推荐', video: 9, detail: '最多 9 帧 · 通常一张分镜',
      use: '适合日常看作品。五分钟视频约取 9 帧，可以顺着时间看大致过程。',
    },
    {
      label: '高 · 看仔细', video: 12, detail: '取帧较多 · 超过 9 帧分两张',
      use: '最多 12 帧，适合细看教程或多场景片段。取帧更慢，送给模型的图片可能更多；日常可用中档。',
    },
  ] as const;
  const visualPresets = el('div', undefined, 'sm-presets sm-visual-presets');
  visualPresets.setAttribute('role', 'group');
  visualPresets.setAttribute('aria-label', '视频抽帧档位');
  const visualCustom = fold('自定义次数和张数', 'sm-subsection sm-visual-custom');
  const visualToday = el('p', '正在读取今日用量…', 'sm-visual-today');
  let lastVisualLimit = RESOURCE_DEFAULTS.maxDailyVisualCalls;
  function visualField(key: string) {
    return extraInputs.get(key) as HTMLInputElement;
  }
  function changeNumber(key: string, value: number) {
    const input = visualField(key);
    input.value = String(value);
    input.dispatchEvent(new Event('input'));
  }
  const visualToggle = el('button', '关闭画面', 'sm-visual-toggle');
  visualToggle.type = 'button';
  visualToggle.addEventListener('click', () => {
    const current = Number(visualField(visualKeys.calls).value);
    if (current > 0) lastVisualLimit = current;
    changeNumber(visualKeys.calls, current > 0 ? 0 : lastVisualLimit);
  }, { signal: ctx.signal });
  const videoButtons = videoModes.map(mode => {
    const option = el('button');
    option.type = 'button';
    option.append(el('strong', mode.label), el('span', mode.detail), el('small', mode.use));
    option.addEventListener('click', () => {
      changeNumber(visualKeys.video, mode.video);
    }, { signal: ctx.signal });
    visualPresets.append(option);
    return option;
  });
  function syncVisualControls() {
    const daily = visualField(visualKeys.calls);
    const video = visualField(visualKeys.video);
    const unlimited = visualField(visualKeys.unlimited);
    if (!daily?.value || !video?.value || !unlimited) return;
    const limit = Number(daily.value);
    visualToggle.textContent = limit === 0 ? '开启画面' : '关闭画面';
    daily.disabled = unlimited.checked && limit > 0;
    videoButtons.forEach((option, index) => {
      option.setAttribute('aria-pressed', String(Number(video.value) === videoModes[index].video));
    });
  }
  const visualHeading = el('div', undefined, 'sm-visual-heading');
  visualHeading.append(el('h3', '全平台画面默认值'), visualToggle);
  resourceSection.append(
    visualHeading,
    el('p', '按视频时长取帧，短片会少取。图片会增加模型输入，抽帧也占用本机资源。只回评论时可先读文字。', 'sm-muted'),
    visualToday, visualPresets, visualCustom,
  );
  const resourceAdvanced = fold('高级 · 图片大小、缓存和 FFmpeg');
  resourceSection.append(resourceAdvanced);
  const resourceStatus = el('p', '', 'sm-muted'),
    resourceFeedback = el('p', '', 'sm-muted');
  resourceAdvanced.append(resourceStatus);
  resourceSection.append(resourceFeedback);
  button(
    '清理图片缓存',
    async () => {
      resourceFeedback.textContent = '正在清理本World图片缓存…';
      const r = await ctx.invoke<{ removed: number }>('clearMediaCache');
      resourceFeedback.textContent =
        '已清理' + r.removed + '份本World图片缓存；历史附件与累计预算保留。';
      await refresh();
    },
    resourceSection,
  );
  button(
    '清理浏览器网络缓存',
    async () => {
      resourceFeedback.textContent = '正在清理网络缓存；若有访问正在进行，等本次访问结束后处理…';
      const r = await ctx.invoke<{ results: Array<{ detail: string }> }>('clearBrowserCache');
      resourceFeedback.textContent = r.results.map((x) => x.detail).join(' ');
    },
    resourceSection,
  );
  button(
    '归档旧发言记录',
    async () => {
      const r = await ctx.invoke<{ history: { archived: number } }>('maintainResources');
      resourceFeedback.textContent =
        '已归档' + r.history.archived + '条旧记录；完整回执和防重信息保留。';
      await refresh();
    },
    resourceSection,
  );
  const maintenance = fold('缓存与记录维护', 'sm-subsection sm-maintenance');
  for (const b of [...resourceSection.children])
    if (b instanceof HTMLButtonElement) maintenance.append(b);
  maintenance.append(resourceFeedback);
  resourceSection.append(maintenance);
  const advanced = fold('连接选项', 'sm-subsection sm-platform-advanced');
  const douyinLimits = fold('发言额度', 'sm-subsection sm-platform-limits');
  const douyinAdvanced = fold('连接选项', 'sm-subsection sm-platform-advanced');
  const groupSection = fold('群聊监听', 'sm-subsection sm-group-settings');
  const groupAdvanced = fold('高级设置 · 群聊频率', 'sm-subsection sm-group-advanced');
  groupSection.append(groupAdvanced);
  const groupStatus = el('p', '尚未开启群聊监听', 'sm-muted');
  groupSection.append(
    groupStatus,
    el(
      'p',
      '只监听你填写的群。首次保存后检查，固定真实会话；旧消息只作上下文。群越多、间隔越短，后台读取越频繁。默认查完释放浏览器；没有新消息就不会反复唤醒小K。',
      'sm-muted',
    ),
  );
  button(
    '保存后检查群连接',
    async () => {
      await perform(async () => {
        const r = await ctx.invoke<{ message: string }>('groupCheck');
        feedback.textContent = r.message;
        feedback.hidden = false;
        await refresh();
      });
    },
    groupSection,
  );
  const bindingActions = el('div');
  groupSection.append(bindingActions);
  let bindingDigest = '';
  function renderBindingActions(groups: NonNullable<Snapshot['groupChat']>['groups']) {
    const digest = JSON.stringify(groups.map((g) => [g.id, g.name]));
    if (digest === bindingDigest) return;
    bindingDigest = digest;
    bindingActions.replaceChildren();
    for (const g of groups) {
      const row = el('div', undefined, 'sm-subsection');
      row.append(el('p', g.name + ' · ' + g.id, 'sm-muted'));
      button(
        '重新核对并绑定',
        async () => {
          await perform(async () => {
            const p = await ctx.invoke<{
              token: string;
              previous?: { name: string; accountId: string };
              proposed: { name: string; accountId: string };
            }>('groupPreview', [g.id]);
            const review = el('div', undefined, 'sm-entry');
            review.append(
              el(
                'p',
                '旧绑定：' +
                  (p.previous
                    ? p.previous.name + ' · 账号…' + p.previous.accountId.slice(-10)
                    : '尚未绑定'),
              ),
              el(
                'p',
                '本次检查：' + p.proposed.name + ' · 账号…' + p.proposed.accountId.slice(-10),
              ),
              el('small', '请核对群名和账号。采用后，旧记录归档保留；本次历史消息不补回。'),
            );
            button(
              '采用本次检查结果',
              async () => {
                await perform(async () => {
                  await ctx.invoke('groupRebind', [g.id, p.token]);
                  review.remove();
                  await refresh();
                });
              },
              review,
            );
            button(
              '取消',
              async () => {
                review.remove();
              },
              review,
            );
            row.append(review);
          });
        },
        row,
      );
      bindingActions.append(row);
    }
  }
  const biliSocial = fold('动态与主动 @', 'sm-subsection sm-bili-social');
  const biliSocialAdvanced = fold(
    '高级设置 · 动态频率与 @',
    'sm-subsection sm-bili-social-advanced',
  );
  const dynamicFeedback = el(
    'p',
    '动态读取、纯文字发布和主动 @ 为实验功能，各自单独开启。发布后分别核对访客能否看到、对方是否收到 @。',
    'sm-muted',
  );
  biliSocial.append(dynamicFeedback);
  const readDynamicsButton = button(
    '读取特别关注的最新动态',
    async () => {
      dynamicFeedback.textContent = '正在通过官网读取动态…';
      try {
        const r = await ctx.invoke<{ items: PublicDynamic[] }>('readDynamics', [
          { action: 'list', scope: 'focus', limit: 5 },
        ]);
        dynamicFeedback.textContent =
          '已读取' + r.items.length + '条动态；完整范围以官网返回为准。';
        await refresh();
      } catch (e) {
        dynamicFeedback.textContent = e instanceof Error ? e.message : '动态读取未完成';
        throw e;
      }
    },
    biliSocial,
  );
  const biliFocusTiming = fold('检查范围与频率');
  const douyinFocusTiming = fold('检查范围与频率');
  focusSection.append(biliFocusTiming);
  douyinFocusSection.append(douyinFocusTiming);
  const isFocusPrimary = (path: string) =>
    /\.(enabled|account|autoReplyNewComments|replyExistingComments)$/.test(path);
  const roamCards = new Map<string, HTMLDetailsElement>();
  const roamFields = new Map<string, HTMLDetailsElement>();
  const roamStatuses = new Map<string, HTMLParagraphElement>();
  for (const [id, title] of [
    ['bilibili', 'B站'],
    ['douyin', '抖音'],
    ...POST_PLATFORMS.map(id => [id, PUBLIC_POST_NAMES[id]] as const),
  ] as const) {
    const card = fold(title + '活跃度', 'sm-subsection sm-platform-roaming'),
      status = el('p', '', 'sm-muted');
    const choices = el('div', undefined, 'sm-presets sm-presets-compact');
    for (const [key, label] of [
      ['light', '轻量'],
      ['balanced', '均衡'],
      ['active', '活跃'],
      ['free', '放养'],
    ] as const) {
      const values = ROAMING_PRESETS[key];
      const b = button(
        label,
        async () => {
          const patch = Object.fromEntries(
            Object.entries(values).map(([k, v]) => [
              'worlds.socialmedia.platforms.' + id + '.roaming.' + k,
              v,
            ]),
          );
          await saveConfig('world:socialmedia', patch);
          for (const k of Object.keys(patch)) dirtyExtras.delete(k);
          refreshSaveHints();
          await refresh();
        },
        choices,
      );
      b.dataset.roamPreset = key;
      b.replaceChildren(
        el('strong', label),
        el('small', key === 'free' ? '阅读不限量 · 高消耗' : values.maxDailySessions + '轮/天'),
        el('small', {
          light: '空闲很久才逛，适合减少后台请求。',
          balanced: '偶尔主动看新内容，适合日常。',
          active: '更常看看有什么新内容，后台请求会增多。',
          free: '空闲时可能多次唤醒小K。模型请求和网页访问都会变多，发评额度仍生效。',
        }[key]),
      );
    }
    const fields = fold('自定义等待与额度');
    card.append(
      status,
      el(
        'p',
        '选择后立即生效，仅调整本平台。',
        'sm-muted',
      ),
      choices,
      fields,
    );
    roamCards.set(id, card);
    roamFields.set(id, fields);
    roamStatuses.set(id, status);
  }
  type NumberPreset = readonly [number, string, string];
  const numberPresets: Record<string, readonly NumberPreset[]> = {
    maxDailyVisualCalls: [
      [8, '8 次 · 偶尔看', '适合控制每日视觉用量。'],
      [20, '20 次 · 日常推荐', '留给日常刷视频和翻几组图文。'],
      [40, '40 次 · 经常看', '适合多平台频繁观察。'],
    ],
    maxFrames: [
      [1, '1 张 · 先看一张', '适合扫封面或开头。'],
      [2, '2 张 · 日常推荐', '兼顾开头和下一张内容。'],
      [6, '6 张 · 多看几张', '适合连贯图文，单次送给模型的图会更多。'],
    ],
    pageWaitSeconds: [
      [20, '20 秒 · 尽快返回', '页面通常很快时用，慢页面容易超时。'],
      [45, '45 秒 · 日常推荐', '适合大多数作品和评论区。'],
      [90, '90 秒 · 网络较慢', '给长时间加载的页面更多机会，加载完就继续。'],
    ],
    maxImageKB: [
      [256, '256 KB · 省空间', '适合大致看画面，小字可能变糊。'],
      [512, '512 KB · 日常推荐', '兼顾分镜可读性和附件体积。'],
      [1024, '1024 KB · 保留细节', '适合字幕和图中文字，附件可能更大。'],
    ],
    cacheDays: [
      [3, '3 天 · 少占空间', '适合很少回看旧作品。'],
      [7, '7 天 · 日常推荐', '一周内回看可以复用缓存。'],
      [14, '14 天 · 经常回看', '减少重复下载，缓存可能留得更久。'],
    ],
    maxCacheMB: [
      [64, '64 MB · 轻量', '空间紧张时选，旧图更早退出缓存。'],
      [200, '200 MB · 日常推荐', '适合日常跨平台回看。'],
      [512, '512 MB · 经常回看', '适合重复打开很多作品。'],
    ],
    browserCacheMB: [
      [64, '64 MB · 轻量', '适合较少使用网页。'],
      [128, '128 MB · 日常推荐', '适合日常刷网页。'],
      [256, '256 MB · 频繁读取', '可以缓存更多网页资源。'],
    ],
    historyDays: [
      [30, '30 天 · 最近一个月', '更早记录较早归档。'],
      [90, '90 天 · 日常推荐', '近期视图保留较长时间。'],
      [180, '180 天 · 回看半年', '较久以前的详细发言留在近期区更久。'],
    ],
    minIntervalSec: [
      [30, '30 秒 · 回得较快', '适合需要及时跟上对话的场合。'],
      [60, '60 秒 · 日常推荐', '连续发言之间留出一点间隔。'],
      [180, '180 秒 · 放慢频率', '适合不希望密集发言的频道。'],
    ],
    pollIntervalSec: [
      [30, '30 秒 · 更及时', '更快发现消息，网页检查也更频繁。'],
      [60, '60 秒 · 日常推荐', '兼顾响应速度和后台请求。'],
      [180, '180 秒 · 少打扰', '后台请求更少，新消息可能晚一些出现。'],
    ],
    autoReplyIntervalMinutes: [
      [2, '2 分钟 · 回得更快', '适合新作品发布后集中看评论。'],
      [5, '5 分钟 · 日常推荐', '通常能及时发现新评论。'],
      [15, '15 分钟 · 减少检查', '适合更新较少的作品。'],
    ],
    intervalMinutes: [
      [15, '15 分钟 · 经常看看', '适合关注对象更新较频繁。'],
      [60, '60 分钟 · 日常推荐', '每小时看一次近期作品。'],
      [180, '180 分钟 · 偶尔看看', '减少后台检查，适合更新少的账号。'],
    ],
    maxDailyReplies: [
      [5, '5 条 · 少量回应', '适合只回复几条最相关的通知。'],
      [20, '20 条 · 日常', '给活跃评论区留出更多回应空间。'],
      [40, '40 条 · 通知多', '适合确实收到较多通知的账号。'],
    ],
    maxVideos: [
      [3, '3 个 · 只看最近', '适合更新少或只关心最近作品的账号。'],
      [8, '8 个 · 日常', '最近发布的多条作品都能纳入检查。'],
      [15, '15 个 · 追得更远', '检查范围更广，每轮读取可能更久。'],
    ],
  };
  const numberControls = new Map<string, { buttons: HTMLButtonElement[]; choices: readonly NumberPreset[] }>();
  function syncNumberPreset(path: string) {
    const control = numberControls.get(path);
    const input = extraInputs.get(path);
    if (!control || !input) return;
    control.buttons.forEach((option, index) => {
      option.disabled = input.disabled;
      option.setAttribute('aria-pressed', String(input.value === String(control.choices[index][0])));
    });
  }
  const visualCards = new Map(ROAMING_PLATFORMS.map(id => [id, fold('本站画面设置', 'sm-subsection')]));
  const learningCards = new Map(ROAMING_PLATFORMS.map(id => [
    id, fold('语料学习偏好', 'sm-subsection'),
  ]));
  const learningUsage = new Map(ROAMING_PLATFORMS.map(id => {
    const status = el('p', '', 'sm-muted');
    visualCards.get(id)!.append(status);
    return [id, status] as const;
  }));
  const platformOptionLabels: Record<string, string> = {
    inherit: '沿用全局设置', bounded: '本站独立限额', unlimited: '本站每日不限次数',
    off: '关闭', light: '低 · 偶尔参考', medium: '中 · 日常参考', strong: '高 · 优先参考',
  };
  const excluded = new Set([
    'worlds.socialmedia.platforms.douyin.enabled',
    'worlds.socialmedia.platforms.douyin.posting.enabled',
    'worlds.socialmedia.platforms.bilibili.enabled',
    'worlds.socialmedia.platforms.bilibili.monitor.enabled',
    'worlds.socialmedia.platforms.bilibili.posting.enabled',
    'worlds.socialmedia.focus.maxDailyActions',
    'worlds.socialmedia.platforms.douyin.focus.maxDailyActions',
  ]);
  for (const [path, prop] of Object.entries(SOCIALMEDIA_CONFIG_GROUP.schema.properties)) {
    if (path.startsWith('worlds.socialmedia.activeHours.') || path.startsWith('worlds.socialmedia.roaming.') || path.startsWith('worlds.socialmedia.experiments.') || excluded.has(path)) continue;
    const roamPath = path.match(
      /^worlds\.socialmedia\.platforms\.(bilibili|douyin|tieba|xiaohongshu)\.roaming\.(.+)$/,
    );
    const platformSetting = path.match(/^worlds\.socialmedia\.platforms\.(bilibili|douyin|tieba|xiaohongshu)\.(visualDaily|corpusWeight)$/);
    if (/^worlds\.socialmedia\.platforms\.(tieba|xiaohongshu)\./.test(path) && !roamPath && !platformSetting) continue;
    const ownerQuota = path === 'worlds.socialmedia.focus.outsideReplyLimit';
    const replyTotal = path === 'worlds.socialmedia.platforms.bilibili.posting.maxDailyReplies';
    const parent = ownerQuota ? ownerReplySection : replyTotal ? extraSection : platformSetting
      ? (platformSetting[2] === 'visualDaily' ? visualCards : learningCards).get(platformSetting[1] as typeof ROAMING_PLATFORMS[number])!
      :
      path.startsWith('worlds.socialmedia.platforms.bilibili.dynamics.') ||
      /^worlds\.socialmedia\.focus\.(allowMentions|maxDailyMentions)$/.test(path)
        ? ['enabled', 'allowPublishing', 'autonomousEnabled', 'allowMentions'].includes(
            path.split('.').at(-1)!,
          )
          ? biliSocial
          : biliSocialAdvanced
        : path.startsWith('worlds.socialmedia.platforms.douyin.chat.')
          ? ['enabled', 'allowSend', 'groups', 'activity', 'proactiveEnabled'].includes(
              path.split('.').at(-1)!,
            )
            ? groupSection
            : groupAdvanced
          : roamPath
            ? ['enabled', 'idleMinutes', 'minIntervalMinutes'].includes(roamPath[2])
              ? roamCards.get(roamPath[1])!
              : roamFields.get(roamPath[1])!
            : path.startsWith('worlds.socialmedia.media.')
              ? path === visualKeys.unlimited
                ? resourceSection
                : path === visualKeys.calls || path === visualKeys.frames || path === visualKeys.video
                  ? visualCustom
                  : resourceAdvanced
              : path.startsWith('worlds.socialmedia.focus.')
                ? isFocusPrimary(path)
                  ? focusSection
                  : biliFocusTiming
                : path.startsWith('worlds.socialmedia.platforms.douyin.focus.')
                  ? isFocusPrimary(path)
                    ? douyinFocusSection
                    : douyinFocusTiming
                  : path.startsWith('worlds.socialmedia.platforms.douyin.') ||
                          path.startsWith('worlds.socialmedia.douyinBrowser.')
                        ? path.startsWith('worlds.socialmedia.douyinBrowser.')
                          ? douyinAdvanced
                          : douyinLimits
                        : /maxDailyComments|maxDailyReplies|minIntervalSec/.test(path)
                          ? extraSection
                          : advanced;
    const label = el('label', undefined, 'sm-config-field');
    const copy = el('span');
    copy.append(el('strong', ownerQuota ? '每天最多回复主人几次' : replyTotal ? '普通通知每日总额度' : prop.title));
    if (prop.description) copy.append(el('small', prop.description));
    if (prop.type === 'integer' && prop.minimum !== undefined && prop.maximum !== undefined)
      copy.append(el('small', ownerQuota ? '可填 0–100，或 -1 表示不限次数' : '可填 ' + prop.minimum + '–' + prop.maximum));
    let input: HTMLInputElement | HTMLSelectElement;
    if (prop.enum) {
      const select = el('select');
      for (const v of prop.enum) {
        const o = el(
          'option',
          platformSetting ? platformOptionLabels[v] ?? v :
          v === 'quiet'
            ? '安静'
            : v === 'balanced'
              ? '均衡'
              : v === 'active'
                ? '活跃'
                : v === 'browser'
                  ? '后台网页（推荐）'
                  : v === 'api'
                    ? '接口（实验）'
                    : v === 'free'
                      ? '放养 · 阅读不限量'
                      : v === 'bounded'
                        ? '按额度闲逛'
                        : v,
        );
        o.value = v;
        select.append(o);
      }
      input = select;
    } else {
      const field = el('input');
      field.type =
        prop.type === 'boolean' ? 'checkbox' : prop.type === 'integer' ? 'number' : 'text';
      if (prop.minimum !== undefined) field.min = String(prop.minimum);
      if (prop.maximum !== undefined) field.max = String(prop.maximum);
      input = field;
    }
    input.setAttribute('aria-label', prop.title);
    const help = [...copy.querySelectorAll('small')];
    if (help.length) {
      const idBase = (settingsMode ? 'sm-setting-' : 'sm-panel-') + path;
      help.forEach((line, index) => { line.id = idBase + '-' + index; });
      input.setAttribute('aria-describedby', help.map(line => line.id).join(' '));
    }
    input.addEventListener(
      'input',
      () => {
        dirtyExtras.add(path);
        if (input instanceof HTMLInputElement && input.type === 'checkbox') {
          const peerKey =
            path.endsWith('.focus.enabled') && !input.checked
              ? path.replace(/enabled$/, 'autoReplyNewComments')
              : path.endsWith('.focus.autoReplyNewComments') && input.checked
                ? path.replace(/autoReplyNewComments$/, 'enabled')
                : undefined;
          const peer = peerKey ? extraInputs.get(peerKey) : undefined;
          if (peerKey && peer instanceof HTMLInputElement && peer.checked !== input.checked) {
            peer.checked = input.checked;
            dirtyExtras.add(peerKey);
          }
        }
        refreshSaveHints();
        if (path === visualKeys.calls || path === visualKeys.frames || path === visualKeys.video || path === visualKeys.unlimited)
          syncVisualControls();
        syncNumberPreset(path);
        if (path === visualKeys.unlimited) syncNumberPreset(visualKeys.calls);
        feedback.hidden = true;
      },
      { signal: ctx.signal },
    );
    extraInputs.set(path, input);
    label.append(copy, input);
    if (path === visualKeys.unlimited) {
      label.classList.add('sm-visual-unlimited');
      resourceSection.insertBefore(label, visualCustom);
    } else parent.append(label);
    const key = path.split('.').at(-1)!;
    const presetKey = key === 'intervalSec' || key === 'pollSeconds' ? 'pollIntervalSec' : key;
    const choices = numberPresets[presetKey]?.filter(([value]) =>
      value >= (prop.minimum ?? 0) && value <= (prop.maximum ?? Infinity),
    );
    if (prop.type === 'integer' && choices && choices.length >= 2) {
      const presets = el('div', undefined, 'sm-number-presets');
      presets.setAttribute('role', 'group');
      presets.setAttribute('aria-label', prop.title + '预设');
      const buttons = choices.map(([value, name, hint]) => {
        const option = el('button', name);
        option.type = 'button';
        option.append(el('small', hint));
        option.addEventListener('click', () => changeNumber(path, value), { signal: ctx.signal });
        presets.append(option);
        return option;
      });
      numberControls.set(path, { buttons, choices });
      label.after(presets);
    }
  }
  for (const [id, fields] of roamFields) roamCards.get(id)!.append(fields);
  groupSection.append(groupAdvanced);
  const saveExtras = async (scope: SaveScope) => {
    const values: Record<string, unknown> = {};
    for (const [key, input] of extraInputs) {
      if (settingScope(key) !== scope || !dirtyExtras.has(key)) continue;
      if (!input.validity.valid || (input instanceof HTMLInputElement && input.type === 'number' && !input.value.trim())) {
        input.focus();
        throw new Error('请检查「' + input.getAttribute('aria-label') + '」的取值范围。');
      }
      const p = SOCIALMEDIA_CONFIG_GROUP.schema.properties[key];
      values[key] =
        p.type === 'boolean'
          ? (input as HTMLInputElement).checked
          : p.type === 'integer'
            ? Number(input.value)
            : input.value;
    }
    const prefix =
      scope === 'bilibili'
        ? 'worlds.socialmedia.focus.'
        : scope === 'resources'
          ? undefined
          : 'worlds.socialmedia.platforms.' + scope + '.focus.';
    const focusChanged = prefix && [...dirtyExtras].some((k) => k.startsWith(prefix));
    if (!Object.keys(values).length) return;
    const checkFocus = prefix && focusChanged && (extraInputs.get(prefix + 'enabled') as HTMLInputElement)?.checked && extraInputs.get(prefix + 'account')?.value.trim();
    await saveConfig('world:socialmedia', values);
    for (const [key, saved] of Object.entries(values)) {
      const input = extraInputs.get(key)!;
      const current = input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : input.value;
      if (String(current) === String(saved)) dirtyExtras.delete(key);
    }
    refreshSaveHints();
    await refresh();
    if (checkFocus) {
      feedback.textContent = '设置已保存，正在检查关注账号与作品…';
      try {
        await ctx.invoke('focusRefresh', [scope]);
        feedback.textContent = '设置已保存，关注检查结果见本平台摘要。';
      } catch (e) {
        feedback.textContent =
          '设置已保存；关注检查未完成：' + (e instanceof Error ? e.message : '请稍后再检查');
      } finally {
        feedback.hidden = false;
        await refresh();
      }
    }
  };
  button('保存画面设置', () => saveExtras('resources'), resourceSection).classList.add('sm-save-visual');
  resourceSection.append(maintenance);
  function platformSave(id: Exclude<SaveScope, 'resources'>, title: string) {
    const bar = el('div', undefined, 'sm-platform-savebar'),
      hint = el('small', '无待保存修改');
    hint.setAttribute('role', 'status');
    hint.setAttribute('aria-live', 'polite');
    saveHints.set(id, hint);
    button('保存' + title + '设置', () => saveExtras(id), bar);
    bar.append(hint, el('small', '预设和权限开关即时生效；其他修改在这里统一保存。'));
    return bar;
  }
  const saveBilibili = platformSave('bilibili', 'B站'),
    saveDouyin = platformSave('douyin', '抖音');
  const webLoginButtons = el('div', undefined, 'sm-toolbar');
  for (const [label, method] of [
    ['打开B站网页登录', 'bilibiliLogin'],
    ['完成B站网页登录', 'bilibiliFinishLogin'],
    ['关闭B站登录窗口', 'bilibiliClose'],
  ] as const)
    button(
      label,
      async () => {
        const r = await ctx.invoke<{ detail: string }>(method, []);
        feedback.textContent = r.detail;
        feedback.hidden = false;
        await refresh();
      },
      webLoginButtons,
    );
  advanced.append(
    el(
      'p',
      '海外客户端无法扫码时，可尝试独立官网登录后完成核对。只支持bilibili.com账号，Bstation／bilibili.tv尚未接入；不需要把密码、Cookie或验证码发给Bot。',
      'sm-muted',
    ),
    webLoginButtons,
    browserDiagnostic,
    logoutButton,
    credentials,
  );
  advanced.append(loginGuide('bilibili'));
  douyinAdvanced.append(loginGuide('douyin'));
  dyControls.checks.append(usageChecks('douyin'));
  biliSocial.append(biliSocialAdvanced);
  accountSection.append(
    roamCards.get('bilibili')!,
    focusSection,
    ownerReplySection,
    biliSocial,
    extraSection,
    usageChecks('bilibili'), advanced,
    visualCards.get('bilibili')!, learningCards.get('bilibili')!,
    saveBilibili,
  );
  const douyinNotifications = fold('通知与 @');
  douyinNotifications.append(
    el('p', '当前可以扫描特别关注作品下的评论，并回复已核对的原楼层。', 'sm-muted'),
    el('p', '全站收到的 @、别人回复 Bot，以及在评论中主动插入 @ 标记仍待接入。', 'sm-muted'),
  );
  button('打开抖音专用窗口', async () => {
    const result = await ctx.invoke<{ detail: string }>('douyinLogin');
    feedback.textContent = result.detail + ' 可在官网顶部手动查看「通知」。';
    feedback.hidden = false;
  }, douyinNotifications);
  douyinSection.append(
    roamCards.get('douyin')!,
    douyinFocusSection,
    groupSection,
    douyinLimits, douyinNotifications,
    dyControls.checks, douyinAdvanced, visualCards.get('douyin')!,
    learningCards.get('douyin')!,
    saveDouyin,
  );
  const experiments = settingsMode ? expressionSettings(ctx, refresh) : undefined;
  for (const [id, title, panel] of experiments?.publicPanels ?? []) {
    panel.insertBefore(roamCards.get(id)!, panel.querySelector('.sm-platform-focus'));
    const visualControl = panel.querySelector('.sm-platform-visual-control');
    if (visualControl) visualCards.get(id)!.append(visualControl);
    panel.append(visualCards.get(id)!, learningCards.get(id)!, platformSave(id, title));
  }
  const platformTabs = el('div', undefined, 'sm-platform-tabs');
  platformTabs.setAttribute('role', 'tablist');
  platformTabs.setAttribute('aria-label', '平台配置');
  const platformPanels = [
    ['bilibili', '哔哩哔哩', accountSection],
    ['douyin', '抖音', douyinSection],
    ...(experiments?.publicPanels ?? []),
  ] as const;
  const activityGroups = new Map<string, HTMLElement>();
  for (const [id] of platformPanels) {
    const platformActivity = roamCards.get(id)!;
    const group = el('section', undefined, 'sm-activity-settings');
    platformActivity.before(group);
    group.append(el('h3', '活跃安排'), platformActivity);
    activityGroups.set(id, group);
  }
  const visualPanes = new Map<string, HTMLElement>();
  const showCategory = new Map<string, (key: string) => void>();
  for (const [id, , panel] of platformPanels) {
    const heading = panel.querySelector('h3')!;
    const save = panel.querySelector('.sm-platform-savebar')!;
    const activity = activityGroups.get(id)!;
    const focus = panel.querySelector<HTMLDetailsElement>('.sm-platform-focus')!;
    const localVisual = visualCards.get(id)!;
    const connection = el('div');
    const navigation = el('div', undefined, 'sm-setting-choices');
    navigation.setAttribute('role', 'group');
    navigation.setAttribute('aria-label', '常用设置');
    const visual = el('div');
    visual.append(localVisual);
    visualPanes.set(id, visual);
    for (const node of [...panel.children]) {
      if (node !== heading && node !== save && node !== activity && node !== focus) connection.append(node);
    }
    const focusPane = el('div');
    focusPane.append(focus);
    if (id === 'bilibili') focusPane.append(ownerReplySection);
    const groups = [
      ['account', '账号与连接', '登录、权限与通知', connection],
      ['activity', '活跃度', '频率、时段与闲逛', activity],
      ['focus', '特别关注', '主人账号与回评', focusPane],
      ['visual', '画面设置', '本站画面与全局预算', visual],
    ] as const;
    const controls = new Map<string, HTMLButtonElement>();
    const choose = (key: string) => {
      for (const [name,,, pane] of groups) {
        pane.hidden = name !== key;
        controls.get(name)!.setAttribute('aria-pressed', String(name === key));
      }
      ctx.memo?.set('settings-category', key);
    };
    for (const [key, label, description, pane] of groups) {
      const choice = el('button');
      choice.type = 'button';
      choice.append(el('strong', label), el('small', description));
      choice.setAttribute('aria-label', label);
      pane.id = (settingsMode ? 'sm-' : 'sm-detached-') + id + '-' + key;
      choice.setAttribute('aria-controls', pane.id);
      choice.addEventListener('click', () => {
        choose(key);
        if (key === 'focus') focus.open = true;
        if (key === 'activity') roamCards.get(id)!.open = true;
      }, { signal: ctx.signal });
      controls.set(key, choice);
      navigation.append(choice);
    }
    showCategory.set(id, choose);
    panel.append(navigation, ...groups.map(([, , , pane]) => pane), save);
  }
  const platformButtons = new Map<string, HTMLButtonElement>();
  const prefix = settingsMode ? 'sm-settings' : 'sm-detached';
  function selectPlatform(id: string) {
    for (const [key, , panel] of platformPanels) {
      const selected = key === id,
        tab = platformButtons.get(key)!;
      panel.hidden = !selected;
      tab.setAttribute(key === 'xiaohongshu' ? 'aria-pressed' : 'aria-selected', String(selected));
      tab.tabIndex = selected || (id === 'xiaohongshu' && key === 'bilibili') || key === 'xiaohongshu' ? 0 : -1;
    }
    // Move the shared controls, including any unsaved time edit, with the selected platform.
    activityGroups.get(id)!.insertBefore(roamSection, roamCards.get(id)!);
    activityGroups.get(id)!.insertBefore(hoursBox, roamCards.get(id)!);
    visualPanes.get(id)!.append(resourceSection);
    showCategory.get(id)!(ctx.memo?.get<string>('settings-category', 'account') ?? 'account');
    ctx.memo?.set('settings-platform', id);
  }
  for (const [id, title, panel] of platformPanels) {
    const tab = el('button');
    const badge = el('small', '正在读取状态', 'sm-channel-status');
    const name = el('strong', title);
    const experimental = id === 'tieba';
    if (experimental) name.append(el('span', '实验', 'sm-experimental'));
    if (id === 'xiaohongshu') name.append(el('span', '易风控', 'sm-risk-badge'));
    tab.append(name, badge);
    tab.setAttribute('aria-label', experimental ? title + '（实验）' : id === 'xiaohongshu' ? title + '（易风控）' : title);
    tab.type = 'button';
    tab.dataset.platform = id;
    tab.id = prefix + '-tab-' + id;
    if (id !== 'xiaohongshu') tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', prefix + '-panel-' + id);
    panel.id = prefix + '-panel-' + id;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    tab.addEventListener('click', () => {
      selectPlatform(id);
      if (id === 'xiaohongshu') panel.focus();
    }, { signal: ctx.signal });
    tab.addEventListener(
      'keydown',
      (event) => {
        if (id === 'xiaohongshu') return;
        const keys = platformPanels.map(([key]) => key).filter(key => key !== 'xiaohongshu'),
          index = keys.indexOf(id);
        const next =
          event.key === 'ArrowRight'
            ? (index + 1) % keys.length
            : event.key === 'ArrowLeft'
              ? (index + keys.length - 1) % keys.length
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? keys.length - 1
                  : -1;
        if (next < 0) return;
        event.preventDefault();
        selectPlatform(keys[next]);
        platformButtons.get(keys[next])!.focus();
      },
      { signal: ctx.signal },
    );
    platformButtons.set(id, tab);
    if (id === 'xiaohongshu' && experiments) {
      const lab = el('div', undefined, 'sm-lab-platform');
      const enable = panel.querySelector<HTMLElement>('.sm-lab-enable')!;
      lab.append(enable, tab, el('small', '每次启动默认关闭。只看笔记时可关闭公开发言。'));
      experiments.element.querySelector('.sm-experiment-body')!.prepend(lab);
    } else platformTabs.append(tab);
  }
  const remembered = ctx.memo?.get<string>('settings-platform', 'bilibili');
  selectPlatform(platformButtons.has(remembered ?? '') ? remembered! : 'bilibili');
  const layoutLinks = el('div', undefined, 'sm-layout-links');
  layoutLinks.append(el('h3', '平台'));
  const platformColumn = el('div', undefined, 'sm-primary');
  platformColumn.append(layoutLinks, platformTabs, ...platformPanels.map(([, , panel]) => panel));
  settings.append(platformColumn);
  ctx.guardLeave?.(() => (dirtyExtras.size || hoursDirty ? '还有未保存的设置，离开将放弃这些修改。' : null));
  const overview = el('div', undefined, 'sm-overview');
  const metrics = new Map<string, HTMLElement>();
  for (const label of ['待回应', '已发出', '今日闲逛']) {
    const card = el('div', undefined, 'sm-metric'),
      value = el('strong', '—');
    card.append(el('span', label), value);
    overview.append(card);
    metrics.set(label, value);
  }
  const feed = el('section', undefined, 'sm-feed');
  const feedHeading = el('div', undefined, 'sm-feed-heading');
  feedHeading.append(el('h3', '作品与对话'));
  const feedToolbar = el('div', undefined, 'sm-feed-toolbar'),
    filters = el('div', undefined, 'sm-filters');
  filters.setAttribute('aria-label', '互动筛选');
  let workPage = 0;
  let stableWorkKeys: string[] = [];
  const entryPages = new Map<string, number>();
  let activeFilter: InteractionFilter = 'all',
    lastState: Snapshot | undefined,
    lastDigest = '',
    latestIds = new Set<string>();
  const filterButtons = new Map<InteractionFilter, HTMLButtonElement>();
  for (const [key, label] of [
    ['all', '全部'],
    ['pending', '待回应'],
    ['sent', '已发出'],
    ['roam', '闲逛'],
  ] as const) {
    const b = button(
      label,
      async () => {
        activeFilter = key;
        workPage = 0;
        lastDigest = '';
        if (lastState) renderTimeline(lastState, true);
      },
      filters,
    );
    b.setAttribute('aria-pressed', String(key === 'all'));
    filterButtons.set(key, b);
  }
  const search = el('input');
  search.type = 'search';
  search.placeholder = '搜索视频、原评论或我的发言';
  search.setAttribute('aria-label', '搜索互动');
  search.addEventListener(
    'input',
    () => {
      workPage = 0;
      lastDigest = '';
      if (lastState) renderTimeline(lastState, true);
    },
    { signal: ctx.signal },
  );
  const order = el('select');
  order.setAttribute('aria-label', '互动排序');
  for (const [v, label] of [
    ['newest', '最近互动在前'],
    ['oldest', '较早互动在前'],
  ]) {
    const o = el('option', label);
    o.value = v;
    order.append(o);
  }
  order.addEventListener(
    'change',
    () => {
      workPage = 0;
      lastDigest = '';
      if (lastState) renderTimeline(lastState, true);
    },
    { signal: ctx.signal },
  );
  const newest = button(
    '有新动态 · 回到最新',
    async () => {
      order.value = 'newest';
      workPage = 0;
      newest.hidden = true;
      lastDigest = '';
      if (lastState) renderTimeline(lastState, true);
      feed.scrollIntoView({ block: 'start', behavior: 'auto' });
    },
    feedToolbar,
  );
  newest.hidden = true;
  feedToolbar.prepend(filters, search, order);
  const timeline = el('div', undefined, 'sm-list sm-timeline');
  const loadingRecords = el('p', '正在读取互动记录…', 'sm-empty');
  loadingRecords.setAttribute('role', 'status');
  timeline.append(loadingRecords);
  timeline.setAttribute('aria-label', '互动时间线');
  function renderPager(
    nav: HTMLElement,
    current: number,
    total: number,
    info: string,
    change: (page: number) => void,
  ) {
    nav.replaceChildren(el('span', info, 'sm-pagination-status'));
    const add = (label: string, page: number, disabled = false) => {
      const b = button(
        label,
        async () => {
          if (page !== current) change(page);
        },
        nav,
      );
      b.disabled = disabled;
      return b;
    };
    add('上一页', current - 1, current === 0);
    const pages = [
      ...new Set([0, total - 1, ...Array.from({ length: 5 }, (_, i) => current + i - 2)]),
    ]
      .filter((i) => i >= 0 && i < total)
      .sort((a, b) => a - b);
    let previous = -1;
    for (const page of pages) {
      if (page > previous + 1) nav.append(el('span', '…', 'sm-page-gap'));
      const b = add(String(page + 1), page);
      b.classList.add('sm-page-number');
      if (page === current) b.setAttribute('aria-current', 'page');
      previous = page;
    }
    add('下一页', current + 1, current >= total - 1);
  }
  const workPager = el('nav', undefined, 'sm-toolbar sm-pagination sm-work-pager');
  workPager.setAttribute('aria-label', '作品分页');
  if (!settingsMode) feed.append(feedHeading, feedToolbar, workPager, timeline);
  const focusPanel = focusView(async () => {
    await perform(async () => {
      await ctx.invoke('focusRefresh');
      await refresh();
    });
  }, ctx.signal);
  const douyinFocusPanel = focusView(
    async () => {
      await perform(async () => {
        await ctx.invoke('focusRefresh', ['douyin']);
        await refresh();
      });
    },
    ctx.signal,
    '抖音特别关注',
    'douyin',
  );
  const groupRecords = fold('抖音群 · 对话记录', 'sm-focus-card sm-group-records');
  groupRecords.open = true;
  groupRecords.dataset.platform = 'douyin';
  const groupRecordBody = el('div');
  groupRecordBody.className = 'sm-focus-body';
  groupRecords.append(groupRecordBody);
  let groupDigest = '';
  function groupHealth(g: NonNullable<Snapshot['groupChat']>['groups'][number]) {
    return (
      ({
        disabled: '已关闭',
        unbound: '尚未绑定',
        online: '读取正常',
        retrying: '等待重连',
        verification: '等待登录或人工验证',
        stale: '最近读取已过期',
      }[g.connection] ?? '状态待检查') +
      (g.checkedAt ? ' · 最近检查 ' + prettyTime(g.checkedAt) : '') +
      (g.lastMessageAt ? ' · 最新消息 ' + prettyTime(g.lastMessageAt) : ' · 尚未读到消息') +
      (g.retryAt ? ' · 下次重试 ' + prettyTime(g.retryAt) : '') +
      (g.error ? ' · ' + g.error : '')
    );
  }
  function renderGroups(state: Snapshot) {
    const chat = state.groupChat;
    renderBindingActions(chat?.groups ?? []);
    groupStatus.textContent = !chat?.enabled
      ? '群监听已关闭'
      : (chat.error ??
        (chat.groups.length
          ? '监听' +
            chat.groups.length +
            '个群 · ' +
            (chat.allowSend ? '允许接话' : '只读') +
            ' · ' +
            ({ quiet: '安静', balanced: '均衡', active: '活跃' }[chat.activity] ?? '均衡') +
            (chat.proactiveEnabled ? ' · 可主动开启话题' : ' · 有新消息时接话')
          : '请填写并保存群号与群名'));
    groupRecords.hidden = !chat?.groups.length;
    // A polling timestamp alone must never replace the conversation being read.
    for (const card of groupRecordBody.querySelectorAll<HTMLElement>('[data-group-id]')) {
      const g = chat?.groups.find((g) => g.id === card.dataset.groupId),
        health = card.querySelector('.sm-group-health');
      if (g && health) health.textContent = groupHealth(g);
    }
    const digest = JSON.stringify([
      chat?.enabled,
      chat?.allowSend,
      chat?.activity,
      chat?.proactiveEnabled,
      chat?.groups.map(({ checkedAt, ...g }) => g),
      chat?.outbox,
    ]);
    if (digest === groupDigest) return;
    groupDigest = digest;
    const scroller = scrollHost(),
      oldTop = scroller.scrollTop,
      top = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
    const visible = [...root.querySelectorAll<HTMLElement>('[data-anchor]')].find(
      (n) => n.getClientRects().length && n.getBoundingClientRect().bottom > top,
    );
    const anchor =
      visible && oldTop > 24
        ? { id: visible.dataset.anchor, offset: visible.getBoundingClientRect().top }
        : undefined;
    const opened = new Set(
      [...groupRecordBody.querySelectorAll<HTMLDetailsElement>('details[open][data-group-id]')].map(
        (d) => d.dataset.groupId,
      ),
    );
    groupRecordBody.replaceChildren();
    for (const g of chat?.groups ?? []) {
      const card = el('details', undefined, 'sm-video sm-group-card');
      card.dataset.platform = 'douyin';
      card.dataset.groupId = g.id;
      card.open = opened.has(g.id);
      const outgoing = chat!.outbox.filter((r) => r.groupId === g.id);
      const combined = [
        ...g.messages.map((m) => ({
          id: m.id,
          text: m.text,
          time: m.time,
          own: m.own,
          who: m.own ? '我' : m.sender || '群友',
          note: m.system ? '群提示' : m.own ? '已读回' : '群消息',
          detail: outgoing.find((r) => r.messageId === m.id)?.detail,
        })),
        ...outgoing
          .filter((r) => !r.messageId || !g.messages.some((m) => m.id === r.messageId))
          .map((r) => ({
            id: r.id,
            text: r.text,
            time: r.time,
            own: true,
            who: '我',
            note:
              r.status === 'sent' ? '已受理' : r.status === 'not_submitted' ? '未提交' : '待核实',
            detail: r.detail,
          })),
      ]
        .filter((m) => m.text)
        .sort((a, b) => b.time - a.time)
        .slice(0, 35);
      const head = el('summary', undefined, 'sm-video-header');
      head.dataset.anchor = 'group:' + g.id;
      const title = el('div');
      title.append(
        el(
          'span',
          '抖音群 · ' +
            g.messages.length +
            ' 条近期记录' +
            (g.pending ? ' · ' + g.pending + ' 条待接话' : ''),
          'sm-eyebrow sm-platform-label',
        ),
        el('h4', g.name),
        el('small', '群号 ' + g.id),
      );
      const side = el('span', undefined, 'sm-video-side');
      side.append(
        el(
          'span',
          g.connected ? '读取正常' : '待检查',
          'sm-tag ' + (g.connected ? 'sm-tag-good' : 'sm-tag-note'),
        ),
        el('span', '展开对话', 'sm-open-label'),
      );
      head.append(title, side);
      card.append(head, el('p', groupHealth(g), 'sm-group-health sm-muted'));
      const thread = el('div', undefined, 'sm-thread sm-group-thread');
      for (const r of combined) {
        const item = el('article', undefined, 'sm-event sm-' + (r.own ? 'outgoing' : 'incoming'));
        item.dataset.platform = 'douyin';
        item.dataset.anchor = 'group-message:' + g.id + ':' + r.id;
        const meta = el('div', undefined, 'sm-event-meta'),
          tags = el('div', undefined, 'sm-tags');
        tags.append(
          el('span', r.who, 'sm-speaker'),
          el(
            'span',
            r.note,
            'sm-tag ' + (['未提交', '待核实'].includes(r.note) ? 'sm-tag-note' : ''),
          ),
        );
        meta.append(tags, el('time', prettyTime(r.time)));
        item.append(meta, el('p', r.text, 'sm-body'));
        if (r.detail) {
          const detail = fold('发送结果', 'sm-group-receipt');
          detail.append(el('p', r.detail, 'sm-muted'));
          item.append(detail);
        }
        thread.append(item);
      }
      if (!combined.length)
        thread.append(el('p', '尚无群对话记录；先在配置中检查连接。', 'sm-muted'));
      else if (!g.pending)
        thread.append(
          el(
            'p',
            '当前没有新的待接话消息。活跃度决定接话意愿，主动开启话题需单独开启。',
            'sm-muted sm-group-note',
          ),
        );
      card.append(thread);
      groupRecordBody.append(card);
    }
    if (anchor) {
      const restored = [...root.querySelectorAll<HTMLElement>('[data-anchor]')].find(
        (n) => n.dataset.anchor === anchor.id,
      );
      if (restored)
        scroller.scrollTop = oldTop + restored.getBoundingClientRect().top - anchor.offset;
    }
  }
  const dynamicRecords = fold('B站动态 · 最近读过', 'sm-focus-card');
  dynamicRecords.dataset.platform = 'bilibili';
  const dynamicBody = el('div', undefined, 'sm-focus-body');
  const dynamicPosts = fold('B站动态 · 发布记录', 'sm-focus-card');
  dynamicPosts.dataset.platform = 'bilibili';
  const dynamicPostBody = el('div', undefined, 'sm-focus-body');
  dynamicPosts.append(dynamicPostBody);
  dynamicRecords.append(dynamicBody);
  root.append(header, alert);
  if (settingsMode) {
    platformColumn.append(capabilities);
    root.append(feedback, settings, experiments!.element);
  } else {
    const layout = el('div', undefined, 'sm-record-layout');
    const side = el('aside', undefined, 'sm-rail sm-activity');
    side.append(
      el('h3', '互动概况'),
      overview,
      summary,
      focusPanel.element,
      douyinFocusPanel.element,
      groupRecords,
      dynamicRecords,
      dynamicPosts,
      capabilities,
    );
    layout.append(feed, side);
    root.append(layout);
  }
  let archivedRecords: Snapshot['outbox'] = [],
    archiveOffset = 0;
  const archiveButton = button(
    '查看较早发言',
    async () => {
      const r = await ctx.invoke<{ items: Snapshot['outbox'] }>('history', [50, archiveOffset]);
      archiveOffset += r.items.length;
      archivedRecords = [
        ...new Map([...archivedRecords, ...r.items].map((x) => [x.id, x])).values(),
      ];
      await refresh();
    },
    feed,
  );
  archiveButton.hidden = true;
  function link(label: string, url: string | undefined, parent: HTMLElement) {
    const href = safeBiliLink(url);
    if (!href) return;
    const a = el('a', label);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    parent.append(a);
  }
  function renderTimeline(state: Snapshot, reset = false) {
    lastState = state;
    for (const [key, b] of filterButtons)
      b.setAttribute('aria-pressed', String(activeFilter === key));
    const digest = JSON.stringify([
      state.recordsRevision ?? [state.inbox, state.outbox, state.videos, state.comments],
      archiveOffset,
      activeFilter,
      search.value,
      order.value,
      workPage,
      activeFilter === 'roam' ? state.roaming?.recent : undefined,
    ]);
    if (digest === lastDigest && !reset) return;
    if (
      timeline.contains(document.activeElement) &&
      document.activeElement instanceof HTMLInputElement
    )
      return;
    const scroller = scrollHost(),
      oldTop = scroller.scrollTop;
    const top = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
    const nearEdge = oldTop < 24;
    const visible = [...timeline.querySelectorAll<HTMLElement>('[data-anchor]')].find(
      (n) => n.getClientRects().length > 0 && n.getBoundingClientRect().bottom > top,
    );
    const anchor = visible
      ? { id: visible.dataset.anchor, offset: visible.getBoundingClientRect().top }
      : undefined;
    for (const n of timeline.querySelectorAll<HTMLDetailsElement>('.sm-video')) {
      if (n.dataset.autoExpansion === 'true') continue;
      if (n.open) expanded.add(n.dataset.groupKey!);
      else expanded.delete(n.dataset.groupKey!);
    }
    ctx.memo?.set('expanded-videos', [...expanded]);
    const opened = new Set(
      [...timeline.querySelectorAll<HTMLDetailsElement>('details[open]')].map(
        (n) => n.dataset.keepKey,
      ),
    );
    const all = buildInteractions(state.inbox, state.outbox, state.videos, state.comments),
      groups = filterInteractions(all, activeFilter, search.value);
    if (order.value === 'oldest') groups.reverse();
    if (!reset && (workPage > 0 || !nearEdge) && stableWorkKeys.length) {
      const positions = new Map(stableWorkKeys.map((key, index) => [key, index]));
      groups.sort(
        (a, b) =>
          (positions.get(a.key) ?? positions.size) - (positions.get(b.key) ?? positions.size),
      );
    }
    stableWorkKeys = groups.map((g) => g.key);
    const currentIds = new Set(
      all.flatMap((g) => g.threads.flatMap((t) => t.entries.map((e) => e.id))),
    );
    if (
      !reset &&
      (workPage > 0 || !nearEdge) &&
      latestIds.size &&
      [...currentIds].some((id) => !latestIds.has(id))
    )
      newest.hidden = false;
    latestIds = currentIds;
    lastDigest = digest;
    timeline.replaceChildren();
    const workPages = Math.max(1, Math.ceil(groups.length / 20));
    workPage = Math.max(0, Math.min(workPage, workPages - 1));
    workPager.hidden = groups.length === 0;
    renderPager(
      workPager,
      workPage,
      workPages,
      '共' + groups.length + '个作品 · 第' + (workPage + 1) + ' / ' + workPages + '页 · 每页20个',
      (page) => {
        workPage = page;
        lastDigest = '';
        if (lastState) renderTimeline(lastState, true);
        workPager.scrollIntoView({ block: 'start', behavior: 'auto' });
        workPager
          .querySelector<HTMLButtonElement>('[aria-current=page]')
          ?.focus({ preventScroll: true });
      },
    );
    for (const group of groups.slice(workPage * 20, (workPage + 1) * 20)) {
      const section = el('details', undefined, 'sm-video');
      section.dataset.platform = group.platform;
      section.dataset.groupKey = group.key;
      section.dataset.keepKey = 'video:' + group.key;
      section.dataset.autoExpansion = String(
        Boolean(search.value.trim()) || activeFilter === 'pending',
      );
      section.open = section.dataset.autoExpansion === 'true' || expanded.has(group.key);
      section.addEventListener(
        'toggle',
        () => {
          if (!section.isConnected) return;
          if (section.open) drawBody();
          else {
            for (const n of body?.querySelectorAll<HTMLDetailsElement>('details[open]') ?? [])
              opened.add(n.dataset.keepKey);
            body?.remove();
            body = undefined;
          }
          if (section.isConnected && section.dataset.autoExpansion !== 'true') {
            if (section.open) expanded.add(group.key);
            else expanded.delete(group.key);
            ctx.memo?.set('expanded-videos', [...expanded]);
          }
        },
        { signal: ctx.signal },
      );
      const head = el('summary', undefined, 'sm-video-header');
      head.dataset.anchor = 'video:' + group.key;
      const entries = group.threads.flatMap((t) => t.entries),
        sent = entries.filter((e) => e.direction === 'outgoing').length,
        waiting = entries.filter((e) => e.pending).length;
      head.setAttribute(
        'aria-label',
        group.video.title + '，' + sent + '条发言' + (waiting ? '，' + waiting + '条待回应' : ''),
      );
      const title = el('div');
      title.append(
        el(
          'span',
          (group.platform === 'douyin'
            ? '抖音'
              : group.platform === 'bilibili'
                ? '哔哩哔哩'
                : group.platform === 'tieba' ? '百度贴吧' : group.platform === 'xiaohongshu' ? '小红书' : group.platform) +
            ' · ' +
            sent +
            ' 条发言' +
            (waiting ? ' · ' + waiting + ' 条待回应' : ''),
          'sm-eyebrow sm-platform-label',
        ),
        el('h4', group.video.title),
      );
      if (group.video.author) title.append(el('small', group.video.author));
      const side = el('span', undefined, 'sm-video-side');
      side.append(el('time', prettyTime(group.latestAt)), el('span', '展开对话', 'sm-open-label'));
      head.append(title, side);
      section.append(head);
      let body: HTMLDivElement | undefined;
      const drawBody = () => {
        if (body) return;
        body = el('div', undefined, 'sm-video-body');
        section.append(body);
        const totalEntryPages = Math.max(1, Math.ceil(entries.length / 40));
        const entryPage = Math.max(
          0,
          Math.min(entryPages.get(group.key) ?? 0, totalEntryPages - 1),
        );
        entryPages.set(group.key, entryPage);
        const selected = new Set(
          [...entries]
            .sort(
              (a, b) =>
                (activeFilter === 'pending' ? Number(b.pending) - Number(a.pending) : 0) ||
                (order.value === 'oldest' ? a.at - b.at : b.at - a.at),
            )
            .slice(entryPage * 40, (entryPage + 1) * 40)
            .map((e) => e.id),
        );
        const open = el('div', undefined, 'sm-video-tools');
        link('打开视频 ↗', group.video.url, open);
        body.append(open);
        const threads = order.value === 'oldest' ? [...group.threads].reverse() : group.threads;
        for (const thread of threads) {
          const threadEl = el('div', undefined, 'sm-thread');
          for (const e of thread.entries) {
            if (!selected.has(e.id)) continue;
            const card = el('article', undefined, 'sm-event sm-' + e.direction);
            card.dataset.platform = group.platform;
            card.dataset.eventId = e.id;
            card.dataset.anchor = e.id;
            const meta = el('div', undefined, 'sm-event-meta');
            const tags = el('div', undefined, 'sm-tags');
            tags.append(el('span', e.kind, 'sm-tag'));
            tags.append(
              el(
                'span',
                e.status,
                'sm-tag ' +
                  (e.pending
                    ? 'sm-tag-wait'
                    : e.status === '访客可见'
                      ? 'sm-tag-good'
                      : ['仅自己可见', '未发出', '发送待核对'].includes(e.status)
                        ? 'sm-tag-note'
                        : ''),
              ),
            );
            if (e.inbox?.retryAt && Date.parse(e.inbox.retryAt) > Date.now()) {
              const tag = el('span', '稍后考虑', 'sm-tag sm-tag-quiet');
              tag.title = prettyTime(e.inbox.retryAt) + '后再考虑';
              tags.append(tag);
            }
            if (e.record?.roamId) tags.append(el('span', '闲逛', 'sm-tag sm-tag-quiet'));
            const when = el('time', prettyTime(e.at));
            when.dateTime = new Date(e.at).toISOString();
            meta.append(tags, when);
            card.append(
              meta,
              el('strong', e.direction === 'incoming' ? e.author : '我的发言', 'sm-speaker'),
            );
            if (
              e.quote?.text &&
              !thread.entries.some(
                (i) =>
                  selected.has(i.id) &&
                  i.direction === 'incoming' &&
                  i.target.parent === e.quote?.target.parent,
              )
            ) {
              const quote = el('blockquote');
              quote.append(
                el('span', e.quote.author ? '回复 ' + e.quote.author : '回复原评论', 'sm-muted'),
                el('p', e.quote.text),
              );
              card.append(quote);
            }
            if (e.text.length > 260) {
              const body = el('details', undefined, 'sm-long-message');
              body.dataset.keepKey = 'body:' + e.id;
              body.open = opened.has(body.dataset.keepKey);
              const summary = el('summary');
              const preview = el('span', e.text.slice(0, 110) + '…', 'sm-preview'),
                more = el('span', body.open ? '收起正文' : '展开全文', 'sm-more');
              summary.append(preview, more);
              body.append(summary, el('p', e.text, 'sm-body'));
              body.addEventListener(
                'toggle',
                () => {
                  more.textContent = body.open ? '收起正文' : '展开全文';
                },
                { signal: ctx.signal },
              );
              card.append(body);
            } else card.append(el('p', e.text, 'sm-body'));
            const actions = el('div', undefined, 'sm-event-actions');
            link(
              e.record && !e.record.receiptId ? '查看原楼层 ↗' : '定位这条评论 ↗',
              e.url,
              actions,
            );
            if (e.inbox?.status === 'pending')
              button(
                '标记已处理',
                async () => {
                  await ctx.invoke('handled', [e.inbox!.id]);
                  await refresh();
                },
                actions,
              );

            if (e.record?.status === 'unknown') {
              const receipt = el('input');
              receipt.placeholder = '核实后的评论编号';
              receipt.setAttribute('aria-label', '核实后的评论编号');
              actions.append(receipt);
              button(
                '已核实发布',
                async () => {
                  await ctx.invoke('resolve', [e.record!.id, 'sent', receipt.value]);
                  await refresh();
                },
                actions,
              );
              button(
                '已核实未发布',
                async () => {
                  await ctx.invoke('resolve', [e.record!.id, 'rejected']);
                  await refresh();
                },
                actions,
              );
            }
            if (e.inbox?.handling) card.append(el('p', e.inbox.handling.reason, 'sm-muted'));
            card.append(actions);
            if (e.record) {
              const r = e.record,
                detail = el('details', undefined, 'sm-receipt');
              detail.dataset.keepKey = e.id;
              detail.open = opened.has(e.id);
              detail.append(el('summary', '回执与发言前整理'));
              if (r.preparation) {
                detail.append(el('p', '发言目的：' + r.preparation.purpose));
                if (r.preparation.judgment)
                  detail.append(el('p', r.preparation.judgment.reason, 'sm-muted'));
                for (const advice of r.preparation.advice)
                  detail.append(el('p', advice, 'sm-muted'));
                if (r.preparation.video?.observation)
                  detail.append(el('p', r.preparation.video.observation, 'sm-muted'));
              }
              if (r.detail) detail.append(el('p', r.detail, 'sm-muted'));
              if (r.visibility)
                detail.append(
                  el('p', r.visibility.detail, 'sm-muted'),
                  el('small', '核验于 ' + prettyTime(r.visibility.checkedAt)),
                );
              detail.append(
                el(
                  'small',
                  (r.transport === 'api'
                    ? '接口发送'
                    : r.transport === 'browser'
                      ? '后台网页发送'
                      : '发送记录') + (r.receiptId ? ' · 评论 ' + r.receiptId : ''),
                ),
              );
              card.append(detail);
            }
            threadEl.append(card);
          }
          if (threadEl.childElementCount) body.append(threadEl);
        }
        if (totalEntryPages > 1) {
          const pager = el('nav', undefined, 'sm-toolbar sm-pagination sm-entry-pager');
          pager.setAttribute('aria-label', '对话分页');
          renderPager(
            pager,
            entryPage,
            totalEntryPages,
            '共' +
              entries.length +
              '条 · 第' +
              (entryPage + 1) +
              ' / ' +
              totalEntryPages +
              '页 · 每页40条',
            (page) => {
              entryPages.set(group.key, page);
              body?.remove();
              body = undefined;
              drawBody();
              head.scrollIntoView({ block: 'start', behavior: 'auto' });
              section
                .querySelector<HTMLButtonElement>('.sm-entry-pager [aria-current=page]')
                ?.focus({ preventScroll: true });
            },
          );
          body.append(pager);
        }
      };
      if (section.open) drawBody();
      timeline.append(section);
    }
    if (activeFilter === 'roam' && state.roaming?.recent.length) {
      const journal = el('section', undefined, 'sm-reading-notes');
      journal.append(el('h4', '最近读到的东西'));
      for (const r of state.roaming.recent) {
        const entry = el('article');
        entry.append(
          el('small', prettyTime(r.createdAt)),
          el(
            'p',
            r.summary ||
              (r.status === 'active'
                ? '正在阅读，稍后留下心得。'
                : r.status === 'offered'
                  ? '闲逛机会，等待选择。'
                  : '这轮没有留下心得。'),
          ),
        );
        for (const v of r.videos) link(v.title, v.url, entry);
        journal.append(entry);
      }
      timeline.append(journal);
    }
    if (!timeline.childElementCount)
      timeline.append(
        el(
          'p',
          search.value
            ? '没有找到对应互动。'
            : activeFilter === 'pending'
              ? '暂时没有需要回应的评论。'
              : activeFilter === 'sent'
                ? '还没有已发出的评论。'
                : activeFilter === 'roam'
                  ? '有空闲逛后，见闻和发言会留在这里。'
                  : '收到的评论与自己的发言，都会按视频和楼层留在这里。',
          'sm-empty',
        ),
      );
    if (reset) newest.hidden = true;
    else if (anchor) {
      const restored = [...timeline.querySelectorAll<HTMLElement>('[data-anchor]')].find(
        (n) => n.dataset.anchor === anchor.id,
      );
      if (restored) {
        const shift = restored.getBoundingClientRect().top - anchor.offset;
        scroller.scrollTop += shift;
      }
    }
  }
  async function perform(action: () => Promise<void>, b?: HTMLButtonElement) {
    if (b) b.disabled = true;
    alert.hidden = true;
    try {
      await action();
    } catch (e) {
      if (!ctx.signal.aborted) {
        alert.textContent = e instanceof Error ? e.message : '操作失败';
        alert.hidden = false;
      }
    } finally {
      if (b) b.disabled = b === hoursSave && !hoursDirty;
    }
  }
  function render(state: Snapshot) {
    renderEvidence(state);
    readDynamicsButton.disabled = !state.dynamics?.enabled;
    dynamicRecords.hidden = !state.dynamics?.items.length;
    dynamicBody.replaceChildren();
    for (const d of state.dynamics?.items ?? []) {
      const item = el('article', undefined, 'sm-entry');
      item.append(
        el('small', d.author + ' · ' + prettyTime(d.publishedAt * 1000)),
        el('p', (d.title ? d.title + '\n' : '') + d.text),
      );
      if (d.imageCount)
        item.append(el('small', d.imageCount + '张图片 · 本次只读取文字，未观察图片'));
      link('打开原动态', d.url, item);
      dynamicBody.append(item);
    }
    dynamicPosts.hidden = !state.dynamics?.posts?.length;
    dynamicPostBody.replaceChildren();
    for (const r of state.dynamics?.posts ?? []) {
      const item = el('article', undefined, 'sm-entry');
      const label = {
        prepared: '草稿待发布',
        sending: '正在提交',
        sent: '已受理',
        unknown: '结果待核实 · 不补发',
        rejected: '未提交 / 未获准',
      }[r.status];
      item.append(
        el(
          'small',
          prettyTime(r.attemptedAt ?? r.createdAt) +
            ' · ' +
            (r.autonomous ? '自主动态 · ' : '') +
            label,
        ),
        el('p', (r.mention ? '@' + r.mention.name + ' ' : '') + r.text),
      );
      if (r.detail) item.append(el('small', r.detail));
      link('打开这条动态', r.url, item);
      dynamicPostBody.append(item);
    }
    renderGroups(state);
    const p = state.platforms.find((p) => p.id === 'bilibili');
    const dy = state.platforms.find((p) => p.id === 'douyin');
    for (const [id, tab] of platformButtons) {
      const platform = state.platforms.find((entry) => entry.id === id);
      const publicState = isPublicPostPlatform(id) ? state.publicPlatforms?.[id] : undefined;
      const badge = tab.querySelector('small')!;
      const status = !platform?.enabled ? '未启用' : platform.error || publicState?.paused ? '连接待检查'
        : platform.account && (publicState?.bound ?? true) ? '已连接' : '已启用 · 登录待核对';
      badge.textContent = status;
      badge.dataset.connected = String(Boolean(platform?.enabled && status === '已连接'));
    }
    refreshSaveHints();
    dyControls.render(state);
    experiments?.renderPublic(
      state.publicPlatforms,
      state.platforms.find(platform => platform.id === 'xiaohongshu')?.publishing?.ownerCommentsToday,
    );
    const biliFocus = state.focusPlatforms?.bilibili ?? state.focus;
    const dyFocus = state.focusPlatforms?.douyin;
    const biliOwnerCount = p?.publishing?.ownerCommentsToday;
    const dyOwnerCount = dy?.publishing?.ownerCommentsToday;
    focusPanel.render(biliFocus, p?.enabled ?? true, biliOwnerCount);
    douyinFocusPanel.render(dyFocus, dy?.enabled ?? true, dyOwnerCount);
    for (const [node, focus, platformEnabled, ownerCount] of [
      [biliFocusStatus, biliFocus, p?.enabled ?? true, biliOwnerCount],
      [douyinFocusStatus, dyFocus, dy?.enabled ?? true, dyOwnerCount],
    ] as const) {
      const view = focusStatus(focus, platformEnabled, ownerCount);
      node.textContent = view.label + '\n' + view.detail;
      node.dataset.state = view.tone;
      node.classList.add('sm-focus-status');
      node.setAttribute('role', 'status');
      const summary = node.parentElement?.querySelector('summary');
      if (summary) {
        const badge = summary.querySelector('.sm-fold-status') ?? el('span', '', 'sm-fold-status');
        badge.textContent = view.label;
        summary.append(badge);
      }
    }
    if (
      settingsMode &&
      state.config &&
      ![...extraInputs.values()].includes(document.activeElement as HTMLInputElement)
    ) {
      for (const [path, input] of extraInputs) {
        if (dirtyExtras.has(path)) continue;
        const parts = path.slice('worlds.socialmedia.'.length).split('.');
        let value: unknown = state.config;
        for (const part of parts) value = (value as Record<string, unknown>)?.[part];
        if (parts[0] === 'platforms' && parts[2] === 'roaming') {
          const key = parts[3] as keyof RoamingConfig;
          value =
            key === 'enabled'
              ? (state.config.platforms[parts[1]].roaming?.enabled ?? true)
              : roamingConfig(state.config, parts[1])[key];
        }
        if (path.endsWith('.outsideReplyLimit')) value ??= 5;
        if (path.endsWith('.visualDaily')) value ??= 'inherit';
        if (path.endsWith('.corpusWeight')) value ??= state.config.experiments?.corpus ? 'medium' : 'off';
        if (input instanceof HTMLInputElement && input.type === 'checkbox')
          input.checked = Boolean(value);
        else input.value = String(value ?? '');
      }
    }
    syncVisualControls();
    for (const path of numberControls.keys()) syncNumberPreset(path);
    enabled.checked = p?.enabled ?? state.config?.platforms.bilibili?.enabled ?? false;
    monitor.checked = p?.monitor ?? state.config?.platforms.bilibili?.monitor.enabled ?? false;
    posting.checked = p?.posting ?? state.config?.platforms.bilibili?.posting.enabled ?? false;
    const r = state.roaming;
    for (const [id, card] of roamCards) {
      const policy =
        r?.platforms?.[id]?.limits ?? (state.config ? roamingConfig(state.config, id) : undefined);
      const used = r?.platforms?.[id]?.usedToday ?? 0;
      roamStatuses.get(id)!.textContent = policy
        ? (policy.enabled ? '已开启' : '总开关或平台闲逛未开启') +
          ' · ' +
          (policy.mode === 'free'
            ? '放养 · 今日已逛' + used + '轮'
            : '今日' + used + '/' + policy.maxDailySessions + '轮') +
          ' · 空闲' +
          policy.idleMinutes +
          '分钟后，间隔' +
          policy.minIntervalMinutes +
          '分钟'
        : '沿用统一默认';
      const summary = card.querySelector('summary')!;
      let badge = summary.querySelector<HTMLElement>('.sm-fold-status');
      if (!badge) { badge = el('span', '', 'sm-fold-status'); summary.append(badge); }
      badge.textContent = !policy ? '' : !policy.enabled ? '关闭' : '空闲 ' + policy.idleMinutes + ' 分钟 · 间隔 ' + policy.minIntervalMinutes + ' 分钟';
      for (const b of card.querySelectorAll<HTMLButtonElement>('[data-roam-preset]')) {
        const preset = ROAMING_PRESETS[b.dataset.roamPreset as keyof typeof ROAMING_PRESETS];
        b.setAttribute(
          'aria-pressed',
          String(
            Boolean(policy) &&
              Object.entries(preset).every(
                ([k, v]) =>
                  (k === 'mode'
                    ? (policy!.mode ?? 'bounded')
                    : policy![k as keyof RoamingConfig]) === v,
              ),
          ),
        );
      }
    }
    const hours = { ...DEFAULT_ACTIVE_HOURS, ...state.config?.activeHours };
    if (!hoursDirty) {
      hoursOn.checked = hours.enabled;
      startTime.value = hours.start;
      endTime.value = hours.end;
      hoursFields.hidden = !hours.enabled;
      hoursSave.disabled = true;
    }
    hoursBadge.textContent = hours.enabled && hours.start !== hours.end ? hours.start + '–' + hours.end : '全天';
    hoursStatus.textContent = (hours.enabled && hours.start !== hours.end
      ? (state.activeHours?.open === false ? '休息中' : '活跃时段') + ' · ' + hours.start + '–' + hours.end
      : '全天可活动') + (state.activeHours?.timezone ? ' · ' + state.activeHours.timezone : '');
    roamingEnabled.checked = r?.enabled ?? false;
    roamSummary.textContent = !r
      ? '正在读取闲逛状态…'
      : r.enabled
        ? '已开启 · 各平台独立计数，按各自等待轮流闲逛'
        : '已暂停发起新闲逛，各平台设置会保留。';
    idleSample = typeof r?.idleSeconds === 'number' && typeof r.idle === 'boolean'
      ? { seconds: r.idleSeconds, idle: r.idle, at: Date.now() } : undefined;
    updateIdleClock();
    roamPlatformStates.replaceChildren();
    for (const [id, title] of platformPanels) {
      const policy =
        r?.platforms?.[id]?.limits ?? (state.config ? roamingConfig(state.config, id) : undefined);
      const chip = el(
        'span',
        title +
          ' · ' +
          (policy?.enabled ? (policy.mode === 'free' ? '放养' : '按额度闲逛') : '暂停') +
          ' · 今日' +
          (r?.platforms?.[id]?.usedToday ?? 0) +
          '轮',
        'sm-platform-state',
      );
      chip.dataset.platform = id;
      roamPlatformStates.append(chip);
    }
    summary.textContent = `${p?.account ? 'B站已连接' : p?.enabled ? 'B站待连接' : 'B站未启用'} · ${p?.account?.name ?? (state.credentialSaved ? '已保存登录' : '尚未登录')}${p?.lastPollAt ? ' · 最近同步 ' + prettyTime(p.lastPollAt) : ''}`;
    summary.textContent += dy?.enabled
      ? ' · 抖音' + (dy.account ? '已登录 · ' + dy.account.name : '已启用')
      : '';
    connectionSummary.textContent = p?.account
      ? '已登录 ' + p.account.name + (p.lastPollAt ? ' · 最近同步 ' + prettyTime(p.lastPollAt) : '')
      : p?.enabled
        ? '已启用 · 等待核对登录'
        : '未启用';
    const browserResult = diagnosticRows.get('检查网页发评')!;
    if (browserResult.hidden && state.publishing?.browser.detail) {
      browserResult.hidden = false;
      browserResult.dataset.state = state.publishing.browser.ready ? 'success' : 'error';
      browserResult.textContent =
        '最近网页状态 · ' +
        state.publishing.browser.detail +
        (state.publishing.browser.checkedAt
          ? ' · ' + prettyTime(state.publishing.browser.checkedAt)
          : '');
    }
    if (state.publishing)
      hint.textContent =
        state.publishing.transport === 'browser'
          ? '开关即时保存；发评浏览器按需启动，空闲后自动关闭。' +
            (!state.publishing.browser.available ? ' 未找到浏览器，请在配置中填写程序路径。' : '')
          : '当前使用接口直发（实验）；以访客核验为准，公开状态不明时不会重复发评。';
    const error = state.lastError || p?.error;
    if (error) {
      alert.textContent = error;
      alert.hidden = false;
    }
    metrics.get('待回应')!.textContent = String(state.pending);
    metrics.get('已发出')!.textContent = String(
      state.stats?.sent ?? state.outbox.filter((r) => r.status === 'sent').length,
    );

    metrics.get('今日闲逛')!.textContent = r ? r.usedToday + '轮' : '—';
    const rsrc = state.resources;
    if (rsrc) {
      const mb = (n: number) => (n / 1048576).toFixed(1) + 'MB';
      for (const [id, usage] of learningUsage) {
        const mode = state.config?.platforms[id]?.visualDaily ?? 'inherit';
        const unlimited = mode === 'inherit' ? rsrc.unlimitedDailyVisualCalls : mode === 'unlimited';
        usage.textContent = rsrc.maxDailyVisualCalls === 0 ? '全局画面已关闭' :
          '本站今日已看 ' + (rsrc.byPlatform?.[id] ?? 0) + ' 次 · ' +
          (unlimited ? '每日不限次数' : '本站上限 ' + rsrc.maxDailyVisualCalls + ' 次');
      }
      visualToday.textContent = rsrc.maxDailyVisualCalls === 0
        ? '画面已关闭 · 今日已看 ' + rsrc.todayCalls + ' 次'
        : '今天已看 ' + rsrc.todayCalls +
          (rsrc.byPlatform ? ' 次 · 各平台独立计数' :
            (rsrc.unlimitedDailyVisualCalls ? ' 次 · 每日次数不限' : ' / ' + rsrc.maxDailyVisualCalls + ' 次'));
      resourceStatus.textContent =
        '图片缓存 ' +
        mb(rsrc.cacheBytes) +
        ' · 累计图片交付 ' +
        mb(rsrc.publishedBytes) +
        ' / ' +
        mb(rsrc.maxPublishedBytes) +
        ' · 归档 ' +
        rsrc.history.count +
        ' 条 / ' +
        mb(rsrc.history.bytes);
      archiveButton.hidden = rsrc.history.count === 0;
      archiveButton.disabled = archiveOffset >= rsrc.history.count;
      archiveButton.textContent =
        archiveOffset >= rsrc.history.count
          ? '较早记录已全部加载'
          : '查看较早发言（已加载' + archiveOffset + '条）';
    }
    if (!settingsMode)
      renderTimeline({
        ...state,
        outbox: archivedRecords.length
          ? [...new Map([...archivedRecords, ...state.outbox].map(r => [r.id, r])).values()]
              .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
          : state.outbox,
      });
  }
  type Records = Pick<Snapshot, 'inbox' | 'outbox' | 'videos' | 'comments'>;
  let records: Records = { inbox: [], outbox: [] };
  let recordsRevision: string | undefined;
  async function refresh() {
    if (refreshing || ctx.signal.aborted) return;
    refreshing = true;
    try {
      const s = await ctx.invoke<Omit<Snapshot, keyof Records> & Partial<Records>>(
        'status', ['compact', recordsRevision ?? null],
      );
      if (ctx.signal.aborted) return;
      if (s.inbox && s.outbox) {
        records = { inbox: s.inbox, outbox: s.outbox, videos: s.videos, comments: s.comments };
        recordsRevision = s.recordsRevision;
      }
      render({ ...s, ...records });
    } finally {
      refreshing = false;
    }
  }
  void perform(refresh);
  ctx.interval(() => {
    if (qrActive && !qrPolling) {
      qrPolling = true;
      void perform(async () => {
        try {
          const r = await ctx.invoke<{ status: string }>('loginPoll');
          if (r.status === 'success') {
            qrActive = false;
            loginBox.hidden = true;
            await refresh();
          } else if (r.status === 'expired' || r.status === 'error') {
            qrActive = false;
            qrHint.textContent = '二维码已失效，请重新获取。';
          } else if (r.status === 'scanned') qrHint.textContent = '已扫码，请在手机上确认。';
        } finally {
          qrPolling = false;
        }
      });
    }
  }, 3000);
  ctx.interval(() => void perform(refresh), 10000);
}
export const mountSettings = (ctx: WebUiPanelContext) => mount(ctx, true);
export default { panels: { desk: { mount }, settings: { mount: mountSettings } } };

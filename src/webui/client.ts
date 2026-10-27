import type { GroupChats } from '../group-chat.ts';
import type { PublicDynamic } from '../platforms/bilibili-dynamics.ts';
import { focusView, focusStatus, type FocusSnapshot } from './focus.ts';
import {
  buildInteractions,
  filterInteractions,
  safeBiliLink,
  type InteractionFilter,
} from '../interactions.ts';
import {
  ROAMING_PRESETS,
  roamingConfig,
  SOCIALMEDIA_CONFIG_GROUP,
  type SocialMediaConfigSection,
  type RoamingConfig,
} from '../config.ts';
import type { RoamSession } from '../roaming.ts';
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { InboxItem, SendRecord, PublicVideo, PublicComment } from '../platform.ts';
import './style.css';
interface Snapshot {
  dynamics?: { enabled: boolean; readsToday: number; limit: number; items: PublicDynamic[] };
  groupChat?: ReturnType<GroupChats['status']> & { error?: string };
  resources?: {
    todayCalls: number;
    maxDailyVisualCalls: number;
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
  kuaishou?: { running: boolean; loginOpen: boolean; detail: string };
  focus?: FocusSnapshot;
  focusPlatforms?: Record<string, FocusSnapshot>;
  config?: SocialMediaConfigSection;
  videos?: PublicVideo[];
  comments?: PublicComment[];
  stats?: { sent: number; unconfirmed: number };
  douyin?: { running: boolean; loginOpen: boolean; detail: string };
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
  }>;
  inbox: InboxItem[];
  outbox: SendRecord[];
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
  function fold(title: string, cls = 'sm-subsection') {
    const details = el('details', undefined, cls);
    details.append(el('summary', title));
    return details;
  }
  const header = el('header');
  header.append(
    el('h2', settingsMode ? '按你的节奏，出去看看' : '在这里聊过'),
    el(
      'p',
      settingsMode ? '账号、闲逛与交流边界，都在这里。' : '按视频收好每一次接话。',
      'sm-muted',
    ),
  );
  const capabilities = fold('平台能力与限制 · B站 / 抖音 / 快手', 'sm-subsection sm-capabilities');
  capabilities.append(
    el(
      'p',
      '三个平台的能力各不相同。展开查看当前支持范围；开启平台或发布权限不会解锁尚未接入的功能。',
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
          '动态可读文字与图片数量，暂不创建动态；动态评论与主动@目前仅接口实验路径，默认网页仍只发视频评论。普通群聊未接入，画面采样另需FFmpeg。',
        ],
      ],
    ],
    [
      'douyin',
      '抖音 · 实验',
      [
        [
          '可用',
          '官网可访问的视频、图文与评论；精确楼中楼回复、推荐流闲逛、特别关注；本地指定群的监听与发言。',
        ],
        ['边界', '完整字幕、全站回复及@通知未接入。群聊须单独启用并核对目标；不是监听所有群。'],
      ],
    ],
    [
      'kuaishou',
      '快手 · 实验',
      [
        [
          '可用',
          '普通视频详情与评论；主评论通过官网原生评论框发送；首屏搜索、推荐候选、已核实视频的特别关注。',
        ],
        [
          '楼中楼',
          '可以尝试精确回复，但仍走实验接口，他人可见性尚未完成验收，不能按主评论效果保证。',
        ],
        [
          '未支持',
          '普通群聊、图文自动发评、画面采样、字幕和全站通知。准确图文链接有时可单独读评论，不代表能发评。',
        ],
        [
          '作品检查',
          '官网作品列表可能不完整；“作品检查未完成”不等于没有作品或没有新评论，也不能保证覆盖所有图文。',
        ],
      ],
    ],
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
      '使用须知：各平台分别登录、设置特别关注并授权发评。新评论采用有限范围轮询，不是全量实时推送；返回评论编号只代表平台受理，不保证其他账号可见。浏览器后台模式仍会占用资源；抖音默认任务结束立即释放，快手空闲后关闭，登录资料保留。',
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
  roamSection.append(
    el('h3', '闲逛总开关'),
    roamingEnabled.parentElement!,
    roamSummary,
    roamPlatformStates,
    el(
      'small',
      '总开关控制是否发起闲逛；活跃度和等待时间只在各平台设置。新消息到来时收好当前一步，再回归聊天。',
    ),
  );
  function browserPlatform(id: 'douyin' | 'kuaishou', title: string, description: string) {
    const section = el('section', undefined, 'sm-config-section sm-platform-card');
    section.dataset.platform = id;
    section.append(el('h3', title + ' · 账号与交流'), el('p', description, 'sm-muted'));
    const enabled = toggle(
      '启用' + title + '（实验）',
      'worlds.socialmedia.platforms.' + id + '.enabled',
    );
    const posting = toggle(
      '允许' + title + '公开发评',
      'worlds.socialmedia.platforms.' + id + '.posting.enabled',
    );
    const status = el('p', '尚未检查' + title + '连接', 'sm-summary');
    status.setAttribute('aria-live', 'polite');
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
            const r = await ctx.invoke<{ detail: string }>(
              method,
              read ? [input.value.trim()] : [],
            );
            status.textContent = r.detail;
            await refresh();
          } catch (e) {
            status.textContent = e instanceof Error ? e.message : '操作未完成';
            throw e;
          }
        },
        buttons,
      );
    action('打开' + title + '登录窗口', id + 'Login');
    action('完成' + title + '登录', id + 'FinishLogin');
    action('关闭' + title + '登录窗口', id + 'Close');
    const readButton = action('测试' + title + '读取', id + 'Check', true);
    const checks = fold('读取与连接检查', 'sm-subsection sm-connection-check');
    checks.append(el('p', '检查指定作品和评论，不会发布内容。', 'sm-muted'), input, readButton);
    const switches = el('div', undefined, 'sm-controls');
    switches.append(enabled.parentElement!, posting.parentElement!);
    section.append(status, switches, buttons, checks);
    return {
      section,
      status,
      input,
      enabled,
      posting,
      render(state: Snapshot) {
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
  const ksControls = browserPlatform(
    'kuaishou',
    '快手',
    '普通视频评论区可发主评论；楼中楼为实验功能，他人可见性未完成验收。群聊未接入，图文不支持自动发评；作品列表可能不完整。',
  );
  const douyinSection = dyControls.section;
  const kuaishouSection = ksControls.section;
  const kuaishouFocusSection = el('details', undefined, 'sm-subsection sm-platform-focus');
  kuaishouFocusSection.append(
    el('summary', '快手特别关注'),
    el(
      'p',
      '填写主人完整主页或快手号，搜索后核实公开主页上的号码。仅监测官网能返回并核实的普通视频，不支持图文自动回应；“作品检查未完成”不代表账号没有作品或没有新评论。',
      'sm-muted',
    ),
  );
  const kuaishouFocusStatus = el('p', '', 'sm-muted');
  kuaishouFocusSection.append(kuaishouFocusStatus);
  const settings = el('div', undefined, 'sm-settings');
  accountSection.append(toolbar, connectionResults, loginBox);
  const extraInputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
  const dirtyExtras = new Set<string>();
  type SaveScope = 'bilibili' | 'douyin' | 'kuaishou' | 'resources';
  const saveHints = new Map<string, HTMLElement>();
  function settingScope(key: string): SaveScope {
    if (key.startsWith('worlds.socialmedia.media.')) return 'resources';
    if (
      key.startsWith('worlds.socialmedia.platforms.douyin.') ||
      key.startsWith('worlds.socialmedia.douyinBrowser.')
    )
      return 'douyin';
    if (
      key.startsWith('worlds.socialmedia.platforms.kuaishou.') ||
      key.startsWith('worlds.socialmedia.kuaishouBrowser.')
    )
      return 'kuaishou';
    return 'bilibili';
  }
  function refreshSaveHints() {
    for (const [id, hint] of saveHints) {
      const n = [...dirtyExtras].filter((k) => settingScope(k) === id).length;
      hint.textContent = n ? n + '项修改待保存' : '无待保存修改';
    }
  }

  const extraSection = el('details', undefined, 'sm-subsection sm-platform-limits');
  extraSection.append(
    el('summary', '回应与发布额度'),
    el(
      'p',
      '主人评论自动回应单独计账，不占这里的普通额度；普通通知与闲逛分别计数，共用普通发布上限，普通渠道同一人每天最多五条。',
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
  const resourceSection = el('section', undefined, 'sm-config-section');
  resourceSection.append(
    el('h3', '观察与资源'),
    el(
      'p',
      '默认先读文字与原评论，需要理解画面时再采样。图片缓存可回收；Cortico历史附件由宿主管理，累计图片预算只控制本World的新增交付。',
      'sm-muted',
    ),
  );
  const resourceAdvanced = el('details', undefined, 'sm-advanced');
  resourceAdvanced.append(el('summary', '容量与保留策略'));
  resourceSection.append(resourceAdvanced);
  const resourceStatus = el('p', '正在读取资源用量…', 'sm-summary'),
    resourceFeedback = el('p', '', 'sm-muted');
  resourceSection.append(resourceStatus, resourceFeedback);
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
  const kuaishouLimits = fold('发言额度', 'sm-subsection sm-platform-limits');
  const douyinAdvanced = fold('连接选项', 'sm-subsection sm-platform-advanced');
  const groupSection = fold('群聊监听', 'sm-subsection sm-group-settings');
  const groupStatus = el('p', '尚未开启群聊监听', 'sm-muted');
  groupSection.append(
    groupStatus,
    el(
      'p',
      '只监听你填写的群。首次保存后检查，固定真实会话；旧消息只作上下文。监听期间需保留后台浏览器，不弹窗口。',
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
  const kuaishouAdvanced = fold('连接选项', 'sm-subsection sm-platform-advanced');
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
  const dynamicFeedback = el('p', '动态读取默认关闭；仅记录已核实文字和图片数量。', 'sm-muted');
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
  const kuaishouFocusTiming = fold('检查范围与频率');
  focusSection.append(biliFocusTiming);
  douyinFocusSection.append(douyinFocusTiming);
  kuaishouFocusSection.append(kuaishouFocusTiming);
  const isFocusPrimary = (path: string) =>
    /\.(enabled|account|autoReplyNewComments|replyExistingComments)$/.test(path);
  const roamCards = new Map<string, HTMLDetailsElement>();
  const roamFields = new Map<string, HTMLDetailsElement>();
  const roamStatuses = new Map<string, HTMLParagraphElement>();
  for (const [id, title] of [
    ['bilibili', 'B站'],
    ['douyin', '抖音'],
    ['kuaishou', '快手'],
  ] as const) {
    const card = fold('闲逛与活跃度', 'sm-subsection sm-platform-roaming'),
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
        el('small', key === 'free' ? '阅读不限量' : values.maxDailySessions + '轮/天'),
      );
    }
    const fields = fold('自定义等待与额度');
    card.append(
      status,
      el(
        'p',
        '总开关开启后，此平台独立使用自己的等待与额度。放养仅放开阅读，发评上限保持不变。',
        'sm-muted',
      ),
      choices,
      fields,
    );
    roamCards.set(id, card);
    roamFields.set(id, fields);
    roamStatuses.set(id, status);
  }
  const excluded = new Set([
    'worlds.socialmedia.platforms.kuaishou.enabled',
    'worlds.socialmedia.platforms.kuaishou.posting.enabled',
    'worlds.socialmedia.platforms.douyin.enabled',
    'worlds.socialmedia.platforms.douyin.posting.enabled',
    'worlds.socialmedia.platforms.bilibili.enabled',
    'worlds.socialmedia.platforms.bilibili.monitor.enabled',
    'worlds.socialmedia.platforms.bilibili.posting.enabled',
  ]);
  for (const [path, prop] of Object.entries(SOCIALMEDIA_CONFIG_GROUP.schema.properties)) {
    if (path.startsWith('worlds.socialmedia.roaming.') || excluded.has(path)) continue;
    const roamPath = path.match(
      /^worlds\.socialmedia\.platforms\.(bilibili|douyin|kuaishou)\.roaming\.(.+)$/,
    );
    const parent =
      path.startsWith('worlds.socialmedia.platforms.bilibili.dynamics.') ||
      /^worlds\.socialmedia\.focus\.(allowMentions|maxDailyMentions)$/.test(path)
        ? biliSocial
        : path.startsWith('worlds.socialmedia.platforms.douyin.chat.')
          ? groupSection
          : roamPath
            ? ['enabled', 'mode', 'idleMinutes', 'minIntervalMinutes'].includes(roamPath[2])
              ? roamCards.get(roamPath[1])!
              : roamFields.get(roamPath[1])!
            : path.startsWith('worlds.socialmedia.media.')
              ? ['textFirst', 'maxDailyVisualCalls', 'maxFrames'].includes(path.split('.').at(-1)!)
                ? resourceSection
                : resourceAdvanced
              : path.startsWith('worlds.socialmedia.focus.')
                ? isFocusPrimary(path)
                  ? focusSection
                  : biliFocusTiming
                : path.startsWith('worlds.socialmedia.platforms.douyin.focus.')
                  ? isFocusPrimary(path)
                    ? douyinFocusSection
                    : douyinFocusTiming
                  : path.startsWith('worlds.socialmedia.platforms.kuaishou.focus.')
                    ? isFocusPrimary(path)
                      ? kuaishouFocusSection
                      : kuaishouFocusTiming
                    : path.startsWith('worlds.socialmedia.platforms.kuaishou.') ||
                        path.startsWith('worlds.socialmedia.kuaishouBrowser.')
                      ? path.startsWith('worlds.socialmedia.kuaishouBrowser.')
                        ? kuaishouAdvanced
                        : kuaishouLimits
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
    copy.append(el('strong', prop.title));
    if (prop.description) copy.append(el('small', prop.description));
    let input: HTMLInputElement | HTMLSelectElement;
    if (prop.enum) {
      const select = el('select');
      for (const v of prop.enum) {
        const o = el(
          'option',
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
        feedback.hidden = true;
      },
      { signal: ctx.signal },
    );
    extraInputs.set(path, input);
    label.append(copy, input);
    parent.append(label);
  }
  const saveExtras = async (scope: SaveScope) => {
    const values: Record<string, unknown> = {};
    for (const [key, input] of extraInputs) {
      if (settingScope(key) !== scope) continue;
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
    if (prefix && values[prefix + 'autoReplyNewComments']) values[prefix + 'enabled'] = true;
    await saveConfig('world:socialmedia', values);
    for (const key of Object.keys(values)) dirtyExtras.delete(key);
    refreshSaveHints();
    await refresh();
    if (prefix && focusChanged && values[prefix + 'enabled'] && values[prefix + 'account']) {
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
  button('保存观察与资源设置', () => saveExtras('resources'), resourceSection);
  resourceSection.append(maintenance);
  function platformSave(id: 'bilibili' | 'douyin' | 'kuaishou', title: string) {
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
    saveDouyin = platformSave('douyin', '抖音'),
    saveKuaishou = platformSave('kuaishou', '快手');
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
  accountSection.append(
    roamCards.get('bilibili')!,
    focusSection,
    biliSocial,
    extraSection,
    advanced,
    saveBilibili,
  );
  douyinSection.append(
    roamCards.get('douyin')!,
    douyinFocusSection,
    groupSection,
    douyinLimits,
    douyinAdvanced,
    saveDouyin,
  );
  kuaishouSection.append(
    roamCards.get('kuaishou')!,
    kuaishouFocusSection,
    kuaishouLimits,
    kuaishouAdvanced,
    saveKuaishou,
  );
  const platformTabs = el('div', undefined, 'sm-platform-tabs');
  platformTabs.setAttribute('role', 'tablist');
  platformTabs.setAttribute('aria-label', '平台配置');
  const platformPanels = [
    ['bilibili', '哔哩哔哩', accountSection],
    ['douyin', '抖音', douyinSection],
    ['kuaishou', '快手', kuaishouSection],
  ] as const;
  const platformButtons = new Map<string, HTMLButtonElement>();
  const prefix = settingsMode ? 'sm-settings' : 'sm-detached';
  function selectPlatform(id: string) {
    for (const [key, , panel] of platformPanels) {
      const selected = key === id,
        tab = platformButtons.get(key)!;
      panel.hidden = !selected;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    ctx.memo?.set('settings-platform', id);
  }
  for (const [id, title, panel] of platformPanels) {
    const tab = el('button', title);
    tab.type = 'button';
    tab.dataset.platform = id;
    tab.id = prefix + '-tab-' + id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', prefix + '-panel-' + id);
    panel.id = prefix + '-panel-' + id;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    tab.addEventListener('click', () => selectPlatform(id), { signal: ctx.signal });
    tab.addEventListener(
      'keydown',
      (event) => {
        const keys = platformPanels.map(([key]) => key),
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
    platformTabs.append(tab);
  }
  const remembered = ctx.memo?.get<string>('settings-platform', 'bilibili');
  selectPlatform(platformButtons.has(remembered ?? '') ? remembered! : 'bilibili');
  settings.append(
    roamSection,
    platformTabs,
    accountSection,
    douyinSection,
    kuaishouSection,
    resourceSection,
  );
  ctx.guardLeave?.(() => (dirtyExtras.size ? '还有未保存的设置，离开将放弃这些修改。' : null));
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
  feedHeading.append(
    el('h3', '视频与对话'),
    el('span', '点开一条视频，查看这里的完整交流。', 'sm-muted'),
  );
  const feedToolbar = el('div', undefined, 'sm-feed-toolbar'),
    filters = el('div', undefined, 'sm-filters');
  filters.setAttribute('aria-label', '互动筛选');
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
      lastDigest = '';
      if (lastState) renderTimeline(lastState, true);
    },
    { signal: ctx.signal },
  );
  const newest = button(
    '有新动态 · 回到最新',
    async () => {
      order.value = 'newest';
      lastDigest = '';
      if (lastState) renderTimeline(lastState, true);
      feed.scrollIntoView({ block: 'start', behavior: 'auto' });
    },
    feedToolbar,
  );
  newest.hidden = true;
  feedToolbar.prepend(filters, search, order);
  const timeline = el('div', undefined, 'sm-list sm-timeline');

  timeline.setAttribute('aria-label', '互动时间线');
  feed.append(feedHeading, feedToolbar, timeline);
  const kuaishouFocusPanel = focusView(
    async () => {
      await perform(async () => {
        await ctx.invoke('focusRefresh', ['kuaishou']);
        await refresh();
      });
    },
    ctx.signal,
    '快手特别关注',
    'kuaishou',
  );
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
  const groupRecords = fold('抖音群 · 对话记录', 'sm-platform sm-group-records');
  groupRecords.dataset.platform = 'douyin';
  const groupRecordBody = el('div');
  groupRecords.append(groupRecordBody);
  let groupDigest = '';
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
            ({ quiet: '安静', balanced: '均衡', active: '活跃' }[chat.activity] ?? '均衡')
          : '请填写并保存群号与群名'));
    groupRecords.hidden = !chat?.groups.length;
    const digest = JSON.stringify(chat);
    if (digest === groupDigest) return;
    groupDigest = digest;
    const open = new Set(
      [...groupRecordBody.querySelectorAll<HTMLDetailsElement>('details[open]')].map(
        (d) => d.dataset.groupId,
      ),
    );
    groupRecordBody.replaceChildren();
    for (const g of chat?.groups ?? []) {
      const card = fold(g.name + ' · ' + g.id, 'sm-subsection');
      card.dataset.groupId = g.id;
      card.open = open.has(g.id);
      card.append(
        el(
          'p',
          ({
            disabled: '已关闭',
            unbound: '尚未绑定',
            online: '读取正常',
            retrying: '等待重连',
            verification: '等待登录或人工验证',
            stale: '最近读取已过期',
          }[g.connection] ?? '状态待检查') +
            (g.checkedAt ? ' · 最近成功 ' + prettyTime(g.checkedAt) : '') +
            (g.retryAt ? ' · 下次重试 ' + prettyTime(g.retryAt) : '') +
            (g.error ? ' · ' + g.error : ''),
          'sm-muted',
        ),
      );
      const outgoing = chat!.outbox.filter((r) => r.groupId === g.id);
      const combined = [
        ...g.messages.map((m) => ({
          id: m.id,
          text: m.text,
          time: m.time,
          who: m.own ? '我' : m.sender || '群友',
          note: m.system ? '群提示' : '',
        })),
        ...outgoing
          .filter((r) => !r.messageId || !g.messages.some((m) => m.id === r.messageId))
          .map((r) => ({
            id: r.id,
            text: r.text,
            time: r.time,
            who: '我',
            note:
              r.status === 'sent' ? '已受理' : r.status === 'not_submitted' ? '未提交' : '待核实',
          })),
      ]
        .filter((m) => m.text)
        .sort((a, b) => b.time - a.time)
        .slice(0, 35);
      for (const r of combined) {
        const item = el('article', undefined, 'sm-entry');
        item.append(
          el('small', prettyTime(r.time) + ' · ' + r.who + (r.note ? ' · ' + r.note : '')),
          el('p', r.text),
        );
        card.append(item);
      }
      if (!combined.length) card.append(el('p', '尚无群对话记录。', 'sm-muted'));
      groupRecordBody.append(card);
    }
  }
  const dynamicRecords = fold('B站动态 · 最近读过', 'sm-focus-card');
  dynamicRecords.dataset.platform = 'bilibili';
  const dynamicBody = el('div', undefined, 'sm-focus-body');
  dynamicRecords.append(dynamicBody);
  if (settingsMode) root.append(header, capabilities, alert, feedback, settings);
  else
    root.append(
      header,
      capabilities,
      alert,
      summary,
      overview,
      focusPanel.element,
      douyinFocusPanel.element,
      kuaishouFocusPanel.element,
      groupRecords,
      dynamicRecords,
      feed,
    );
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
      state.inbox,
      state.outbox,
      state.videos,
      state.comments,
      activeFilter,
      search.value,
      order.value,
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
    const existingKeys = [...timeline.querySelectorAll<HTMLElement>('.sm-video')].map(
      (n) => n.dataset.groupKey,
    );
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
    if (!reset && existingKeys.length)
      groups.sort((a, b) => {
        const ai = existingKeys.indexOf(a.key),
          bi = existingKeys.indexOf(b.key);
        return (ai < 0 ? existingKeys.length : ai) - (bi < 0 ? existingKeys.length : bi);
      });
    const currentIds = new Set(
      all.flatMap((g) => g.threads.flatMap((t) => t.entries.map((e) => e.id))),
    );
    if (!reset && !nearEdge && latestIds.size && [...currentIds].some((id) => !latestIds.has(id)))
      newest.hidden = false;
    latestIds = currentIds;
    lastDigest = digest;
    timeline.replaceChildren();
    for (const group of groups) {
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
            : group.platform === 'kuaishou'
              ? '快手'
              : group.platform === 'bilibili'
                ? '哔哩哔哩'
                : group.platform) +
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
      const open = el('div', undefined, 'sm-video-tools');
      link('打开视频 ↗', group.video.url, open);
      section.append(open);
      const threads = order.value === 'oldest' ? [...group.threads].reverse() : group.threads;
      for (const thread of threads) {
        const threadEl = el('div', undefined, 'sm-thread');
        for (const e of thread.entries) {
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
              (i) => i.direction === 'incoming' && i.target.parent === e.quote?.target.parent,
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
          link(e.record && !e.record.receiptId ? '查看原楼层 ↗' : '定位这条评论 ↗', e.url, actions);
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
              for (const advice of r.preparation.advice) detail.append(el('p', advice, 'sm-muted'));
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
        section.append(threadEl);
      }
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
      if (restored)
        scroller.scrollTop = oldTop + restored.getBoundingClientRect().top - anchor.offset;
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
      if (b) b.disabled = false;
    }
  }
  function render(state: Snapshot) {
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
    renderGroups(state);
    const p = state.platforms.find((p) => p.id === 'bilibili');
    const dy = state.platforms.find((p) => p.id === 'douyin');
    const ks = state.platforms.find((p) => p.id === 'kuaishou');
    refreshSaveHints();
    dyControls.render(state);
    ksControls.render(state);
    focusPanel.render(state.focusPlatforms?.bilibili ?? state.focus, p?.enabled ?? true);
    const dyFocus = state.focusPlatforms?.douyin;
    douyinFocusPanel.render(dyFocus, dy?.enabled ?? true);
    const ksFocus = state.focusPlatforms?.kuaishou;
    kuaishouFocusPanel.render(ksFocus, ks?.enabled ?? true);
    for (const [node, focus, platformEnabled] of [
      [biliFocusStatus, state.focusPlatforms?.bilibili ?? state.focus, p?.enabled ?? true],
      [douyinFocusStatus, dyFocus, dy?.enabled ?? true],
      [kuaishouFocusStatus, ksFocus, ks?.enabled ?? true],
    ] as const) {
      const view = focusStatus(focus, platformEnabled);
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
        if (input instanceof HTMLInputElement && input.type === 'checkbox')
          input.checked = Boolean(value);
        else input.value = String(value ?? '');
      }
    }
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
    roamingEnabled.checked = r?.enabled ?? false;
    roamSummary.textContent = !r
      ? '正在读取闲逛状态…'
      : r.enabled
        ? '已开启 · 三平台独立计数，按各自等待轮流闲逛'
        : '已暂停发起新闲逛，各平台设置会保留。';
    roamPlatformStates.replaceChildren();
    for (const [id, title] of [
      ['bilibili', '哔哩哔哩'],
      ['douyin', '抖音'],
      ['kuaishou', '快手'],
    ] as const) {
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
      ? ' · 抖音' + (dy.account ? '已登录 · ' + dy.account.name : '已启用（实验）')
      : '';
    summary.textContent += ks?.enabled
      ? ' · 快手' + (ks.account ? '已登录 · ' + ks.account.name : '已启用（实验）')
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
      resourceStatus.textContent =
        '今日看图 ' +
        rsrc.todayCalls +
        '/' +
        rsrc.maxDailyVisualCalls +
        ' 次 · 图片缓存 ' +
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
        outbox: [
          ...state.outbox,
          ...archivedRecords.filter((r) => !state.outbox.some((x) => x.id === r.id)),
        ],
      });
  }
  async function refresh() {
    if (refreshing || ctx.signal.aborted) return;
    refreshing = true;
    try {
      const s = await ctx.invoke<Snapshot>('status');
      if (!ctx.signal.aborted) render(s);
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

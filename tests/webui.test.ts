import { focusStatus, focusView, type FocusSnapshot } from '../src/webui/focus.ts';
import { SOCIALMEDIA_DEFAULTS } from '../src/config.ts';
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mount, mountSettings } from '../src/webui/client.ts';
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
describe('operator desk', () => {
  it('renders untrusted text literally, preserves scroll, and never sends cookies into a model', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new AbortController();
    const intervals: Array<() => void> = [];
    const state = {
      credentialSaved: false,
      pending: 1,
      unknown: 0,
      platforms: [{ id: 'bilibili', enabled: true, monitor: false, posting: false }],
      inbox: [
        {
          id: 'i',
          author: '<img src=x onerror=alert(1)>',
          text: '<script>bad()</script>',
          status: 'pending',
          target: { oid: '1', parent: '2' },
          occurredAt: 123,
          url: 'javascript:bad()',
        },
      ],
      outbox: [],
    };
    const ctx = {
      root,
      signal: controller.signal,
      invoke: async () => state,
      interval: (fn: () => void) => {
        intervals.push(fn);
        return { dispose() {} };
      },
      setConfig: async () => '',
    } as unknown as WebUiPanelContext;
    mount(ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toContain('<script>bad()</script>');
    expect(root.querySelectorAll('input[type=checkbox]')).toHaveLength(0);
    expect(root.querySelector<HTMLDetailsElement>('.sm-video')?.open).toBe(false);
    const list = root.querySelector('.sm-list') as HTMLElement;
    list.scrollTop = 123;
    intervals[1]();
    await new Promise((r) => setTimeout(r, 0));
    expect(list.scrollTop).toBe(123);
    controller.abort();
    root.remove();
  });
});

it('keeps self-only receipts without routine recheck controls', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = new AbortController();
  const calls: string[] = [];
  const state = {
    credentialSaved: true,
    pending: 0,
    unknown: 0,
    platforms: [],
    inbox: [],
    outbox: [
      {
        id: 'send1',
        status: 'sent',
        receiptId: '567',
        createdAt: new Date().toISOString(),
        text: '测试',
        target: { oid: '99', parent: '100' },
        visibility: {
          status: 'self-only',
          detail: '平台限制公开展示',
          checkedAt: new Date().toISOString(),
        },
      },
    ],
  };
  mount({
    root,
    signal: controller.signal,
    interval: () => ({ dispose() {} }),
    setConfig: async () => '',
    invoke: async (method: string) => {
      calls.push(method);
      return state;
    },
  } as unknown as WebUiPanelContext);
  await new Promise((r) => setTimeout(r, 0));
  expect(root.textContent).toContain('仅自己可见');
  expect(root.querySelector('time')?.textContent).toBe(
    new Date(state.outbox[0].createdAt).toLocaleString(),
  );
  expect([...root.querySelectorAll('button')].some((b) => b.textContent === '复查公开状态')).toBe(
    false,
  );
  expect(calls).toEqual(['status']);
  controller.abort();
  root.remove();
});

it('offers reference presets and preserves unsaved custom limits across refreshes', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = new AbortController();
  const intervals: Array<() => void> = [],
    changes: Array<Record<string, unknown>> = [];
  const state = {
    credentialSaved: true,
    pending: 0,
    unknown: 0,
    platforms: [],
    inbox: [],
    outbox: [],
    roaming: {
      enabled: true,
      usedToday: 0,
      limits: structuredClone(SOCIALMEDIA_DEFAULTS.roaming),
      recent: [],
    },
  };
  mountSettings({
    root,
    signal: controller.signal,
    interval: (fn: () => void) => {
      intervals.push(fn);
      return { dispose() {} };
    },
    invoke: async (method: string, args: unknown[]) => {
      if (method === 'settings') {
        changes.push(args[0] as Record<string, unknown>);
        return { message: '已保存' };
      }
      return state;
    },
    setConfig: async () => '',
  } as unknown as WebUiPanelContext);
  try {
    await new Promise((r) => setTimeout(r, 0));
    const field = root.querySelector(
      '[aria-label="B站闲逛 · 连续空闲多久再闲逛（分钟）"]',
    ) as HTMLInputElement;
    field.value = '21';
    field.dispatchEvent(new Event('input'));
    intervals[1]();
    await new Promise((r) => setTimeout(r, 0));
    expect(field.value).toBe('21');
    const save = [...root.querySelectorAll('button')].find((b) => b.textContent === '保存B站设置')!;
    save.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(changes[0]['worlds.socialmedia.platforms.bilibili.roaming.idleMinutes']).toBe(21);
    const preset = root.querySelector<HTMLButtonElement>(
      '.sm-platform-card[data-platform="bilibili"] [data-roam-preset="light"]',
    )!;
    preset.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(changes[1]['worlds.socialmedia.platforms.bilibili.roaming.maxDailySessions']).toBe(4);
    expect(changes[1]).not.toHaveProperty('worlds.socialmedia.roaming.enabled');
  } finally {
    controller.abort();
    root.remove();
  }
});

it('collapses long historical comments and keeps expanded bodies open on refresh', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = new AbortController();
  const intervals: Array<() => void> = [];
  const state = {
    credentialSaved: true,
    pending: 0,
    unknown: 0,
    platforms: [],
    inbox: [],
    outbox: [
      {
        id: 'long',
        platform: 'bilibili',
        accountId: '42',
        text: '这是一条很长的公开评论。'.repeat(30),
        target: { oid: '99', type: 1, root: '0', parent: '0' },
        createdAt: '2026-10-23T00:00:00Z',
        status: 'sent',
        receiptId: '123',
      },
    ],
  };
  mount({
    root,
    signal: controller.signal,
    invoke: async () => state,
    interval: (fn: () => void) => {
      intervals.push(fn);
      return { dispose() {} };
    },
    setConfig: async () => '',
  } as unknown as WebUiPanelContext);
  try {
    await new Promise((r) => setTimeout(r, 0));
    const body = root.querySelector<HTMLDetailsElement>('.sm-long-message');
    expect(body).not.toBeNull();
    expect(body!.open).toBe(false);
    body!.open = true;
    state.outbox[0].receiptId = '124';
    intervals[1]();
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector<HTMLDetailsElement>('.sm-long-message')!.open).toBe(true);
  } finally {
    controller.abort();
    root.remove();
  }
});

it('lets users fill their own owner and saves focus without losing other unsaved edits', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = new AbortController();
  const intervals: Array<() => void> = [];
  const changes: Array<Record<string, unknown>> = [];
  const state = {
    credentialSaved: true,
    pending: 0,
    unknown: 0,
    platforms: [],
    inbox: [],
    outbox: [],
    config: structuredClone(SOCIALMEDIA_DEFAULTS),
  };
  mountSettings({
    root,
    signal: controller.signal,
    interval: (fn: () => void) => {
      intervals.push(fn);
      return { dispose() {} };
    },
    setConfig: async () => '',
    invoke: async (method: string, args: unknown[]) => {
      if (method === 'settings') {
        const values = args[0] as Record<string, unknown>;
        changes.push(values);
        for (const [key, value] of Object.entries(values))
          if (key.startsWith('worlds.socialmedia.focus.'))
            (state.config.focus as unknown as Record<string, unknown>)[key.split('.').at(-1)!] =
              value;
        return { message: '已保存' };
      }
      return state;
    },
  } as unknown as WebUiPanelContext);
  try {
    await new Promise((r) => setTimeout(r, 0));
    const owner = root.querySelector(
      '[aria-label="主人账号（UID、主页链接或昵称）"]',
    ) as HTMLInputElement;
    expect(owner.value).toBe('');
    owner.value = '同名';
    owner.dispatchEvent(new Event('input'));
    const quota = root.querySelector(
      '[aria-label="快手每日普通发布上限"]',
    ) as HTMLInputElement | null;
    const other =
      quota ??
      [...root.querySelectorAll<HTMLInputElement>('input')].find(
        (i) =>
          i.getAttribute('aria-label')?.includes('每日') &&
          !i.getAttribute('aria-label')?.includes('关注'),
      )!;
    const savedOther = other.value;
    other.value = '67';
    other.dispatchEvent(new Event('input'));
    [...root.querySelectorAll('button')].find((b) => b.textContent === '保存B站设置')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(changes[0]['worlds.socialmedia.focus.account']).toBe('同名');
    expect(
      Object.keys(changes[0]).every(
        (k) => !k.includes('platforms.kuaishou') && !k.includes('platforms.douyin'),
      ),
    ).toBe(true);
    expect(other.value).toBe('67');
    intervals[1]();
    await new Promise((r) => setTimeout(r, 0));
    expect(owner.value).toBe('同名');
    expect(other.value).not.toBe(savedOther);
  } finally {
    controller.abort();
    root.remove();
  }
});
it('shows pinned owner and literal recent-work titles while preserving the focus fold', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = new AbortController();
  const intervals: Array<() => void> = [];
  const state = {
    credentialSaved: true,
    pending: 0,
    unknown: 0,
    platforms: [],
    inbox: [],
    outbox: [],
    focus: {
      enabled: true,
      input: '同名',
      limit: 12,
      binding: {
        accountId: '42',
        input: '同名',
        ownerId: '7',
        name: '同名',
        method: 'first-contact',
      },
      works: [
        {
          aid: '99',
          id: 'av99',
          title: '<img src=x onerror=alert(1)>',
          url: 'https://www.bilibili.com/video/av99/',
          updatedAt: '',
          participation: 'unseen',
          comments: 0,
        },
      ],
    },
  };
  mount({
    root,
    signal: controller.signal,
    interval: (fn: () => void) => {
      intervals.push(fn);
      return { dispose() {} };
    },
    setConfig: async () => '',
    invoke: async () => state,
  } as unknown as WebUiPanelContext);
  try {
    await new Promise((r) => setTimeout(r, 0));
    const card = root.querySelector<HTMLDetailsElement>('.sm-focus-card')!;
    expect(card.open).toBe(false);
    expect(card.textContent).toContain('UID 7');
    expect(card.querySelector('img')).toBeNull();
    card.open = true;
    state.focus.works[0].participation = 'accepted';
    intervals[1]();
    await new Promise((r) => setTimeout(r, 0));
    expect(card.open).toBe(true);
    expect(card.textContent).toContain('已发送');
  } finally {
    controller.abort();
    root.remove();
  }
});

it('shows per-button progress and durable login, browser and sync results near the controls', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = new AbortController();
  const intervals: Array<() => void> = [];
  const state = {
    credentialSaved: true,
    pending: 0,
    unknown: 0,
    platforms: [
      {
        id: 'bilibili',
        enabled: true,
        monitor: true,
        posting: true,
        account: { id: '42', name: '测试账号' },
      },
    ],
    inbox: [],
    outbox: [],
  };
  let finish!: (v: unknown) => void;
  const connection = new Promise((resolve) => {
    finish = resolve;
  });
  mountSettings({
    root,
    signal: controller.signal,
    setConfig: async () => '',
    interval: (fn: () => void) => {
      intervals.push(fn);
      return { dispose() {} };
    },
    invoke: async (method: string) =>
      method === 'connect'
        ? connection
        : method === 'browserCheck'
          ? { detail: '官方评论组件已就绪；此检查没有发评论。' }
          : method === 'sync'
            ? {
                ...state,
                operation: {
                  status: 'completed',
                  detail: '同步完成：新增0条通知，当前0条待处理。',
                },
              }
            : state,
  } as unknown as WebUiPanelContext);
  try {
    await new Promise((r) => setTimeout(r, 0));
    const buttons = () => [...root.querySelectorAll('button')];
    const login = buttons().find((b) => b.textContent === '检查登录')!;
    login.click();
    expect(login.disabled).toBe(true);
    expect(root.textContent).toContain('正在核对登录');
    finish({ id: '42', name: '测试账号' });
    await new Promise((r) => setTimeout(r, 0));
    expect(root.textContent).toContain('登录有效');
    expect(root.textContent).toContain('测试账号');
    buttons()
      .find((b) => b.textContent === '检查网页发评')!
      .click();
    await new Promise((r) => setTimeout(r, 0));
    intervals[1]();
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector('.sm-connection-results')?.textContent).toContain(
      '官方评论组件已就绪',
    );
    buttons()
      .find((b) => b.textContent === '立即同步')!
      .click();
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector('.sm-connection-results')?.textContent).toContain('新增0条通知');
    expect(login.disabled).toBe(false);
  } finally {
    controller.abort();
    root.remove();
  }
});
it('keeps a failed diagnostic visible across automatic refreshes', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = new AbortController();
  const intervals: Array<() => void> = [];
  const state = {
    credentialSaved: false,
    pending: 0,
    unknown: 0,
    platforms: [],
    inbox: [],
    outbox: [],
  };
  mountSettings({
    root,
    signal: controller.signal,
    setConfig: async () => '',
    interval: (fn: () => void) => {
      intervals.push(fn);
      return { dispose() {} };
    },
    invoke: async (method: string) => {
      if (method === 'connect') throw Error('登录已失效，请扫码登录');
      return state;
    },
  } as unknown as WebUiPanelContext);
  try {
    await new Promise((r) => setTimeout(r, 0));
    [...root.querySelectorAll('button')].find((b) => b.textContent === '检查登录')!.click();
    await new Promise((r) => setTimeout(r, 0));
    intervals[1]();
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector('.sm-connection-results')?.textContent).toContain('登录已失效');
  } finally {
    controller.abort();
    root.remove();
  }
});

it('shows separate Douyin controls and preserves feedback after a read-only check', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = new AbortController();
  const calls: string[] = [];
  const state = {
    credentialSaved: false,
    pending: 0,
    unknown: 0,
    inbox: [],
    outbox: [],
    config: structuredClone(SOCIALMEDIA_DEFAULTS),
    platforms: [
      { id: 'bilibili', enabled: true, posting: false, monitor: false },
      { id: 'douyin', enabled: true, posting: false, monitor: false },
    ],
  };
  mountSettings({
    root,
    signal: controller.signal,
    interval: () => ({ dispose() {} }),
    invoke: async (method: string) => {
      calls.push(method);
      return method === 'douyinCheck' ? { detail: '已读取 · 5条评论；未发送任何内容。' } : state;
    },
  } as unknown as WebUiPanelContext);
  await new Promise((r) => setTimeout(r, 0));
  const input = root.querySelector<HTMLInputElement>('[aria-label="抖音读取测试的视频"]')!;
  expect(input).not.toBeNull();
  input.value = '7697799441646256819';
  const check = [...root.querySelectorAll('button')].find((b) => b.textContent === '测试抖音读取')!;
  check.click();
  await new Promise((r) => setTimeout(r, 0));
  expect(calls).toContain('douyinCheck');
  expect(root.textContent).toContain('5条评论');
  expect(root.textContent).toContain('全站通知与完整字幕未接入');
  controller.abort();
  root.remove();
});

it('saves Douyin focus independently without overwriting Bilibili owner settings', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = new AbortController();
  const changes: any[] = [];
  const state = {
    config: structuredClone(SOCIALMEDIA_DEFAULTS),
    platforms: [],
    inbox: [],
    outbox: [],
    pending: 0,
    unknown: 0,
  };
  mountSettings({
    root,
    signal: controller.signal,
    interval: () => ({ dispose() {} }),
    invoke: async (method: string, args: any[]) => {
      if (method === 'settings') changes.push(args[0]);
      return state;
    },
  } as unknown as WebUiPanelContext);
  await new Promise((r) => setTimeout(r, 0));
  expect(root.textContent).toContain('B站特别关注');
  expect(root.textContent).toContain('抖音特别关注');
  const input = root.querySelector<HTMLInputElement>(
    'input[aria-label="抖音主人账号（抖音号或主页链接）"]',
  )!;
  input.value = 'my_owner';
  input.dispatchEvent(new Event('input'));
  [...root.querySelectorAll('button')].find((b) => b.textContent === '保存抖音设置')!.click();
  await new Promise((r) => setTimeout(r, 0));
  expect(changes.at(-1)['worlds.socialmedia.platforms.douyin.focus.account']).toBe('my_owner');
  expect(changes.at(-1)).not.toHaveProperty('worlds.socialmedia.focus.account');
  controller.abort();
  root.remove();
});

it('labels Douyin and Bilibili sends correctly together under All', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = new AbortController();
  const records = ['bilibili', 'douyin'].map((platform, i) => ({
    id: platform,
    platform,
    accountId: 'bot',
    text: '发言' + i,
    status: 'sent',
    receiptId: '9',
    createdAt: new Date().toISOString(),
    target: { oid: String(77 + i), type: i + 1, root: '0', parent: '0' },
  }));
  mount({
    root,
    signal: controller.signal,
    interval: () => ({ dispose() {} }),
    invoke: async () => ({ platforms: [], inbox: [], outbox: records, pending: 0, unknown: 0 }),
  } as unknown as WebUiPanelContext);
  await new Promise((r) => setTimeout(r, 0));
  expect(root.querySelectorAll('.sm-video')).toHaveLength(2);
  expect(root.querySelector('[data-group-key="douyin:2:78"] .sm-eyebrow')?.textContent).toContain(
    '抖音',
  );
  expect(root.querySelector('[data-group-key="bilibili:1:77"] .sm-eyebrow')?.textContent).toContain(
    '哔哩哔哩',
  );
  controller.abort();
  root.remove();
});

it('checks the saved Douyin owner immediately without asking to post', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = new AbortController(),
    calls: Array<[string, any[]]> = [];
  const cfg = structuredClone(SOCIALMEDIA_DEFAULTS);
  cfg.platforms.douyin.focus!.enabled = true;
  const state = { config: cfg, platforms: [], inbox: [], outbox: [], pending: 0, unknown: 0 };
  mountSettings({
    root,
    signal: controller.signal,
    interval: () => ({ dispose() {} }),
    invoke: async (method: string, args: any[] = []) => {
      calls.push([method, args]);
      return state;
    },
  } as unknown as WebUiPanelContext);
  await new Promise((r) => setTimeout(r, 0));
  const input = root.querySelector<HTMLInputElement>(
    '[aria-label="抖音主人账号（抖音号或主页链接）"]',
  )!;
  input.value = '1809102273';
  input.dispatchEvent(new Event('input'));
  [...root.querySelectorAll('button')].find((b) => b.textContent === '保存抖音设置')!.click();
  await new Promise((r) => setTimeout(r, 0));
  expect(calls).toContainEqual(['focusRefresh', ['douyin']]);
  expect(calls.some(([m]) => m === 'publish')).toBe(false);
  controller.abort();
  root.remove();
});

it('saves a disabled Kuaishou focus without starting a browser or overwriting other platform settings', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = new AbortController(),
    calls: Array<[string, any[]]> = [];
  const state = {
    config: structuredClone(SOCIALMEDIA_DEFAULTS),
    platforms: [],
    inbox: [],
    outbox: [],
    pending: 0,
    unknown: 0,
  };
  mountSettings({
    root,
    signal: controller.signal,
    interval: () => ({ dispose() {} }),
    invoke: async (method: string, args: any[] = []) => {
      calls.push([method, args]);
      return state;
    },
  } as unknown as WebUiPanelContext);
  await new Promise((r) => setTimeout(r, 0));
  [...root.querySelectorAll('button')].find((b) => b.textContent === '保存快手设置')!.click();
  await new Promise((r) => setTimeout(r, 0));
  expect(calls.some(([m]) => m === 'focusRefresh')).toBe(false);
  const saved = calls.find(([m]) => m === 'settings')![1][0];
  expect(
    Object.keys(saved).every(
      (k) =>
        k.startsWith('worlds.socialmedia.platforms.kuaishou.') ||
        k.startsWith('worlds.socialmedia.kuaishouBrowser.'),
    ),
  ).toBe(true);
  controller.abort();
  root.remove();
});

it('shows resource usage and invokes only the World-owned cache cleanup control', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = new AbortController(),
    calls: string[] = [];
  const state = {
    config: structuredClone(SOCIALMEDIA_DEFAULTS),
    platforms: [],
    inbox: [],
    outbox: [],
    pending: 0,
    unknown: 0,
    resources: {
      todayCalls: 2,
      maxDailyVisualCalls: 20,
      publishedBytes: 1024,
      maxPublishedBytes: 536870912,
      cacheBytes: 1024,
      cacheEntries: 1,
      cacheDays: 7,
      history: { count: 0, sent: 0, bytes: 0, recent: 0, maxArchiveBytes: 536870912 },
    },
  };
  mountSettings({
    root,
    signal: controller.signal,
    interval: () => ({ dispose() {} }),
    invoke: async (method: string) => {
      calls.push(method);
      return method === 'clearMediaCache' ? { removed: 1 } : state;
    },
  } as unknown as WebUiPanelContext);
  await new Promise((r) => setTimeout(r, 0));
  expect(root.textContent).toContain('今日看图 2/20');
  [...root.querySelectorAll('button')].find((b) => b.textContent === '清理图片缓存')!.click();
  await new Promise((r) => setTimeout(r, 0));
  expect(calls).toContain('clearMediaCache');
  expect(root.textContent).toContain('历史附件与累计预算保留');
  expect(calls).not.toContain('publish');
  controller.abort();
  root.remove();
});

it('enables Kuaishou immediately like Douyin and does not require a separate settings save', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = new AbortController(),
    calls: Array<[string, any[]]> = [];
  const state = {
    config: structuredClone(SOCIALMEDIA_DEFAULTS),
    platforms: [],
    inbox: [],
    outbox: [],
    pending: 0,
    unknown: 0,
  };
  mountSettings({
    root,
    signal: controller.signal,
    interval: () => ({ dispose() {} }),
    invoke: async (method: string, args: any[] = []) => {
      calls.push([method, args]);
      return state;
    },
  } as unknown as WebUiPanelContext);
  await new Promise((r) => setTimeout(r, 0));
  const section = [...root.querySelectorAll('section')].find((s) =>
    s.querySelector('h3')?.textContent?.startsWith('快手 ·'),
  )!;
  const input = [...section.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find((i) =>
    i.parentElement?.textContent?.includes('启用快手'),
  )!;
  expect(input).toBeDefined();
  input.checked = true;
  input.dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 0));
  expect(
    calls.some(
      ([m, a]) =>
        m === 'settings' && a[0]['worlds.socialmedia.platforms.kuaishou.enabled'] === true,
    ),
  ).toBe(true);
  controller.abort();
  root.remove();
});
it('keeps Kuaishou read errors visible inside its own section instead of leaving a loading message', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = new AbortController();
  const state = {
    config: structuredClone(SOCIALMEDIA_DEFAULTS),
    platforms: [{ id: 'kuaishou', enabled: true, posting: false }],
    inbox: [],
    outbox: [],
    pending: 0,
    unknown: 0,
  };
  mountSettings({
    root,
    signal: controller.signal,
    interval: () => ({ dispose() {} }),
    invoke: async (method: string) => {
      if (method === 'kuaishouCheck') throw Error('作品暂不可读');
      return state;
    },
  } as unknown as WebUiPanelContext);
  await new Promise((r) => setTimeout(r, 0));
  root.querySelector<HTMLInputElement>('[aria-label="快手读取测试的视频"]')!.value =
    '3xtestvideo1234';
  [...root.querySelectorAll('button')].find((b) => b.textContent === '测试快手读取')!.click();
  await new Promise((r) => setTimeout(r, 0));
  const section = [...root.querySelectorAll('section')].find((s) =>
    s.querySelector('h3')?.textContent?.startsWith('快手 ·'),
  )!;
  expect(section.textContent).toContain('作品暂不可读');
  expect(section.textContent).not.toContain('正在读取快手');
  controller.abort();
  root.remove();
});

it('groups each platform with its own folded focus, limits and connection settings', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = new AbortController();
  const cfg = structuredClone(SOCIALMEDIA_DEFAULTS);
  mountSettings({
    root,
    signal: controller.signal,
    interval: () => ({ dispose() {} }),
    invoke: async () => ({
      config: cfg,
      platforms: [],
      inbox: [],
      outbox: [],
      pending: 0,
      unknown: 0,
    }),
  } as unknown as WebUiPanelContext);
  try {
    await new Promise((r) => setTimeout(r, 0));
    const cards = root.querySelectorAll('.sm-platform-card');
    expect(cards).toHaveLength(3);
    for (const id of ['bilibili', 'douyin', 'kuaishou']) {
      const card = root.querySelector<HTMLElement>(
        '.sm-platform-card[data-platform="' + id + '"]',
      )!;
      const focus = card.querySelector<HTMLDetailsElement>('.sm-platform-focus')!;
      expect(focus).not.toBeNull();
      expect(focus.open).toBe(false);
      expect(card.querySelector('.sm-platform-limits')).not.toBeNull();
      expect(card.querySelector('.sm-platform-advanced')).not.toBeNull();
    }
    expect(
      root
        .querySelector('[aria-label="快手浏览器程序"]')
        ?.closest('.sm-platform-card')
        ?.getAttribute('data-platform'),
    ).toBe('kuaishou');
    expect(
      root
        .querySelector('[aria-label="抖音主人账号（抖音号或主页链接）"]')
        ?.closest('.sm-platform-card')
        ?.getAttribute('data-platform'),
    ).toBe('douyin');
    const roamToggle = [...root.querySelectorAll('label.sm-toggle')].find((n) =>
      n.textContent?.includes('允许空闲时闲逛'),
    )!;
    expect(roamToggle.closest('.sm-roaming')).not.toBeNull();
  } finally {
    controller.abort();
    root.remove();
  }
});

it('gives all three record groups and outgoing replies a platform identity for consistent colors', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = new AbortController();
  const outbox = ['bilibili', 'douyin', 'kuaishou'].map((platform, i) => ({
    id: platform,
    platform,
    accountId: 'bot',
    text: '各自平台的回复',
    status: 'sent',
    receiptId: '12345',
    createdAt: new Date().toISOString(),
    target: { oid: String(100 + i), type: i + 1, root: '0', parent: '0' },
  }));
  mount({
    root,
    signal: controller.signal,
    interval: () => ({ dispose() {} }),
    invoke: async () => ({ platforms: [], inbox: [], outbox, pending: 0, unknown: 0 }),
  } as unknown as WebUiPanelContext);
  try {
    await new Promise((r) => setTimeout(r, 0));
    for (const id of ['bilibili', 'douyin', 'kuaishou']) {
      const group = root.querySelector('.sm-video[data-platform="' + id + '"]');
      expect(group).not.toBeNull();
      expect(group!.querySelector('.sm-outgoing')?.getAttribute('data-platform')).toBe(id);
      expect(group!.querySelector('.sm-platform-label')).not.toBeNull();
    }
  } finally {
    controller.abort();
    root.remove();
  }
});

it('distinguishes a known owner with an unread work list from no owner or no comments', () => {
  const state = {
    enabled: true,
    autoReplyNewComments: true,
    input: '12345',
    binding: { name: '主人', ownerId: 'owner' },
    check: { at: 123, error: '官网暂未返回作品列表' },
    works: [],
  } as unknown as FocusSnapshot;
  expect(focusStatus(state)).toMatchObject({ label: '账号已识别 · 暂未读到作品', tone: 'warning' });
  expect(focusStatus(state).detail).toContain('这不代表没有新评论');
  expect(focusStatus(state, false).label).toContain('平台未启用');
  expect(focusStatus({ ...state, check: undefined }).label).toContain('等待首次检查');
});

it('updates the focus summary when only the platform switch changes', () => {
  const controller = new AbortController();
  const view = focusView(async () => {}, controller.signal);
  const state = {
    enabled: true,
    autoReplyNewComments: true,
    input: '12345',
    binding: { name: '主人', ownerId: 'owner' },
    check: { at: 123 },
    works: [],
  } as unknown as FocusSnapshot;
  view.render(state, true);
  expect(view.element.textContent).toContain('自动回应已开启');
  view.render(state, false);
  expect(view.element.textContent).toContain('平台未启用');
  controller.abort();
});

it('offers free roaming per platform without changing another platform or public posting limits', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = new AbortController(),
    changes: any[] = [];
  const state = {
    config: structuredClone(SOCIALMEDIA_DEFAULTS),
    platforms: [],
    inbox: [],
    outbox: [],
    pending: 0,
    unknown: 0,
  };
  mountSettings({
    root,
    signal: controller.signal,
    interval: () => ({ dispose() {} }),
    invoke: async (method: string, args: any[]) => {
      if (method === 'settings') changes.push(args[0]);
      return state;
    },
  } as unknown as WebUiPanelContext);
  try {
    await new Promise((r) => setTimeout(r, 0));
    const card = root.querySelector('.sm-platform-card[data-platform="kuaishou"]')!;
    (card.querySelector('[data-roam-preset="free"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(changes[0]['worlds.socialmedia.platforms.kuaishou.roaming.mode']).toBe('free');
    expect(
      Object.keys(changes[0]).every((k) =>
        k.startsWith('worlds.socialmedia.platforms.kuaishou.roaming.'),
      ),
    ).toBe(true);
    expect(root.querySelectorAll('.sm-roaming [data-preset]')).toHaveLength(0);
  } finally {
    controller.abort();
    root.remove();
  }
});

it('keeps only one master switch and saves attention, roaming and limits together for the selected platform', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = new AbortController(),
    changes: any[] = [];
  const cfg = structuredClone(SOCIALMEDIA_DEFAULTS);
  const state = { config: cfg, platforms: [], inbox: [], outbox: [], pending: 0, unknown: 0 };
  mountSettings({
    root,
    signal: controller.signal,
    interval: () => ({ dispose() {} }),
    invoke: async (method: string, args: any[]) => {
      if (method === 'settings') changes.push(args[0]);
      return state;
    },
  } as unknown as WebUiPanelContext);
  try {
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector('.sm-roaming')?.textContent).toContain('闲逛总开关');
    expect(root.querySelectorAll('.sm-roaming input')).toHaveLength(1);
    expect(root.querySelectorAll('.sm-roaming [data-preset]')).toHaveLength(0);
    const owner = root.querySelector<HTMLInputElement>(
      '[aria-label="抖音主人账号（抖音号或主页链接）"]',
    )!;
    owner.value = 'owner-123';
    owner.dispatchEvent(new Event('input'));
    const idle = root.querySelector<HTMLInputElement>(
      '[aria-label="抖音闲逛 · 连续空闲多久再闲逛（分钟）"]',
    )!;
    idle.value = '13';
    idle.dispatchEvent(new Event('input'));
    [...root.querySelectorAll('button')].find((b) => b.textContent === '保存抖音设置')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(changes[0]['worlds.socialmedia.platforms.douyin.focus.account']).toBe('owner-123');
    expect(changes[0]['worlds.socialmedia.platforms.douyin.roaming.idleMinutes']).toBe(13);
    expect(
      Object.keys(changes[0]).every(
        (k) =>
          k.startsWith('worlds.socialmedia.platforms.douyin.') ||
          k.startsWith('worlds.socialmedia.douyinBrowser.'),
      ),
    ).toBe(true);
  } finally {
    controller.abort();
    root.remove();
  }
});

it('distinguishes saved settings from a failed optional focus check and does not recheck unchanged owners', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = new AbortController(),
    calls: string[] = [];
  const cfg = structuredClone(SOCIALMEDIA_DEFAULTS);
  cfg.platforms.douyin.focus!.enabled = true;
  cfg.platforms.douyin.focus!.account = 'known-owner';
  const state = { config: cfg, platforms: [], inbox: [], outbox: [], pending: 0, unknown: 0 };
  mountSettings({
    root,
    signal: controller.signal,
    interval: () => ({ dispose() {} }),
    invoke: async (method: string) => {
      calls.push(method);
      if (method === 'focusRefresh') throw Error('官网暂未返回作品');
      return state;
    },
  } as unknown as WebUiPanelContext);
  try {
    await new Promise((r) => setTimeout(r, 0));
    const save = [...root.querySelectorAll('button')].find(
      (b) => b.textContent === '保存抖音设置',
    )!;
    save.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).not.toContain('focusRefresh');
    const owner = root.querySelector<HTMLInputElement>(
      '[aria-label="抖音主人账号（抖音号或主页链接）"]',
    )!;
    owner.value = 'new-owner';
    owner.dispatchEvent(new Event('input'));
    save.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector('.sm-feedback')?.textContent).toContain('设置已保存；关注检查未完成');
    expect(root.querySelector<HTMLElement>('.sm-alert')!.hidden).toBe(true);
  } finally {
    controller.abort();
    root.remove();
  }
});

it('turns off automatic owner replies visibly when owner attention is disabled', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = new AbortController(),
    changes: any[] = [];
  const cfg = structuredClone(SOCIALMEDIA_DEFAULTS);
  cfg.platforms.douyin.focus!.enabled = true;
  cfg.platforms.douyin.focus!.autoReplyNewComments = true;
  const state = { config: cfg, platforms: [], inbox: [], outbox: [], pending: 0, unknown: 0 };
  mountSettings({
    root,
    signal: controller.signal,
    interval: () => ({ dispose() {} }),
    invoke: async (method: string, args: any[]) => {
      if (method === 'settings') changes.push(args[0]);
      return state;
    },
  } as unknown as WebUiPanelContext);
  try {
    await new Promise((r) => setTimeout(r, 0));
    const enabled = root.querySelector<HTMLInputElement>(
        '[aria-label="优先关注抖音主人作品与评论区"]',
      )!,
      auto = root.querySelector<HTMLInputElement>('[aria-label="自动回应抖音主人评论区的新评论"]')!;
    enabled.checked = false;
    enabled.dispatchEvent(new Event('input'));
    expect(auto.checked).toBe(false);
    [...root.querySelectorAll('button')].find((b) => b.textContent === '保存抖音设置')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(changes[0]['worlds.socialmedia.platforms.douyin.focus.enabled']).toBe(false);
    expect(changes[0]['worlds.socialmedia.platforms.douyin.focus.autoReplyNewComments']).toBe(
      false,
    );
  } finally {
    controller.abort();
    root.remove();
  }
});

it('shows the actual Bilibili permission states on first render', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = new AbortController();
  mountSettings({
    root,
    signal: controller.signal,
    interval: () => ({ dispose() {} }),
    setConfig: async () => '',
    invoke: async () => ({
      credentialSaved: true,
      pending: 0,
      unknown: 0,
      inbox: [],
      outbox: [],
      platforms: [{ id: 'bilibili', enabled: true, monitor: true, posting: true }],
    }),
  } as unknown as WebUiPanelContext);
  await new Promise((r) => setTimeout(r, 0));
  const switches = [
    ...root.querySelectorAll<HTMLInputElement>(
      '.sm-platform-card[data-platform=bilibili] .sm-controls input',
    ),
  ];
  expect(switches.map((input) => input.checked)).toEqual([true, true, true]);
  controller.abort();
  root.remove();
});
it('requires a local preview before adopting a changed group binding', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const c = new AbortController(),
    calls: string[] = [];
  const state = {
    credentialSaved: false,
    pending: 0,
    unknown: 0,
    platforms: [],
    inbox: [],
    outbox: [],
    groupChat: {
      enabled: true,
      allowSend: true,
      activity: 'active',
      groups: [
        {
          id: '123456',
          name: '测试群',
          connected: false,
          connection: 'retrying',
          error: '账号变化',
          messages: [],
        },
      ],
      outbox: [],
    },
  };
  mountSettings({
    root,
    signal: c.signal,
    interval: () => ({ dispose() {} }),
    invoke: async (method: string) => {
      calls.push(method);
      if (method === 'groupPreview')
        return {
          token: 'preview',
          previous: { name: '旧群', accountId: 'old-account' },
          proposed: { name: '新群', accountId: 'new-account' },
        };
      return state;
    },
  } as unknown as WebUiPanelContext);
  try {
    await new Promise((r) => setTimeout(r, 0));
    [...root.querySelectorAll('button')].find((b) => b.textContent === '重新核对并绑定')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContain('groupPreview');
    expect(calls).not.toContain('groupRebind');
    expect(root.textContent).toContain('旧群');
    expect(root.textContent).toContain('新群');
    [...root.querySelectorAll('button')].find((b) => b.textContent === '采用本次检查结果')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContain('groupRebind');
  } finally {
    c.abort();
    root.remove();
  }
});

it('keeps dynamic switches simple and puts cadence controls behind a closed advanced section', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const c = new AbortController();
  const state = {
    config: structuredClone(SOCIALMEDIA_DEFAULTS),
    platforms: [],
    inbox: [],
    outbox: [],
    pending: 0,
    unknown: 0,
  };
  mountSettings({
    root,
    signal: c.signal,
    interval: () => ({ dispose() {} }),
    invoke: async () => state,
  } as unknown as WebUiPanelContext);
  try {
    await new Promise((r) => setTimeout(r, 0));
    const section = root.querySelector('.sm-bili-social')!,
      advanced = section.querySelector<HTMLDetailsElement>('.sm-bili-social-advanced')!;
    expect(advanced).not.toBeNull();
    expect(advanced.open).toBe(false);
    expect(advanced.textContent).toContain('每天最多主动动态数');
    expect(advanced.textContent).toContain('主动机会最短间隔');
    expect(section.textContent).toContain('空闲时主动发动态');
    const direct = [...section.children]
      .filter((el) => el !== advanced)
      .map((el) => el.textContent)
      .join('');
    expect(direct).not.toContain('每天最多主动动态数');
    expect(direct).toContain('允许发布纯文字动态');
  } finally {
    c.abort();
    root.remove();
  }
});

it('uses platform cards for groups and keeps open messages intact on polling-only refresh', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = new AbortController(),
    intervals: Array<() => void> = [];
  const state = {
    config: structuredClone(SOCIALMEDIA_DEFAULTS),
    platforms: [],
    inbox: [],
    outbox: [],
    groupChat: {
      enabled: true,
      allowSend: true,
      activity: 'active',
      proactiveEnabled: true,
      groups: [
        {
          id: '123456',
          name: '测试群',
          connection: 'online',
          connected: true,
          checkedAt: Date.now(),
          lastMessageAt: 1000,
          pending: 0,
          messages: [
            { id: 'm1', sender: '甲', text: '<script>原话</script>', time: 1000, own: false },
          ],
        },
      ],
      outbox: [
        {
          id: 'r1',
          groupId: '123456',
          time: 2000,
          text: '未提交的原文',
          status: 'not_submitted',
          detail: '输入前失败',
        },
      ],
    },
  };
  mount({
    root,
    signal: controller.signal,
    invoke: async () => structuredClone(state),
    interval: (fn: () => void) => {
      intervals.push(fn);
      return { dispose() {} };
    },
  } as unknown as WebUiPanelContext);
  try {
    await new Promise((r) => setTimeout(r, 0));
    const card = root.querySelector<HTMLDetailsElement>('.sm-group-card')!;
    expect(card.dataset.platform).toBe('douyin');
    card.open = true;
    const message = card.querySelector('.sm-event');
    expect(root.textContent).toContain('未提交');
    expect(root.querySelector('script')).toBeNull();
    state.groupChat.groups[0].checkedAt += 1000;
    for (const f of intervals) f();
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector('.sm-group-card')).toBe(card);
    expect(card.open).toBe(true);
    expect(card.querySelector('.sm-event')).toBe(message);
  } finally {
    controller.abort();
    root.remove();
  }
});

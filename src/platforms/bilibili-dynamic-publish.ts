import type { Page, Route } from 'playwright-core';
import type { DynamicPost } from '../dynamic-publishing.ts';
import { dynamicText } from '../dynamic-publishing.ts';
import { PlatformError } from '../platform.ts';
import { parsePlatformJson } from './bilibili.ts';
import { dynamicId, type PublicDynamic } from './bilibili-dynamics.ts';
const API = 'https://api.bilibili.com';
const CHECK = '/x/dynamic/feed/create/submit_check';
const CREATE = '/x/dynamic/feed/create/dyn';
export function matchesPostedDynamic(
  item: Pick<PublicDynamic, 'authorId' | 'text' | 'mentions'>,
  draft: Pick<DynamicPost, 'accountId' | 'text' | 'mention'>,
) {
  if (item.authorId !== draft.accountId) return false;
  const actual = item.text.replace(/\u00a0/g, ' ').trim();
  if (!draft.mention) return actual === draft.text;
  if (!item.mentions?.some((m) => m.id === draft.mention!.id)) return false;
  const prefix = '@' + draft.mention.name;
  return actual === prefix + draft.text || actual === prefix + ' ' + draft.text;
}
const EDITOR = '.bili-dyn-publishing .bili-rich-textarea__inner[contenteditable="true"]';
export function matchesDynamicPayload(raw: any, draft: Pick<DynamicPost, 'text' | 'mention'>) {
  if (
    !raw ||
    ![1, 2].includes(raw.scene) ||
    Object.keys(raw).some(
      (k) =>
        ![
          'content',
          'scene',
          'attach_card',
          'create_option',
          'option',
          'upload_id',
          'meta',
        ].includes(k),
    )
  )
    return false;
  if (
    raw.attach_card != null ||
    (raw.option && Object.keys(raw.option).some((k) => k !== 'aigc')) ||
    (raw.create_option && Object.keys(raw.create_option).some((k) => k !== 'aigc'))
  )
    return false;
  if (
    !raw.content ||
    Object.keys(raw.content).some((k) => k !== 'contents') ||
    !Array.isArray(raw.content.contents) ||
    raw.content.contents.length > 8
  )
    return false;
  let text = '',
    mentions = 0;
  for (const c of raw.content.contents) {
    if (
      Object.keys(c).some((k) => !['raw_text', 'type', 'biz_id'].includes(k)) ||
      typeof c.raw_text !== 'string'
    )
      return false;
    if (c.type === 1) {
      if (c.biz_id) return false;
      text += c.raw_text;
    } else if (
      c.type === 2 &&
      draft.mention &&
      String(c.biz_id) === draft.mention.id &&
      c.raw_text.trim() === '@' + draft.mention.name
    )
      mentions++;
    else return false;
  }
  return text.trim() === draft.text && mentions === (draft.mention ? 1 : 0);
}
/** Populate the official editor; mentioning requires its real account token, never plain @text. */
export async function prepareDynamicPage(page: Page, draft: Pick<DynamicPost, 'text' | 'mention'>) {
  dynamicText(draft.text);
  if (new URL(page.url()).origin !== 'https://t.bilibili.com')
    throw new PlatformError('不是B站官网动态发布页，尚未提交。', 'rejected');
  const editor = page.locator(EDITOR).first();
  await editor.waitFor({ state: 'visible', timeout: 15000 });
  const previous = (await editor.innerText()).replace(/[\u200b\ufeff]/g, '').trim();
  if (previous) {
    await editor.click();
    await editor.press('ControlOrMeta+A');
    await editor.press('Backspace');
  }
  await page
    .locator('.bili-dyn-publishing__action.launcher.disabled')
    .waitFor({ state: 'visible', timeout: 5000 });
  if (draft.mention) {
    await page.locator('.bili-dyn-publishing__tools__item.at').click();
    const popup = page.locator('.bili-at-popup:visible');
    await popup.waitFor({ timeout: 5000 });
    let user = popup
      .locator('.bili-at-popup__user')
      .filter({ has: page.getByText(draft.mention.name, { exact: true }) });
    if (
      !(await user
        .first()
        .waitFor({ state: 'visible', timeout: 7000 })
        .then(
          () => true,
          () => false,
        ))
    ) {
      await editor.pressSequentially(draft.mention.name, { delay: 100 });
      user = popup
        .locator('.bili-at-popup__user')
        .filter({ has: page.getByText(draft.mention.name, { exact: true }) });
    }
    await user.first().waitFor({ state: 'visible', timeout: 7000 });
    if ((await user.count()) !== 1)
      throw new PlatformError('官网未提供唯一的特别关注@候选，尚未提交。', 'rejected');
    await user.click({ timeout: 5000 });
    // The official rich editor exposes its selected account as an anchor or an atomic token.
    const selected = await editor.evaluate((el) =>
      Array.from(el.querySelectorAll('*')).map((e) => ({
        text: e.textContent,
        attrs: Array.from(e.attributes).map((a) => [a.name, a.value]),
      })),
    );
    const id = draft.mention.id;
    if (
      !selected.some((e) =>
        e.attrs.some(
          ([k, v]) =>
            (['data-id', 'data-uid', 'data-biz-id'].includes(k) && v === id) ||
            (k === 'data-data' &&
              (() => {
                try {
                  const token = JSON.parse(v);
                  return token.data?.type === 'at' && String(token.data?.rid) === id;
                } catch {
                  return false;
                }
              })()) ||
            (k === 'href' &&
              new RegExp('^https://space\\.bilibili\\.com/' + id + '(?:[/?#]|$)').test(v)),
        ),
      )
    )
      throw new PlatformError('官网@标记未核实到准确UID，尚未提交。', 'rejected');
    await editor.press('End');
    await page.keyboard.insertText(draft.text);
  } else {
    await editor.click();
    await page.keyboard.insertText(draft.text);
  }
  const expected = draft.mention ? '@' + draft.mention.name + ' ' + draft.text : draft.text;
  const actual = (await editor.innerText())
    .replace(/[\u200b\ufeff]/g, '')
    .replace(/\u00a0/g, ' ')
    .trim();
  if (actual !== expected)
    throw new PlatformError('官网输入框正文或@标记发生变化，尚未提交。', 'rejected');
  await page
    .locator('.bili-dyn-publishing__action.launcher:not(.disabled)')
    .waitFor({ state: 'visible', timeout: 5000 });
  return expected;
}
/** Forward only one exact plain create request. Opaque gateways stay blocked. No request replay. */
export async function submitDynamicPage(
  page: Page,
  draft: Pick<DynamicPost, 'text' | 'mention'>,
  signal: AbortSignal,
  sessionCurrent: () => boolean | Promise<boolean>,
  timeout = 15000,
  forward: (route: Route) => Promise<unknown> = (route) => route.continue(),
) {
  let armed = false,
    forwarded = false,
    finished = false,
    checked = false;
  let settle!: (v: { id?: string; rejected?: string }) => void;
  const outcome = new Promise<{ id?: string; rejected?: string }>((r) => {
    settle = r;
  });
  const guard = async (route: Route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.fallback();
    const u = new URL(req.url());
    if (
      !armed ||
      finished ||
      signal.aborted ||
      !(await sessionCurrent()) ||
      u.origin !== API ||
      req.method() !== 'POST'
    )
      return route.abort();
    let data: any;
    try {
      data = parsePlatformJson(req.postData() || '');
    } catch {
      return route.abort();
    }
    if (u.pathname === CHECK && matchesDynamicPayload(data, draft) && !checked && !forwarded) {
      checked = true;
      await forward(route);
      return;
    }
    if (u.pathname === CREATE && !forwarded && matchesDynamicPayload(data.dyn_req, draft)) {
      forwarded = true;
      await forward(route);
      return;
    }
    await route.abort();
    if (u.pathname === CREATE && !forwarded)
      settle({ rejected: '官网提交的正文、@或作品类型与草稿不符，已拦下，未发布。' });
  };
  const response = async (r: import('playwright-core').Response) => {
    const u = new URL(r.url());
    if (
      u.origin !== API ||
      ![CREATE, CHECK].includes(u.pathname) ||
      r.request().method() !== 'POST'
    )
      return;
    try {
      const raw = parsePlatformJson(await r.text());
      if (raw.code !== 0) {
        settle({
          rejected:
            'B站内容检查/发布未获准：' +
            String(raw.message ?? raw.code)
              .replace(/<[^>]*>/g, '')
              .slice(0, 120),
        });
        return;
      }
      if (u.pathname === CREATE) {
        const id = raw.data?.dyn_id_str ?? raw.data?.dyn_id;
        if (id) settle({ id: dynamicId(String(id)) });
      }
    } catch {}
  };
  await page.route('**/*', guard);
  page.on('response', response);
  try {
    const expected = await prepareDynamicPage(page, draft);
    signal.throwIfAborted();
    if (!(await sessionCurrent()))
      throw new PlatformError('发布开关或登录发生变化，尚未提交。', 'rejected');
    if (
      (await page.locator(EDITOR).first().innerText())
        .replace(/[\u200b\ufeff]/g, '')
        .replace(/\u00a0/g, ' ')
        .trim() !== expected
    )
      throw new PlatformError('发送前正文变化，尚未提交。', 'rejected');
    armed = true;
    await page
      .locator('.bili-dyn-publishing__action.launcher:not(.disabled)')
      .click({ timeout: 5000 });
    const timer = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
    const wait = () =>
      new Promise<undefined>((resolve) => {
        if (timer.aborted) return resolve(undefined);
        timer.addEventListener('abort', () => resolve(undefined), { once: true });
      });
    // A normal content warning may offer this native confirm. Captcha/auth challenges are never clicked.
    const confirm = page.getByText('确认并发送', { exact: true });
    if (await confirm.isVisible()) await confirm.click({ timeout: 3000 });
    const result = await Promise.race([outcome, wait()]);
    return { forwarded, ...result };
  } catch (e) {
    if (forwarded) return { forwarded: true };
    throw e instanceof PlatformError
      ? e
      : new PlatformError('动态官网输入或检查未完成，尚未提交。', 'rejected');
  } finally {
    armed = false;
    finished = true;
    page.off('response', response);
  }
}

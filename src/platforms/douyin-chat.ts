import { GROUP_MESSAGES_SOURCE, type DouyinMessage } from './douyin-chat-dom.ts';
import type { Page, Locator } from 'playwright-core';
export interface GroupBinding {
  id: string;
  name: string;
  conversationId?: string;
  accountId?: string;
}
const groupTitle = '[class*="StackChatHeadertitle"]';
export async function openDouyinGroup(page: Page, binding: GroupBinding) {
  const titles = page.locator(groupTitle).filter({ visible: true });
  const current = await titles.allTextContents();
  if (!binding.name || !current.some((t) => groupName(t) === binding.name)) {
    const search = page.getByPlaceholder('搜索', { exact: true }).filter({ visible: true });
    if (!(await search.count())) {
      const entry = page
        .locator('[data-e2e="something-button"]')
        .filter({ has: page.getByText('消息', { exact: true }) })
        .filter({ visible: true });
      const fallback = page.getByText('消息', { exact: true }).filter({ visible: true });
      if (page.url().startsWith('https://www.douyin.com/'))
        await entry.waitFor({ state: 'visible', timeout: 25000 });
      const trigger = (await entry.count()) === 1 ? entry : fallback.first();
      for (let attempt = 0; attempt < 3 && !(await search.isVisible()); attempt++) {
        await trigger.evaluate((node) => (node as HTMLElement).click());
        await search.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      }
    }
    await search.waitFor({ state: 'visible', timeout: 25000 });
    await search.fill(binding.name || binding.id);
    const groupHeader = page
      .locator('[class*="SearchPanelgroupheader"]')
      .filter({ visible: true, hasText: /^群聊$/ });
    await groupHeader.waitFor({ state: 'visible', timeout: 10000 });
    const expected = binding.name || binding.id;
    const matches = page.getByText(expected, { exact: true }).filter({ visible: true });
    const candidates: Locator[] = [];
    for (let index = 0; index < (await matches.count()); index++) {
      let row = matches.nth(index);
      for (let depth = 0; depth < 5; depth++) {
        row = row.locator('..');
        const label = (await row.innerText()).trim();
        if (label.includes('联系人')) break;
        const button = row.getByText('发消息', { exact: true }).filter({ visible: true });
        if (/[(（]\d+[)）]/.test(label) && (await button.count()) === 1) {
          candidates.push(button);
          break;
        }
      }
    }
    if (candidates.length !== 1)
      throw Error('群号/群名没有定位到唯一群聊；请补充准确群名，原绑定保留。');
    await candidates[0].evaluate((node) => (node as HTMLElement).click());
  }
  await page.locator('[contenteditable=true]').waitFor({ state: 'visible', timeout: 12000 });
  const header = (await page.locator(groupTitle).filter({ visible: true }).allTextContents()).find(
    (t) => groupName(t) === binding.name,
  );
  if (!header || !/[(（]\d+[)）]/.test(header)) throw Error('当前会话未核实为指定群聊，停止操作。');
  return { title: header.trim(), name: groupName(header) };
}
function groupName(title: string) {
  return title
    .trim()
    .replace(/\s*[(（]\d+[)）]\s*$/, '')
    .trim();
}
export async function readDouyinGroup(page: Page, binding: GroupBinding, accountId: string) {
  const group = await openDouyinGroup(page, binding);
  let messages = (await page.evaluate(GROUP_MESSAGES_SOURCE)) as DouyinMessage[];
  if (!messages.length) {
    await page.waitForTimeout(1000);
    messages = await page.evaluate(GROUP_MESSAGES_SOURCE);
  }
  const ids = [...new Set(messages.map((m) => m.conversationId))];
  if (ids.length !== 1 || (binding.conversationId && ids[0] !== binding.conversationId))
    throw Error('群会话编号未核实或与已绑定目标不同，停止操作');
  return {
    accountId,
    conversationId: ids[0],
    name: group.name,
    messages: messages
      .map((m) => ({ ...m, own: m.senderId === accountId }))
      .sort((a, b) => a.time - b.time),
  };
}
export async function sendDouyinGroup(
  page: Page,
  binding: GroupBinding,
  accountId: string,
  draft: string,
  onStage: (stage: string) => void = () => {},
) {
  if (!binding.conversationId || !draft.trim() || draft.length > 500)
    throw Error('群发送目标或内容未准备');
  onStage('核对群会话');
  const before = await readDouyinGroup(page, binding, accountId),
    seen = new Set(before.messages.map((m) => m.id));
  const editor = page.locator('[contenteditable=true]').filter({ visible: true });
  const existing = (await editor.innerText()).replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (existing && existing !== draft.trim())
    throw Error('群输入框已有不同的未发送内容，保留原文，本次未提交');
  onStage('填写群消息');
  await editor.fill(draft);
  const actual = (await editor.innerText()).replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (actual !== draft.trim()) throw Error('群输入框内容与草稿不符，尚未发送');
  // Verify conversation again immediately before the only submit action.
  await readDouyinGroup(page, binding, accountId);
  onStage('提交群消息');
  await editor.press('Enter');
  onStage('核对群消息回执');
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    const after = await readDouyinGroup(page, binding, accountId);
    const sent = after.messages.find(
      (m) => m.own && !seen.has(m.id) && m.text === draft && m.serverStatus === 0,
    );
    if (sent)
      return {
        status: 'sent' as const,
        messageId: sent.id,
        detail: '原生群输入框已提交，并读回本账号的新消息编号；未独立核验其他成员可见性。',
      };
    await page.waitForTimeout(400);
  }
  return {
    status: 'unknown' as const,
    detail: '已经触发一次提交，暂未读回服务端消息编号；不自动重发。',
  };
}

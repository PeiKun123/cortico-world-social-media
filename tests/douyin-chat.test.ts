import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { findBrowserExecutable } from '../src/platforms/bilibili-browser.ts';
import { openDouyinGroup, readDouyinGroup, sendDouyinGroup } from '../src/platforms/douyin-chat.ts';
describe.skipIf(!findBrowserExecutable())('Douyin group destination boundaries', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: findBrowserExecutable(), headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  async function fixture(duplicate = false, wrong = false) {
    const page = await browser.newPage();
    await page.context().setOffline(true);
    await page.setContent(`<button id=messages>消息</button><div id=panel></div><div id=chat></div><script>
    window.opens=0;document.querySelector('#messages').onclick=()=>{document.querySelector('#panel').innerHTML='<input placeholder=搜索><div><div class=SearchPanelgroupheader>联系人</div><section><span>测试群</span>小K<button>发消息</button></section></div><div><div class=SearchPanelgroupheader>群聊</div><section><span>测试群</span>(27)<button id=open>发消息</button></section>${duplicate ? '<section><span>测试群</span>(12)<button>发消息</button></section>' : ''}</div>';document.querySelector('#open').onclick=()=>{window.opens++;document.querySelector('#chat').innerHTML='<div class=StackLayoutStackChatHeadertitle>${wrong ? '别的群' : '测试群'}(27)</div><div class=componentsRightPanelnotHeaderArea data-conversation-id=conv-1><div data-message-id=m-1>群友：你好</div></div><div contenteditable=true data-placeholder=发送消息></div>';}};
    </script>`);
    return page;
  }
  it('opens only the group result when an owner contact has the same highlighted name', async () => {
    const page = await fixture();
    try {
      expect(await openDouyinGroup(page, { id: '123456', name: '测试群' })).toMatchObject({
        name: '测试群',
      });
      expect(await page.evaluate(() => (window as any).opens)).toBe(1);
    } finally {
      await page.close();
    }
  });
  it('waits for the official message button to initialize before opening', async () => {
    const p = await fixture();
    try {
      await p.evaluate(() => {
        const button = document.querySelector('#messages') as HTMLElement;
        const handler = button.onclick;
        button.onclick = null;
        setTimeout(() => (button.onclick = handler), 700);
      });
      expect(await openDouyinGroup(p, { id: '123456', name: '测试群' })).toMatchObject({
        name: '测试群',
      });
    } finally {
      await p.close();
    }
  }, 20000);
  it('refuses ambiguous same-name groups', async () => {
    const page = await fixture(true);
    try {
      await expect(openDouyinGroup(page, { id: '123456', name: '测试群' })).rejects.toThrow(
        /唯一群聊/,
      );
      expect(await page.evaluate(() => (window as any).opens)).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('refuses an unexpected conversation after the page opens a different group', async () => {
    const page = await fixture(false, true);
    try {
      await expect(openDouyinGroup(page, { id: '123456', name: '测试群' })).rejects.toThrow(
        /指定群聊/,
      );
    } finally {
      await page.close();
    }
  });
  it('reads actual long server IDs and derives self from the verified account, not UI isMyMessage', async () => {
    const p = await browser.newPage();
    try {
      await p.context().setOffline(true);
      await p.setContent(
        '<div class=StackChatHeadertitle>测试群(3)</div><div class=messageMessageBoxmessageBox><div class=MessageBoxMessageTitleavatarName>甲</div></div><div contenteditable=true data-placeholder=发送消息></div>',
      );
      await p.evaluate(
        `(()=>{document.querySelector('[class*=messageMessageBoxmessageBox]').__reactFiberTest={memoizedProps:{message:{serverId:'9007199254740993',conversationId:'conv-test',secSender:'other',isMyMessage:true,_parsedContent:{text:'你好'},createdAt:new Date(1000),serverStatus:0,type:7}}};})()`,
      );
      const view = await readDouyinGroup(p, { id: '123456', name: '测试群' }, 'bot');
      expect(view.messages[0]).toMatchObject({
        id: '9007199254740993',
        own: false,
        sender: '甲',
        text: '你好',
      });
      await expect(
        sendDouyinGroup(
          p,
          { id: '123456', name: '测试群', conversationId: 'wrong' },
          'bot',
          '你好',
        ),
      ).rejects.toThrow(/群会话/);
      expect(await p.locator('[contenteditable]').innerText()).toBe('');
    } finally {
      await p.close();
    }
  });
  it('submits once and requires a new own server message with exact text before accepting delivery', async () => {
    const p = await browser.newPage();
    try {
      await p.context().setOffline(true);
      await p.setContent(
        '<div class=StackChatHeadertitle>测试群(3)</div><div class=messageMessageBoxmessageBox></div><div contenteditable=true data-placeholder=发送消息></div>',
      );
      await p.evaluate(
        `(()=>{document.querySelector('[class*=messageMessageBoxmessageBox]').__reactFiberTest={memoizedProps:{message:{serverId:'123',conversationId:'conv-test',secSender:'other',_parsedContent:{text:'早上好'},createdAt:new Date(1000),serverStatus:0,type:7}}};window.submits=0;document.querySelector('[contenteditable]').oninput=e=>e.target.removeAttribute('data-placeholder');document.querySelector('[contenteditable]').onkeydown=e=>{if(e.key!=='Enter')return;e.preventDefault();window.submits++;const n=document.createElement('div');n.className='messageMessageBoxmessageBox';n.__reactFiberTest={memoizedProps:{message:{serverId:'9007199254740995',conversationId:'conv-test',secSender:'bot',_parsedContent:{text:e.target.innerText},createdAt:new Date(),serverStatus:0,type:7}}};document.body.append(n);e.target.innerText='';};})()`,
      );
      expect(
        await sendDouyinGroup(
          p,
          { id: '123456', name: '测试群', conversationId: 'conv-test' },
          'bot',
          '早呀',
        ),
      ).toMatchObject({ status: 'sent', messageId: '9007199254740995' });
      expect(await p.evaluate('window.submits')).toBe(1);
    } finally {
      await p.close();
    }
  });
});

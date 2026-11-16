import { chromium, type Browser, type Route } from 'playwright-core';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { GeminiPractice } from '../src/platforms/gemini-practice.ts';
import { findBrowserExecutable } from '../src/platforms/bilibili-browser.ts';

const executablePath = findBrowserExecutable();
let browser: Browser;
beforeAll(async () => {
  if (executablePath) browser = await chromium.launch({ executablePath, headless: true });
});
afterAll(async () => { await browser?.close(); });
it.skipIf(!executablePath)('waits for a complete Gemini response before asking the follow-up in the bound chat', async () => {
  const submitted: string[] = [];
  const handle = async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://gemini.google.com') return route.abort();
    if (url.pathname === '/record') {
      submitted.push(route.request().postData() ?? '');
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === '/app/unavailable') return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<rich-textarea><div contenteditable="true">不能发送</div></rich-textarea>
        <script>history.replaceState({}, '', '/app/practice-test');</script>`,
    });
    if (url.pathname === '/app/thread-limit' || url.pathname === '/app/usage-limit') return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<user-query>历史问题</user-query><rich-textarea><div contenteditable="true">草稿</div></rich-textarea><div role="alert">' +
        (url.pathname === '/app/thread-limit' ? 'This conversation is too long' : 'Usage limit reached') + '</div>',
    });
    if (url.pathname !== '/app/practice-test') return route.abort();
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
      <rich-textarea><div contenteditable="true" role="textbox"></div></rich-textarea>
      <button aria-label="发送消息">发送</button><section></section>
      <script>
      const editor = document.querySelector('[contenteditable]');
      const send = document.querySelector('button');
      const thread = document.querySelector('section');
      let count = 0;
      setTimeout(() => thread.insertAdjacentHTML('afterbegin', '<user-query><span class="query-text-line">已绑定会话的开场</span></user-query>'), 200);
      send.onclick = () => {
        const prompt = editor.textContent;
        void fetch('/record', { method: 'POST', body: prompt });
        count++;
        editor.textContent = '';
        if (count === 1) thread.insertAdjacentHTML('afterbegin',
          '<user-query><div class="query-text">旧开场</div></user-query><model-response><div class="markdown">发来吧，把原话贴给我</div><button aria-label="复制回复">复制</button></model-response>');
        const query = document.createElement('user-query');
        const body = document.createElement('div');
        body.className = 'query-text';
        const label = document.createElement('span');
        label.textContent = '你说';
        const line = document.createElement('span');
        line.className = 'query-text-line';
        line.textContent = prompt;
        body.append(label, line);
        query.append(body);
        thread.append(query);
        const result = document.createElement('model-response');
        result.innerHTML = '<div class="markdown">还没说完</div><button aria-label="停止生成">停止</button>';
        thread.append(result);
        setTimeout(() => {
          result.querySelector('.markdown').textContent = '完整回复 ' + count;
          result.querySelector('button').remove();
          result.insertAdjacentHTML('beforeend','<button aria-label="复制回复">复制</button>');
        }, 1100);
      };
      </script>` });
  };
  const launch = vi.spyOn(chromium, 'launchPersistentContext').mockImplementation(async () => {
    const context = await browser.newContext({ offline: true });
    await context.route('**/*', handle);
    return context;
  });
  const teacher = new GeminiPractice('unused-profile');
  try {
    const feedback: string[] = [];
    await expect(teacher.verifyConversation('https://gemini.google.com/app')).rejects.toThrow('教学会话网址');
    expect(launch).not.toHaveBeenCalled();
    await expect(teacher.verifyConversation('https://gemini.google.com/app/practice-test?source=copy'))
      .resolves.toBe('https://gemini.google.com/app/practice-test');
    expect(submitted).toEqual([]);

    await expect(teacher.practice('https://gemini.google.com/app/unavailable', '不要发', undefined, AbortSignal.timeout(9000), () => {}))
      .rejects.toThrow('离开绑定');
    expect(submitted).toEqual([]);
    await teacher.practice('https://gemini.google.com/app/practice-test', '第一题', '再出一道新题', AbortSignal.timeout(9000), text => feedback.push(text));
    expect(feedback).toEqual(['完整回复 1', '完整回复 2']);
    expect(submitted).toEqual(['第一题', '再出一道新题']);
    expect(launch).toHaveBeenCalledWith('unused-profile', expect.objectContaining({ channel: 'msedge', headless: true }));
    launch.mockClear();
    await teacher.practice('https://gemini.google.com/app/practice-test', '新话题', undefined, AbortSignal.timeout(7000), text => feedback.push(text), true);
    await teacher.practice('https://gemini.google.com/app/practice-test', '接着问', undefined, AbortSignal.timeout(7000), text => feedback.push(text), true);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(submitted.slice(-2)).toEqual(['新话题', '接着问']);
    expect(feedback.slice(-2)).toEqual(['完整回复 1', '完整回复 2']);
    await expect(teacher.practice('https://gemini.google.com/app/unavailable', '不能换会话发', undefined, AbortSignal.timeout(7000), () => {}, true))
      .rejects.toThrow('离开绑定');
    expect(submitted).not.toContain('不能换会话发');
    await expect(teacher.verifyConversation('https://gemini.google.com/app/thread-limit')).rejects.toThrow('长度上限');
    await expect(teacher.verifyConversation('https://gemini.google.com/app/usage-limit')).rejects.toThrow('使用额度');
  } finally {
    await teacher.close();
    launch.mockRestore();
  }
}, 20_000);

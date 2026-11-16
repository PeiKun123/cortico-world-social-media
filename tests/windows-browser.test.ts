import { describe, it, expect, vi } from 'vitest';
import { chromium } from 'playwright-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBrowserExecutable } from '../src/platforms/bilibili-browser.ts';
import { hideOwnedBrowserWindows } from '../src/platforms/windows-browser.ts';
vi.setConfig({ testTimeout: 30000 });
describe.skipIf(process.platform !== 'win32' || !findBrowserExecutable())(
  'owned Windows browser visibility',
  () => {
    it('hides only its own compatible window while keeping page actions working and releases the helper', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'socialmedia-window-test-'));
      const context = await chromium.launchPersistentContext(dir, {
        executablePath: findBrowserExecutable(),
        headless: false,
        args: [
          '--window-position=-32000,-32000',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
        ],
      });
      try {
        const page = context.pages()[0] || (await context.newPage());
        await page.setContent('<p>isolated browser</p>');
        const result = await hideOwnedBrowserWindows(context);
        expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
        expect(result.windows).toBeGreaterThan(0);
        expect(result.onScreen).toBe(0);
        expect(result.taskbar).toBe(0);
        await page.evaluate(() => {
          document.body.innerHTML = '<button onclick="this.textContent=String(42)">test</button>';
        });
        await page.getByRole('button', { name: 'test' }).click();
        expect(await page.getByRole('button').innerText()).toBe('42');
        expect((await hideOwnedBrowserWindows(context)).onScreen).toBe(0);
      } finally {
        await context.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  },
);

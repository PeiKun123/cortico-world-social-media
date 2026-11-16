import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { BrowserContext } from 'playwright-core';

const run = promisify(execFile);
// No titles, profile paths or commands come from pages. The PID comes from this context's CDP.
const nativeCode = `using System;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class OwnedBrowserWindow {
  delegate bool Visit(IntPtr window, IntPtr state);
  [DllImport("user32.dll")] static extern bool EnumWindows(Visit visit, IntPtr state);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int size);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int state);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] static extern IntPtr Get64(IntPtr window, int index);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] static extern IntPtr Set64(IntPtr window, int index, IntPtr value);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int Get32(IntPtr window, int index);
  [DllImport("user32.dll", EntryPoint="SetWindowLongW")] static extern int Set32(IntPtr window, int index, int value);
  static long Style(IntPtr window) { return IntPtr.Size == 8 ? Get64(window,-20).ToInt64() : Get32(window,-20); }
  public static string Hide(uint ownedPid) {
    var owner=Process.GetProcessById((int)ownedPid);
    var ownerHandle=owner.Handle; // Retain the original process identity while enumerating.
    int windows=0, visible=0, taskbar=0;
    EnumWindows((window,state) => {
      if(owner.HasExited) return false;
      uint actual; GetWindowThreadProcessId(window,out actual);
      if(actual!=ownedPid) return true;
      var name=new StringBuilder(128); GetClassName(window,name,name.Capacity);
      if(!name.ToString().StartsWith("Chrome_WidgetWin_",StringComparison.Ordinal)) return true;
      windows++;
      ShowWindow(window,0);
      long style=(Style(window) & ~0x40000L) | 0x80L | 0x08000000L;
      if(IntPtr.Size==8) Set64(window,-20,new IntPtr(style)); else Set32(window,-20,(int)style);
      // Keep native rendering active; only its screen/taskbar presentation is hidden.
      int left=GetSystemMetrics(76), top=GetSystemMetrics(77);
      SetWindowPos(window,IntPtr.Zero,left-20000,top-20000,0,0,0x35);
      ShowWindow(window,8); // SW_SHOWNA: no foreground activation.
      Rect rect;
      if(IsWindowVisible(window) && GetWindowRect(window,out rect) &&
         rect.Right>left && rect.Bottom>top && rect.Left<left+GetSystemMetrics(78) && rect.Top<top+GetSystemMetrics(79)) visible++;
      long after=Style(window);
      if((after & 0x40000L)!=0 || (after & 0x80L)==0) taskbar++;
      return true;
    }, IntPtr.Zero);
    return "{\\"windows\\":"+windows+",\\"onScreen\\":"+visible+",\\"taskbar\\":"+taskbar+"}";
  }
}`;
export async function hideOwnedBrowserWindows(
  context: BrowserContext,
): Promise<{ windows: number; onScreen: number; taskbar: number }> {
  if (process.platform !== 'win32') throw Error('窗口隐藏仅支持Windows。');
  const browser = context.browser();
  if (!browser) throw Error('无法确认本World的浏览器进程。');
  const session = await browser.newBrowserCDPSession();
  let pid: number;
  try {
    const info = await session.send('SystemInfo.getProcessInfo');
    const owners = info.processInfo.filter((p) => p.type === 'browser');
    if (
      owners.length !== 1 ||
      !Number.isSafeInteger(owners[0].id) ||
      owners[0].id < 1 ||
      owners[0].id > 0xffffffff
    )
      throw Error('无法确认本World的浏览器进程。');
    pid = owners[0].id;
  } finally {
    await session.detach();
  }
  const directory = await mkdtemp(join(tmpdir(), 'socialmedia-window-'));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  context.once('close', cancel);
  try {
    if (!browser.isConnected()) throw Error('浏览器已关闭。');
    const script =
      "$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n" +
      nativeCode +
      "\n'@\n[OwnedBrowserWindow]::Hide(" +
      pid +
      ')';
    const { stdout } = await run(
      join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        windowsHide: true,
        shell: false,
        timeout: 7000,
        maxBuffer: 4096,
        signal: controller.signal,
        env: { ...process.env, TEMP: directory, TMP: directory },
      },
    );
    const result = JSON.parse(stdout.trim());
    if (
      !Number.isInteger(result.windows) ||
      result.windows < 1 ||
      result.onScreen !== 0 ||
      result.taskbar !== 0
    )
      throw Error('未能确认窗口已经隐藏。');
    return result;
  } catch {
    throw Error('隐藏窗口未成功，保留普通兼容模式。');
  } finally {
    context.off('close', cancel);
    await rm(directory, { recursive: true, force: true });
  }
}

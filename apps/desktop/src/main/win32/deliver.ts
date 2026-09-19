/**
 * 桌面端投递：把一段文字送进目标应用的输入框并回车。
 */

import type { TargetDef } from '@xfb/shared';
import { win32Helper } from './helper.js';
import { clipboardWatcher } from '../clipboard/watcher.js';

export interface DeliverOutcome {
  ok: boolean;
  /** 目标窗口句柄，后续探测要用。 */
  hwnd?: number;
  /** 目标窗口标题。像素差分要靠它在 desktopCapturer 里认窗口。 */
  title?: string;
  /** 失败原因，已经是可以直接显示给用户的中文。 */
  message?: string;
}

export interface LocatedWindow {
  hwnd: number;
  title: string;
}

/** deliver 内部有窗口切换和多次等待，给足超时。 */
const DELIVER_TIMEOUT_MS = 15_000;

function describeFailure(reason: string | undefined): string {
  switch (reason) {
    case 'not-found':
      return '没找到目标窗口，可能应用没启动或被收进了托盘';
    case 'foreground-failed':
    case 'foreground-timeout':
      return '无法切换到目标窗口，可能被其它全屏程序挡住了';
    default:
      return reason ? `投递失败：${reason}` : '投递失败';
  }
}

/** 定位目标窗口。返回 null 表示没有可见窗口。 */
export async function locateWindow(target: TargetDef): Promise<LocatedWindow | null> {
  if (!target.processName) return null;
  const res = await win32Helper.send('find', {
    processName: target.processName,
    windowClass: target.windowClass ?? null,
  });
  if (res.ok && typeof res['hwnd'] === 'number') {
    const title = typeof res['title'] === 'string' && res['title'] ? res['title'] : target.processName;
    return { hwnd: res['hwnd'], title };
  }
  return null;
}

/**
 * 投递文本到 win32 目标。
 *
 * restoreFocus 默认开启：发完立刻把焦点还给用户原来所在的窗口，
 * 目标应用留在后台安静生成——这是「发完别打扰我」的核心。
 */
export async function deliverToWin32(
  target: TargetDef,
  text: string,
  restoreFocus = true,
): Promise<DeliverOutcome> {
  const located = await locateWindow(target);
  if (located === null) {
    return { ok: false, message: describeFailure('not-found') };
  }
  const { hwnd, title } = located;

  // 中文经 base64 传输，绕开命令行与 PowerShell 之间的所有编码陷阱。
  const encoded = Buffer.from(text, 'utf8').toString('base64');

  /*
    整个 deliver 都要圈进静默窗口。

    助手内部会写两次剪贴板（写投递文本、再恢复用户原本的备份），这两次
    都不是用户在复制。不圈起来的话，每发一条消息，剪贴板历史里就会多出
    一条自己刚发的内容——而且是紧跟在用户真正复制的那条后面，很难看出是程序干的。

    必须包住整个调用而不只是前半段：恢复剪贴板发生在助手返回**之前**的最后一步。
  */
  const res = await clipboardWatcher.suppress(() =>
    win32Helper.send('deliver', { hwnd, text: encoded, restoreFocus }, DELIVER_TIMEOUT_MS),
  );

  if (!res.ok) {
    return { ok: false, hwnd, title, message: describeFailure(res.reason) };
  }
  return { ok: true, hwnd, title };
}

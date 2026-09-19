/**
 * 悬浮标的鼠标命中跟踪。
 *
 * 为什么是主进程轮询，而不是渲染层监听 mousemove：
 * 窗口默认开着鼠标穿透（否则那片透明区域会一直挡桌面点击），
 * 而 `setIgnoreMouseEvents(true, { forward: true })` 承诺的「穿透时仍转发
 * mousemove」在 Windows 上实测**收不到**——渲染层完全静默。
 * 于是改成主进程直接问系统光标在哪，不依赖渲染层收事件。
 *
 * 轮询的代价很小：一次 getCursorScreenPoint 加几个数值比较。
 */

import { screen, type BrowserWindow } from 'electron';

/** 轮询间隔。够跟手，又不至于空转太频繁。 */
const POLL_MS = 120;

/** 本体在窗口内的位置，由渲染层上报（CSS 像素，等同于 DIP）。 */
export interface HitRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface HoverTracker {
  /** 渲染层在本体尺寸变化时调用（展开/收拢会改变可命中区域）。 */
  updateRect(rect: HitRect): void;
  stop(): void;
}

/**
 * 开始跟踪。命中状态变化时回调一次，不是每轮都回调。
 */
export function trackHover(
  win: BrowserWindow,
  onChange: (hovering: boolean) => void,
): HoverTracker {
  let rect: HitRect | null = null;
  let hovering = false;

  const timer = setInterval(() => {
    if (win.isDestroyed() || !rect) return;

    const cursor = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    // 换算到窗口内坐标再和本体矩形比对。
    const x = cursor.x - bounds.x;
    const y = cursor.y - bounds.y;
    const inside =
      x >= rect.left &&
      x <= rect.left + rect.width &&
      y >= rect.top &&
      y <= rect.top + rect.height;

    if (inside === hovering) return;
    hovering = inside;
    onChange(hovering);
  }, POLL_MS);

  return {
    updateRect(next: HitRect) {
      rect = next;
    },
    stop() {
      clearInterval(timer);
    },
  };
}

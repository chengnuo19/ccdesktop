/**
 * UIA 可访问性树探测器 —— 桌面端的中档方案。
 *
 * 原理：Chromium 在生成回复时，发送按钮会变成「停止」按钮。
 * 轮询可访问性树里有没有停止类按钮，就能判断出是否仍在生成。
 * 比像素差分准得多，但仍有轮询延迟，所以置信度是 approximate。
 *
 * 前提是 Chromium 的 a11y 树被唤醒了。实测 ChatGPT Classic 可以
 * （节点数 8 → 245），Gemini 不行（恒为 15）。所以每次都要先验货，
 * 唤不醒就如实报告不可用，让上层降级到像素差分。
 */

import { win32Helper } from '../win32/helper.js';

/**
 * 判定 a11y 树「醒了」的节点数下限。
 *
 * 未唤醒时只有窗口外壳的那几个节点（实测 8~15 个）；
 * 真醒了会有几百个。50 这个值落在两者之间，留足余量。
 */
const AWAKE_NODE_THRESHOLD = 50;

export interface UiaProbeResult {
  /** 这条探测路可不可用。false 表示上层应当降级。 */
  usable: boolean;
  streaming: boolean;
}

export class UiaProbe {
  private awake = false;

  constructor(private readonly hwnd: number) {}

  /**
   * 尝试唤醒并验货。
   * 返回 false 表示这个目标吃不了 UIA 这一档。
   */
  async prepare(): Promise<boolean> {
    try {
      await win32Helper.send('wake-a11y', { hwnd: this.hwnd });
      // 唤醒后 Chromium 需要一点时间构建树，立刻查会看到旧的节点数。
      await new Promise((r) => setTimeout(r, 600));
      const res = await win32Helper.send('uia-probe', { hwnd: this.hwnd });
      const count = typeof res['nodeCount'] === 'number' ? res['nodeCount'] : 0;
      this.awake = res.ok === true && count >= AWAKE_NODE_THRESHOLD;
      return this.awake;
    } catch {
      this.awake = false;
      return false;
    }
  }

  async sample(): Promise<UiaProbeResult> {
    if (!this.awake) return { usable: false, streaming: false };
    try {
      const res = await win32Helper.send('uia-probe', { hwnd: this.hwnd });
      if (res.ok !== true) return { usable: false, streaming: false };
      const count = typeof res['nodeCount'] === 'number' ? res['nodeCount'] : 0;
      // 树中途塌回未唤醒状态（应用重载页面时会发生），同样按不可用处理。
      if (count < AWAKE_NODE_THRESHOLD) return { usable: false, streaming: false };
      return { usable: true, streaming: res['streaming'] === true };
    } catch {
      return { usable: false, streaming: false };
    }
  }
}

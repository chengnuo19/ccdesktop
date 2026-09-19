/**
 * 进度跟踪编排器。
 *
 * 按目标声明的 probeChain 依次尝试各档探测器，哪一档能用就用哪一档，
 * 全都不行就退到最粗的一档。跟踪期间持续汇报状态，
 * 结束或超时后收尾。
 */

import type { ProbeConfidence, TargetDef } from '@xfb/shared';
import { THINKING_TIMEOUT_MS } from '@xfb/shared';
import { UiaProbe } from './uia.js';
import { PixelProbe } from './pixel.js';

/** 各档探测器的轮询间隔。UIA 要跨进程查树，开销大些，放慢一点。 */
const POLL_INTERVAL_MS: Record<ProbeConfidence, number> = {
  exact: 400,
  approximate: 1_000,
  coarse: 700,
};

export interface TrackUpdate {
  phase: 'thinking' | 'done';
  confidence: ProbeConfidence;
  elapsedMs: number;
}

export interface TrackOptions {
  target: TargetDef;
  hwnd: number;
  windowTitle: string;
  onUpdate: (update: TrackUpdate) => void;
}

/**
 * 跟踪一轮生成直到结束。
 *
 * 返回的 stop() 用于外部打断（比如用户又发了新消息，
 * 或者应用要退出了）。
 */
export function trackProgress(opts: TrackOptions): { stop: () => void } {
  const { target, hwnd, windowTitle, onUpdate } = opts;
  const startedAt = Date.now();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };

  const finish = (confidence: ProbeConfidence) => {
    if (stopped) return;
    stopped = true;
    onUpdate({ phase: 'done', confidence, elapsedMs: Date.now() - startedAt });
  };

  void (async () => {
    // ---- 挑一档能用的探测器 ----
    let uia: UiaProbe | null = null;
    let confidence: ProbeConfidence = 'coarse';

    for (const kind of target.probeChain) {
      if (stopped) return;
      if (kind === 'uia') {
        const probe = new UiaProbe(hwnd);
        if (await probe.prepare()) {
          uia = probe;
          confidence = 'approximate';
          break;
        }
        // 唤不醒，继续试下一档。
      } else if (kind === 'pixel') {
        confidence = 'coarse';
        break;
      }
      // 'dom' 由扩展侧负责，不会走到这里。
    }

    let pixel: PixelProbe | null = uia ? null : new PixelProbe(windowTitle);
    pixel?.begin();

    if (stopped) return;
    // 选中哪一档直接决定进度的可信度，出问题时这是第一条要看的线索。
    console.log(`[探测] ${target.id} 选用 ${confidence} 档`);
    onUpdate({ phase: 'thinking', confidence, elapsedMs: 0 });

    let interval = POLL_INTERVAL_MS[confidence];

    const poll = async (): Promise<void> => {
      if (stopped) return;

      const elapsed = Date.now() - startedAt;
      // 兜底超时：任何一档探测都可能漏掉结束事件，
      // 绝不让圆环永远转下去。
      if (elapsed > THINKING_TIMEOUT_MS) {
        finish(confidence);
        return;
      }

      let stillStreaming: boolean;
      if (uia) {
        const res = await uia.sample();
        if (!res.usable) {
          // 跟踪途中 UIA 失效了（比如页面重载），当场降级到像素差分，
          // 而不是直接判定结束。
          uia = null;
          confidence = 'coarse';
          pixel = new PixelProbe(windowTitle);
          pixel.begin();
          interval = POLL_INTERVAL_MS.coarse;
          onUpdate({ phase: 'thinking', confidence, elapsedMs: elapsed });
          timer = setTimeout(() => void poll(), interval);
          return;
        }
        stillStreaming = res.streaming;
      } else if (pixel) {
        const res = await pixel.sample();
        stillStreaming = res.streaming;
      } else {
        stillStreaming = false;
      }

      if (!stillStreaming) {
        finish(confidence);
        return;
      }

      onUpdate({ phase: 'thinking', confidence, elapsedMs: elapsed });
      timer = setTimeout(() => void poll(), interval);
    };

    timer = setTimeout(() => void poll(), interval);
  })();

  return { stop };
}

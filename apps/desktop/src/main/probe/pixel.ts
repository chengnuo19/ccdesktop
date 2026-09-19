/**
 * 像素差分探测器 —— 所有目标的兜底方案。
 *
 * 原理：定期抓目标窗口的小尺寸缩略图，比较相邻两帧的差异。
 * 画面还在变 = 正在生成；连续若干次几乎不变 = 生成结束。
 *
 * 它读不出任何内容，只能看出「有没有在动」，所以置信度是 coarse。
 * 但它不依赖可访问性树、不依赖 DOM，对任何应用都有效——
 * Gemini 桌面端实测唤不醒 a11y，只能吃这一档。
 */

import { desktopCapturer } from 'electron';

/** 缩略图边长。够小以保证性能，又够大以反映文字增长。 */
const THUMB_SIZE = 96;

/** 平均每通道差值超过这个数，就认为画面在变。 */
const CHANGE_THRESHOLD = 1.2;

/** 连续这么多次判定为静止，才认定生成结束。 */
const STILL_COUNT_TO_FINISH = 3;

/**
 * 投递后的宽限期。
 *
 * 消息刚发出去时要等网络往返，画面可能好几秒都不动。
 * 这段时间内一律按「生成中」处理，否则会立刻误判成完成。
 */
const GRACE_PERIOD_MS = 4_000;

export interface PixelProbeResult {
  /** 是否仍在生成。 */
  streaming: boolean;
  /** 本帧与上帧的差异度，用于调试和阈值调参。 */
  delta: number;
}

async function grabThumbnail(windowTitle: string): Promise<Buffer | null> {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: THUMB_SIZE, height: THUMB_SIZE },
    fetchWindowIcons: false,
  });

  // desktopCapturer 不按句柄索引，只能靠标题匹配。
  // 标题完全相等优先，避免 "ChatGPT" 误匹配到 "ChatGPT Classic"。
  const exact = sources.find((s) => s.name === windowTitle);
  const source = exact ?? sources.find((s) => s.name.includes(windowTitle));
  if (!source || source.thumbnail.isEmpty()) return null;
  return source.thumbnail.toBitmap();
}

/** 两帧之间的平均每通道绝对差。 */
function frameDelta(a: Buffer, b: Buffer): number {
  if (a.length !== b.length || a.length === 0) return Number.POSITIVE_INFINITY;
  let sum = 0;
  // BGRA 排列，跳过 alpha 通道；每 4 个像素采样一次以省 CPU。
  const stride = 16;
  let samples = 0;
  for (let i = 0; i < a.length - 3; i += stride) {
    sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    sum += Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0));
    sum += Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0));
    samples += 3;
  }
  return samples === 0 ? 0 : sum / samples;
}

export class PixelProbe {
  private lastFrame: Buffer | null = null;
  private stillCount = 0;
  private startedAt = 0;

  constructor(private readonly windowTitle: string) {}

  /** 每轮投递开始时调用，重置状态。 */
  begin(): void {
    this.lastFrame = null;
    this.stillCount = 0;
    this.startedAt = Date.now();
  }

  /** 采一帧并判断是否仍在生成。 */
  async sample(): Promise<PixelProbeResult> {
    const frame = await grabThumbnail(this.windowTitle);

    // 抓不到窗口（被最小化或已关闭）。保持「生成中」，交给上层超时收尾，
    // 总比把一次可能还在进行的回复错报成完成要好。
    if (!frame) {
      return { streaming: true, delta: 0 };
    }

    const previous = this.lastFrame;
    this.lastFrame = frame;

    const inGrace = Date.now() - this.startedAt < GRACE_PERIOD_MS;
    if (!previous) {
      return { streaming: true, delta: 0 };
    }

    const delta = frameDelta(previous, frame);

    if (delta > CHANGE_THRESHOLD) {
      this.stillCount = 0;
      return { streaming: true, delta };
    }

    if (inGrace) {
      // 宽限期内的静止不计数——这时候多半只是还没开始吐字。
      return { streaming: true, delta };
    }

    this.stillCount += 1;
    return { streaming: this.stillCount < STILL_COUNT_TO_FINISH, delta };
  }
}

/**
 * 宠物状态的唯一真源。
 *
 * 把「投递」和「进度跟踪」串成一条链，对外只暴露一个 PetState 流。
 * 渲染层不关心消息去了桌面端还是网页端、进度是怎么探出来的，
 * 只认这里广播的状态。
 */

import {
  DONE_LINGER_MS,
  ERROR_LINGER_MS,
  INITIAL_PET_STATE,
  THINKING_TIMEOUT_MS,
  findTarget,
  type PetState,
  type ProbeConfidence,
} from '@xfb/shared';
import { deliverToWin32 } from './win32/deliver.js';
import type { BridgeServer } from './bridge/server.js';
import { trackProgress } from './probe/tracker.js';

type Listener = (state: PetState) => void;

export class PetOrchestrator {
  private state: PetState = { ...INITIAL_PET_STATE };
  private listeners = new Set<Listener>();
  private activeTrack: { stop: () => void } | null = null;
  private lingerTimer: NodeJS.Timeout | null = null;
  private bridge: BridgeServer | null = null;

  /** 接入扩展桥。没接的话，网页目标会如实报告不可用。 */
  attachBridge(bridge: BridgeServer): void {
    this.bridge = bridge;
  }

  getState(): PetState {
    return this.state;
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private patch(next: Partial<PetState>): void {
    this.state = { ...this.state, ...next };
    for (const fn of this.listeners) fn(this.state);
  }

  private clearLinger(): void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
  }

  /** 回到待机。done / error 停留一段时间后自动调用。 */
  private toIdle(): void {
    this.clearLinger();
    this.patch({
      phase: 'idle',
      targetId: null,
      confidence: null,
      progress: null,
      elapsedMs: 0,
      errorMessage: null,
    });
  }

  private fail(message: string): void {
    this.clearLinger();
    this.patch({ phase: 'error', errorMessage: message, confidence: null, progress: null });
    this.lingerTimer = setTimeout(() => this.toIdle(), ERROR_LINGER_MS);
  }

  private succeed(confidence: ProbeConfidence, elapsedMs: number): void {
    this.clearLinger();
    this.patch({ phase: 'done', confidence, progress: 1, elapsedMs });
    this.lingerTimer = setTimeout(() => this.toIdle(), DONE_LINGER_MS);
  }

  /**
   * 提交一条消息。
   *
   * 新的提交会打断上一轮还在跟踪的进度——用户又发问了，
   * 旧那一轮的圆环就没意义了。
   */
  async submit(targetId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    this.activeTrack?.stop();
    this.activeTrack = null;
    this.clearLinger();

    const target = findTarget(targetId);
    if (!target) {
      this.fail(`未知的目标：${targetId}`);
      return;
    }

    this.patch({
      phase: 'sending',
      targetId,
      confidence: null,
      progress: null,
      elapsedMs: 0,
      errorMessage: null,
    });

    if (target.delivery === 'web') {
      await this.submitToWeb(targetId, trimmed);
      return;
    }

    let outcome;
    try {
      outcome = await deliverToWin32(target, trimmed);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : '投递时发生未知错误');
      return;
    }

    if (!outcome.ok || outcome.hwnd === undefined) {
      this.fail(outcome.message ?? '投递失败');
      return;
    }

    const hwnd = outcome.hwnd;
    // 像素差分要靠窗口标题在 desktopCapturer 里认窗口。
    const windowTitle = outcome.title ?? target.processName ?? '';

    this.patch({ phase: 'thinking', confidence: null, progress: null });

    this.activeTrack = trackProgress({
      target,
      hwnd,
      windowTitle,
      onUpdate: (update) => {
        if (update.phase === 'thinking') {
          this.patch({
            phase: 'thinking',
            confidence: update.confidence,
            // 只有 exact 档才有真实比例；其余交给 UI 画不确定动画。
            progress: update.confidence === 'exact' ? this.state.progress : null,
            elapsedMs: update.elapsedMs,
          });
        } else {
          this.succeed(update.confidence, update.elapsedMs);
          this.activeTrack = null;
        }
      },
    });
  }

  /**
   * 网页目标：投递和进度探测都由扩展负责。
   * 扩展能直接读 DOM，所以结束时刻是准的——但仍然拿不到完成百分比
   * （不知道回复总长），progress 因此保持为空，UI 照常转圈。
   */
  private async submitToWeb(targetId: string, text: string): Promise<void> {
    const bridge = this.bridge;
    if (!bridge) {
      this.fail('网页端需要配合浏览器扩展，当前没有连接');
      return;
    }

    // 超时兜底：扩展可能在生成中途被浏览器回收，进度就再也回不来了。
    const timeout = setTimeout(() => {
      if (this.state.phase === 'thinking') this.succeed('exact', THINKING_TIMEOUT_MS);
    }, THINKING_TIMEOUT_MS);
    this.activeTrack = { stop: () => clearTimeout(timeout) };

    const outcome = await bridge.deliver(targetId, text, (update) => {
      if (update.phase === 'thinking') {
        this.patch({
          phase: 'thinking',
          confidence: update.confidence,
          progress: update.progress,
          elapsedMs: this.state.elapsedMs,
        });
      } else {
        clearTimeout(timeout);
        this.activeTrack = null;
        this.succeed(update.confidence, this.state.elapsedMs);
      }
    });

    if (!outcome.ok) {
      clearTimeout(timeout);
      this.activeTrack = null;
      this.fail(outcome.message ?? '网页端投递失败');
      return;
    }

    this.patch({ phase: 'thinking', confidence: 'exact', progress: null });
  }

  dispose(): void {
    this.activeTrack?.stop();
    this.clearLinger();
    this.listeners.clear();
  }
}

export const orchestrator = new PetOrchestrator();

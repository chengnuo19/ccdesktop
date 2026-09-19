/**
 * 目标可用性检测。
 *
 * 「这个目标现在发得过去吗」以前只能靠发一次失败才知道。
 * 面板要在选之前就告诉用户，所以需要主动探一下：
 *   桌面端 → 有没有可见窗口（收进托盘也算不可用，它接不了粘贴）
 *   网页端 → 扩展连着吗、有没有开着对应站点的标签页
 */

import { BUILTIN_TARGETS, type TargetDef } from '@xfb/shared';
import { locateWindow } from './win32/deliver.js';
import type { BridgeServer } from './bridge/server.js';

export interface TargetStatus {
  id: string;
  label: string;
  shortLabel: string;
  delivery: 'win32' | 'web';
  /** null 表示还没探完，UI 显示为「检测中」。 */
  available: boolean | null;
  /** 不可用时给出人话原因，直接显示在面板上。 */
  reason?: string;
}

/** 还没开始检测时的初始列表，让面板能立刻画出来。 */
export function pendingStatuses(): TargetStatus[] {
  return BUILTIN_TARGETS.map((t) => ({
    id: t.id,
    label: t.label,
    shortLabel: t.shortLabel,
    delivery: t.delivery,
    available: null,
  }));
}

async function checkWin32(target: TargetDef): Promise<TargetStatus> {
  const base = {
    id: target.id,
    label: target.label,
    shortLabel: target.shortLabel,
    delivery: target.delivery,
  };
  try {
    const found = await locateWindow(target);
    if (found) return { ...base, available: true };
    return { ...base, available: false, reason: '未启动或在托盘' };
  } catch {
    // 助手没响应时不谎报可用，但也说清是检测失败而非目标不可用。
    return { ...base, available: false, reason: '检测失败' };
  }
}

function checkWeb(target: TargetDef, bridge: BridgeServer | null): TargetStatus {
  const base = {
    id: target.id,
    label: target.label,
    shortLabel: target.shortLabel,
    delivery: target.delivery,
  };
  if (!bridge?.connected) return { ...base, available: false, reason: '扩展未连接' };
  if (!bridge.isTargetAvailable(target.id)) {
    return { ...base, available: false, reason: '没有打开该站点' };
  }
  return { ...base, available: true };
}

/**
 * 逐个检测所有目标。
 * win32 的检测要跨进程问助手，串行做——助手本身是单线程的，并发发过去也是排队。
 */
export async function checkAllTargets(bridge: BridgeServer | null): Promise<TargetStatus[]> {
  const out: TargetStatus[] = [];
  for (const target of BUILTIN_TARGETS) {
    out.push(target.delivery === 'web' ? checkWeb(target, bridge) : await checkWin32(target));
  }
  return out;
}

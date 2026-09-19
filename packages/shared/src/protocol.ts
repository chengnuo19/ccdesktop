/**
 * 悬浮窗主程序 ⇄ 浏览器扩展 的通信协议。
 *
 * 走本地 WebSocket：主程序开服务端，扩展的 background 连上来。
 * 只监听 127.0.0.1，不对外暴露。
 */

import type { ProbeConfidence } from './state.js';

/** 本地桥接端口。选一个不常用的高位端口，避开常见开发端口。 */
export const BRIDGE_PORT = 47615;
export const BRIDGE_URL = `ws://127.0.0.1:${BRIDGE_PORT}`;

/**
 * 握手用的共享密钥。
 *
 * 本地任何网页都能连 127.0.0.1 的 WebSocket，所以必须校验身份，
 * 否则随便一个页面都能驱动用户的 AI 客户端发消息。
 * 真实密钥在主程序首次启动时随机生成并写入配置，扩展安装时由用户粘贴，
 * 这里只定义字段名。
 */
export const AUTH_HEADER = 'x-xfb-token';

/** 主程序 → 扩展 */
export type HostMessage =
  /** 握手结果。 */
  | { type: 'hello'; ok: boolean; reason?: string }
  /**
   * 应用层心跳。
   *
   * 必须是真正的消息，不能用 WebSocket 协议层的 ping：
   * 协议层 ping 由浏览器底层直接回 pong，不会唤醒扩展的 service worker，
   * 它照样会在空闲 30 秒后被回收、连接随之断开。
   * 只有 message 事件才能重置那个空闲计时器。
   */
  | { type: 'heartbeat' }
  /** 让扩展把这段文字送进指定的网页目标并发送。 */
  | { type: 'deliver'; requestId: string; targetId: string; text: string }
  /** 询问某个网页目标当前是否可用（有没有打开着的标签页）。 */
  | { type: 'ping-target'; requestId: string; targetId: string }
  /**
   * 把某个网页目标的标签页切到前台。
   *
   * 生成完了之后用户想做的事就是去看回复，这条消息是那条路。
   * 用 tabId 而不是 targetId：投递发生时那个标签页是确定的，
   * 之后用户可能又开了同一站点的第二个标签页，按 targetId 现查会跳错地方。
   */
  | { type: 'activate'; requestId: string; tabId: number };

/** 扩展 → 主程序 */
export type ExtensionMessage =
  /** 扩展上线，报告自己能覆盖哪些目标。 */
  | { type: 'ready'; token: string; availableTargets: string[] }
  /** 投递结果。tabId 是这次实际送进了哪个标签页，用于事后跳回去看。 */
  | { type: 'deliver-result'; requestId: string; ok: boolean; reason?: string; tabId?: number }
  /** 切标签页的结果。浏览器窗口可能被系统的前台锁定挡住，不保证成功。 */
  | { type: 'activate-result'; requestId: string; ok: boolean; reason?: string }
  /**
   * 网页端探测到的生成进度。
   * 扩展能读到 DOM，所以这里的 confidence 一律是 'exact'。
   */
  | { type: 'progress'; requestId: string; phase: 'thinking' | 'done'; progress: number | null; confidence: ProbeConfidence }
  /** 目标可用性回报。 */
  | { type: 'target-status'; requestId: string; targetId: string; available: boolean };

export type BridgeMessage = HostMessage | ExtensionMessage;

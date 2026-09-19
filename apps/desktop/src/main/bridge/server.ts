/**
 * 本地桥：主程序 ⇄ 浏览器扩展。
 *
 * 只监听 127.0.0.1，且必须校验密钥——本机任何网页都能连上本地 WebSocket，
 * 不验身份的话，随便一个页面就能驱动用户的 AI 客户端发消息。
 *
 * MV3 的 service worker 空闲约 30 秒就会被回收。Chrome 116 起 WebSocket 收发
 * 会重置那个计时器，所以这里定期发心跳，把扩展的后台"焐着"。
 */

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID, randomBytes } from 'node:crypto';
import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { BRIDGE_PORT, type ExtensionMessage, type HostMessage, type ProbeConfidence } from '@xfb/shared';

/** 心跳间隔。必须显著小于 service worker 的 30 秒空闲上限。 */
const HEARTBEAT_MS = 20_000;

/** 等扩展回报投递结果的时限。 */
const DELIVER_TIMEOUT_MS = 12_000;

/**
 * 投递时若扩展不在线，愿意等它重连多久。
 * service worker 刚被回收时重连很快（约 1 秒），这个窗口足够覆盖。
 */
const RECONNECT_GRACE_MS = 4_000;

export interface WebDeliverOutcome {
  ok: boolean;
  message?: string;
}

export interface WebProgressUpdate {
  phase: 'thinking' | 'done';
  progress: number | null;
  confidence: ProbeConfidence;
}

type ProgressHandler = (update: WebProgressUpdate) => void;

/** 读取或生成桥接密钥。密钥存在用户数据目录，重启后保持不变。 */
export function loadOrCreateToken(): string {
  const file = path.join(app.getPath('userData'), 'bridge-token.txt');
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  }
  const token = randomBytes(24).toString('base64url');
  writeFileSync(file, token, 'utf8');
  return token;
}

export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private availableTargets = new Set<string>();

  /** 在途请求：requestId -> 回调。 */
  private pendingDeliveries = new Map<string, (outcome: WebDeliverOutcome) => void>();
  private progressHandlers = new Map<string, ProgressHandler>();

  constructor(private readonly token: string) {}

  start(): void {
    if (this.wss) return;

    // 绑定到回环地址，不对外暴露。
    this.wss = new WebSocketServer({ port: BRIDGE_PORT, host: '127.0.0.1' });

    this.wss.on('connection', (ws) => {
      console.log('[桥] 有客户端接入，等待握手');
      ws.on('message', (raw) => {
        let msg: ExtensionMessage;
        try {
          msg = JSON.parse(raw.toString()) as ExtensionMessage;
        } catch {
          console.warn('[桥] 收到无法解析的消息：', raw.toString().slice(0, 120));
          return;
        }
        console.log('[桥] 收到', msg.type);
        this.handleMessage(ws, msg);
      });

      ws.on('close', () => {
        if (this.client === ws) {
          this.client = null;
          this.availableTargets.clear();
        }
      });
    });

    this.wss.on('error', (err) => {
      console.error('[桥] 监听失败：', err.message);
    });

    // 用应用层消息保活。协议层的 ws.ping() 不会唤醒扩展的 service worker，
    // 它照样会被回收，连接随之断开——这一点是实测踩出来的。
    this.heartbeat = setInterval(() => {
      this.send({ type: 'heartbeat' });
    }, HEARTBEAT_MS);
  }

  private send(msg: HostMessage): boolean {
    if (this.client?.readyState !== WebSocket.OPEN) return false;
    this.client.send(JSON.stringify(msg));
    return true;
  }

  private handleMessage(ws: WebSocket, msg: ExtensionMessage): void {
    switch (msg.type) {
      case 'ready': {
        // 首次握手必须带正确密钥；后续的目标同步允许留空。
        if (this.client !== ws) {
          if (msg.token !== this.token) {
            console.warn(
              `[桥] 握手被拒：密钥不匹配（收到 ${msg.token ? msg.token.length + ' 字符' : '空值'}）`,
            );
            ws.send(JSON.stringify({ type: 'hello', ok: false, reason: '密钥不匹配' } satisfies HostMessage));
            ws.close();
            return;
          }
          this.client = ws;
          console.log('[桥] 握手成功，扩展已连接');
          ws.send(JSON.stringify({ type: 'hello', ok: true } satisfies HostMessage));
        }
        this.availableTargets = new Set(msg.availableTargets);
        console.log(`[桥] 可用网页目标：${[...this.availableTargets].join(', ') || '（无）'}`);
        return;
      }

      case 'deliver-result': {
        // 失败原因里带着页面实况，是排查网页端最关键的一条线索，务必完整记下。
        console.log(
          msg.ok ? '[桥] 投递成功' : `[桥] 投递失败：${msg.reason ?? '（未说明原因）'}`,
        );
        const resolve = this.pendingDeliveries.get(msg.requestId);
        if (!resolve) return;
        this.pendingDeliveries.delete(msg.requestId);
        resolve({ ok: msg.ok, message: msg.reason });
        return;
      }

      case 'progress': {
        console.log(`[桥] 网页端进度：${msg.phase}`);
        const handler = this.progressHandlers.get(msg.requestId);
        if (!handler) return;
        handler({ phase: msg.phase, progress: msg.progress, confidence: msg.confidence });
        if (msg.phase === 'done') this.progressHandlers.delete(msg.requestId);
        return;
      }

      case 'target-status':
        if (msg.available) this.availableTargets.add(msg.targetId);
        else this.availableTargets.delete(msg.targetId);
        return;

      default:
        return;
    }
  }

  get connected(): boolean {
    return this.client?.readyState === WebSocket.OPEN;
  }

  /** 某个网页目标当前有没有可用的标签页。 */
  isTargetAvailable(targetId: string): boolean {
    return this.availableTargets.has(targetId);
  }

  /** 等扩展连上来，最多等 timeoutMs。已经连着则立刻返回。 */
  private waitForConnection(timeoutMs: number): Promise<boolean> {
    if (this.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (this.connected) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - startedAt >= timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, 200);
    });
  }

  /**
   * 投递到网页目标。
   * 返回投递是否送达；后续的生成进度通过 onProgress 回调汇报。
   */
  async deliver(
    targetId: string,
    text: string,
    onProgress: ProgressHandler,
  ): Promise<WebDeliverOutcome> {
    if (!this.connected) {
      // 扩展的 service worker 可能刚被浏览器回收、正在重连。
      // 给一个短暂的窗口等它回来，别一上来就判死。
      const back = await this.waitForConnection(RECONNECT_GRACE_MS);
      if (!back) return { ok: false, message: '浏览器扩展没有连接' };
    }

    const requestId = randomUUID();
    this.progressHandlers.set(requestId, onProgress);

    return new Promise<WebDeliverOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingDeliveries.delete(requestId);
        this.progressHandlers.delete(requestId);
        resolve({ ok: false, message: '扩展没有回应，试试刷新目标标签页' });
      }, DELIVER_TIMEOUT_MS);

      this.pendingDeliveries.set(requestId, (outcome) => {
        clearTimeout(timer);
        if (!outcome.ok) this.progressHandlers.delete(requestId);
        resolve(outcome);
      });

      console.log(`[桥] 向 ${targetId} 投递（${text.length} 字）`);
      this.send({ type: 'deliver', requestId, targetId, text });
    });
  }

  dispose(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.client?.close();
    this.client = null;
    this.wss?.close();
    this.wss = null;
  }
}

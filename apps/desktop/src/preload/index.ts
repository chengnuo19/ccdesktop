/**
 * 预加载脚本：给渲染层开一扇窄门。
 *
 * 渲染层拿不到 Node，也拿不到 ipcRenderer 本体，
 * 只能调用这里显式列出的几个方法。
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { Celebration, PetState, PromptCategoryId } from '@xfb/shared';

export interface TargetSummary {
  id: string;
  label: string;
  delivery: 'win32' | 'web';
}

/** 提示词在列表里需要的字段。正文也带上，填入时不必再往返一次。 */
export interface PromptSummary {
  id: string;
  title: string;
  content: string;
  /** 用于列表分组。用户自建的条目没有这个字段。 */
  category?: PromptCategoryId;
  hasVariables: boolean;
}

/**
 * 剪贴板历史在列表里需要的字段。
 * 文本条目连全文一起带上，填入时不必再往返一次（同 PromptSummary 的取舍）。
 */
export interface ClipSummary {
  id: string;
  kind: 'text' | 'image';
  /** 全文。image 条目为空串。 */
  text: string;
  /** 单行预览。image 条目为空串，由渲染层用尺寸另行拼。 */
  preview: string;
  /** image 条目的缩略图 data URL。 */
  thumbnail?: string;
  width?: number;
  height?: number;
  copiedAt: number;
}

/** 目标面板的一行。available 为 null 表示还在检测。 */
export interface TargetStatus {
  id: string;
  label: string;
  shortLabel: string;
  delivery: 'win32' | 'web';
  available: boolean | null;
  reason?: string;
}

export interface PanelData {
  targets: TargetStatus[];
  /** 这次要投给哪些目标，第一个是主目标。通常只有一个。 */
  currentTargetIds: string[];
}

/** 投递全都失败时随 opened 一起回来的文本，见主进程的 restoreInput。 */
export interface InputRestore {
  text: string;
  message: string;
}

const api = {
  /** 取一次当前状态，用于窗口刚加载时的首帧渲染。 */
  getState: (): Promise<PetState> => ipcRenderer.invoke('pet:get-state'),

  /** 订阅状态变化。返回取消订阅的函数。 */
  onState: (cb: (state: PetState) => void): (() => void) => {
    const handler = (_e: unknown, state: PetState) => cb(state);
    ipcRenderer.on('pet:state', handler);
    return () => ipcRenderer.off('pet:state', handler);
  },

  /**
   * 订阅目标可用性。
   *
   * 和面板走同一份 checkAllTargets 结果——输入条上那个状态点以前是编的
   * （桌面端一律"能发"、网页端一律"不能发"），会和面板对同一个目标各说各话。
   */
  onTargetStatus: (cb: (targets: TargetStatus[]) => void): (() => void) => {
    const handler = (_e: unknown, targets: TargetStatus[]) => cb(targets);
    ipcRenderer.on('input:target-status', handler);
    return () => ipcRenderer.off('input:target-status', handler);
  },

  /**
   * 输入条被唤起时触发，用于聚焦输入框、同步当前目标。
   *
   * `restore` 有值时这次不是普通唤起，而是上一条投递全都没送到、
   * 把文本还回来了——输入框要填回它而不是照常清空。
   */
  onOpened: (
    cb: (payload: { targetIds: string[]; restore?: InputRestore }) => void,
  ): (() => void) => {
    const handler = (_e: unknown, payload: { targetIds: string[]; restore?: InputRestore }) =>
      cb(payload);
    ipcRenderer.on('input:opened', handler);
    return () => ipcRenderer.off('input:opened', handler);
  },

  listTargets: (): Promise<{ targets: TargetSummary[]; currentTargetIds: string[] }> =>
    ipcRenderer.invoke('targets:list'),

  /** 单选：换主目标，丢掉附加的。 */
  selectTarget: (targetId: string): Promise<string[]> =>
    ipcRenderer.invoke('targets:select', targetId),

  /** 多选：把一个目标加进这次投递或取消掉。不会让它变成零个。 */
  toggleTarget: (targetId: string): Promise<string[]> =>
    ipcRenderer.invoke('targets:toggle', targetId),

  submit: (text: string, targetIds?: string[]): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('pet:submit', { text, targetIds }),

  /**
   * 跳到目标窗口去看回复。
   * 同时发给多个目标时连点会依次轮换，详见 orchestrator.reveal。
   */
  revealTarget: (): Promise<{ ok: boolean; targetId?: string }> =>
    ipcRenderer.invoke('pet:reveal'),

  closeInput: (): void => ipcRenderer.send('input:close'),

  /** 点击宠物本体。 */
  activate: (): void => ipcRenderer.send('pet:activate'),

  /** 打开目标选择面板。 */
  openMenu: (): void => ipcRenderer.send('pet:menu'),

  /** 上报本体在窗口内的位置，供主进程做鼠标命中判断。 */
  reportHitRect: (rect: { left: number; top: number; width: number; height: number }): void =>
    ipcRenderer.send('pet:hit-rect', rect),

  /**
   * 订阅庆祝事件。
   *
   * 和 onState 分开走是刻意的：state 会被反复推送（thinking 期间 elapsedMs
   * 一直在变），而庆祝是一次性的**转换**。挂在 state 上会变成生成过程中一直撒花。
   */
  onCelebrate: (cb: (c: Celebration) => void): (() => void) => {
    const handler = (_e: unknown, c: Celebration) => cb(c);
    ipcRenderer.on('pet:celebrate', handler);
    return () => ipcRenderer.off('pet:celebrate', handler);
  },

  /** 庆祝演完了，请主进程把撑大的窗口缩回去。 */
  celebrateEnd: (): void => ipcRenderer.send('pet:celebrate-end'),

  /** 订阅「鼠标是否压在本体上」，用于悬停展开。 */
  onHover: (cb: (hovering: boolean) => void): (() => void) => {
    const handler = (_e: unknown, hovering: boolean) => cb(hovering);
    ipcRenderer.on('pet:hover', handler);
    return () => ipcRenderer.off('pet:hover', handler);
  },

  /* ---------- 提示词 ---------- */

  /** 按关键词搜提示词。空串返回最常用的几条。 */
  searchPrompts: (query: string): Promise<PromptSummary[]> =>
    ipcRenderer.invoke('prompts:search', query),

  /** 取某条提示词上次填过的变量值，用于预填。 */
  rememberedValues: (id: string): Promise<Record<string, string>> =>
    ipcRenderer.invoke('prompts:remembered', id),

  /** 记一次使用，并存下这次填的变量值。 */
  recordPromptUsage: (id: string, variableValues?: Record<string, string>): void =>
    ipcRenderer.send('prompts:used', { id, variableValues }),

  /** 把当前输入存成新提示词。 */
  savePrompt: (title: string, content: string): Promise<string> =>
    ipcRenderer.invoke('prompts:save', { title, content }),

  /** 请主进程调整输入条窗口高度，用于容纳提示词列表。 */
  resizeInput: (height: number): void => ipcRenderer.send('input:resize', height),

  /* ---------- 剪贴板历史 ---------- */

  /** 取剪贴板历史，新的在前。 */
  listClips: (): Promise<ClipSummary[]> => ipcRenderer.invoke('clips:list'),

  /**
   * 把某条图片放回系统剪贴板，返回是否成功。
   * 图片送不进任何投递目标，只能这样交回给用户自己 Ctrl+V。
   */
  putClipImage: (id: string): Promise<boolean> => ipcRenderer.invoke('clips:put-image', id),

  clearClips: (): Promise<void> => ipcRenderer.invoke('clips:clear'),

  /** 历史有变动（新复制了东西、或被清空）。列表开着时据此重画。 */
  onClipsChanged: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on('clips:changed', handler);
    return () => ipcRenderer.off('clips:changed', handler);
  },

  /* ---------- 目标面板 ---------- */

  /** 面板加载完成，取初始数据（可用性随后异步推送）。 */
  panelReady: (): Promise<PanelData> => ipcRenderer.invoke('panel:ready'),

  /** 订阅可用性检测结果。 */
  onPanelData: (cb: (data: PanelData) => void): (() => void) => {
    const handler = (_e: unknown, data: PanelData) => cb(data);
    ipcRenderer.on('panel:data', handler);
    return () => ipcRenderer.off('panel:data', handler);
  },

  closePanel: (): void => ipcRenderer.send('panel:close'),
};

contextBridge.exposeInMainWorld('xfb', api);

export type XfbApi = typeof api;

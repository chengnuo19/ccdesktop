/**
 * 渲染层能看到的全局 API。
 *
 * 由 preload 通过 contextBridge 注入。两个页面共用这一份声明，
 * 避免各自 declare global 造成重复定义。
 */

import type { Celebration, PetState, PromptCategoryId } from '@xfb/shared';

// 两个页面都从这里取类型，省得各自再去引 shared。
export type { Celebration, PetState, PromptCategoryId };

export interface TargetSummary {
  id: string;
  /** 完整名字，用于菜单。 */
  label: string;
  /** 短名字，用于输入条那个窄按钮。 */
  shortLabel: string;
  delivery: 'win32' | 'web';
}

/** 提示词在列表里需要的字段。正文也带上，填入时不必再往返一次。 */
export interface PromptSummary {
  id: string;
  title: string;
  content: string;
  /** 用于列表分组。用户自建的条目没有这个字段，归到末尾的「我的」。 */
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

export interface BasketItem {
  id: string;
  name: string;
  kind: 'file' | 'directory' | 'text' | 'url' | 'image';
  size: number;
  createdAt: number;
  thumbnail?: string;
}

/** 投递全都失败时随 opened 一起回来的文本，见主进程的 restoreInput。 */
export interface InputRestore {
  text: string;
  message: string;
}

export interface XfbApi {
  getState(): Promise<PetState>;
  onState(cb: (state: PetState) => void): () => void;
  onOpened(cb: (payload: { targetIds: string[]; restore?: InputRestore }) => void): () => void;
  onTargetStatus(cb: (targets: TargetStatus[]) => void): () => void;
  listTargets(): Promise<{ targets: TargetSummary[]; currentTargetIds: string[] }>;
  /** 单选：换主目标，丢掉附加的。 */
  selectTarget(targetId: string): Promise<string[]>;
  /** 多选：把一个目标加进这次投递或取消掉。不会让它变成零个。 */
  toggleTarget(targetId: string): Promise<string[]>;
  submit(text: string, targetIds?: string[]): Promise<{ ok: boolean; message?: string }>;
  /** 跳到目标窗口去看回复。多目标时连点会依次轮换。 */
  revealTarget(): Promise<{ ok: boolean; targetId?: string }>;
  closeInput(): void;
  activate(): void;
  openMenu(): void;
  openBasket(): void;
  reportHitRect(rect: { left: number; top: number; width: number; height: number }): void;
  onHover(cb: (hovering: boolean) => void): () => void;
  onCelebrate(cb: (c: Celebration) => void): () => void;
  celebrateEnd(): void;

  /* 提示词 */
  searchPrompts(query: string): Promise<PromptSummary[]>;
  rememberedValues(id: string): Promise<Record<string, string>>;
  recordPromptUsage(id: string, variableValues?: Record<string, string>): void;
  savePrompt(title: string, content: string): Promise<string>;
  resizeInput(height: number): void;

  /* 剪贴板历史 */
  listClips(): Promise<ClipSummary[]>;
  putClipImage(id: string): Promise<boolean>;
  clearClips(): Promise<void>;
  onClipsChanged(cb: () => void): () => void;

  /* 临时篮子 */
  listBasketItems(): Promise<BasketItem[]>;
  addToBasket(files: File[], text: string): Promise<{ added: number; message?: string }>;
  openBasketItem(id: string): Promise<boolean>;
  dragBasketItem(id: string): void;
  showBasketItemMenu(id: string): void;
  closeBasket(): void;
  onBasketChanged(cb: () => void): () => void;
  onBasketToast(cb: (message: string) => void): () => void;

  /* 目标面板 */
  panelReady(): Promise<PanelData>;
  onPanelData(cb: (data: PanelData) => void): () => void;
  closePanel(): void;
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

declare global {
  interface Window {
    xfb: XfbApi;
  }
}

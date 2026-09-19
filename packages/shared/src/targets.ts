/** 投递目标的定义。 */

/** 消息怎么送到目标手里。 */
export type DeliveryKind =
  /** Windows 桌面应用：找窗口 → 闪切焦点 → 粘贴 → 回车 → 还原焦点。 */
  | 'win32'
  /** 浏览器网页：交给扩展，由 content script 直接操作输入框。 */
  | 'web';

/** 进度怎么探测出来。按可靠性从高到低排列，运行时逐级降级。 */
export type ProbeKind =
  /** 扩展读 DOM。 */
  | 'dom'
  /** Windows 可访问性树轮询。 */
  | 'uia'
  /** 窗口位图帧间差分。 */
  | 'pixel';

export interface TargetDef {
  id: string;
  /** 完整名字，用在空间充裕的地方（托盘菜单、展开菜单）。 */
  label: string;
  /**
   * 短名字，用在输入条那个窄按钮上。
   * 桌面端直接用产品名，网页端保留「网页」后缀——
   * 「发到哪儿去」这个区分不能因为省地方就丢掉。
   */
  shortLabel: string;
  delivery: DeliveryKind;
  /**
   * 探测手段的优先级列表。运行时从头开始试，
   * 某一档不可用（比如 UIA 唤不醒）就自动落到下一档。
   */
  probeChain: ProbeKind[];
  /** win32 目标：窗口类名（实测三个目标都是 Chromium 壳）。 */
  windowClass?: string;
  /** win32 目标：进程名，用于在多个同类窗口中定位。 */
  processName?: string;
  /** web 目标：匹配哪些页面。 */
  urlPatterns?: string[];
}

/**
 * 内置目标。
 *
 * 窗口类名与进程名都是在本机实测得到的：三个应用全部是 Chromium 壳，
 * 类名一律为 Chrome_WidgetWin_1，所以必须靠进程名区分，不能只看类名。
 */
export const BUILTIN_TARGETS: TargetDef[] = [
  {
    id: 'chatgpt-classic',
    label: 'ChatGPT Classic（桌面端）',
    shortLabel: 'ChatGPT Classic',
    delivery: 'win32',
    // 实测可以用 WM_GETOBJECT 唤醒可访问性树，所以 UIA 优先，像素差分兜底。
    probeChain: ['uia', 'pixel'],
    windowClass: 'Chrome_WidgetWin_1',
    processName: 'ChatGPT Classic',
  },
  {
    id: 'chatgpt-desktop',
    label: 'ChatGPT（新版桌面端）',
    shortLabel: 'ChatGPT 新版',
    delivery: 'win32',
    probeChain: ['uia', 'pixel'],
    windowClass: 'Chrome_WidgetWin_1',
    processName: 'ChatGPT',
  },
  {
    id: 'gemini-desktop',
    label: 'Gemini（桌面端）',
    shortLabel: 'Gemini',
    delivery: 'win32',
    // 实测 a11y 树唤不醒，大概率只能吃像素差分。仍保留 uia 做运行时探测，
    // 万一某个版本能唤醒就自动升级精度。
    probeChain: ['uia', 'pixel'],
    windowClass: 'Chrome_WidgetWin_1',
    processName: 'Gemini',
  },
  {
    id: 'chatgpt-web',
    label: 'ChatGPT（网页端）',
    shortLabel: 'ChatGPT 网页',
    delivery: 'web',
    probeChain: ['dom'],
    urlPatterns: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  },
  {
    id: 'gemini-web',
    label: 'Gemini（网页端）',
    shortLabel: 'Gemini 网页',
    delivery: 'web',
    probeChain: ['dom'],
    urlPatterns: ['https://gemini.google.com/*'],
  },
];

export function findTarget(id: string): TargetDef | undefined {
  return BUILTIN_TARGETS.find((t) => t.id === id);
}

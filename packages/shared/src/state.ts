/**
 * 宠物状态机。
 *
 * 这是整个项目的核心抽象：不论消息投递到哪个目标（桌面端还是网页端），
 * 也不论进度是怎么探测出来的，宠物只认这一套状态。
 */

/** 宠物当前在干什么。驱动悬浮窗的圆环动画。 */
export type PetPhase =
  /** 待机。圆环不显示，宠物做呼吸动画。 */
  | 'idle'
  /** 正在投递：抢焦点 → 粘贴 → 回车 → 还焦点。通常 200~400ms。 */
  | 'sending'
  /** 已送达，AI 正在生成。圆环转动 —— 这是用户最常看到的状态。 */
  | 'thinking'
  /** 生成完成。圆环收尾并高亮，几秒后自动回到 idle。 */
  | 'done'
  /** 出错了（没找到目标窗口、投递失败等）。 */
  | 'error';

/**
 * 进度探测的可信度。
 *
 * 三个目标能拿到的信息精度差别很大，UI 要据此决定圆环怎么画：
 * 能拿到真实进度就画确定性圆环，拿不到就画无限循环的转圈。
 */
export type ProbeConfidence =
  /**
   * 网页端扩展：直接读 DOM 的「停止生成」按钮。
   * 注意 exact 指的是**开始与结束时刻**准确，不代表能算出完成百分比——
   * 回复总长度是未知的，所以谁都给不出真实比例。
   */
  | 'exact'
  /** 桌面端 UIA：轮询可访问性树的按钮状态。有延迟但方向可靠。 */
  | 'approximate'
  /** 像素差分兜底：只知道「画面还在变」还是「稳定了」。 */
  | 'coarse';

/**
 * 值得庆祝的两个时刻。
 *
 * 它们是**状态转换**，不是状态本身——所以不能从 PetState 里读出来，
 * 只能靠比对前后两次 phase 得到（`sending → thinking` 和 `thinking → done`）。
 * 这也是为什么它单独走一条事件通道，而不是塞进 PetState：
 * 状态会被反复推送（thinking 期间 elapsedMs 一直在变），
 * 把一次性的动画挂在上面会变成生成过程中一直撒花。
 */
export type CelebrationKind =
  /** 话送进去了。用户这时注意力已经移开，只需要回答「送到了吗」。 */
  | 'sent'
  /** 对面说完了。这是唯一真正值得召回注意力的时刻。 */
  | 'done';

/** 一次庆祝的完整描述。 */
export interface Celebration {
  kind: CelebrationKind;
  /**
   * 这一轮的探测档位，直接决定动画有多隆重。
   *
   * 和圆环不画假百分比是同一条原则：`coarse` 判定「完成」的依据
   * 只是画面一秒多没变，可能只是对面打字停顿了一下。
   * 这时候撒花等于宣称「我确定它讲完了」——动画的确信程度
   * 不该超过探测的确信程度。kind 为 'sent' 时无意义。
   */
  confidence: ProbeConfidence | null;
  /**
   * 本体在撑大后的窗口里该往哪偏，CSS 像素。
   *
   * 窗口朝四周扩，但悬浮标常年贴着屏幕右下角，那两边扩不动，
   * 扩出来的框就不再以本体为中心。不修正的话本体会随窗口一起平移，
   * 看起来像它自己蹦了一下再弹回来。
   */
  offsetX: number;
  offsetY: number;
}

/** 悬浮窗渲染进程拿到的完整状态快照。 */
export interface PetState {
  phase: PetPhase;
  /** 本轮投递去了哪个目标。idle 时为 null。 */
  targetId: string | null;
  /** 这一轮的进度是怎么探测的，决定圆环画法。 */
  confidence: ProbeConfidence | null;
  /**
   * 0~1 的进度。
   *
   * 目前所有探测手段都给不出真实比例，所以实际运行中它一直是 null，
   * UI 一律画不确定的转圈动画——宁可不显示，也不编造一个百分比。
   * 保留这个字段是为了将来真能拿到进度时（比如走官方 API 流式输出）
   * 可以直接用上，UI 侧的确定性圆环已经实现好了。
   */
  progress: number | null;
  /** thinking 已经持续了多久（毫秒），用于超时兜底和 UI 提示。 */
  elapsedMs: number;
  /** error 时的说明文案，直接展示给用户。 */
  errorMessage: string | null;
}

export const INITIAL_PET_STATE: PetState = {
  phase: 'idle',
  targetId: null,
  confidence: null,
  progress: null,
  elapsedMs: 0,
  errorMessage: null,
};

/**
 * thinking 状态的兜底超时。
 *
 * 所有探测手段都可能漏掉「生成结束」这个事件（比如像素差分遇到静态回复、
 * 或者用户手动切走了窗口）。超过这个时间就强制收尾，绝不让圆环永远转下去。
 */
export const THINKING_TIMEOUT_MS = 180_000;

/** done 状态停留多久后自动回到 idle。 */
export const DONE_LINGER_MS = 4_000;

/** error 状态停留多久后自动回到 idle。 */
export const ERROR_LINGER_MS = 6_000;

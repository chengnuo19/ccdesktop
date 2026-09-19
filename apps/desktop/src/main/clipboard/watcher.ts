/**
 * 剪贴板监视。
 *
 * Electron 没有剪贴板变更事件，只能轮询——这一点和 hover.ts 一样，
 * 不优雅但可靠。真正的问题是**怎么判断「变了」**：
 *
 * - 比对 readText()：抓不到「图片 A → 图片 B」。连续两次截图会被当成没变。
 * - 每轮读图算哈希：一张 4K 截图的位图约 30MB，每 700ms 做一次完全不可接受。
 *
 * 所以走助手拿 Windows 的 GetClipboardSequenceNumber()——剪贴板内容一变它就自增，
 * 读它是零成本的，序号没动就直接返回，一个字节的内容都不用碰。
 *
 * 不做任何内容过滤：复制了什么就记什么。兜底靠条数上限和托盘里的清空入口。
 */

import { clipboard } from 'electron';
import { createHash } from 'node:crypto';
import { CLIP_MAX_TEXT_BYTES, clipPreview, type ClipItem } from '@xfb/shared';
import { win32Helper } from '../win32/helper.js';
import { addClip, saveImageFile, type NewClip } from './store.js';

/** 轮询间隔。剪贴板是人手动操作的，不需要更快。 */
const POLL_MS = 700;

/** 缩略图高度。列表一行 40px 出头，留一点余量。 */
const THUMB_HEIGHT = 44;

/**
 * 静默窗口结束后多等一会儿再取基线。
 *
 * 助手在 deliver 内部是**先还焦点、再恢复剪贴板**的（win32-helper.ps1 里
 * 恢复前还 Start-Sleep 50ms），所以 deliver 的响应回到这里时，
 * 最后那次 Set-Clipboard 可能还没落定。不等就会把它当成用户的新复制记进去。
 */
const SUPPRESS_SETTLE_MS = 250;

/** 降级模式下，每隔这么多拍重试一次助手。 */
const HELPER_RETRY_TICKS = 20;

/**
 * 图片读不出来时重试几次、每次隔多久。
 *
 * 实测截图工具（Win+Shift+S）写剪贴板时，availableFormats() 已经报出
 * image/png，readImage() 却还是空的——格式先挂上、图像数据后落。
 * 不重试的话第一拍会把整张图丢掉；这次只是碰巧因为截图工具又动了一次剪贴板
 * （序号再跳一次）才补记上，换个来源就补不上了。
 */
const IMAGE_READ_RETRIES = 4;
const IMAGE_READ_RETRY_MS = 120;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ClipState {
  seq: number;
}

export type ClipListener = (item: ClipItem) => void;

export class ClipboardWatcher {
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<ClipListener>();

  /** 上一次看到的序列号。-1 表示还没取过基线。 */
  private lastSeq = -1;
  /**
   * 上一次看到的文本，降级模式下靠它比对。
   *
   * 非降级模式下也一直维护着：助手可能中途挂掉，那一刻要能无缝接上，
   * 否则接管的第一拍会把当时剪贴板里的东西当成「刚复制的」重记一遍。
   */
  private lastText: string | null = null;

  /**
   * 静默计数。
   *
   * 用计数而不是布尔：suppress 可能嵌套，也可能背靠背连着来
   * （发完消息紧接着点了「复制连接密钥」）。布尔标志在后一种情况下会被
   * 前一次的收尾提前清掉，于是后一次写进去的内容照样进了历史。
   */
  private suppressDepth = 0;
  /** 收尾中（等最后一次写落定、重新取基线）。这期间同样不能记。 */
  private settleTimer: NodeJS.Timeout | null = null;
  private resettingBaseline = false;

  /** 助手不可用，退化成纯文本比对。 */
  private degraded = false;
  private degradedTicks = 0;
  /** 降级日志只打一次，不然每 700ms 刷一行。 */
  private degradeLogged = false;

  /** 现在是不是「本程序自己在动剪贴板」的时间窗内。 */
  private get muted(): boolean {
    return this.suppressDepth > 0 || this.settleTimer !== null || this.resettingBaseline;
  }

  onClip(fn: ClipListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(): void {
    if (this.timer) return;
    // 先取一次基线：启动瞬间剪贴板里已有的内容不算「刚复制的」。
    void this.resetBaseline();
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    console.log(`[剪贴板] 已开始监视（每 ${POLL_MS}ms）`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.listeners.clear();
  }

  /**
   * 在静默窗口里执行一段会写剪贴板的操作。
   *
   * 投递、复制连接密钥、把历史里的图片放回剪贴板——这三件事都是**本程序**
   * 在写剪贴板，不是用户在复制。不圈起来的话，每发一条消息历史里就多一条
   * 自己刚发的内容，连接密钥也会被原样记下来。
   *
   * 结束后重新取基线而不入库，静默期间的所有变化因此被整体跳过。
   */
  async suppress<T>(fn: () => Promise<T>): Promise<T> {
    this.suppressDepth += 1;
    // 上一次静默还在收尾就把它取消——收尾要等最后一次写完，而现在又要写了。
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    try {
      return await fn();
    } finally {
      this.suppressDepth -= 1;
      if (this.suppressDepth === 0) this.scheduleSettle();
    }
  }

  private scheduleSettle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      void this.resetBaseline();
    }, SUPPRESS_SETTLE_MS);
  }

  /** 把当前剪贴板状态记成新基线，不产生历史条目。 */
  private async resetBaseline(): Promise<void> {
    this.resettingBaseline = true;
    try {
      const state = await this.sample();
      if (state) this.lastSeq = state.seq;
      this.lastText = clipboard.readText();
    } finally {
      this.resettingBaseline = false;
    }
  }

  /** 问助手要剪贴板序列号。助手不可用时返回 null 并切进降级模式。 */
  private async sample(): Promise<ClipState | null> {
    try {
      const res = await win32Helper.send('clip-state');
      if (!res.ok || typeof res['seq'] !== 'number') return null;
      if (this.degraded) {
        this.degraded = false;
        this.degradeLogged = false;
        console.log('[剪贴板] 助手恢复，重新使用序列号判变');
      }
      return { seq: res['seq'] };
    } catch (err) {
      if (!this.degradeLogged) {
        this.degradeLogged = true;
        console.warn('[剪贴板] 助手不可用，降级为纯文本比对（图片不再记录）：', err);
      }
      this.degraded = true;
      this.degradedTicks = 0;
      return null;
    }
  }

  private async tick(): Promise<void> {
    if (this.muted) return;

    if (this.degraded) {
      // 助手会自动重启，隔一阵子试一次，别一直卡在降级里。
      this.degradedTicks += 1;
      if (this.degradedTicks >= HELPER_RETRY_TICKS) {
        this.degradedTicks = 0;
        const state = await this.sample();
        if (state) {
          this.lastSeq = state.seq;
          return;
        }
      }
      this.captureTextOnly();
      return;
    }

    const state = await this.sample();
    if (!state) {
      this.captureTextOnly();
      return;
    }

    if (state.seq === this.lastSeq) return;
    this.lastSeq = state.seq;

    await this.capture();
  }

  /** 降级模式：只能靠比对文本发现变化，图片一律记不了。 */
  private captureTextOnly(): void {
    const text = clipboard.readText();
    if (text === this.lastText) return;
    this.lastText = text;
    this.recordText(text);
  }

  /**
   * 读取并记录当前剪贴板内容。
   *
   * 有文本就按文本记——从浏览器复制图片时往往连 text/html 一起带上，
   * 但 text/plain 是空的，所以「文本为空才当图片」这条规则足够可靠，
   * 也比逐个匹配 availableFormats 的格式名稳当。
   */
  private async capture(): Promise<void> {
    const text = clipboard.readText();
    this.lastText = text;

    if (text.trim()) {
      this.recordText(text);
      return;
    }

    const image = await this.readImageWithRetry();
    if (!image) {
      const formats = clipboard.availableFormats().join(', ') || '无';
      console.log(`[剪贴板] 内容变了但既不是文本也不是可读的图片（格式：${formats}），跳过`);
      return;
    }
    this.recordImage(image);
  }

  /**
   * 读图，读不出来就隔一会儿再试。
   *
   * 格式挂上了但数据还没落是常态（见 IMAGE_READ_RETRY_MS 的注释）。
   * 只在剪贴板确实声明了图片格式时才值得等——没声明就是真没有，
   * 干等只会让每一次「复制了个文件」都白白卡住半秒。
   */
  private async readImageWithRetry(): Promise<Electron.NativeImage | null> {
    for (let i = 0; i < IMAGE_READ_RETRIES; i++) {
      const image = clipboard.readImage();
      if (!image.isEmpty()) {
        if (i > 0) console.log(`[剪贴板] 图片在第 ${i + 1} 次尝试时才读到`);
        return image;
      }
      if (!clipboard.availableFormats().some((fmt) => fmt.startsWith('image/'))) return null;
      await delay(IMAGE_READ_RETRY_MS);
    }
    return null;
  }

  private recordText(text: string): void {
    if (!text.trim()) return;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > CLIP_MAX_TEXT_BYTES) {
      console.log(`[剪贴板] 文本 ${Math.round(bytes / 1024)}KB 超过上限，不记录`);
      return;
    }
    this.emit({
      kind: 'text',
      text,
      hash: createHash('sha256').update(text).digest('hex'),
    });
    console.log(`[剪贴板] 记下文本：${clipPreview(text)}`);
  }

  private recordImage(image: Electron.NativeImage): void {
    let png: Buffer;
    try {
      png = image.toPNG();
    } catch (err) {
      console.warn('[剪贴板] 图片转 PNG 失败：', err);
      return;
    }
    if (png.length === 0) return;

    const hash = createHash('sha256').update(png).digest('hex');
    const { width, height } = image.getSize();

    let thumbnail: string | undefined;
    try {
      thumbnail = image.resize({ height: THUMB_HEIGHT }).toDataURL();
    } catch (err) {
      // 缩略图失败不该拖垮整条记录，列表里退化成一行文字即可。
      console.warn('[剪贴板] 生成缩略图失败：', err);
    }

    const item: NewClip = {
      kind: 'image',
      text: '',
      imageFile: saveImageFile(hash, png),
      hash,
      width,
      height,
    };
    if (thumbnail) item.thumbnail = thumbnail;

    this.emit(item);
    console.log(`[剪贴板] 记下图片：${width}×${height}，${Math.round(png.length / 1024)}KB`);
  }

  private emit(clip: NewClip): void {
    const item = addClip(clip);
    for (const fn of this.listeners) fn(item);
  }
}

export const clipboardWatcher = new ClipboardWatcher();

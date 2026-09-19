/**
 * 剪贴板历史的数据模型。
 *
 * 定位是「喂给 AI 的素材来源」，不是通用剪贴板管理器：
 * 只留最近的一小把内容，不做置顶收藏，也不做粘贴回任意应用。
 * 所以条数上限定得很低——列表要能一眼扫完，而不是变成另一个需要搜索的库。
 */

/** 一条剪贴板记录。 */
export interface ClipItem {
  id: string;
  kind: 'text' | 'image';
  /** text 条目的全文；image 条目为空串。 */
  text: string;
  /**
   * image 条目的图片文件名（相对 userData/clips/）。
   * 原图不进 json：一张截图几 MB，塞进去会让每次读写都变慢。
   */
  imageFile?: string;
  /**
   * 列表里显示的缩略图 data URL。
   * 这一份**故意**存进 json：画列表时一次读取就够，不用再为每条图片往返读文件。
   */
  thumbnail?: string;
  /** 原图尺寸，用于在列表里注明「1920×1080」。 */
  width?: number;
  height?: number;
  /**
   * 去重键。text 用正文本身，image 用 PNG 字节的 sha256。
   *
   * 没有它的话，反复复制同一段内容会很快把上限占满——而人本来就会
   * 为了确认「复制上了没有」而多按两次 Ctrl+C。
   */
  hash: string;
  copiedAt: number;
}

export interface ClipboardStore {
  schemaVersion: 1;
  /** 新的在前，长度不超过 CLIP_HISTORY_LIMIT。 */
  items: ClipItem[];
}

export const EMPTY_CLIPBOARD_STORE: ClipboardStore = {
  schemaVersion: 1,
  items: [],
};

/** 历史条数上限。 */
export const CLIP_HISTORY_LIMIT = 15;

/**
 * 单条文本的字节上限，超过就不记。
 *
 * 复制一整个文件的内容是常事，那种东西进了历史既撑爆 json，
 * 也没法在列表里有意义地预览。
 */
export const CLIP_MAX_TEXT_BYTES = 100 * 1024;

/** 列表里一行预览截多长。 */
export const CLIP_PREVIEW_CHARS = 80;

/** 把正文压成单行预览。列表每条只有一行，换行和连续空白都要抹平。 */
export function clipPreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, CLIP_PREVIEW_CHARS);
}

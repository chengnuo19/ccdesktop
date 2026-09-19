/**
 * 剪贴板历史的读写。
 *
 * 结构与 prompts.ts 一致：json 存在 userData，每次现读不做内存缓存。
 * 区别是图片——原图单独落在 userData/clips/ 下，json 里只留文件名和缩略图，
 * 否则每次读写都要搬运几 MB 的 base64。
 */

import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  CLIP_HISTORY_LIMIT,
  EMPTY_CLIPBOARD_STORE,
  type ClipItem,
  type ClipboardStore,
} from '@xfb/shared';

function storePath(): string {
  return path.join(app.getPath('userData'), 'clipboard.json');
}

/** 图片原图的存放目录。 */
export function imagesDir(): string {
  return path.join(app.getPath('userData'), 'clips');
}

export function imagePath(file: string): string {
  return path.join(imagesDir(), file);
}

function ensureImagesDir(): void {
  const dir = imagesDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * 读取历史。
 *
 * 和 prompts.ts 同样的取舍：文件被改坏时按空库继续跑，绝不让应用起不来——
 * 剪贴板历史是锦上添花的功能，没有理由因为它挂掉整个悬浮标。
 */
function readStore(): ClipboardStore {
  const file = storePath();
  if (!existsSync(file)) return { ...EMPTY_CLIPBOARD_STORE, items: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ClipboardStore>;
    return {
      ...EMPTY_CLIPBOARD_STORE,
      ...parsed,
      items: Array.isArray(parsed.items) ? parsed.items : [],
    };
  } catch (err) {
    console.warn('[剪贴板] clipboard.json 解析失败，本次按空库处理：', err);
    return { ...EMPTY_CLIPBOARD_STORE, items: [] };
  }
}

function writeStore(store: ClipboardStore): void {
  try {
    writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    console.warn('[剪贴板] 写入失败：', err);
  }
}

function removeImageFile(item: ClipItem): void {
  if (item.kind !== 'image' || !item.imageFile) return;
  try {
    rmSync(imagePath(item.imageFile), { force: true });
  } catch (err) {
    console.warn(`[剪贴板] 删除图片 ${item.imageFile} 失败：`, err);
  }
}

/** 新记录要落盘时提供的字段；id 与时间戳由这里补。 */
export type NewClip = Omit<ClipItem, 'id' | 'copiedAt'>;

/**
 * 记一条。返回落定后的条目。
 *
 * 先按 hash 去重：命中就把老的提到最前并刷新时间，而不是新增一条。
 * 人为了确认「到底复制上没有」常会连按两次 Ctrl+C，不去重的话
 * 15 条的上限一会儿就被同一段内容占满了。
 */
export function addClip(clip: NewClip): ClipItem {
  const store = readStore();
  const existing = store.items.find((it) => it.hash === clip.hash);

  let item: ClipItem;
  if (existing) {
    item = { ...existing, copiedAt: Date.now() };
    store.items = [item, ...store.items.filter((it) => it.id !== existing.id)];
  } else {
    item = { ...clip, id: `clip-${randomUUID()}`, copiedAt: Date.now() };
    store.items = [item, ...store.items];
  }

  // 挤掉的图片条目要连原图一起删，否则 clips/ 只涨不消。
  if (store.items.length > CLIP_HISTORY_LIMIT) {
    for (const dropped of store.items.slice(CLIP_HISTORY_LIMIT)) removeImageFile(dropped);
    store.items = store.items.slice(0, CLIP_HISTORY_LIMIT);
  }

  writeStore(store);
  return item;
}

/** 把图片原图写进 clips/，返回文件名。同 hash 已存在则直接复用。 */
export function saveImageFile(hash: string, png: Buffer): string {
  ensureImagesDir();
  const file = `${hash}.png`;
  const full = imagePath(file);
  if (!existsSync(full)) writeFileSync(full, png);
  return file;
}

export function listClips(): ClipItem[] {
  return readStore().items;
}

export function findClip(id: string): ClipItem | undefined {
  return readStore().items.find((it) => it.id === id);
}

export function countClips(): number {
  return readStore().items.length;
}

/** 清空历史，连图片一起删。剪贴板里难免有敏感内容，这个入口必须是真的清干净。 */
export function clearClips(): void {
  const store = readStore();
  for (const item of store.items) removeImageFile(item);
  writeStore({ ...EMPTY_CLIPBOARD_STORE, items: [] });
  console.log(`[剪贴板] 已清空历史（${store.items.length} 条）`);
}

/**
 * 清掉 json 里没人引用的图片文件。
 *
 * 进程被强杀时可能「图片已落盘、json 还没写」，留下孤儿文件。
 * 每次启动扫一遍，不然那个目录会无声地一直长。
 */
export function sweepOrphanImages(): void {
  const dir = imagesDir();
  if (!existsSync(dir)) return;
  const referenced = new Set(
    readStore()
      .items.map((it) => it.imageFile)
      .filter((f): f is string => !!f),
  );
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (referenced.has(name)) continue;
      rmSync(path.join(dir, name), { force: true });
      removed += 1;
    }
  } catch (err) {
    console.warn('[剪贴板] 清理孤儿图片失败：', err);
    return;
  }
  if (removed > 0) console.log(`[剪贴板] 清理了 ${removed} 个没人引用的图片文件`);
}

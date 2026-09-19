/**
 * 临时篮子的磁盘存储。
 *
 * 和 Tokri 一样，篮子里的每一项都是真实文件：重启不会丢，拖出时也能直接交给
 * Windows 的原生拖放。这里不另建索引，目录本身就是唯一事实来源。
 */

import { app, nativeImage, shell } from 'electron';
import { copyFile, cp, lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export type BasketItemKind = 'file' | 'directory' | 'text' | 'url' | 'image';

export interface BasketItem {
  id: string;
  name: string;
  kind: BasketItemKind;
  size: number;
  createdAt: number;
  thumbnail?: string;
}

export interface EmbeddedImage {
  name: string;
  mimeType: string;
  base64: string;
}

export interface BasketCopyPayload {
  kind: BasketItemKind;
  path: string;
  text?: string;
}

const IMAGE_EXTENSIONS = new Set([
  '.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.webp',
]);

const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};

function basketDir(): string {
  // 只给运行时自检用，正常启动永远落在 userData。测试目录由启动命令显式提供。
  if (process.env['XFB_BASKET_TEST_DIR']) return path.resolve(process.env['XFB_BASKET_TEST_DIR']);
  return path.join(app.getPath('userData'), 'basket');
}

async function ensureBasketDir(): Promise<string> {
  const dir = basketDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname;
  } catch {
    return false;
  }
}

function safeName(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return cleaned || fallback;
}

async function uniquePath(dir: string, requestedName: string): Promise<string> {
  const parsed = path.parse(requestedName);
  for (let suffix = 0; ; suffix++) {
    const name = suffix === 0 ? requestedName : `${parsed.name} (${suffix})${parsed.ext}`;
    const candidate = path.join(dir, name);
    try {
      await lstat(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return candidate;
      throw err;
    }
  }
}

/** 只允许访问篮子根目录下的直接子项，IPC 传进来的 id 不能借机越界。 */
export async function resolveBasketItem(id: string): Promise<string | null> {
  if (!id || path.basename(id) !== id) return null;
  const dir = await ensureBasketDir();
  const target = path.join(dir, id);
  if (path.dirname(target) !== dir) return null;
  try {
    await lstat(target);
    return target;
  } catch {
    return null;
  }
}

/** 原生 startDrag 必须在 dragstart 的同步链路里调用，不能先等异步磁盘查询。 */
export function resolveBasketItemSync(id: string): string | null {
  if (!id || path.basename(id) !== id) return null;
  const dir = basketDir();
  const target = path.join(dir, id);
  if (path.dirname(target) !== dir || !existsSync(target)) return null;
  return target;
}

function kindFor(name: string, isDirectory: boolean): BasketItemKind {
  if (isDirectory) return 'directory';
  if (name.endsWith('.url.txt')) return 'url';
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ext === '.txt' || ext === '.md') return 'text';
  return 'file';
}

export async function listBasketItems(): Promise<BasketItem[]> {
  const dir = await ensureBasketDir();
  const entries = await readdir(dir, { withFileTypes: true });
  const items = await Promise.all(entries.map(async (entry): Promise<BasketItem | null> => {
    const itemPath = path.join(dir, entry.name);
    try {
      const info = await stat(itemPath);
      const kind = kindFor(entry.name, entry.isDirectory());
      const item: BasketItem = {
        id: entry.name,
        name: entry.name,
        kind,
        size: entry.isDirectory() ? 0 : info.size,
        createdAt: info.birthtimeMs || info.mtimeMs,
      };

      if (kind === 'image') {
        const image = nativeImage.createFromPath(itemPath);
        if (!image.isEmpty()) {
          item.thumbnail = image.resize({ width: 128, height: 96, quality: 'good' }).toDataURL();
        }
      }
      return item;
    } catch (err) {
      console.warn(`[临时篮子] 无法读取 ${entry.name}：`, err);
      return null;
    }
  }));

  return items
    .filter((item): item is BasketItem => item !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function addPathsToBasket(paths: string[]): Promise<number> {
  const dir = await ensureBasketDir();
  let added = 0;

  for (const source of [...new Set(paths)]) {
    try {
      const info = await lstat(source);
      const sourceResolved = path.resolve(source);
      if (path.dirname(sourceResolved) === dir) continue;

      const name = safeName(path.basename(source), info.isDirectory() ? '文件夹' : '文件');
      const destination = await uniquePath(dir, name);
      if (info.isDirectory()) {
        await cp(sourceResolved, destination, { recursive: true, errorOnExist: true, force: false });
      } else {
        await copyFile(sourceResolved, destination);
      }
      added++;
    } catch (err) {
      console.warn(`[临时篮子] 接收路径失败：${source}`, err);
    }
  }
  return added;
}

export async function addTextToBasket(text: string): Promise<boolean> {
  const content = text.trim();
  if (!content) return false;

  const dir = await ensureBasketDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const url = isHttpUrl(content);
  let base = url ? new URL(content).hostname : '文本';
  base = safeName(base, url ? '链接' : '文本');
  const destination = await uniquePath(dir, `${base}-${stamp}${url ? '.url' : ''}.txt`);
  await writeFile(destination, content, 'utf8');
  return true;
}

export async function addImagesToBasket(images: EmbeddedImage[]): Promise<number> {
  const dir = await ensureBasketDir();
  let added = 0;

  for (const image of images) {
    try {
      const bytes = Buffer.from(image.base64, 'base64');
      if (bytes.length === 0 || bytes.length > 50 * 1024 * 1024) continue;
      const extFromMime = IMAGE_MIME_EXTENSIONS[image.mimeType.toLowerCase()] ?? 'png';
      const requested = safeName(image.name, `图片.${extFromMime}`);
      const requestedExtension = path.extname(requested).toLowerCase();
      const withExtension = IMAGE_EXTENSIONS.has(requestedExtension)
        ? requested
        : `${requested}.${extFromMime}`;
      const destination = await uniquePath(dir, withExtension);
      await writeFile(destination, bytes);
      added++;
    } catch (err) {
      console.warn(`[临时篮子] 接收图片失败：${image.name}`, err);
    }
  }
  return added;
}

export async function openBasketItem(id: string): Promise<boolean> {
  const target = await resolveBasketItem(id);
  if (!target) return false;

  if (target.endsWith('.url.txt')) {
    const url = (await readFile(target, 'utf8')).trim();
    if (!isHttpUrl(url)) return false;
    await shell.openExternal(url);
    return true;
  }

  return (await shell.openPath(target)) === '';
}

export async function revealBasketItem(id: string): Promise<boolean> {
  const target = await resolveBasketItem(id);
  if (!target) return false;
  shell.showItemInFolder(target);
  return true;
}

/** 返回复制所需的最小数据；文本类复制内容，其余类型由主进程按原生格式写入剪贴板。 */
export async function basketCopyPayload(id: string): Promise<BasketCopyPayload | null> {
  const target = await resolveBasketItem(id);
  if (!target) return null;

  const info = await lstat(target);
  const kind = kindFor(path.basename(target), info.isDirectory());
  if (kind === 'text' || kind === 'url') {
    return { kind, path: target, text: await readFile(target, 'utf8') };
  }
  return { kind, path: target };
}

export async function trashBasketItem(id: string): Promise<boolean> {
  const target = await resolveBasketItem(id);
  if (!target) return false;
  await shell.trashItem(target);
  return true;
}

/**
 * 提示词库的读写。
 *
 * 用户数据在 userData/prompts.json，内置模板在代码里（builtinPrompts.ts）。
 * 两者在读取时合并：同 id 的用户条目覆盖内置条目，hiddenBuiltinIds 里的内置项跳过。
 */

import { app, shell } from 'electron';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  BUILTIN_PROMPTS,
  EMPTY_PROMPT_STORE,
  scorePrompt,
  type Prompt,
  type PromptStore,
} from '@xfb/shared';

export function promptsFilePath(): string {
  return path.join(app.getPath('userData'), 'prompts.json');
}

/**
 * 读取用户文件。
 *
 * 刻意不做内存缓存：用户可能正拿编辑器改这个文件，每次现读才能做到
 * 「改完立刻生效、不用重启」。文件很小，这点开销无所谓。
 */
function readStore(): PromptStore {
  const file = promptsFilePath();
  if (!existsSync(file)) return { ...EMPTY_PROMPT_STORE };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PromptStore>;
    return {
      ...EMPTY_PROMPT_STORE,
      ...parsed,
      // 手改过的文件可能缺字段，逐个兜底，避免后面到处判空。
      prompts: parsed.prompts ?? [],
      hiddenBuiltinIds: parsed.hiddenBuiltinIds ?? [],
      usage: parsed.usage ?? {},
      variableValues: parsed.variableValues ?? {},
    };
  } catch (err) {
    // 用户手改出语法错误时，宁可当空库继续跑，也不能让应用起不来。
    console.warn('[提示词] prompts.json 解析失败，本次按空库处理：', err);
    return { ...EMPTY_PROMPT_STORE };
  }
}

function writeStore(store: PromptStore): void {
  try {
    writeFileSync(promptsFilePath(), JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    console.warn('[提示词] 写入失败：', err);
  }
}

/** 合并内置与用户条目，并把使用统计附上。 */
function allPrompts(store: PromptStore): Prompt[] {
  const overrides = new Map(store.prompts.map((p) => [p.id, p]));
  const hidden = new Set(store.hiddenBuiltinIds);
  const builtinIds = new Set(BUILTIN_PROMPTS.map((b) => b.id));
  const withUsage = (p: Prompt): Prompt => {
    const usage = store.usage[p.id];
    return usage ? { ...p, usage } : p;
  };

  const merged: Prompt[] = [];
  for (const builtin of BUILTIN_PROMPTS) {
    if (hidden.has(builtin.id)) continue;
    /*
      用户改过就用用户那份，但仍标记为内置（不可删）。
      铺在内置那份**上面**而不是直接取代它：用户文件里的覆盖项通常只写了
      title 和 content，没有 category。直接取代的话，用户随手改一条绘图提示词，
      它就从绘图组里掉出去、落到末尾的「我的」里了。
    */
    const override = overrides.get(builtin.id);
    merged.push(withUsage(override ? { ...builtin, ...override, builtin: true } : builtin));
  }
  for (const own of store.prompts) {
    if (builtinIds.has(own.id)) continue; // 已经作为覆盖项处理过了
    merged.push(withUsage(own));
  }
  return merged;
}

/**
 * 按关键词搜索。空关键词返回最常用的几条，按使用热度排序。
 * 打分规则见 shared/prompts.ts 的 scorePrompt。
 *
 * 两档上限：空查询给 12 条，刚好填满列表那 260px 而不必滚太久；
 * 有查询给 24 条，因为搜分类名（「绘图」「科研」）会一次命中整组，
 * 按 8 条截断会把半个分类切掉，看起来像是搜漏了。
 */
export function searchPrompts(query: string, limit = query.trim() ? 24 : 12): Prompt[] {
  const store = readStore();
  const scored: { prompt: Prompt; score: number; order: number }[] = [];
  allPrompts(store).forEach((prompt, order) => {
    const score = scorePrompt(prompt, query);
    if (score !== null) scored.push({ prompt, score, order });
  });
  /*
    同分时按原始顺序（内置定义顺序在前、用户自建在后），不要退化成字母序——
    空查询时所有条目都是 0 分，按字母排会让列表看起来是随机的，
    而内置顺序是按用途分好组的，扫起来更有意义。
  */
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, limit).map((s) => s.prompt);
}

/** 新建一条用户提示词，返回它的 id。 */
export function savePrompt(title: string, content: string): string {
  const store = readStore();
  const id = `user-${randomUUID()}`;
  store.prompts.push({ id, title: title.trim() || '未命名', content });
  writeStore(store);
  return id;
}

/** 记一次使用，顺便存下这次填的变量值。 */
export function recordUsage(id: string, variableValues?: Record<string, string>): void {
  const store = readStore();
  const prev = store.usage[id];
  store.usage[id] = {
    count: (prev?.count ?? 0) + 1,
    lastUsedAt: Date.now(),
  };
  if (variableValues && Object.keys(variableValues).length > 0) {
    store.variableValues[id] = { ...store.variableValues[id], ...variableValues };
  }
  writeStore(store);
}

/** 取某条提示词上次填过的变量值，用于预填。 */
export function rememberedValues(id: string): Record<string, string> {
  return readStore().variableValues[id] ?? {};
}

export function countPrompts(): number {
  return allPrompts(readStore()).length;
}

/**
 * 用系统默认编辑器打开提示词文件。
 * 文件还不存在时先写一份空的，否则编辑器会报「文件不存在」。
 */
export async function openPromptsFile(): Promise<void> {
  const file = promptsFilePath();
  if (!existsSync(file)) writeStore({ ...EMPTY_PROMPT_STORE });
  await shell.openPath(file);
}

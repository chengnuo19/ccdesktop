/**
 * 提示词的数据模型与 {{变量}} 解析。
 *
 * 语法沿用 PromptDock 的约定（`{{名称}}` 与 `{{名称:默认值}}`），
 * 将来若要导入它导出的备份 JSON，字段能直接对上。
 */

export interface PromptUsage {
  count: number;
  lastUsedAt: number;
}

/**
 * 分类。用于列表分组，也用于搜索——打「绘图」应该能出整组，
 * 而不是只出标题里碰巧有这两个字的那一条。
 */
export type PromptCategoryId =
  | 'study'
  | 'research'
  | 'analysis'
  | 'code'
  | 'writing'
  | 'image'
  | 'video'
  | 'commercial';

export interface PromptCategory {
  id: PromptCategoryId;
  /** 列表里的组标题。 */
  label: string;
  /**
   * 搜索别名。用户不会去记准确的组名，想找画图的会打「画图」「图片」「插画」，
   * 三个都得能命中同一组。英文也留一份，切不回中文输入法时照样能搜。
   */
  aliases: string[];
}

/** 数组顺序即列表里的分组顺序，按日常使用频度排。 */
export const PROMPT_CATEGORIES: PromptCategory[] = [
  { id: 'study', label: '学习解题', aliases: ['学习', '解题', '做题', 'study'] },
  {
    id: 'research',
    label: '科研写作',
    aliases: ['科研', '论文', '写作', '审稿', '文献', 'paper', 'research'],
  },
  {
    id: 'analysis',
    label: '数据分析',
    aliases: ['数据', '分析', '统计', '实验设计', 'data', 'stats'],
  },
  { id: 'code', label: '编程开发', aliases: ['编程', '代码', '开发', 'code', 'dev'] },
  { id: 'writing', label: '文字处理', aliases: ['文字', '翻译', '改写', 'text', 'writing'] },
  {
    id: 'image',
    label: '绘图生成',
    aliases: ['绘图', '画图', '图片', '插画', '信息图', '配图', 'image', 'draw'],
  },
  { id: 'video', label: '视频分镜', aliases: ['视频', '分镜', '镜头', '动画', 'video'] },
  {
    id: 'commercial',
    label: '商业素材',
    aliases: ['商业', '电商', '营销', '广告', '海报', '带货', 'commercial', 'marketing'],
  },
];

const CATEGORY_BY_ID = new Map(PROMPT_CATEGORIES.map((c) => [c.id, c]));

export function categoryLabel(id: PromptCategoryId | undefined): string {
  return (id && CATEGORY_BY_ID.get(id)?.label) || '我的';
}

export interface Prompt {
  id: string;
  title: string;
  content: string;
  /**
   * 分类。可选——用户自建的条目没有这个字段，列表里归到末尾的「我的」组。
   */
  category?: PromptCategoryId;
  /** 内置模板。可以隐藏、可以改，但不能真正删除。 */
  builtin?: boolean;
  /**
   * 用于排序。**不持久化在 prompts 数组里**，而是读取时从 store.usage 合并进来——
   * 否则用一次内置模板就得把它整份内容抄进用户文件，以后升级就带不上新内容了。
   */
  usage?: PromptUsage;
}

export interface PromptStore {
  schemaVersion: 1;
  /** 用户自建的提示词，以及对内置项的覆盖（同 id 即为覆盖）。 */
  prompts: Prompt[];
  hiddenBuiltinIds: string[];
  /** 使用统计，键是提示词 id。与定义分开存，内置项也能记而不污染定义。 */
  usage: Record<string, PromptUsage>;
  /** 每条提示词上次填过的变量值，键是提示词 id。 */
  variableValues: Record<string, Record<string, string>>;
}

export const EMPTY_PROMPT_STORE: PromptStore = {
  schemaVersion: 1,
  prompts: [],
  hiddenBuiltinIds: [],
  usage: {},
  variableValues: {},
};

/** 提示词正文里的一个变量占位。 */
export interface PromptVariable {
  /** 变量名，也是没有默认值时的占位文字。 */
  name: string;
  defaultValue: string;
  /** 在正文中的起止位置，用于填入后定位光标。 */
  start: number;
  end: number;
}

/*
  匹配 {{名称}} 与 {{名称:默认值}}。
  冒号半角全角都认——中文输入法下打出全角冒号太常见了，
  只认半角的话用户会写出一个看起来没问题、实际解析不出默认值的模板。
*/
const VARIABLE_RE = /\{\{\s*([^:：}]+?)\s*(?:[:：]\s*([^}]*?)\s*)?\}\}/g;

/** 按出现顺序列出正文里的所有变量。同名变量会重复出现，逐个定位。 */
export function parseVariables(content: string): PromptVariable[] {
  const found: PromptVariable[] = [];
  VARIABLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VARIABLE_RE.exec(content)) !== null) {
    const name = (m[1] ?? '').trim();
    if (!name) continue;
    found.push({
      name,
      defaultValue: (m[2] ?? '').trim(),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return found;
}

export interface ExpandedPrompt {
  /** 变量已替换成默认值/变量名之后的正文。 */
  text: string;
  /** 每个变量在 text 中的最终位置，供依次选中。 */
  slots: { name: string; start: number; end: number }[];
}

/**
 * 把提示词展开成可直接放进输入框的文本，并给出每个变量的落点。
 *
 * 变量位置填什么，按优先级：上次填过的值 → 默认值 → 变量名本身。
 * 填变量名而不是留空，是为了让用户一眼看出这里要填什么；
 * 反正光标会选中它，直接打字就替换掉了。
 */
export function expandPrompt(
  content: string,
  remembered: Record<string, string> = {},
): ExpandedPrompt {
  const vars = parseVariables(content);
  if (vars.length === 0) return { text: content, slots: [] };

  let text = '';
  let cursor = 0;
  const slots: ExpandedPrompt['slots'] = [];

  for (const v of vars) {
    text += content.slice(cursor, v.start);
    const value = remembered[v.name] || v.defaultValue || v.name;
    slots.push({ name: v.name, start: text.length, end: text.length + value.length });
    text += value;
    cursor = v.end;
  }
  text += content.slice(cursor);

  return { text, slots };
}

/** 正文是否含变量，用于在列表里给带变量的条目加个标记。 */
export function hasVariables(content: string): boolean {
  VARIABLE_RE.lastIndex = 0;
  return VARIABLE_RE.test(content);
}

/**
 * 查询是否指向某个分类。组名和别名都认，双向包含——
 * 打「绘图」要命中「绘图生成」，打「绘图生成」也要命中别名「绘图」。
 */
function matchesCategory(id: PromptCategoryId | undefined, q: string): boolean {
  if (!id) return false;
  const category = CATEGORY_BY_ID.get(id);
  if (!category) return false;
  for (const name of [category.label, ...category.aliases]) {
    const n = name.toLowerCase();
    if (n.includes(q) || q.includes(n)) return true;
  }
  return false;
}

/**
 * 搜索打分。分数越高越靠前，返回 null 表示不匹配。
 *
 * 排序依据（由强到弱）：标题匹配度 → 分类命中 → 正文命中 → 使用次数 → 最近使用。
 * 标题命中远比正文命中重要——用户搜「推导」是在找那条叫「分步推导」的，
 * 而不是任何正文里碰巧提到推导的模板。
 */
export function scorePrompt(prompt: Prompt, query: string): number | null {
  const q = query.trim().toLowerCase();
  const title = prompt.title.toLowerCase();

  let base: number;
  if (!q) {
    base = 0;
  } else if (title === q) {
    base = 1000;
  } else if (title.startsWith(q)) {
    base = 800;
  } else if (title.includes(q)) {
    base = 600;
  } else if (matchesCategory(prompt.category, q)) {
    /*
      夹在「标题包含」和「正文包含」之间是有意的：
      打「绘图」要能捞出整个绘图分类，但如果某条标题里就带这两个字，
      那条仍然排在整组前面——它更可能就是用户在找的那条。
    */
    base = 400;
  } else if (prompt.content.toLowerCase().includes(q)) {
    base = 200;
  } else {
    return null;
  }

  const usage = prompt.usage;
  if (!usage) return base;

  // 次数封顶，避免某条用了几百次之后把搜索结果彻底锁死。
  const byCount = Math.min(usage.count, 50);
  // 最近 7 天内用过的额外加权，越近越高。
  const days = (Date.now() - usage.lastUsedAt) / 86_400_000;
  const byRecency = days < 7 ? Math.round((7 - days) * 3) : 0;

  return base + byCount + byRecency;
}

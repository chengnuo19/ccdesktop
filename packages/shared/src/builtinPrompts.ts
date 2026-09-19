/**
 * 内置提示词的汇总入口。
 *
 * 写在代码里而不是写进用户的 prompts.json：这样升级能带上新模板，
 * 用户自己的文件也不会被一堆内置内容淹没。用户改过的以同 id 覆盖，
 * 隐藏的记在 hiddenBuiltinIds 里。
 *
 * 内容按分类拆到 builtinPrompts/ 下——一个文件装八十来条实在没法看，
 * 而且每一类的取材来源不同，注释解释起来也该各说各的。
 * 这里只负责拼起来，导出路径不变，下游 import 不受影响。
 *
 * 选取原则：偏向「先诊断、要检验、别急着下结论」的问法。
 * 直接问结果的提示词没什么价值——真正省事的是那些能约束 AI
 * 别跳步、别编、别糊弄过去的说法。视觉类也一样，给的是可检验的
 * 硬约束（色值、占比、禁止项），不是「画得好看一点」。
 *
 * 数组顺序即列表里的默认顺序，与 PROMPT_CATEGORIES 保持一致。
 */

import type { Prompt } from './prompts.js';
import { STUDY_PROMPTS } from './builtinPrompts/study.js';
import { RESEARCH_PROMPTS } from './builtinPrompts/research.js';
import { ANALYSIS_PROMPTS } from './builtinPrompts/analysis.js';
import { CODE_PROMPTS } from './builtinPrompts/code.js';
import { WRITING_PROMPTS } from './builtinPrompts/writing.js';
import { IMAGE_PROMPTS } from './builtinPrompts/image.js';
import { VIDEO_PROMPTS } from './builtinPrompts/video.js';
import { COMMERCIAL_PROMPTS } from './builtinPrompts/commercial.js';

export const BUILTIN_PROMPTS: Prompt[] = [
  ...STUDY_PROMPTS,
  ...RESEARCH_PROMPTS,
  ...ANALYSIS_PROMPTS,
  ...CODE_PROMPTS,
  ...WRITING_PROMPTS,
  ...IMAGE_PROMPTS,
  ...VIDEO_PROMPTS,
  ...COMMERCIAL_PROMPTS,
];

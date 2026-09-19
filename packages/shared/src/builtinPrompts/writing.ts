/**
 * 文字处理与翻译。
 *
 * 「术语一致性」来自 Yuan1z0825/nature-skills 的 nature-polishing——
 * 它原本要读 manifest.yaml 按论文类型/章节/语种做多轴路由，
 * 那套在对话框里没法复现；但它守着的那条底线（宁可标出问题也不许编）可以。
 */

import type { Prompt } from '../prompts.js';

export const WRITING_PROMPTS: Prompt[] = [
  {
    id: 'builtin-to-english',
    title: '中译英',
    builtin: true,
    category: 'writing',
    content: '翻译成英文，保持原文的语气和正式程度。只给译文，不要附加解释。',
  },
  {
    id: 'builtin-plain-words',
    title: '大白话重讲',
    builtin: true,
    category: 'writing',
    content:
      '用大白话重讲一遍，面向没有相关背景的人。可以用类比，' +
      '但不要为了通俗而牺牲准确性；如果某处必须保留术语，就先解释再用。',
  },
  {
    id: 'builtin-compress',
    title: '压缩',
    builtin: true,
    category: 'writing',
    content:
      '把下面的内容压缩到 {{字数:200}} 字以内，保留关键数据和结论，' +
      '删掉铺垫、重复和例子。\n\n{{正文}}',
  },
  {
    id: 'builtin-term-consistency',
    title: '术语一致性',
    builtin: true,
    category: 'writing',
    content:
      '扫描下面这段的术语使用。列出：\n' +
      '1. 同一个概念用了几种不同说法的（列出全部变体，并建议统一用哪个）；\n' +
      '2. 同一个词在不同地方指了不同东西的；\n' +
      '3. 中英混用不一致的（某处用中文某处用英文缩写）。\n' +
      '只列清单，不要改写正文。\n\n{{正文}}',
  },
  {
    id: 'builtin-three-sentences',
    title: '三句话摘要',
    builtin: true,
    category: 'writing',
    content:
      '用三句话概括下面的内容：\n' +
      '第一句说清楚讲的是什么问题，第二句说做了什么，第三句说结论是什么。\n' +
      '不要用「本文」「首先」这类套话，直接说事。如果三句话说不完整，' +
      '指出是哪部分信息缺失，不要硬凑。\n\n{{正文}}',
  },
  {
    id: 'builtin-for-reader',
    title: '按读者改写',
    builtin: true,
    category: 'writing',
    content:
      '把下面这段改写给 {{读者:完全没有背景的同事}} 看。\n' +
      '先说明你判断这类读者关心什么、能接受多少术语密度，再给改写版本。\n' +
      '保留全部事实和数据，只调整详略、顺序和用词。\n\n{{正文}}',
  },
  {
    id: 'builtin-spoken-to-written',
    title: '口语转书面',
    builtin: true,
    category: 'writing',
    content:
      '把下面这段口语记录整理成书面表达：去掉口头禅、重复和自我修正，' +
      '把散落的意思合并成完整句子，理清指代不明的「这个」「那个」。\n' +
      '不要增加原话里没有的内容，说话人没讲清楚的地方标出来，不要替他补全。\n\n{{正文}}',
  },
  {
    id: 'builtin-dehumanize',
    title: '降 AI 痕迹',
    builtin: true,
    category: 'writing',
    content:
      '把下面这段改得更像人写的：拆开过长的句子，去掉排比和「首先/其次/最后」' +
      '这类模板化结构，删掉不提供信息的总结句和过渡句。' +
      '保留原意、专业术语和全部数据，不要新增内容。\n\n{{正文}}',
  },
];

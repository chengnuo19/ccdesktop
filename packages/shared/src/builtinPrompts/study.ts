/**
 * 学习解题。
 *
 * 新增几条来自 K-Dense-AI/scientific-agent-skills 的 Research Methodology 分支，
 * 蒸馏掉了它跑 Python、查数据库那一层——那些在对话框里没法用。
 * 留下的是它真正值钱的部分：逼着人先把「我到底哪里不懂」说清楚。
 */

import type { Prompt } from '../prompts.js';

export const STUDY_PROMPTS: Prompt[] = [
  {
    id: 'builtin-step-derive',
    title: '分步推导',
    builtin: true,
    category: 'study',
    content:
      '分步推导，每一步注明依据的定理或公式。得出结果后做量纲检查和数量级估算，' +
      '说明结果是否合理。如果条件不足，先指出缺什么，不要自行假设补齐。',
  },
  {
    id: 'builtin-concept',
    title: '概念澄清',
    builtin: true,
    category: 'study',
    content:
      '解释 {{概念}}。\n' +
      '1. 先用一句话给出定义；\n' +
      '2. 说明它是为了解决什么问题才被提出来的；\n' +
      '3. 和 {{易混概念}} 的关键区别在哪；\n' +
      '4. 给一个尽量小的例子。',
  },
  {
    id: 'builtin-feynman',
    title: '费曼检验',
    builtin: true,
    category: 'study',
    content:
      '下面是我对 {{概念}} 的理解，请当作一份待检验的答卷来看。\n' +
      '1. 指出哪几处说法是错的，错在哪；\n' +
      '2. 指出哪几处是「用术语盖住了没想明白的地方」——听起来对，但换个说法就讲不下去；\n' +
      '3. 针对每个卡壳处，给一个能戳穿它的追问。\n' +
      '先不要给正确版本，我想自己再试一遍。\n\n我的理解：{{正文}}',
  },
  {
    id: 'builtin-fermi',
    title: '数量级估算',
    builtin: true,
    category: 'study',
    content:
      '估算 {{问题}}。\n' +
      '把它拆成几个能各自估出量级的因子，逐个给出取值和取这个值的理由，' +
      '再相乘得到结果。最后说明：哪个因子的不确定性最大，结果可能偏了几倍。\n' +
      '不要查精确数据，这是估算；但也不要把不确定性藏起来。',
  },
  {
    id: 'builtin-error-cause',
    title: '错题归因',
    builtin: true,
    category: 'study',
    content:
      '这道题我做错了。先别给正确解法。\n' +
      '1. 指出我是在哪一步开始偏的；\n' +
      '2. 判断这是哪一类错误：概念理解错、公式用错条件、计算失误，还是题意读错；\n' +
      '3. 给一道只考这个错因、其他都更简单的题让我重做。\n\n' +
      '题目：{{题目}}\n我的解法：{{我的解法}}',
  },
  {
    id: 'builtin-concept-map',
    title: '概念地图',
    builtin: true,
    category: 'study',
    content:
      '把 {{主题}} 里的核心概念整理成一张关系图（用文字描述节点和连线即可）。\n' +
      '要求：每条连线都标明是什么关系（推出、包含、对立、特例、前提）；' +
      '标出哪几个是地基概念，不懂它们后面全塌；' +
      '最后列出最容易被混为一谈的 2–3 对概念。',
  },
];

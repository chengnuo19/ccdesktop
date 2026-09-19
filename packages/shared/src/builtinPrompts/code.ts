/**
 * 编程开发。
 *
 * 后四条对着 K-Dense-AI/scientific-agent-skills 里 ML 与实验复现那一支写的。
 * 它原本靠脚本去跑基准、查随机种子，这里只能把它的检查清单变成问法——
 * 好在这类 skill 的价值本来就在清单，不在脚本。
 */

import type { Prompt } from '../prompts.js';

export const CODE_PROMPTS: Prompt[] = [
  {
    id: 'builtin-explain-code',
    title: '逐段解释',
    builtin: true,
    category: 'code',
    content:
      '逐段解释这段代码在做什么。重点说清楚为什么这么写、解决了什么问题，' +
      '而不是复述语法。如果有可疑或危险的写法，顺带指出来。',
  },
  {
    id: 'builtin-diagnose-first',
    title: '先诊断再改',
    builtin: true,
    category: 'code',
    content:
      '这段代码出现 {{现象}}。\n' +
      '先列出 3 个最可能的原因，每个说明判断依据；' +
      '再给出验证每个原因的最小实验。\n' +
      '先不要改代码，等我确认是哪个原因之后再动手。',
  },
  {
    id: 'builtin-repro-check',
    title: '复现性检查',
    builtin: true,
    category: 'code',
    content:
      '审查这段实验代码能不能被别人跑出同样的结果。逐项回答，没问题的直接写「无」：\n' +
      '1. 随机性：种子设了吗，是否覆盖了所有来源（框架、数据加载、数据增强、多进程）；\n' +
      '2. 数据：划分是固定的还是每次重随机，有没有测试集泄漏；\n' +
      '3. 环境：有没有依赖未固定版本的行为；\n' +
      '4. 硬件：结果是否依赖特定设备或并行度。\n' +
      '只报事实，不要顺手重写代码。',
  },
  {
    id: 'builtin-pipeline-review',
    title: '数据管线审查',
    builtin: true,
    category: 'code',
    content:
      '审查这段数据处理管线。按数据流顺序，逐个环节指出：\n' +
      '这一步会静默丢弃哪些数据（空值、类型不符、超界）；' +
      '出错时是抛异常还是继续跑；' +
      '有没有在划分训练/测试之前就用全量数据算过统计量。\n' +
      '重点找「不报错但结果已经不对了」的地方。',
  },
  {
    id: 'builtin-seed-audit',
    title: '随机性排查',
    builtin: true,
    category: 'code',
    content:
      '这段代码每次跑出来的结果不一样，差异是 {{差异表现}}。\n' +
      '列出代码里所有引入随机性的地方，按「最可能造成这个量级差异」排序，' +
      '每个说明怎么单独固定住它来验证。\n' +
      '如果某处差异不可能由随机性解释，直接指出来——那说明是别的 bug。',
  },
  {
    id: 'builtin-measure-first',
    title: '先测后优化',
    builtin: true,
    category: 'code',
    content:
      '我想优化这段代码的 {{性能指标:耗时}}。\n' +
      '先不要改。告诉我：应该测哪几个点、用什么方式测、' +
      '以及在测之前你对瓶颈在哪的猜测和理由。\n' +
      '等我把实测数据贴给你，再讨论怎么改。',
  },
];

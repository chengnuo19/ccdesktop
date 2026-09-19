/**
 * 目标选择面板的渲染逻辑。
 *
 * 只做三件事：列出目标、标出哪个能用、点一下切过去。
 * 可用性检测要跨进程查窗口，比较慢，所以先把列表画出来，
 * 检测结果回来再更新状态点——不让用户对着空白面板干等。
 */

import type { TargetStatus } from './env.js';

const list = document.getElementById('list');
const summary = document.getElementById('summary');

if (!list || !summary) {
  throw new Error('面板的 DOM 结构不完整');
}

let items: TargetStatus[] = [];
/** 这次要投给哪些目标，第一个是主目标。 */
let selectedIds: string[] = [];

/**
 * 每个目标一张图标，文件名就是目标 id。
 * 之所以不按品牌共用：桌面端和网页端是两条完全不同的投递链路，
 * 图上用地球+光标把网页端区分出来，比只靠文字标签好认得多。
 */
function iconFor(targetId: string): string {
  return `icons/${targetId}.png`;
}

/** 图标文件缺失时的文字占位，按品牌给。 */
function fallbackLetter(targetId: string): string {
  if (targetId.startsWith('chatgpt')) return 'GPT';
  if (targetId.startsWith('gemini')) return 'G';
  return '?';
}

function buildIcon(t: TargetStatus): HTMLElement {
  const box = document.createElement('div');
  box.className = 'icon';

  const img = document.createElement('img');
  img.src = iconFor(t.id);
  img.alt = '';
  /*
    图标文件可能还没放进去。加载失败就换成文字占位，
    否则会留一个破图标——比没有图标更难看。
  */
  img.addEventListener('error', () => {
    box.innerHTML = '';
    const span = document.createElement('span');
    span.className = 'icon-fallback';
    span.textContent = fallbackLetter(t.id);
    box.appendChild(span);
  });
  box.appendChild(img);
  return box;
}

function render(): void {
  list!.innerHTML = '';

  for (const t of items) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'item';
    item.setAttribute('role', 'radio');
    /*
      主目标和「同时也发」分开标：前者是 radio 的选中，后者只是加进来的。
      两者用同一种高亮的话，面板上会出现两个看起来一样的「当前目标」。
    */
    const rank = selectedIds.indexOf(t.id);
    item.setAttribute('aria-checked', String(rank === 0));
    if (rank > 0) item.dataset['extra'] = 'true';
    item.dataset['available'] = t.available === null ? 'unknown' : String(t.available);

    const body = document.createElement('div');
    body.className = 'item-body';

    const name = document.createElement('div');
    name.className = 'item-name';
    name.textContent = t.shortLabel;

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = t.delivery === 'web' ? '网页' : '桌面';
    meta.appendChild(kind);
    meta.append(t.reason ?? (t.available ? '可用' : '检测中'));

    body.append(name, meta);

    const dot = document.createElement('span');
    dot.className = 'state-dot';

    item.append(buildIcon(t), body, dot);
    item.addEventListener('click', (e) => {
      /*
        Ctrl/⌘+点击 = 把这个目标也加进来，同一个问题同时发两家。
        面板**不关闭**：加第二个的下一步多半是想看看还要不要加第三个，
        而且关掉之后就看不见自己刚加了什么了。
        普通点击仍然是「换到它并关闭」——最常用的那条路一步都没变。
      */
      if (e.ctrlKey || e.metaKey) {
        void window.xfb.toggleTarget(t.id).then((ids) => {
          selectedIds = ids;
          render();
        });
        return;
      }
      void window.xfb.selectTarget(t.id).then(() => window.xfb.closePanel());
    });

    list!.appendChild(item);
  }

  const usable = items.filter((t) => t.available === true).length;
  const known = items.filter((t) => t.available !== null).length;
  /*
    选了多个就先说这件事——它比「几个可用」重要得多，
    而且没有别的地方能告诉用户「这次会发两份出去」。
    Ctrl+点击这个用法也只在这儿有机会讲，不写出来没人会发现。
  */
  if (selectedIds.length > 1) {
    summary!.textContent = `同时发给 ${selectedIds.length} 个`;
  } else if (known === 0) {
    summary!.textContent = '检测中…';
  } else {
    summary!.textContent = `${usable} 个可用 · Ctrl+点击可多选`;
  }
}

window.xfb.onPanelData((data) => {
  items = data.targets;
  selectedIds = data.currentTargetIds;
  render();
});

void window.xfb.panelReady();

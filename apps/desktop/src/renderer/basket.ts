import type { BasketItem } from './env';

const basket = document.querySelector<HTMLElement>('#basket');
const items = document.querySelector<HTMLElement>('#items');
const empty = document.querySelector<HTMLElement>('#empty');
const summary = document.querySelector<HTMLElement>('#summary');
const closeButton = document.querySelector<HTMLButtonElement>('#closeButton');
const toast = document.querySelector<HTMLElement>('#toast');

if (!basket || !items || !empty || !summary || !closeButton || !toast) {
  throw new Error('临时篮子的 DOM 结构不完整');
}

const iconFor = (kind: BasketItem['kind']): string => ({
  file: '▤',
  directory: '▰',
  text: 'T',
  url: '↗',
  image: '◇',
})[kind];

function formatSize(bytes: number): string {
  if (bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

let toastTimer: number | null = null;
function showToast(message: string): void {
  toast!.textContent = message;
  toast!.hidden = false;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast!.hidden = true;
    toastTimer = null;
  }, 1800);
}

function renderItem(item: BasketItem): HTMLElement {
  const card = document.createElement('article');
  card.className = 'item';
  card.draggable = true;
  card.title = item.name;

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (item.thumbnail) {
    const image = document.createElement('img');
    image.src = item.thumbnail;
    image.alt = '';
    thumb.append(image);
  } else {
    thumb.textContent = iconFor(item.kind);
  }

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = item.name;

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = item.kind === 'directory' ? '文件夹' : formatSize(item.size);

  card.append(thumb, name, meta);
  card.addEventListener('dblclick', () => void window.xfb.openBasketItem(item.id));
  card.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    window.xfb.showBasketItemMenu(item.id);
  });
  card.addEventListener('dragstart', (event) => {
    event.preventDefault();
    window.xfb.dragBasketItem(item.id);
  });
  return card;
}

async function refresh(): Promise<void> {
  const result = await window.xfb.listBasketItems();
  items!.replaceChildren(...result.map(renderItem));
  empty!.hidden = result.length > 0;
  summary!.textContent = `${result.length} 项`;
}

let dragDepth = 0;
window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth++;
  basket.dataset.dropping = 'true';
});

window.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) delete basket.dataset.dropping;
});

window.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  delete basket.dataset.dropping;

  const transfer = event.dataTransfer;
  if (!transfer) return;
  const files = [...transfer.files];
  const text = transfer.getData('text/uri-list') || transfer.getData('text/plain');
  void window.xfb.addToBasket(files, text).then((result) => {
    if (result.added > 0) showToast(`已放入 ${result.added} 项`);
    else showToast(result.message ?? '没有可接收的内容');
  });
});

closeButton.addEventListener('click', () => window.xfb.closeBasket());
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.xfb.closeBasket();
});

window.xfb.onBasketChanged(() => void refresh());
window.xfb.onBasketToast(showToast);
void refresh();

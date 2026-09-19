/**
 * 悬浮标本体的渲染逻辑。
 *
 * 职责很窄：把主进程推来的 PetState 映射成 DOM 属性，
 * 形态变换和动画全部交给 CSS。状态与表现分开，
 * 以后调动画不用碰这里的逻辑。
 */

import type { Celebration, PetState } from './env.js';

/** 与 CSS 中的 r=23 对应：2πr。 */
const RING_CIRCUMFERENCE = 144.5;

/** thinking 超过这么久才显示提示气泡，免得平时太吵。 */
const SLOW_HINT_AFTER_MS = 12_000;

/** 闲着多久之后收拢成小圆。 */
const IDLE_COLLAPSE_MS = 10_000;

const stage = document.getElementById('stage');
const pill = document.getElementById('pill');
const ringArc = document.getElementById('ringArc');
const ringSegs = document.getElementById('ringSegs');
const bubble = document.getElementById('bubble');
const btnCompose = document.getElementById('btnCompose');
const btnBasket = document.getElementById('btnBasket');
const btnMenu = document.getElementById('btnMenu');
/* 圆心那个点。只有庆祝动画会主动碰它，平时归 CSS 管，所以不进下面的必需检查。 */
const core = document.getElementById('core');

if (!stage || !pill || !ringArc || !ringSegs || !bubble || !btnCompose || !btnBasket || !btnMenu) {
  throw new Error('悬浮标的 DOM 结构不完整');
}

let currentState: PetState | null = null;

/** 这一轮里还有没有能跳过去看的目标。 */
function canReveal(state: PetState): boolean {
  return state.tracks.some((t) => t.revealable && t.phase !== 'sending');
}

function describe(state: PetState): string | null {
  switch (state.phase) {
    case 'error':
      return state.errorMessage ?? '出错了';
    case 'done':
      /*
        只在鼠标压上来的时候才提示可以点。
        每次完成都弹一句的话，天天在用的工具看到第一百遍
        就只剩噪音；而鼠标都移过来了，这句话恰好是他要的。
      */
      if (!pointerOnPill || !canReveal(state)) return null;
      return state.tracks.length > 1 ? '点一下去看，连点换下一个' : '点一下去看回复';
    case 'thinking':
      // 等太久才提示，并说明这是估算的，别让用户以为是精确进度。
      if (state.elapsedMs >= SLOW_HINT_AFTER_MS) {
        return state.confidence === 'coarse' ? '还在生成（粗略估计）' : '还在生成';
      }
      return null;
    default:
      return null;
  }
}

/** 段与段之间留的空隙，弧长单位。留窄了两段会糊成一圈看不出分段。 */
const SEG_GAP = 7;

/**
 * 多轨时把圆周切成几段，每段表示一个目标。
 *
 * 不让每段各自转圈：两段反着转看着像坏了，而且「谁转得快」会被读成
 * 「谁快要好了」——那是编造的信息。每段只用颜色表示自己走到哪了，
 * 还在生成的那段轻轻呼吸，和整圈那条「不画假进度」是同一条原则。
 */
function paintSegments(state: PetState): void {
  const n = state.tracks.length;
  const multi = n > 1;
  stage!.dataset['tracks'] = multi ? 'multi' : 'single';
  stage!.dataset['revealable'] = String(canReveal(state));

  if (!multi) {
    if (ringSegs!.childElementCount > 0) ringSegs!.replaceChildren();
    return;
  }

  const span = RING_CIRCUMFERENCE / n;
  const len = Math.max(span - SEG_GAP, 4);

  /*
    段数没变就只改状态，不重建 DOM。

    重建会让 CSS 动画从头起拍：另一轨每报一次进度，这一轨的呼吸就被
    打断重来，看着像在抽搐——而进度回报是每几百毫秒一次的。
  */
  if (ringSegs!.childElementCount !== n) {
    ringSegs!.replaceChildren(
      ...state.tracks.map((_, i) => {
        const seg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        seg.setAttribute('class', 'ring-seg');
        seg.setAttribute('cx', '26');
        seg.setAttribute('cy', '26');
        seg.setAttribute('r', '23');
        seg.setAttribute('stroke-dasharray', `${len} ${RING_CIRCUMFERENCE - len}`);
        // 负的 offset 让第 i 段顺着圆周往后排，起点仍在 12 点方向。
        seg.setAttribute('stroke-dashoffset', String(-i * span));
        return seg;
      }),
    );
  }

  state.tracks.forEach((track, i) => {
    const seg = ringSegs!.children[i];
    if (seg instanceof SVGElement) seg.dataset['phase'] = track.phase;
  });
}

/**
 * 气泡单独画。
 *
 * 它的内容现在还取决于鼠标在不在本体上（done 时提示「点一下去看」），
 * 而鼠标移进移出不会带来新的 PetState，所以不能只在 render 里画。
 */
function paintBubble(): void {
  const text = currentState ? describe(currentState) : null;
  if (text) {
    bubble!.textContent = text;
    bubble!.removeAttribute('hidden');
  } else {
    bubble!.setAttribute('hidden', '');
  }
}

function render(state: PetState): void {
  currentState = state;
  stage!.dataset['phase'] = state.phase;

  // 只有真拿得到比例时才画确定性进度，否则老实转圈，不伪造。
  const determinate =
    state.phase === 'thinking' && state.confidence === 'exact' && state.progress !== null;
  stage!.dataset['mode'] = determinate ? 'determinate' : 'indeterminate';

  if (determinate) {
    const clamped = Math.min(1, Math.max(0, state.progress ?? 0));
    ringArc!.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE * (1 - clamped)));
  } else if (state.phase === 'done' || state.phase === 'error') {
    ringArc!.setAttribute('stroke-dashoffset', '0');
  }

  paintSegments(state);
  paintBubble();

  // 忙起来就立刻展开；回到待机才重新开始计时收拢。
  if (state.phase === 'idle') scheduleCollapse();
  else expand();
}

/* ---------- 闲置收拢 ---------- */

let collapseTimer: number | null = null;
/** 鼠标是否停在本体上。停着就不收，否则它会在用户眼皮底下缩掉。 */
let pointerOnPill = false;

function cancelCollapse(): void {
  if (collapseTimer !== null) {
    window.clearTimeout(collapseTimer);
    collapseTimer = null;
  }
}

function expand(): void {
  cancelCollapse();
  stage!.dataset['collapsed'] = 'false';
}

/**
 * 安排一次收拢。
 * 只有待机、且鼠标不在本体上时才排队——忙碌时缩掉会让人以为任务没了。
 */
function scheduleCollapse(): void {
  cancelCollapse();
  if (currentState?.phase !== 'idle' || pointerOnPill) return;
  collapseTimer = window.setTimeout(() => {
    collapseTimer = null;
    stage!.dataset['collapsed'] = 'true';
  }, IDLE_COLLAPSE_MS);
}

/* ---------- 庆祝 ---------- */

/*
  想换 emoji 就改这两行——它们是这套动画唯一需要调口味的地方。

  送达那组偏"传递"，完成那组偏"庆祝"。数量都是刻意的：
  送达 8 颗够看出是一圈卷进来，完成 12 颗在撑大的窗口里才铺得开。
*/
const SENT_EMOJI = ['💬', '✨', '📨', '💫', '⚡', '✨', '💬', '💫', '📩', '✨'];
const DONE_EMOJI = ['✨', '🎊', '💫', '⭐', '✨', '🎊', '💫', '✨', '⭐', '💫', '✨', '🎊'];

/**
 * 当前这一轮庆祝的编号。
 *
 * 用户完全可能在花还没撒完的时候就发了下一条。旧那一轮的收尾
 * （缩回窗口、清理粒子）这时必须闭嘴，否则它会把新一轮刚撑开的窗口缩掉，
 * 表现为"有时候撒到一半就没了"，且毫无规律。
 */
let celebrationId = 0;

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/** 造一颗粒子。用完自己删——留在 DOM 里会越攒越多。 */
function spawnSpark(ch: string, size: number, tint: boolean): HTMLElement {
  const el = document.createElement('div');
  el.className = 'spark';
  el.textContent = ch;
  el.style.fontSize = `${size}px`;
  if (tint) el.dataset['tint'] = '';
  stage!.appendChild(el);
  return el;
}

/**
 * 让一颗粒子沿螺旋飞。
 *
 * 螺旋而不是直线：直线汇聚像被吸尘器吸走，转着进来才有"卷"的劲儿。
 * 角度边走边偏 1.5 弧度，五个关键帧就够顺了。
 *
 * 两个半径都要给，因为**窗口不是正方形的**：待机时 216×110，
 * 中心到左右有 108，到上下只有 55。按圆形轨迹撒的话，
 * 上下那两颗会贴着窗口边缘走，甚至被裁掉一半。
 *
 * `inner` 是收住的地方，不是圆心。本体是个半径 26 的圆，
 * 让粒子一路飞进圆心的结果是后半程全被这个圆吞掉——实测第一版就是这样，
 * 看起来像"粒子凭空消失了"。停在圆的外沿才看得见它们汇拢。
 *
 * `inward` 为 false 时整条轨迹倒过来用，于是同一个函数既能汇聚也能迸散。
 */
function flySpark(
  el: HTMLElement,
  angle: number,
  radiusX: number,
  radiusY: number,
  inner: number,
  duration: number,
  delay: number,
  inward: boolean,
): void {
  const frames: Keyframe[] = [];
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const p = i / steps;
    const progress = inward ? p : 1 - p;
    const rx = inner + (radiusX - inner) * (1 - progress);
    const ry = inner + (radiusY - inner) * (1 - progress);
    const a = angle + progress * 1.5;
    // 两头淡入淡出，中间满不透明；不这样的话粒子会在起点和终点硬生生地闪出来。
    const opacity = p < 0.15 ? p / 0.15 : p > 0.8 ? (1 - p) / 0.2 : 1;
    frames.push({
      transform: `translate(calc(-50% + ${Math.cos(a) * rx}px), calc(-50% + ${
        Math.sin(a) * ry
      }px)) scale(${inward ? 0.5 + progress * 0.6 : 1.1 - progress * 0.7})`,
      opacity,
    });
  }
  if (!inward) frames.reverse();

  const anim = el.animate(frames, {
    duration,
    delay,
    easing: 'cubic-bezier(.25,.6,.35,1)',
    fill: 'backwards',
  });
  anim.onfinish = () => el.remove();
  // 动画被取消（新一轮打断）时也要清掉，否则粒子会定格在半路上。
  anim.oncancel = () => el.remove();
}

/** 推一圈涟漪。tone 决定颜色：送达是蓝的，完成是绿的。 */
function ripple(tone: 'sent' | 'done', scale: number, duration: number, delay = 0): void {
  const el = document.createElement('div');
  el.className = 'wave';
  el.dataset['tone'] = tone;
  pill!.appendChild(el);
  const anim = el.animate(
    [
      { opacity: 0.85, transform: 'scale(.7)' },
      { opacity: 0, transform: `scale(${scale})` },
    ],
    { duration, delay, easing: 'ease-out', fill: 'backwards' },
  );
  anim.onfinish = () => el.remove();
  anim.oncancel = () => el.remove();
}

/** 圆心那一下"炸开"。 */
function punchCore(): void {
  core?.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(2.8)', offset: 0.4 }, { transform: 'scale(1)' }],
    { duration: 340, easing: 'ease-out' },
  );
}

/** 在圆心弹出一个大符号，然后淡掉。 */
function popBadge(ch: string, size: number, duration: number): void {
  const el = document.createElement('div');
  el.className = 'spark';
  el.textContent = ch;
  el.style.fontSize = `${size}px`;
  el.style.zIndex = '2';
  pill!.appendChild(el);
  const anim = el.animate(
    [
      { transform: 'translate(-50%,-50%) scale(0)', opacity: 0 },
      { transform: 'translate(-50%,-50%) scale(1.25)', opacity: 1, offset: 0.35 },
      { transform: 'translate(-50%,-50%) scale(1)', opacity: 1, offset: 0.65 },
      { transform: 'translate(-50%,-50%) scale(.85)', opacity: 0 },
    ],
    { duration, easing: 'cubic-bezier(.3,1.5,.5,1)' },
  );
  anim.onfinish = () => el.remove();
  anim.oncancel = () => el.remove();
}

/** 清掉上一轮遗留的粒子。新一轮打断旧一轮时用。 */
function clearSparks(): void {
  stage!.querySelectorAll('.spark, .wave').forEach((n) => n.remove());
}

/**
 * 演一次庆祝。
 *
 * 隆重程度跟着 confidence 走，理由和圆环不画假百分比是同一条：
 * `coarse` 判定"完成"的依据只是画面一秒多没变，可能只是对面打字停顿了一下。
 * 所以它只得到一圈绿涟漪，不撒花——动画的确信程度不该超过探测的确信程度。
 */
function celebrate(c: Celebration): void {
  const id = ++celebrationId;
  clearSparks();

  // 主进程算好的偏移，保证撑大窗口后本体的屏幕坐标不动。
  stage!.style.setProperty('--off-x', `${c.offsetX}px`);
  stage!.style.setProperty('--off-y', `${c.offsetY}px`);

  /*
    窗口尺寸变了，本体在窗口内的位置跟着变，命中矩形必须重报。
    ResizeObserver 指望不上：它盯的是本体，而本体自始至终是 52×52。
  */
  reportHitRect();

  const finish = (delay: number): void => {
    window.setTimeout(() => {
      // 被新一轮接管了就不要插手，见 celebrationId。
      if (id !== celebrationId) return;
      clearSparks();
      stage!.style.setProperty('--off-x', '0px');
      stage!.style.setProperty('--off-y', '0px');
      window.xfb.celebrateEnd();
      reportHitRect();
    }, delay);
  };

  if (reduceMotion.matches) {
    // 结果态由 data-phase 照常给，这里只需要把窗口还回去。
    finish(0);
    return;
  }

  if (c.kind === 'sent') {
    /*
      送达：一圈符号卷到本体外沿，到位时圆心炸一下。不撑窗口——
      这会儿用户的注意力已经移开了，不该为一句「送到了」清出半个屏幕。

      椭圆轨迹是被窗口逼出来的：待机窗口 216×110，中心到上下只有 55，
      按圆形撒的话上下那两颗会贴着边走。
    */
    SENT_EMOJI.forEach((ch, i) => {
      flySpark(spawnSpark(ch, 13, false), (Math.PI * 2 * i) / SENT_EMOJI.length, 84, 44, 30, 420, i * 26, true);
    });
    window.setTimeout(() => {
      if (id !== celebrationId) return;
      punchCore();
      ripple('sent', 1.5, 420);
    }, 400);
    finish(1000);
    return;
  }

  // 以下是 kind === 'done'。
  if (c.confidence === 'coarse') {
    ripple('done', 2.2, 620);
    finish(900);
    return;
  }

  const full = c.confidence === 'exact';
  const incoming = full ? DONE_EMOJI : DONE_EMOJI.slice(0, 6);
  /*
    窗口这时已撑到 360×260，中心到左右 180、到上下 130，
    所以水平能甩得更开一点。同样停在本体外沿，不飞进圆里——
    圆心那会儿正要弹出 🎉，挤进去只会互相盖住。
  */
  incoming.forEach((ch, i) => {
    flySpark(spawnSpark(ch, 15, false), (Math.PI * 2 * i) / incoming.length, 150, 112, 34, 640, i * 26, true);
  });

  window.setTimeout(() => {
    if (id !== celebrationId) return;
    ripple('done', 3.4, 620);
    popBadge(full ? '🎉' : '✨', full ? 26 : 18, full ? 1200 : 900);

    // 迸散只给 exact：那是唯一真能断定「它讲完了」的档位。
    if (full) {
      for (let i = 0; i < 14; i++) {
        flySpark(
          spawnSpark(DONE_EMOJI[i % DONE_EMOJI.length] ?? '✨', 13, false),
          (Math.PI * 2 * i) / 14 + 0.2,
          148,
          110,
          32,
          760,
          i * 18,
          false,
        );
      }
    }
  }, 700);

  finish(full ? 2300 : 1700);
}

window.xfb.onCelebrate(celebrate);

/* ---------- 鼠标命中 ---------- */

/*
  命中判断在主进程做，这里只负责两件事：把本体的位置报上去，以及接收结果。

  为什么不在这里听 mousemove：窗口默认开着鼠标穿透（否则那片透明区域会一直
  挡住桌面点击），而 `setIgnoreMouseEvents(true, { forward: true })` 承诺的
  「穿透时仍转发 mousemove」在 Windows 上实测收不到，渲染层完全静默。
*/
function reportHitRect(): void {
  const r = pill!.getBoundingClientRect();
  window.xfb.reportHitRect({
    left: r.left,
    top: r.top,
    width: r.width,
    height: r.height,
  });
}

/*
  本体尺寸一变就重报：展开是 125×52 的胶囊，收拢后只剩 40×40 的小圆，
  可命中的范围差了一大圈，不更新的话鼠标会在空处「命中」。
  ResizeObserver 比在每个状态切换点手动调用可靠——CSS 过渡期间也会持续触发。
*/
new ResizeObserver(reportHitRect).observe(pill);

/*
  窗口尺寸变了也要重报。

  庆祝时主进程会把窗口从 216×110 撑到 360×260，本体在窗口内的位置
  整个挪了一截——而 ResizeObserver 一声不吭，因为它盯的是本体，
  本体自始至终是 52×52。漏掉这一条，那两秒里鼠标的命中判断会整体偏移，
  表现为"庆祝的时候胶囊点不动"，且没有任何报错。
*/
window.addEventListener('resize', reportHitRect);

window.xfb.onHover((hovering) => {
  pointerOnPill = hovering;
  if (hovering) expand();
  else scheduleCollapse();
  // done 时的「点一下去看」只在鼠标压上来时出现，所以这里要重画一次。
  paintBubble();
});

/* ---------- 按钮 ---------- */

/*
  完成之后点本体 = 跳到目标窗口去看回复。

  “发完不打扰”不等于“不给回去的路”：生成完那一刻用户唯一想做的事
  就是去看它说了什么，而在这之前那还得自己把窗口找出来。
  绿环本来就是纯装饰，让它可点是它最自然的用处。

  这里只能括在 done 里：待机态的本体是胶囊，那两个按钮有自己的事。
*/
pill.addEventListener('click', (e) => {
  if (currentState?.phase !== 'done') return;
  if (e.target instanceof Element && e.target.closest('.act')) return;
  void window.xfb.revealTarget();
});

btnCompose.addEventListener('click', () => window.xfb.activate());

btnBasket.addEventListener('click', () => window.xfb.openBasket());

btnMenu.addEventListener('click', () => window.xfb.openMenu());

window.xfb.onState(render);
void window.xfb.getState().then(render);

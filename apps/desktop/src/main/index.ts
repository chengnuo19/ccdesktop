/**
 * 主进程入口。
 *
 * 负责：窗口生命周期、全局快捷键、托盘、以及渲染层与编排器之间的 IPC。
 */

import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, Tray, nativeImage } from 'electron';
import {
  BUILTIN_TARGETS,
  INITIAL_PET_STATE,
  aggregate,
  clipPreview,
  hasVariables,
  type Celebration,
  type CelebrationKind,
  type PetState,
  type ProbeConfidence,
  type TrackState,
} from '@xfb/shared';
import {
  createInputWindow,
  createPetWindow,
  createTargetPanel,
  createBasketWindow,
  markInputShown,
  positionInputWindow,
  positionTargetPanel,
  resizeInputWindow,
  acrylicAvailable,
  expandPetWindow,
  restorePetWindow,
  showBasketNearCursor,
} from './windows.js';
import { orchestrator, type SubmitOutcome } from './orchestrator.js';
import { win32Helper } from './win32/helper.js';
import { BridgeServer, loadOrCreateToken } from './bridge/server.js';
import { countPrompts, openPromptsFile, recordUsage, rememberedValues, savePrompt, searchPrompts } from './prompts.js';
import { checkAllTargets, pendingStatuses } from './availability.js';
import { trackHover, type HitRect, type HoverTracker } from './hover.js';
import { patchSettings, readSettings, setLaunchAtLogin, syncLaunchAtLogin } from './settings.js';
import { clearClips, countClips, findClip, imagePath, listClips, sweepOrphanImages } from './clipboard/store.js';
import { clipboardWatcher } from './clipboard/watcher.js';
import { installFileLogging, openLogsDir } from './logfile.js';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import {
  addImagesToBasket,
  addPathsToBasket,
  addTextToBasket,
  basketCopyPayload,
  listBasketItems,
  openBasketItem,
  resolveBasketItemSync,
  revealBasketItem,
  trashBasketItem,
  type EmbeddedImage,
} from './basket/store.js';

/*
  日志写不出去，不能把整个程序带走。

  从终端启动后再把终端关掉、或者 dev 的父进程先退了，stdout 的管道对端就没了，
  下一次 console.log 会抛 EPIPE。这条路径**没有任何业务含义**——只是一条日志
  发不出去——但它会冒成未捕获异常，弹出「A JavaScript error occurred in the
  main process」然后杀掉主进程。桥在 connection 回调里打日志时撞见过一次。

  兜两层，缺一不可：

  1. **包住 console 本身。** 实测那次的堆栈是同步的
     （console.log → Writable.write → Socket._write → 抛），
     流已销毁时 write 会直接 throw，光挂 error 监听器接不住。
  2. **再挂流的 error 监听。** 管道是异步写的那条路不会同步抛，
     而是 emit('error')；没有监听器时 Node 同样把它升级成未捕获异常。

  只吞日志这一处，不设全局 uncaughtException——那会把真正的 bug 一起藏掉。
*/
for (const name of ['log', 'warn', 'error', 'info', 'debug'] as const) {
  const original = console[name].bind(console);
  console[name] = (...args: unknown[]) => {
    try {
      original(...args);
    } catch {
      /* 日志发不出去就算了，程序继续跑 */
    }
  };
}

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', () => {
    /* 同上：输出流坏了不是业务错误，静默即可 */
  });
}

/*
  显式定名。默认会取 package.json 的 "@xfb/desktop"，里面的斜杠会把
  userData 目录撑成嵌套的 @xfb\desktop。连接密钥就存在 userData 下，
  路径必须干净且稳定。要在任何 getPath('userData') 之前设置。
*/
app.setName('XuanFuBiao');

/*
  落盘紧跟在定名之后，两头都卡着：早于 setName 会把日志写进 @xfb\desktop
  那个嵌套目录；再晚一点，启动早期那几条（材质判定、快捷键实际用了哪个）
  就赶不上了——而它们恰恰是排查时最先要看的。
*/
installFileLogging();

/**
 * 唤起输入条的候选快捷键，按优先级排列，注册成功一个就用它。
 *
 * 不硬编码单个快捷键，是因为占用情况在每台机器上都不一样：
 * 输入法、QQ、显卡驱动的覆盖层都可能已经抢走某个组合，而且抢占是静默的。
 *
 * 下面这些组合在中文输入环境下已被系统占用，**不要**加进这个列表：
 *   Alt+Shift   切换输入语言      Ctrl+Shift  切换输入法
 *   Ctrl+Space  切换中英文        Shift+Space 切换全角/半角
 *   Alt+Space   ChatGPT 桌面端自己的唤起键
 * 这类冲突尤其阴险：register() 可能照样返回 true，但按键在到达应用前就被吃掉。
 */
const HOTKEY_CANDIDATES = [
  'Ctrl+Alt+Space',
  'Ctrl+Alt+J',
  'Ctrl+Alt+X',
  'Ctrl+Shift+Alt+Space',
  'Ctrl+Alt+Oem3', // Oem3 是主键盘区的反引号键
];


/** 实际生效的那个快捷键，注册后才知道；全都失败则为 null。 */
let activeHotkey: string | null = null;

let petWindow: BrowserWindow | null = null;
let inputWindow: BrowserWindow | null = null;
let targetPanel: BrowserWindow | null = null;
let basketWindow: BrowserWindow | null = null;
let hoverTracker: HoverTracker | null = null;
let tray: Tray | null = null;
let bridge: BridgeServer | null = null;
let bridgeToken = '';
let shakePollTimer: NodeJS.Timeout | null = null;
let shakePollInFlight = false;

/**
 * 重建托盘菜单。由 buildTray 填上。
 *
 * 菜单项的文字和可用性是**构建那一刻**求值的，不是每次打开时求值。
 * 「清空剪贴板历史（N 条）」既显示条数、又靠条数决定灰不灰，
 * 不在剪贴板变动时重建的话，刚复制完东西那一条仍然是灰的——点不动。
 */
let refreshTrayMenu: (() => void) | null = null;

/**
 * 当前选中的投递目标，第一个是主目标。
 *
 * 绝大多数时候只有一个。可以在目标面板里 Ctrl+点击加上第二个，
 * 同一个问题就会同时送往两家——用来对照着看谁答得好。
 * 这个数组**永远非空**：面板那边不允许把最后一个取消掉，
 * 否则按下回车会什么都不发生，而且没有任何提示。
 */
let currentTargetIds: string[] = ['chatgpt-classic'];

/** 主目标。只需要一个名字的地方（托盘的 radio、日志）用它。 */
function primaryTargetId(): string {
  return currentTargetIds[0] ?? 'chatgpt-classic';
}

/**
 * 上一次输入条是怎么弹出来的。
 * 投递失败把文本还回去时照着原样再弹一次——用户点悬浮标唤起的，
 * 就不该让它这回突然跑到屏幕中央去。
 */
let lastInputAnchor: 'pet' | 'screen' = 'screen';

/**
 * 唤起输入条。
 *
 * `anchor` 决定它出现在哪儿：'pet' 贴着悬浮标弹出，'screen' 落在屏幕中间偏上。
 * 详见 windows.ts 的 positionInputWindow。
 */
/** 投递失败后把文本还回来时捎带的东西。 */
interface InputRestore {
  text: string;
  message: string;
}

function showInput(anchor: 'pet' | 'screen' = 'screen', restore?: InputRestore): void {
  if (!inputWindow) {
    console.warn('[输入条] inputWindow 不存在');
    return;
  }
  markInputShown();
  lastInputAnchor = anchor;
  positionInputWindow(inputWindow, anchor === 'pet' ? petWindow : null);
  inputWindow.show();
  inputWindow.focus();

  /*
    光靠 win.focus() 不够：Electron 主进程同样受 Windows 前台锁定限制，
    别的应用正活跃时它会静默失败——输入条显示出来了却收不到键盘，
    用户打的字会跑进原来那个应用里。
    所以再借助助手强抢一次前台，它有绕开前台锁定的手段。
  */
  void focusAndNotify(restore);
}

/**
 * 投递全都失败时，把用户刚打的那段话还回去。
 *
 * 提交时输入框是**立刻**清空并隐藏的——那一刻还不知道送没送到。
 * 等到知道的时候文本已经不在任何地方了：剪贴板也指望不上，
 * 投递路径写的那两次恰好被剪贴板历史的静默窗口排除掉。
 * 于是一次「目标应用收在托盘里」就能让人白打一整段。
 *
 * 只有**一个都没送到**才还。部分成功时再弹出来，用户很可能顺手又发一次，
 * 那就变成重复投递了。
 */
/**
 * 提交，并在全都没送到时把文本还回去。
 *
 * IPC 和自检都走这一条：回填如果只挂在 IPC 那头，
 * 「投递失败会不会丢文本」就取决于是从哪个入口发的——
 * 而 XFB_SELFTEST 存在的意义正是替人跑一遍真实链路。
 */
async function submitAndReport(targetIds: string[], text: string): Promise<SubmitOutcome> {
  console.log(`[投递] 目标=${targetIds.join('、')} 文本长度=${text.length}`);
  inputWindow?.hide();
  const outcome = await orchestrator.submit(targetIds, text);
  if (!outcome.ok) restoreInput(text, outcome.message ?? '投递失败');
  return outcome;
}

function restoreInput(text: string, message: string): void {
  if (!inputWindow || inputWindow.isDestroyed()) return;
  console.log(`[输入条] 投递失败，文本已交还（${text.length} 字）：${message}`);
  showInput(lastInputAnchor, { text, message });
}

/**
 * 先抢到前台，**再**通知渲染层把光标放进输入框。
 *
 * 顺序不能反：抢前台会重新激活窗口，把之前给 input 元素的焦点冲掉，
 * 表现就是输入条看着在前台、却一个字也打不进去。
 */
async function focusAndNotify(restore?: InputRestore): Promise<void> {
  if (!inputWindow) return;
  try {
    const handle = inputWindow.getNativeWindowHandle();
    // Windows 上是 HWND；64 位进程里是 8 字节，但实际值始终落在 32 位范围内。
    const hwnd = handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0);
    await win32Helper.send('focus', { hwnd });
  } catch (err) {
    console.warn('[输入条] 强制聚焦失败：', err);
  }
  if (!inputWindow || inputWindow.isDestroyed()) return;
  inputWindow.webContents.focus();
  /*
    回填的文本跟着 opened 一起送，不单独发一条消息。
    渲染层收到 opened 会把输入框清空（那是正常唤起该做的事），
    分两条发就成了竞态：清空那条后到，刚还回去的文本又没了。
  */
  inputWindow.webContents.send('input:opened', { targetIds: currentTargetIds, restore });
  // 不 await：检测要查窗口、问扩展，几百毫秒起步，不该拖着光标进输入框。
  void refreshInputStatuses();
}

/**
 * 给窗口要一个系统圆角。
 *
 * Win11 只给「正常」窗口自动加圆角，frameless 的窗口拿不到——
 * 输入条和目标面板改走亚克力（窗口不再透明）之后，实测四个角是齐齐的直角。
 *
 * 这条路上圆角**补不了**：窗口本身不透明，CSS 再画圆角也只是在
 * 一块方底上画，四个角各露出一小块底色，比直接方角还难看。只能找 DWM 要。
 *
 * 伪玻璃那条路不需要：窗口是透明的，圆角一直由 CSS 画，而且画得更自由
 * （DWM 只给「圆 / 小圆 / 不圆」三档，改不了半径）。
 */
async function applyRoundCorners(win: BrowserWindow | null, label: string): Promise<void> {
  if (!acrylicAvailable || !win || win.isDestroyed()) return;
  try {
    const handle = win.getNativeWindowHandle();
    // 同 focusAndNotify：Windows 上是 HWND，64 位进程里是 8 字节。
    const hwnd = handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0);
    const res = await win32Helper.send('round-corners', { hwnd });
    console.log(`[材质] ${label}圆角：${res.ok ? '已设置' : `未设置（hr=${String(res['hr'])}）`}`);
  } catch (err) {
    // 没圆角只是不好看，不值得影响启动。
    console.warn(`[材质] ${label}圆角设置失败：`, err);
  }
}

/* ---------- 庆祝 ---------- */

/**
 * 上一次见到的 phase。
 *
 * 值得庆祝的是**转换**（送进去了、说完了），而不是状态本身。
 * 而 state 会被反复推送——thinking 期间 elapsedMs 一直在变，每变一次就推一次。
 * 只看当前 phase 的话，生成过程中会一直撒花。
 */
let lastPhase: PetState['phase'] = 'idle';

/**
 * 抓住那两个时刻，必要时先把窗口撑大，再通知渲染层演。
 *
 * 只有「完成」且探测档位够硬时才撑窗口：
 * - `exact`（网页端读 DOM 的停止按钮）与 `approximate`（桌面端 UIA）撑；
 * - `coarse`（像素差分）不撑——它判定完成的依据只是画面一秒多没变，
 *   可能只是对面打字停顿了一下，大张旗鼓地撒花等于替它把话说死了。
 * 「送达」一律不撑：那会儿用户的注意力已经移开，不该为它清出半个屏幕。
 */
function maybeCelebrate(state: PetState): void {
  const prev = lastPhase;
  lastPhase = state.phase;
  if (prev === state.phase) return;

  let kind: CelebrationKind | null = null;
  if (prev === 'sending' && state.phase === 'thinking') kind = 'sent';
  else if (prev === 'thinking' && state.phase === 'done') kind = 'done';
  if (!kind) return;

  // 关掉之后连窗口都不该动一下。
  if (readSettings().celebrations === false) return;
  if (!petWindow || petWindow.isDestroyed()) return;

  const needsRoom =
    kind === 'done' && (state.confidence === 'exact' || state.confidence === 'approximate');
  const offset = needsRoom
    ? expandPetWindow(petWindow)
    : { offsetX: 0, offsetY: 0 };

  const payload: Celebration = { kind, confidence: state.confidence, ...offset };
  petWindow.webContents.send('pet:celebrate', payload);

  /*
    兜底缩回。

    正常路径是渲染层演完自己报 'pet:celebrate-end'，但那条消息可能永远不来：
    页面崩了、动画被新一轮投递打断、窗口在动画中途被销毁。
    窗口要是就这么一直撑着，那片透明区域会一直盖在桌面上——虽然点击照样穿透，
    但下次 expandPetWindow 会把撑大的尺寸当成原始尺寸，越撑越大。
  */
  if (needsRoom) {
    clearTimeout(celebrationFallback);
    celebrationFallback = setTimeout(() => {
      if (petWindow && !petWindow.isDestroyed()) restorePetWindow(petWindow);
    }, CELEBRATION_MAX_MS);
  }
}

/** 撑大的窗口最多保持这么久，超时无条件缩回。 */
const CELEBRATION_MAX_MS = 5_000;
let celebrationFallback: NodeJS.Timeout | undefined;

function showTargetPanel(): void {
  if (!targetPanel || !petWindow) return;
  if (targetPanel.isVisible()) {
    targetPanel.hide();
    return;
  }
  positionTargetPanel(targetPanel, petWindow);
  targetPanel.show();
  targetPanel.focus();
  // 每次打开都重新检测：窗口开没开、扩展连没连，随时都在变。
  void refreshPanelStatuses();
}

function showBasket(activate: boolean): void {
  if (!basketWindow || basketWindow.isDestroyed()) return;
  if (basketWindow.isVisible()) {
    basketWindow.moveTop();
    if (activate) basketWindow.focus();
    return;
  }
  showBasketNearCursor(basketWindow, activate);
  console.log(`[临时篮子] 已由${activate ? '按钮' : '摇动手势'}唤出`);
}

function notifyBasketChanged(): void {
  if (!basketWindow || basketWindow.isDestroyed()) return;
  basketWindow.webContents.send('basket:changed');
}

async function copyBasketItem(id: string): Promise<boolean> {
  const payload = await basketCopyPayload(id);
  if (!payload) return false;

  return clipboardWatcher.suppress(async () => {
    if (payload.kind === 'text' || payload.kind === 'url') {
      clipboard.writeText(payload.text ?? '');
      return true;
    }

    if (payload.kind === 'image') {
      const image = nativeImage.createFromPath(payload.path);
      if (image.isEmpty()) return false;
      clipboard.writeImage(image);
      return true;
    }

    const encodedPath = Buffer.from(payload.path, 'utf8').toString('base64');
    const response = await win32Helper.send('clipboard-files', { paths: [encodedPath] });
    return response.ok === true;
  });
}

/**
 * helper 持有 WH_MOUSE_LL 钩子，主进程只轮询一个一次性标志。
 * 同一时刻最多一条请求，避免 helper 忙于投递或 UIA 探测时堆出请求队列。
 */
async function pollBasketShake(): Promise<void> {
  if (shakePollInFlight) return;
  shakePollInFlight = true;
  try {
    const result = await win32Helper.send('shake-take');
    if (result.ok && result['detected'] === true) showBasket(false);
  } catch (err) {
    console.warn('[临时篮子] 摇动检测暂不可用：', err);
  } finally {
    shakePollInFlight = false;
  }
}

async function startBasketShakeMonitor(): Promise<void> {
  try {
    const result = await win32Helper.send('shake-start');
    if (!result.ok) {
      console.warn('[临时篮子] 全局鼠标钩子启动失败，仍可用按钮或托盘打开');
      return;
    }
    console.log('[临时篮子] 已启用拖动时摇鼠标唤出');
    shakePollTimer = setInterval(() => void pollBasketShake(), 90);
  } catch (err) {
    console.warn('[临时篮子] 摇动检测启动失败，仍可用按钮或托盘打开：', err);
  }
}

/** 把最新的可用性推给面板。面板没开着就不用白费劲。 */
async function refreshPanelStatuses(): Promise<void> {
  if (!targetPanel || targetPanel.isDestroyed() || !targetPanel.isVisible()) return;
  const targets = await checkAllTargets(bridge);
  if (targetPanel.isDestroyed()) return;
  targetPanel.webContents.send('panel:data', { targets, currentTargetIds });
}

/**
 * 把可用性也推给输入条。
 *
 * 输入条上那个状态点以前是**编出来的**：桌面端一律显示"能发"、网页端一律显示
 * "不能发"，压根没查过。于是它和目标面板会对同一个目标给出相反的答案——
 * 面板说 ChatGPT 网页"可用"（绿），输入条上同一时刻却是灰的。
 *
 * 那个点的全部意义就是回答"现在发过去能不能成"，答错还不如不显示。
 * 现在两处走同一个 checkAllTargets。
 *
 * 每次唤起都重新检测：窗口开没开、扩展连没连，随时都在变（同面板的理由）。
 */
async function refreshInputStatuses(): Promise<void> {
  if (!inputWindow || inputWindow.isDestroyed()) return;
  const targets = await checkAllTargets(bridge);
  if (!inputWindow || inputWindow.isDestroyed()) return;
  inputWindow.webContents.send('input:target-status', targets);
}

function toggleInput(): void {
  if (!inputWindow) return;
  if (inputWindow.isVisible()) {
    console.log('[输入条] 当前可见，收起');
    inputWindow.hide();
  } else {
    showInput();
  }
}

/**
 * 托盘图标路径。打包后随 extraResources 走，开发时读源码目录。
 * 图标必须真实存在——空白图标在任务栏里看不见，
 * 用户也就点不开菜单（连接密钥就藏在那里面）。
 */
function trayIconPath(): string {
  const packaged = path.join(process.resourcesPath, 'tray.png');
  if (app.isPackaged && existsSync(packaged)) return packaged;
  return path.join(app.getAppPath(), 'resources', 'tray.png');
}

function buildTray(): void {
  const icon = nativeImage.createFromPath(trayIconPath());
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('悬浮标');

  const refreshMenu = () => {
    const menu = Menu.buildFromTemplate([
      {
        label: '打开临时篮子',
        click: () => showBasket(true),
      },
      {
        // 实际生效的快捷键要如实显示：候选可能被占用而降级到了别的组合。
        label: activeHotkey ? `唤起输入条（${activeHotkey}）` : '唤起输入条（快捷键全被占用）',
        // 不能直接写 click: showInput——Electron 会把 MenuItem 当第一个参数塞进去，
        // 正好落在 anchor 上，输入条就会摆到莫名其妙的地方。
        click: () => showInput(),
      },
      { type: 'separator' },
      {
        /*
          托盘这里只管单选——点一下就是「换到它」，顺带丢掉附加目标。
          多选放在目标面板里（Ctrl+点击）：那边有图标、有可用性状态点，
          看得见哪个目标现在真能发，而托盘菜单给不了这些。
          标题把当前数量带出来，不然在面板里加的第二个目标在这儿完全看不见。
        */
        label: currentTargetIds.length > 1 ? `投递目标（${currentTargetIds.length} 个）` : '投递目标',
        submenu: BUILTIN_TARGETS.map((t) => ({
          label: currentTargetIds.includes(t.id) && t.id !== primaryTargetId() ? `${t.label} ·同时发` : t.label,
          type: 'radio' as const,
          checked: t.id === primaryTargetId(),
          click: () => {
            currentTargetIds = [t.id];
            refreshMenu();
          },
        })),
      },
      { type: 'separator' },
      {
        // 打包版没有终端，这是看日志唯一的入口；藏起来等于没落盘。
        label: '打开日志文件夹',
        click: () => {
          void openLogsDir();
        },
      },
      {
        label: `提示词库（${countPrompts()} 条）`,
        click: () => {
          void openPromptsFile();
        },
      },
      {
        /*
          清空入口必须一直摆在明面上。剪贴板里难免混进密码、验证码这类东西，
          排除标记只是各家密码管理器的约定，不是保证——得留一个用户自己能按的开关。
        */
        label: `清空剪贴板历史（${countClips()} 条）`,
        enabled: countClips() > 0,
        click: () => {
          clearClips();
          inputWindow?.webContents.send('clips:changed');
          refreshMenu();
        },
      },
      {
        label: '送达与完成时的动画',
        type: 'checkbox',
        // 默认开。天天在用的常驻工具，同一段动画看第一百遍就只剩负担了。
        checked: readSettings().celebrations !== false,
        click: (item) => {
          patchSettings({ celebrations: item.checked });
          refreshMenu();
        },
      },
      {
        label: '开机时自动启动',
        type: 'checkbox',
        checked: readSettings().launchAtLogin === true,
        // 默认关闭，由用户主动打开——常驻工具更不该擅自往启动项里塞东西。
        click: (item) => {
          setLaunchAtLogin(item.checked);
          refreshMenu();
        },
      },
      { type: 'separator' },
      {
        label: bridge?.connected ? '扩展已连接' : '扩展未连接',
        enabled: false,
      },
      {
        label: '复制扩展连接密钥',
        // 圈进静默窗口：密钥是本程序写进剪贴板的，绝不能出现在剪贴板历史里。
        click: () => {
          if (!bridgeToken) return;
          void clipboardWatcher.suppress(async () => clipboard.writeText(bridgeToken));
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]);
    tray?.setContextMenu(menu);
  };

  refreshTrayMenu = refreshMenu;
  refreshMenu();
  tray.on('click', toggleInput);
}

/**
 * 逐个试候选快捷键，用第一个注册成功的。
 * 全都失败也不致命——点击工具条上的编辑按钮、或托盘菜单同样能唤起。
 */
function registerHotkey(): void {
  for (const key of HOTKEY_CANDIDATES) {
    const ok = globalShortcut.register(key, () => {
      console.log(`[快捷键] ${key} 已触发`);
      toggleInput();
    });
    if (ok) {
      activeHotkey = key;
      console.log(`[快捷键] 已启用 ${key}`);
      return;
    }
    console.warn(`[快捷键] ${key} 被占用，试下一个`);
  }
  activeHotkey = null;
  console.error('[快捷键] 候选全部被占用，请改用点击工具条或托盘菜单唤起');
}

function registerIpc(): void {
  // 渲染层订阅状态：编排器每次变更都推给两个窗口。
  orchestrator.onChange((state) => {
    maybeCelebrate(state);
    petWindow?.webContents.send('pet:state', state);
    inputWindow?.webContents.send('pet:state', state);
  });

  ipcMain.handle('pet:get-state', () => orchestrator.getState());

  ipcMain.handle('targets:list', () => ({
    targets: BUILTIN_TARGETS.map((t) => ({
      id: t.id,
      label: t.label,
      shortLabel: t.shortLabel,
      delivery: t.delivery,
    })),
    currentTargetIds,
  }));

  /** 单选：换主目标，并丢掉附加的那些。 */
  ipcMain.handle('targets:select', (_e, targetId: string) => {
    if (BUILTIN_TARGETS.some((t) => t.id === targetId)) currentTargetIds = [targetId];
    refreshTrayMenu?.();
    return currentTargetIds;
  });

  /**
   * 多选：把一个目标加进这次投递，或者取消掉。
   *
   * 不允许取消到一个不剩——那样按回车会静悄悄地什么都不发生。
   * 想换目标就用普通点击（单选），这里只管「再加一个」。
   */
  ipcMain.handle('targets:toggle', (_e, targetId: string) => {
    if (!BUILTIN_TARGETS.some((t) => t.id === targetId)) return currentTargetIds;
    if (currentTargetIds.includes(targetId)) {
      if (currentTargetIds.length > 1) {
        currentTargetIds = currentTargetIds.filter((id) => id !== targetId);
      }
    } else {
      currentTargetIds = [...currentTargetIds, targetId];
    }
    refreshTrayMenu?.();
    return currentTargetIds;
  });

  ipcMain.handle('pet:submit', async (_e, payload: { targetIds?: string[]; text: string }) => {
    const targetIds = payload.targetIds?.length ? payload.targetIds : currentTargetIds;
    if (!payload.targetIds?.length) {
      console.log(`[投递] 渲染层未指定目标，用主进程记的 ${currentTargetIds.join('、')}`);
    }
    return submitAndReport(targetIds, payload.text);
  });

  /**
   * 跳到目标窗口去看回复。
   *
   * 「发完不打扰」不等于「不给回去的路」：生成完那一刻用户唯一想做的事
   * 就是去看它说了什么，而在这之前那还得自己把窗口找出来。
   */
  ipcMain.handle('pet:reveal', async () => orchestrator.reveal());

  ipcMain.on('input:close', () => inputWindow?.hide());

  // 庆祝演完了，把撑大的窗口还回去。超时兜底见 maybeCelebrate。
  ipcMain.on('pet:celebrate-end', () => {
    clearTimeout(celebrationFallback);
    if (petWindow && !petWindow.isDestroyed()) restorePetWindow(petWindow);
  });

  /* ---------- 提示词 ---------- */

  ipcMain.handle('prompts:search', (_e, query: string) =>
    searchPrompts(query).map((p) => ({
      id: p.id,
      title: p.title,
      content: p.content,
      category: p.category,
      hasVariables: hasVariables(p.content),
    })),
  );

  ipcMain.handle('prompts:remembered', (_e, id: string) => rememberedValues(id));

  ipcMain.on('prompts:used', (_e, payload: { id: string; variableValues?: Record<string, string> }) => {
    recordUsage(payload.id, payload.variableValues);
  });

  ipcMain.handle('prompts:save', (_e, payload: { title: string; content: string }) =>
    savePrompt(payload.title, payload.content),
  );

  /* ---------- 剪贴板历史 ---------- */

  /*
    一次把列表要用的东西全给出去：文本条目带全文、图片条目带缩略图。
    理由同 prompts:search——填入时不必再为每一条往返一次。
  */
  ipcMain.handle('clips:list', () =>
    listClips().map((c) => ({
      id: c.id,
      kind: c.kind,
      text: c.text,
      preview: c.kind === 'text' ? clipPreview(c.text) : '',
      thumbnail: c.thumbnail,
      width: c.width,
      height: c.height,
      copiedAt: c.copiedAt,
    })),
  );

  /*
    把历史里的图片放回系统剪贴板。

    图片没法走投递链路——win32 那条是「写剪贴板 → Ctrl+V → Enter」，
    web 那条是扩展往输入框塞文本，两条都只吃文本。所以这里只做到
    「放回剪贴板」，剩下的 Ctrl+V 由用户在目标窗口里自己按。
  */
  ipcMain.handle('clips:put-image', async (_e, id: string) => {
    const item = findClip(id);
    if (!item || item.kind !== 'image' || !item.imageFile) return false;
    const img = nativeImage.createFromPath(imagePath(item.imageFile));
    if (img.isEmpty()) {
      console.warn(`[剪贴板] 图片文件读不出来：${item.imageFile}`);
      return false;
    }
    // 静默窗口：这是本程序写的，不是用户复制的。
    await clipboardWatcher.suppress(async () => clipboard.writeImage(img));
    return true;
  });

  ipcMain.handle('clips:clear', () => {
    clearClips();
    inputWindow?.webContents.send('clips:changed');
  });

  /*
    输入条要容纳提示词列表时会变高。
    往哪个方向长取决于它这次是怎么摆的（贴悬浮标就得往上长），
    所以交给 windows.ts 处理，那儿才知道当前的摆法。
  */
  ipcMain.on('input:resize', (_e, height: number) => {
    if (inputWindow) resizeInputWindow(inputWindow, height);
  });

  // 点击悬浮标上的铅笔唤起输入条，这时贴着悬浮标弹出。
  ipcMain.on('pet:activate', () => {
    console.log('[IPC] 收到 pet:activate');
    showInput('pet');
  });

  /*
    展开按钮打开自定义的目标面板。
    早先用的是系统原生菜单，但那东西布局和配色全归系统管，
    既加不了图标，也显示不了「这个目标现在能不能用」。
  */
  ipcMain.on('pet:menu', () => showTargetPanel());

  ipcMain.on('basket:open', () => showBasket(true));
  ipcMain.on('basket:close', () => basketWindow?.hide());

  ipcMain.handle('basket:list', () => listBasketItems());

  ipcMain.handle('basket:add', async (_e, payload: {
    paths?: string[];
    images?: EmbeddedImage[];
    text?: string;
  }) => {
    const paths = Array.isArray(payload.paths) ? payload.paths.filter((p): p is string => typeof p === 'string') : [];
    const images = Array.isArray(payload.images) ? payload.images : [];
    let added = await addPathsToBasket(paths);
    added += await addImagesToBasket(images);

    // 文件拖放通常还会附送 text/uri-list；已经收下文件时不能再多造一份链接文本。
    if (added === 0 && typeof payload.text === 'string' && payload.text.trim()) {
      if (await addTextToBasket(payload.text.slice(0, 2_000_000))) added++;
    }
    if (added > 0) notifyBasketChanged();
    return { added, message: added === 0 ? '内容为空或无法读取' : undefined };
  });

  ipcMain.handle('basket:open-item', (_e, id: string) => openBasketItem(id));

  ipcMain.on('basket:drag-item', (event, id: string) => {
    const itemPath = resolveBasketItemSync(id);
    if (!itemPath) return;
    const dragIcon = nativeImage.createFromPath(itemPath);
    event.sender.startDrag({
      file: itemPath,
      icon: dragIcon.isEmpty() ? trayIconPath() : dragIcon.resize({ width: 64, height: 64 }),
    });
    // Windows 的默认操作可能把同卷文件移出篮子；拖放结束后按磁盘实况刷新。
    notifyBasketChanged();
  });

  ipcMain.on('basket:item-menu', (event, id: string) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const sender = event.sender;
    const menu = Menu.buildFromTemplate([
      { label: '打开', click: () => void openBasketItem(id) },
      {
        label: '复制',
        click: () => {
          void copyBasketItem(id)
            .then((ok) => {
              if (!sender.isDestroyed()) sender.send('basket:toast', ok ? '已复制' : '复制失败');
            })
            .catch((err) => {
              console.warn('[临时篮子] 复制失败：', err);
              if (!sender.isDestroyed()) sender.send('basket:toast', '复制失败');
            });
        },
      },
      { label: '在资源管理器中显示', click: () => void revealBasketItem(id) },
      { type: 'separator' },
      {
        label: '移到回收站',
        click: () => {
          void trashBasketItem(id).then((ok) => {
            if (ok) notifyBasketChanged();
          });
        },
      },
    ]);
    menu.popup({ window: owner });
  });

  ipcMain.on('panel:close', () => targetPanel?.hide());

  /*
    切换悬浮标的鼠标穿透。

    渲染层发现鼠标压到本体上就请求「可交互」，移开再请求「穿透」。
    不这么做的话，那片透明区域会一直挡着桌面点击；
    而一直穿透又会让胶囊上的按钮点不了——只能动态切。
  */
  /*
    渲染层上报本体在窗口内的位置。
    展开成胶囊还是收拢成小圆，可命中的区域差很多，所以尺寸一变就要重报。
  */
  ipcMain.on('pet:hit-rect', (_e, rect: HitRect) => {
    hoverTracker?.updateRect(rect);
  });

  /*
    面板加载完成后主动来要数据。
    先回一份「检测中」让它立刻能画出来，再异步把真实状态补上——
    检测桌面端要跨进程问助手，让用户对着空面板等几百毫秒不合适。
  */
  ipcMain.handle('panel:ready', async () => {
    const initial = { targets: pendingStatuses(), currentTargetIds };
    void refreshPanelStatuses();
    return initial;
  });
}

/**
 * 状态演示：用 XFB_DEMO=1 启动即可循环播放全部形态，不触发任何真实投递。
 * 调形态变换和圆环动画时不用真的去发消息，也方便截图比对。
 */
function startStateDemo(): void {
  /*
    三个探测档位各走一遍完整的「送出 → 生成 → 完成」。

    只演一档是不够的：庆祝动画的隆重程度是**按档位分**的
    （exact 撒花、approximate 收一档、coarse 只给一圈涟漪），
    单档演示看不出这套分档到底对不对，而这正是最需要肉眼比对的部分。
  */
  const round = (confidence: ProbeConfidence): PetState[] => [
    { ...INITIAL_PET_STATE, phase: 'sending', targetId: 'demo' },
    { ...INITIAL_PET_STATE, phase: 'thinking', targetId: 'demo', confidence },
    { ...INITIAL_PET_STATE, phase: 'done', targetId: 'demo', confidence, progress: 1 },
  ];

  const track = (
    targetId: string,
    phase: TrackState['phase'],
    confidence: ProbeConfidence | null,
  ): TrackState => ({
    targetId,
    phase,
    confidence,
    progress: null,
    elapsedMs: 0,
    errorMessage: phase === 'error' ? '没找到目标窗口' : null,
    revealable: phase !== 'sending' && phase !== 'error',
  });

  /*
    多轨帧走真的 aggregate，不手写聚合结果。

    手写的话，演示里的配色和庆祝可能完全正常，真实运行时却不是那么回事——
    而这个开关存在的意义就是把真实形态摆出来看。
  */
  const multi = (tracks: TrackState[]): PetState => ({
    ...INITIAL_PET_STATE,
    ...aggregate(tracks),
    targetId: tracks[0]?.targetId ?? null,
    tracks,
  });

  const a = 'chatgpt-classic';
  const b = 'gemini-desktop';

  const frames: PetState[] = [
    { ...INITIAL_PET_STATE },
    ...round('exact'),
    ...round('approximate'),
    ...round('coarse'),
    /*
      双轨一轮。第三帧（一半绿、一半还在呼吸）是这里最值得看的：
      分段环到底能不能一眼看出「一家已经好了、另一家还在写」，就看它。
      最后一帧是部分失败：一红一绿，整体仍然算 done。
    */
    multi([track(a, 'sending', null), track(b, 'sending', null)]),
    multi([track(a, 'thinking', 'approximate'), track(b, 'thinking', 'coarse')]),
    multi([track(a, 'done', 'approximate'), track(b, 'thinking', 'coarse')]),
    multi([track(a, 'done', 'approximate'), track(b, 'done', 'coarse')]),
    multi([track(a, 'done', 'approximate'), track(b, 'error', null)]),
    { ...INITIAL_PET_STATE, phase: 'error', errorMessage: '没找到目标窗口' },
  ];

  let i = 0;
  console.log('[演示模式] 每 3.5 秒切换一个状态，三个档位各走一轮，按 Ctrl+C 结束');
  setInterval(() => {
    const frame = frames[i % frames.length];
    i += 1;
    if (!frame) return;
    console.log(
      `[演示模式] ${frame.phase}${frame.confidence ? ` · ${frame.confidence}` : ''}` +
        (frame.tracks.length > 1 ? ` · ${frame.tracks.length} 轨` : ''),
    );
    /*
      演示帧是直接推给渲染层的，绕开了编排器，所以庆祝得在这儿手动过一道。
      不这么做的话 XFB_DEMO 就唯独演不了庆祝——而那正是现在最该用它调的东西。
    */
    maybeCelebrate(frame);
    petWindow?.webContents.send('pet:state', frame);
  }, 3_500);
}

/**
 * 剪贴板静默窗口自检：用 XFB_CLIPTEST=1 启动。
 *
 * 这条路径平时只有投递和「复制连接密钥」会走到，两者都要真实的目标应用
 * 或一次托盘点击才能触发，脚本驱动不了——而它恰恰是整个剪贴板功能里
 * 最容易悄悄坏掉的地方：坏了不报错，只是历史里多出几条你自己发的内容。
 *
 * 所以在这里两个方向都验一遍：静默里写的必须记不下，静默外写的必须记得下。
 * 只验前者的话，一个「什么都不记」的实现也能骗过测试。
 */
function startClipboardSuppressTest(): void {
  const inside = `静默窗口自检·不该出现·${Date.now()}`;
  const outside = `静默窗口自检·应该出现·${Date.now()}`;

  setTimeout(() => {
    void (async () => {
      console.log('[剪贴板自检] 第一步：在静默窗口里写剪贴板');
      await clipboardWatcher.suppress(async () => {
        clipboard.writeText(inside);
        // 模拟 deliver 的形态：静默里写两次（投递文本 + 恢复备份）。
        await new Promise((r) => setTimeout(r, 300));
        clipboard.writeText(`${inside}·第二次写`);
      });

      // 等静默收尾（SUPPRESS_SETTLE_MS）加两个轮询周期。
      await new Promise((r) => setTimeout(r, 2_000));

      console.log('[剪贴板自检] 第二步：在静默窗口外写剪贴板');
      clipboard.writeText(outside);
      await new Promise((r) => setTimeout(r, 2_000));

      const texts = listClips().map((c) => c.text);
      const leaked = texts.filter((t) => t.startsWith('静默窗口自检·不该出现'));
      const recorded = texts.some((t) => t === outside);
      console.log(
        `[剪贴板自检] 静默内写入泄漏 ${leaked.length} 条（应为 0）；静默外写入${recorded ? '已' : '未'}记录（应为已）`,
      );
      console.log(`[剪贴板自检] 结论：${leaked.length === 0 && recorded ? '通过' : '失败'}`);
    })();
  }, 4_000);
}

// 单实例：悬浮宠物跑两份没有意义，还会抢快捷键。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showInput());

  void app.whenReady().then(() => {
    petWindow = createPetWindow();
    inputWindow = createInputWindow();
    targetPanel = createTargetPanel();
    basketWindow = createBasketWindow();

    /*
      走亚克力的三扇窗口要单独去要一个圆角，见 applyRoundCorners。
      不 await：圆角晚几十毫秒设上没关系，两扇窗口这时都还没显示过。
    */
    void applyRoundCorners(inputWindow, '输入条');
    void applyRoundCorners(targetPanel, '目标面板');
    void applyRoundCorners(basketWindow, '临时篮子');

    /*
      把三个渲染窗口的 console 转发到主进程日志。
      没有这个，渲染层的报错完全是黑箱——脚本挂了也只会表现为
      「界面在，但什么都不响应」，极难定位。
    */
    for (const [name, win] of [
      ['悬浮标', petWindow],
      ['输入条', inputWindow],
      ['临时篮子', basketWindow],
    ] as const) {
      win.webContents.on('console-message', (_e, level, message, line, source) => {
        const tag = level >= 2 ? '错误' : '日志';
        const where = source ? ` (${source.split('/').pop()}:${line})` : '';
        console.log(`[${name}渲染层·${tag}] ${message}${where}`);
      });
    }

    /*
      鼠标命中跟踪：决定窗口何时可交互、何时让点击穿透到桌面。
      恢复可交互时**不能**再带 { forward: true }——那个选项只在 ignore 为 true
      时有意义，和 ignore: false 一起传会让调用不生效，表现为窗口永远穿透、
      胶囊按钮点不动，且毫无报错。
    */
    hoverTracker = trackHover(petWindow, (hovering) => {
      if (!petWindow || petWindow.isDestroyed()) return;
      if (hovering) petWindow.setIgnoreMouseEvents(false);
      else petWindow.setIgnoreMouseEvents(true, { forward: true });
      petWindow.webContents.send('pet:hover', hovering);
    });

    if (process.env['XFB_DEMO'] === '1') startStateDemo();

    /*
      自检投递：用 XFB_SELFTEST=<目标id> 启动，几秒后自动投递一条固定文本。
      绕开快捷键和键盘模拟，专门验证「投递 → 探测 → 圆环」这条主链路。
      文本内容固定且自带标识，方便在目标应用里辨认。
    */
    const selfTest = process.env['XFB_SELFTEST'];
    if (selfTest) {
      // 逗号分隔就能一次验多轨：`XFB_SELFTEST=chatgpt-classic,gemini-desktop`。
      // 分段圆环、win32 的串行排队、按最低档庆祝，全都只有多目标时才走得到。
      const ids = selfTest
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      setTimeout(() => {
        console.log(`[自检] 向 ${ids.join('、')} 投递一条测试消息`);
        void submitAndReport(ids, '悬浮标自检消息，请用一句话回复');
      }, 6_000);

      /*
        再加 XFB_REVEAL=1，生成完之后自动跳一次目标窗口。

        跟 XFB_CLIPTEST 是同一个理由：这条路平时只有用户亲手点绿环才走得到，
        脚本驱动不了；而它坏掉时不报错，只是点下去没反应。
        默认不开：跳转会抢前台，不该让普通自检顺手把用户的窗口抽走。
      */
      if (process.env['XFB_REVEAL'] === '1') {
        const off = orchestrator.onChange((state) => {
          if (state.phase !== 'done') return;
          off();
          void orchestrator.reveal().then((res) => {
            console.log(`[自检] 跳转结果：${res.ok ? '成功' : '失败'}${res.targetId ? ` → ${res.targetId}` : ''}`);
          });
        });
      }
    }

    // 起本地桥，供浏览器扩展连接（网页端目标靠它）。
    bridgeToken = loadOrCreateToken();
    bridge = new BridgeServer(bridgeToken);
    bridge.start();
    orchestrator.attachBridge(bridge);

    syncLaunchAtLogin();
    registerIpc();
    // 先注册快捷键：托盘菜单要显示实际生效的那个组合。
    registerHotkey();
    buildTray();

    // 提前把助手拉起来，省掉第一次投递时的冷启动延迟。
    void win32Helper.start().catch((err) => {
      console.error('助手进程启动失败：', err);
    });
    void startBasketShakeMonitor();

    if (process.env['XFB_BASKET_TEST'] === '1') {
      setTimeout(() => {
        void (async () => {
          const source = path.join(app.getPath('temp'), `xfb-basket-source-${process.pid}.txt`);
          try {
            await writeFile(source, '临时篮子路径复制自检', 'utf8');
            const textAdded = await addTextToBasket('临时篮子运行时自检');
            const pathAdded = (await addPathsToBasket([source])) === 1;
            const imageAdded = (await addImagesToBasket([{
              name: '自检图片.png',
              mimeType: 'image/png',
              base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            }])) === 1;
            const items = await listBasketItems();
            const passed = textAdded && pathAdded && imageAdded
              && items.some((item) => item.kind === 'text')
              && items.some((item) => item.kind === 'image');
            console.log(`[临时篮子自检] ${passed ? '通过' : '失败'}：文本/路径/图片落盘后共 ${items.length} 项`);
            notifyBasketChanged();
            showBasket(true);
          } finally {
            await unlink(source).catch(() => {});
          }
        })();
      }, 1_500);
    }

    /*
      剪贴板监视。放在助手之后启动——它靠助手拿剪贴板序列号来判断内容变没变，
      助手还没起来的话第一拍会白白走一次降级分支。
    */
    sweepOrphanImages();
    clipboardWatcher.onClip(() => {
      // 列表开着的时候能立刻看到刚复制的东西，不用关掉重开。
      inputWindow?.webContents.send('clips:changed');
      // 托盘那条「清空剪贴板历史（N 条）」的条数与灰不灰都要跟上。
      refreshTrayMenu?.();
    });
    clipboardWatcher.start();

    if (process.env['XFB_CLIPTEST'] === '1') startClipboardSuppressTest();
  });

  // 宠物是常驻应用，关掉窗口不等于退出。
  app.on('window-all-closed', () => {
    // 留空：仅靠托盘菜单退出。
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (shakePollTimer) clearInterval(shakePollTimer);
    hoverTracker?.stop();
    clipboardWatcher.stop();
    orchestrator.dispose();
    bridge?.dispose();
    win32Helper.dispose();
  });
}

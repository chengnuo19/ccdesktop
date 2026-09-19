/**
 * 把主进程日志复制一份到 userData/logs/。
 *
 * 打包版没有终端：从开始菜单双击启动时 stdout 无处可去，console 的内容
 * 全部被丢弃。而这个工具的故障几乎都是「不报错的静默失效」（见 README
 * 「踩过的坑」整节），排查的第一手线索正是那些 [快捷键] [投递] [探测]
 * 前缀的日志——偏偏在日常真正使用的那种启动方式下，一条都看不到。
 *
 * 所以这里只做一件事：原样复制。不改任何现有的 console 调用，
 * 也不替代终端输出——dev 模式下终端仍然是最顺手的。
 */

import { app, shell } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

/** 单个文件的上限。装得下几十次启动的完整记录，又不至于让排查时翻不动。 */
const MAX_BYTES = 1024 * 1024;
/** 目录里最多留几个文件。倒数第二个通常就是「上次跑坏的那一次」。 */
const KEEP = 3;

const LEVELS = ['log', 'warn', 'error', 'info', 'debug'] as const;
/** 只认自己生成的文件名，避免把用户放进这个目录的东西删掉。 */
const NAME_RE = /^main-\d{8}-\d{6}(-\d+)?\.log$/;

let dir = '';
let file = '';
let written = 0;
let enabled = false;

/** 日志目录。托盘菜单用它把文件夹开给用户——落了盘却找不到等于没落。 */
export function logsDir(): string {
  return dir || path.join(app.getPath('userData'), 'logs');
}

export async function openLogsDir(): Promise<void> {
  const target = logsDir();
  try {
    mkdirSync(target, { recursive: true });
  } catch {
    /* 开不出来下面那句会报，这里不必多说 */
  }
  const err = await shell.openPath(target);
  if (err) console.warn('[日志] 打开目录失败：', err);
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/**
 * 轮转靠换文件名，不靠把旧文件改名往后挪。
 *
 * 最初写的是常见的那套 main.log → main.1.log → main.2.log，在本机实测直接崩：
 *
 *   EXDEV: cross-device link not permitted, rename 'main.1.log' -> 'main.2.log'
 *
 * 同一个目录里也会报跨设备——Windows 上文件被 unlink 后会先进入
 * pending-delete，目录项还在，这时往这个名字上 rename，libuv 就报 EXDEV。
 * 而这条链一旦中途抛异常，日志系统会把自己整个关掉，**不留任何痕迹**：
 * 正是这份日志本来要帮忙排查的那种故障。
 *
 * 换成时间戳文件名之后，写入路径上只剩「创建」和「追加」，没有 rename；
 * 清理旧文件是独立的一步，失败最多是多留几个文件，绝不会影响记录。
 */
function stampedPath(d: Date): string {
  const base =
    `main-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  let candidate = path.join(dir, `${base}.log`);
  // 同一秒内轮转两次几乎不可能，但重名会让新文件接着旧的长，白轮转一次。
  for (let i = 2; existsSync(candidate); i++) candidate = path.join(dir, `${base}-${i}.log`);
  return candidate;
}

/** 按文件名排序就是按时间排序，这是用时间戳命名顺带换来的。 */
function mine(): string[] {
  return readdirSync(dir).filter((n) => NAME_RE.test(n)).sort();
}

/** 只留最新的 KEEP 个。逐个删，一个删不掉不耽误删下一个。 */
function sweep(): void {
  try {
    const files = mine();
    for (const name of files.slice(0, Math.max(0, files.length - KEEP))) {
      try {
        unlinkSync(path.join(dir, name));
      } catch {
        /* 被占用就下次再说，留着不影响任何事 */
      }
    }
  } catch {
    /* 连目录都读不了，也轮不到日志来操心 */
  }
}

/**
 * 同步写。
 *
 * 用 appendFileSync 而不是攥着一个 fd，是因为这份日志存在的全部理由就是排查
 * 「程序突然不见了」——那种时刻缓冲区里的最后几行正是关键，异步流会丢掉它们。
 * 每条一次 open/close 的开销在这里无所谓：日志全是事件驱动的（投递、快捷键、
 * 剪贴板变更），没有轮询打点，实测一次启动到就绪也才 2KB。
 *
 * 顺带还省掉了一类麻烦：句柄失效、写到一半被杀软锁住之类的瞬时故障，
 * 丢掉当前这一条就完事，下一条照常再试，不会让日志从此哑掉。
 */
function write(line: string): void {
  if (!enabled) return;
  try {
    const buf = Buffer.from(line, 'utf8');
    const rolled = written + buf.length > MAX_BYTES;
    if (rolled) {
      file = stampedPath(new Date());
      written = 0;
    }
    appendFileSync(file, buf);
    written += buf.length;
    // 清理放在写入之后：新文件要先真的存在，数出来的个数才对得上 KEEP。
    if (rolled) sweep();
  } catch {
    /* 这一条丢了就丢了，绝不能让写日志把程序带走 */
  }
}

function stamp(level: (typeof LEVELS)[number]): string {
  const d = new Date();
  // 本地时间而不是 ISO 的 UTC：这份日志是给人对着「我刚才按下快捷键那会儿」看的。
  const t =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  // log/info 占了绝大多数，给它们标级别只是噪音；warn/error 才需要一眼看见。
  return level === 'log' || level === 'info' ? `${t}  ` : `${t}  ${level.toUpperCase()} `;
}

/** 接着最近那个文件写；它已经满了才开新的。频繁重启不该刷出一堆碎文件。 */
function pickFile(): void {
  const files = mine();
  const last = files[files.length - 1];
  if (last) {
    const p = path.join(dir, last);
    const size = statSync(p).size;
    if (size < MAX_BYTES) {
      file = p;
      written = size;
      return;
    }
  }
  file = stampedPath(new Date());
  written = 0;
}

/**
 * 装上落盘这一路。
 *
 * **必须在 app.setName() 之后调用**：userData 的路径取决于应用名，
 * 早一步就会把日志写进 @xfb\desktop 那个嵌套目录里去。
 */
export function installFileLogging(): void {
  try {
    dir = path.join(app.getPath('userData'), 'logs');
    mkdirSync(dir, { recursive: true });
    pickFile();
    enabled = true;
  } catch (err) {
    enabled = false;
    console.warn('[日志] 落盘初始化失败，本次只输出到终端：', err);
    return;
  }

  for (const name of LEVELS) {
    // 这里拿到的 console 已经被 index.ts 包过一层 try/catch，
    // 所以 original 不会因为 stdout 断掉而抛；write 自己也吞干净了。
    const original = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      original(...args);
      write(stamp(name) + format(...args) + '\n');
    };
  }

  // 一行分隔。多次启动的日志会落在同一个文件里，没有这条就分不清从哪儿开始。
  console.log(`[日志] ——— 启动 ${app.getVersion()}${app.isPackaged ? '' : '（dev）'} ——— ${file}`);
  // 同上：等这条写完，新开的那个文件才存在。
  sweep();
}

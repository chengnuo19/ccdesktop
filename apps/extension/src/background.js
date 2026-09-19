/**
 * 扩展的后台服务：桌面主程序与网页之间的中继。
 *
 * 上行：连本地 WebSocket 桥，接主程序发来的投递请求，转给对应标签页的 content script。
 * 下行：把 content script 报上来的生成进度转发回主程序。
 *
 * 这里有两个 MV3 的硬约束，整个文件的写法都由它们决定：
 *
 * 1. service worker 空闲约 30 秒就会被回收，**内存状态随之全部丢失**。
 *    所以绝不能把「哪些标签页可用」记在内存里——那个 Map 在下次唤醒时必然是空的。
 *    一律用 chrome.tabs.query 现查，无状态才可靠。
 *
 * 2. WebSocket 也会随 service worker 一起断开。Chrome 116 起 WebSocket 收发会重置
 *    空闲计时器，所以主程序侧定期发心跳把它焐着；再加 alarms 定时兜底重连。
 */

// 与 packages/shared/src/protocol.ts 保持一致。
const BRIDGE_URL = 'ws://127.0.0.1:47615';
const AUTH_KEY = 'xfbToken';

/** 重连退避的上下限。 */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** 兜底检查周期（分钟）。alarms 的最小实际周期约为 1 分钟。 */
const KEEPALIVE_PERIOD_MIN = 1;

/**
 * 目标 → URL 匹配模式。
 * 必须和 adapters.js 里的站点判断保持一致，改一处就要改另一处。
 */
const TARGET_URLS = {
  'chatgpt-web': ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  'gemini-web': ['https://gemini.google.com/*'],
};

let socket = null;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;

function isOpen() {
  return socket && socket.readyState === WebSocket.OPEN;
}

async function getToken() {
  const stored = await chrome.storage.local.get(AUTH_KEY);
  return stored[AUTH_KEY] ?? '';
}

function send(msg) {
  if (!isOpen()) return false;
  socket.send(JSON.stringify(msg));
  return true;
}

/* ---------- 标签页查询（无状态） ---------- */

/** 现查某个目标当前开着哪些标签页。 */
async function queryTabs(targetId) {
  const patterns = TARGET_URLS[targetId];
  if (!patterns) return [];
  try {
    return await chrome.tabs.query({ url: patterns });
  } catch {
    return [];
  }
}

/** 现查所有当前可用的目标。 */
async function listAvailableTargets() {
  const available = [];
  for (const id of Object.keys(TARGET_URLS)) {
    const tabs = await queryTabs(id);
    if (tabs.length > 0) available.push(id);
  }
  return available;
}

/**
 * 挑一个标签页来接这条消息。
 * 优先用户正看着的那个，视觉上最合理；否则退而取第一个。
 */
async function pickTab(targetId) {
  const tabs = await queryTabs(targetId);
  if (tabs.length === 0) return null;
  const active = tabs.find((t) => t.active);
  return (active ?? tabs[0])?.id ?? null;
}

/**
 * 确保目标标签页里有活着的 content script。
 *
 * 扩展安装或重载之前就打开的页面，里面是没有 content script 的，而且不会自动补上——
 * 这会表现为「页面脚本没有响应」，逼用户手动刷新。这里先探一下，
 * 没响应就主动注入，用户无感。
 * content.js 自带幂等保护，即使多注入一次也不会重复注册监听器。
 */
async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ping-target' });
    return { ok: true }; // 已经在跑
  } catch {
    // 没响应，补注入
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/adapters.js', 'src/content.js'],
    });
    return { ok: true };
  } catch (err) {
    // 把真实原因带回主程序显示，否则只能看到一句笼统的「页面脚本没有响应」。
    const reason = String(err?.message ?? err);
    console.warn('[悬浮标] 注入 content script 失败：', reason);
    return { ok: false, reason };
  }
}

/** 把当前可用目标同步给主程序。必须带真实密钥，否则会被当作非法连接断开。 */
async function syncTargets() {
  if (!isOpen()) return;
  const token = await getToken();
  send({ type: 'ready', token, availableTargets: await listAvailableTargets() });
}

/* ---------- 连接 ---------- */

async function connect() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return;
  }

  const token = await getToken();
  if (!token) {
    // 没配密钥就不连，免得无意义地反复重试。用户在选项页填好后会触发重连。
    console.info('[悬浮标] 还没有配置连接密钥，请在扩展选项里填写。');
    return;
  }

  try {
    socket = new WebSocket(BRIDGE_URL);
  } catch (err) {
    console.warn('[悬浮标] 建立连接失败：', err);
    scheduleReconnect();
    return;
  }

  socket.addEventListener('open', () => {
    reconnectDelay = RECONNECT_MIN_MS;
    void syncTargets();
  });

  socket.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    void handleHostMessage(msg);
  });

  socket.addEventListener('close', () => {
    socket = null;
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    // close 事件随后一定会到，重连逻辑统一放在那里。
  });
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

/* ---------- 处理主程序发来的消息 ---------- */

async function handleHostMessage(msg) {
  switch (msg.type) {
    case 'hello':
      if (!msg.ok) console.warn('[悬浮标] 握手被拒绝：', msg.reason);
      return;

    case 'heartbeat':
      // 收到这条消息本身就已经重置了 service worker 的空闲计时器。
      // 顺手同步一次可用目标，省掉一轮往返。
      void syncTargets();
      return;

    case 'deliver': {
      const tabId = await pickTab(msg.targetId);
      if (tabId === null) {
        send({
          type: 'deliver-result',
          requestId: msg.requestId,
          ok: false,
          reason: '没有打开对应站点的标签页',
        });
        return;
      }
      // 页面可能是在扩展安装/重载之前打开的，那样它里面没有 content script。
      // 先确保脚本在位，用户就不用手动刷新页面。
      const injected = await ensureContentScript(tabId);
      if (!injected.ok) {
        send({
          type: 'deliver-result',
          requestId: msg.requestId,
          ok: false,
          reason: `注入页面脚本失败：${injected.reason}`,
        });
        return;
      }
      try {
        const res = await chrome.tabs.sendMessage(tabId, {
          type: 'deliver',
          requestId: msg.requestId,
          text: msg.text,
        });
        send({
          type: 'deliver-result',
          requestId: msg.requestId,
          ok: !!res?.ok,
          reason: res?.reason,
          // 把标签页带回去：生成完之后主程序要靠它跳回来给用户看回复。
          // 不能事后按 targetId 现查——那会儿用户可能又开了同站点的第二个
          // 标签页，现查会跳到一个跟这次投递毫无关系的页面上。
          tabId,
        });
      } catch {
        send({
          type: 'deliver-result',
          requestId: msg.requestId,
          ok: false,
          reason: '页面脚本没有响应，试试刷新该标签页',
        });
      }
      return;
    }

    case 'activate': {
      /*
        把标签页切到前台，用户点了绿环之后落在这里。

        两步都要做：tabs.update 选中标签，windows.update 把浏览器窗口本身
        提到前面——只做前者的话，Chrome 在后台时标签是切对了，但用户
        什么也看不见，还以为点了没反应。

        窗口那一步可能被系统的前台锁定挡下（和主程序抢前台是同一个机制），
        那时最多是任务栏图标闪一下。标签页反正已经切好了，不值得为此报错。
      */
      try {
        const tab = await chrome.tabs.update(msg.tabId, { active: true });
        if (tab?.windowId !== undefined) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        send({ type: 'activate-result', requestId: msg.requestId, ok: true });
      } catch (err) {
        send({
          type: 'activate-result',
          requestId: msg.requestId,
          ok: false,
          // 最常见的是标签页已经被关掉了（Chrome 报 "No tab with id"）。
          reason: String(err?.message ?? err),
        });
      }
      return;
    }

    case 'ping-target': {
      const tabId = await pickTab(msg.targetId);
      send({
        type: 'target-status',
        requestId: msg.requestId,
        targetId: msg.targetId,
        available: tabId !== null,
      });
      return;
    }

    default:
      return;
  }
}

/* ---------- 处理 content script 上来的消息 ---------- */

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'content-ready') {
    // 只当作「该同步一次了」的信号，可用目标仍然现查。
    void syncTargets();
    return false;
  }

  if (msg.type === 'progress') {
    send({
      type: 'progress',
      requestId: msg.requestId,
      phase: msg.phase,
      progress: msg.progress,
      confidence: msg.confidence,
    });
    return false;
  }

  return false;
});

// 标签页开关或跳转都可能改变可用目标，同步一次。
chrome.tabs.onRemoved.addListener(() => void syncTargets());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === 'complete' || changeInfo.url) void syncTargets();
});

/* ---------- 保活与启动 ---------- */

chrome.alarms.create('xfb-keepalive', { periodInMinutes: KEEPALIVE_PERIOD_MIN });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'xfb-keepalive') return;
  if (!isOpen()) void connect();
  else void syncTargets();
});

// 密钥改了立刻重连，用户不用手动重载扩展。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[AUTH_KEY]) {
    if (socket) socket.close();
    reconnectDelay = RECONNECT_MIN_MS;
    void connect();
  }
});

chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());

void connect();

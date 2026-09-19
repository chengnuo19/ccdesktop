/*
  假扮浏览器扩展，端到端验证「生成完跳回目标窗口」这条链路。

      node tools/fake-extension.js          # 另开一个终端，主程序要先跑起来

  配合 `XFB_SELFTEST=gemini-web XFB_REVEAL=1 pnpm dev` 用：
  主程序自检投递 → 这里假装送达并回报一个编出来的 tabId → 假装生成完成 →
  主程序应当拿着**同一个** tabId 发回一条 activate。

  为什么不用真扩展：真扩展会把测试消息真的发进你自己的对话里。而这条链路要验的是
  「tabId 有没有原样存下来、完成后会不会拿它发 activate」，跟页面里发了什么没关系。

  目标固定用 gemini-web：万一真扩展抢到了桥的连接（service worker 随时会重连），
  它只会回「没有打开对应站点的标签页」，不会往任何地方发消息。
*/
const path = require('path');
const fs = require('fs');

// ws 装在 apps/desktop 下（workspace 的依赖不在仓库根）。
const WebSocket = require(path.join(__dirname, '..', 'apps', 'desktop', 'node_modules', 'ws'));

const token = fs
  .readFileSync(path.join(process.env.APPDATA, 'XuanFuBiao', 'bridge-token.txt'), 'utf8')
  .trim();

/** 编出来的标签页号。主程序必须原样带回来，不能自己另找一个。 */
const FAKE_TAB = 424242;

/** 等多久收工。自检在主程序启动 6 秒后才投递，留够余量。 */
const GIVE_UP_MS = 26_000;

const seen = { deliver: false, activate: false, tabMatched: false };

function connect() {
  const ws = new WebSocket('ws://127.0.0.1:47615');

  ws.on('open', () => {
    console.log('[假扩展] 已连上，发握手');
    ws.send(
      JSON.stringify({
        type: 'ready',
        token,
        availableTargets: ['gemini-web', 'chatgpt-web'],
      }),
    );
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());

    if (msg.type === 'hello') {
      console.log(`[假扩展] 握手${msg.ok ? '成功' : '被拒：' + msg.reason}`);
      return;
    }

    if (msg.type === 'deliver') {
      seen.deliver = true;
      console.log(`[假扩展] 收到 deliver（${msg.targetId}），假装成功，回报 tabId=${FAKE_TAB}`);
      ws.send(
        JSON.stringify({
          type: 'deliver-result',
          requestId: msg.requestId,
          ok: true,
          tabId: FAKE_TAB,
        }),
      );
      // 隔一会儿再报完成，让状态真的走一遍 thinking → done。
      setTimeout(() => {
        console.log('[假扩展] 报告生成完成');
        ws.send(
          JSON.stringify({
            type: 'progress',
            requestId: msg.requestId,
            phase: 'done',
            progress: null,
            confidence: 'exact',
          }),
        );
      }, 2000);
      return;
    }

    if (msg.type === 'activate') {
      seen.activate = true;
      seen.tabMatched = msg.tabId === FAKE_TAB;
      console.log(
        `[假扩展] ★ 收到 activate，tabId=${msg.tabId}` +
          `（期望 ${FAKE_TAB}：${seen.tabMatched ? '一致' : '不一致'}）`,
      );
      ws.send(JSON.stringify({ type: 'activate-result', requestId: msg.requestId, ok: true }));
      return;
    }
  });

  ws.on('error', (err) => {
    // 主程序可能还没起来，等一下再试。
    console.log(`[假扩展] 连不上（${err.message}），800ms 后重试`);
    setTimeout(connect, 800);
  });
}

connect();

setTimeout(() => {
  console.log('===== 结果 =====');
  console.log(`收到 deliver ：${seen.deliver}`);
  console.log(`收到 activate：${seen.activate}`);
  console.log(`tabId 一致   ：${seen.tabMatched}`);
  process.exit(seen.deliver && seen.activate && seen.tabMatched ? 0 : 1);
}, GIVE_UP_MS);

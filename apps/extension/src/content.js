/**
 * 注入到 ChatGPT / Gemini 页面里的脚本。
 *
 * 两件事：
 *   1. 收到投递请求时，把文本填进输入框并发送；
 *   2. 盯着「停止生成」按钮，把开始和结束如实回报给 background。
 *
 * 关于进度：网页端能精确知道生成「何时结束」（停止按钮消失），
 * 但算不出「完成了百分之多少」——因为不知道回复总长。
 * 所以这里只报阶段，不报比例，绝不编造百分比。
 *
 * 整个文件包在 IIFE 里，不能用顶层 const：
 * 页面若是在扩展安装/重载之前打开的，里面没有 content script，
 * background 会用 scripting.executeScript 补注入本文件；
 * 而注入进的是同一个全局作用域——顶层 const 第二次声明会直接抛
 * 「Identifier has already been declared」，整个脚本作废，
 * 表现出来就是怎么也修不好的「页面脚本没有响应」。
 */

(() => {
  // 幂等：已经在跑就直接退出，避免重复注册监听器导致一条投递被处理多次。
  if (window.__xfbContentLoaded) {
    console.info('[悬浮标] content script 已在运行，跳过重复注入');
    return;
  }

  /*
    adapters.js 在 manifest 的 js 数组里排在本文件之前，正常情况下一定已经执行。
    但万一没有（加载出错、顺序被改），直接解构会抛异常并让整个脚本死掉，
    表现出来就是「页面脚本没有响应」这种难查的症状。所以这里显式兜一下底。
  */
  const xfbAdapters = window.__xfbAdapters;
  if (!xfbAdapters) {
    console.error('[悬浮标] adapters.js 未先行加载，网页端功能不可用');
    return;
  }

  const { resolveAdapter, pick } = xfbAdapters;
  const adapter = resolveAdapter();

  /** 探测轮询间隔。停止按钮的出现/消失不需要更快的分辨率。 */
  const POLL_MS = 300;

  /**
   * 发出去之后等多久才开始认「停止按钮消失 == 结束」。
   * 请求刚发出时按钮还没出现，这段时间内的「没有停止按钮」
   * 不能当作已经结束，否则会立刻误判完成。
   */
  const START_GRACE_MS = 6_000;

  /** 填完文本到点发送之间的间隔，留给前端框架更新按钮状态。 */
  const SETTLE_MS = 120;

  /* ---------- 往输入框里填字 ---------- */

  /**
   * 把文本写进输入框。
   *
   * ChatGPT 和 Gemini 都用富文本编辑器（ProseMirror / Quill），
   * 直接改 textContent 不会触发框架的内部状态更新，发出去会是空的。
   * execCommand('insertText') 虽然标记为废弃，却是目前唯一能让这两个
   * 编辑器正确接收程序化输入的办法——它走的是浏览器真实的编辑管线。
   */
  function fillInput(el, text) {
    el.focus();

    if (el.isContentEditable) {
      // 先清空已有内容，避免和用户之前的草稿拼在一起。
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      const ok = document.execCommand('insertText', false, text);
      if (!ok) {
        // 兜底：某些环境禁用了 execCommand。这条路不保证能触发框架更新，
        // 但总比什么都不做强。
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      }
      return true;
    }

    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      // React 给 value 装了自己的 setter，必须用原型上的原生 setter 绕过去，
      // 否则 React 察觉不到变化，state 还是空的。
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
      if (setter) setter.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    return false;
  }

  /** 点发送。按钮点不动就退回敲回车。 */
  function submitPrompt(el) {
    const btn = pick(adapter.send);
    if (btn) {
      btn.click();
      return true;
    }
    // 没找到发送按钮时的兜底：多数站点的输入框都认回车。
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }),
    );
    return true;
  }

  /* ---------- 生成状态探测 ---------- */

  let watchTimer = null;

  function stopWatching() {
    if (watchTimer !== null) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
  }

  /**
   * 盯着停止按钮，判断这一轮生成何时结束。
   * 结束或超时后自动收尾，不会一直跑下去。
   */
  function watchGeneration(requestId) {
    stopWatching();

    const startedAt = Date.now();
    let everSawStop = false;

    const report = (phase) => {
      chrome.runtime.sendMessage({
        type: 'progress',
        requestId,
        phase,
        progress: null, // 只报阶段，不编造比例
        confidence: 'exact',
      });
    };

    report('thinking');

    watchTimer = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const streaming = !!pick(adapter.stop);

      if (streaming) {
        everSawStop = true;
        return;
      }

      // 见过停止按钮又消失了 —— 这是最可靠的结束信号。
      if (everSawStop) {
        stopWatching();
        report('done');
        return;
      }

      // 一直没见过停止按钮：宽限期内继续等，超过就认为这轮已经结束
      // （可能回复很短，按钮一闪而过没被采样到）。
      if (elapsed > START_GRACE_MS) {
        stopWatching();
        report('done');
      }
    }, POLL_MS);
  }

  /**
   * 用一行字概括页面当前长什么样，供选择器失配时排查。
   * 只统计数量和可见性，不读取任何对话内容。
   */
  function describePage() {
    const count = (sel) => document.querySelectorAll(sel).length;
    const editables = [...document.querySelectorAll('[contenteditable="true"]')];
    const visibleEditable = editables.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).length;
    return [
      `path=${location.pathname}`,
      `#prompt-textarea=${count('#prompt-textarea')}`,
      `contenteditable=${editables.length}(可见${visibleEditable})`,
      `textarea=${count('textarea')}`,
      `发送键=${count('button[data-testid="send-button"]')}`,
      `就绪=${document.readyState}`,
    ].join(' ');
  }

  /* ---------- 与 background 通信 ---------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!adapter) {
      sendResponse({ ok: false, reason: '当前页面不是受支持的目标站点' });
      return false;
    }

    if (msg.type === 'deliver') {
      const input = pick(adapter.input);
      if (!input) {
        // 附上页面实况，否则「没找到输入框」这句话对排查毫无帮助：
        // 分不清是站点改版、页面没加载完，还是压根不在对话界面。
        sendResponse({ ok: false, reason: `没找到输入框 · ${describePage()}` });
        return false;
      }

      if (!fillInput(input, msg.text)) {
        sendResponse({ ok: false, reason: '无法写入输入框' });
        return false;
      }

      // 等前端把内容吃进去、发送按钮变为可用，再点。
      setTimeout(() => {
        submitPrompt(input);
        watchGeneration(msg.requestId);
      }, SETTLE_MS);

      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'ping-target') {
      sendResponse({ ok: true, targetId: adapter.id, available: !!pick(adapter.input) });
      return false;
    }

    return false;
  });

  // 监听器已装好，这时才置标志：反过来的话，一旦上面抛异常，
  // 标志已被置位，之后每次补注入都会直接 return，再也自愈不了。
  window.__xfbContentLoaded = true;

  /*
    启动自检。站点改版时选择器会失配，这条日志能在页面控制台里
    一眼区分「脚本没注入」和「注入了但找不到输入框」。
  */
  if (adapter) {
    const hasInput = !!pick(adapter.input);
    const hasSend = !!pick(adapter.send);
    console.info(
      `[悬浮标] 已注入 · 目标=${adapter.id} · 输入框=${hasInput ? '✓' : '✗ 未找到'} · 发送键=${hasSend ? '✓' : '✗ 未找到'}`,
    );
    if (!hasInput) {
      console.warn('[悬浮标] 没找到输入框，站点可能已改版：请更新 adapters.js 里的选择器');
    }
    // 让 background 知道这个标签页能接哪个目标。
    chrome.runtime.sendMessage({ type: 'content-ready', targetId: adapter.id });
  } else {
    console.info('[悬浮标] 当前站点不在支持列表内');
  }
})();

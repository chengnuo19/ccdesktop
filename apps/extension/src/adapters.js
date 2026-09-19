/**
 * 站点适配器。
 *
 * 这是整个扩展里最容易因为站点改版而失效的部分，所以全部集中在这一个文件：
 * ChatGPT 或 Gemini 改了 DOM，只需要改这里的选择器，别处一律不用动。
 *
 * 每一项都给了多个候选，按顺序匹配，命中第一个就用。
 * 这样官方小改版（比如换掉某个 data-testid）不至于直接把功能打死。
 *
 * 整个文件包在 IIFE 里，不能用顶层 const：
 * background 会在需要时用 scripting.executeScript 重复注入本文件，
 * 而注入进的是同一个全局作用域——顶层 const 第二次声明会直接抛
 * 「Identifier has already been declared」，整个脚本作废。
 */

(() => {
  const ADAPTERS = [
    {
      id: 'chatgpt-web',
      label: 'ChatGPT（网页端）',
      match: (host) => host === 'chatgpt.com' || host === 'chat.openai.com',
      // 输入区。新版是 ProseMirror 富文本，老版是 textarea，两种都要认。
      input: [
        '#prompt-textarea',
        'div[contenteditable="true"][id="prompt-textarea"]',
        'form div[contenteditable="true"]',
        'textarea[data-id]',
        'textarea',
      ],
      send: [
        'button[data-testid="send-button"]',
        'button[aria-label*="发送"]',
        'button[aria-label*="Send prompt"]',
        'form button[type="submit"]',
      ],
      // 停止按钮存在 == 正在生成。这是判断进度最可靠的信号。
      stop: [
        'button[data-testid="stop-button"]',
        'button[aria-label*="停止"]',
        'button[aria-label*="Stop generating"]',
        'button[aria-label*="Stop streaming"]',
      ],
    },
    {
      id: 'gemini-web',
      label: 'Gemini（网页端）',
      match: (host) => host === 'gemini.google.com',
      // Gemini 用 Quill 编辑器。
      input: [
        'rich-textarea div.ql-editor[contenteditable="true"]',
        'div.ql-editor[contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"]',
      ],
      send: [
        'button.send-button',
        'button[aria-label*="发送"]',
        'button[aria-label*="Send message"]',
        'button[aria-label*="Submit"]',
      ],
      stop: [
        'button.send-button.stop',
        'button[aria-label*="停止"]',
        'button[aria-label*="Stop response"]',
        'button[aria-label*="Stop generating"]',
      ],
    },
  ];

  /** 找出当前页面对应的适配器；不是目标站点就返回 null。 */
  function resolveAdapter(host = location.hostname) {
    return ADAPTERS.find((a) => a.match(host)) ?? null;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.hasAttribute('disabled')) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  /**
   * 按候选顺序找第一个真正可用的元素。
   * 隐藏元素（占位的、离屏的）一律跳过，否则会往看不见的框里打字。
   */
  function pick(selectors) {
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (isVisible(el)) return el;
      }
    }
    return null;
  }

  // content.js 是同一 content script 世界里的另一个文件，通过 window 共享。
  window.__xfbAdapters = { ADAPTERS, resolveAdapter, pick, isVisible };
})();

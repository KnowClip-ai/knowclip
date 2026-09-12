import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// 全局错误捕获：防止未处理异常导致整个窗口空白
window.onerror = (message, source, lineno, colno, error) => {
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML = `<div style="color:red;padding:20px;font-family:sans-serif;">
      <h2>⚠️ 应用发生错误</h2>
      <pre style="background:#1a1a1a;padding:12px;border-radius:6px;overflow:auto;">
Error: ${message}
 at ${source}:${lineno}:${colno}
${error?.stack || ''}
      </pre>
    </div>`;
  }
  return false;
};
window.onunhandledrejection = (event) => {
  const reasonStr = String(event.reason);
  const stack = event.reason?.stack || '';
  if (stack.includes('user-script') || reasonStr.includes('user-script') || reasonStr.includes('dialog.confirm')) {
    // 浏览器扩展/注入脚本产生的无关错误，静默忽略
    return;
  }
  // 浏览器预览（Simple Browser / localhost:1420）没有 Tauri API，忽略此类错误
  if (
    reasonStr.includes("'invoke'") ||
    reasonStr.includes('__TAURI') ||
    reasonStr.includes('__TAURI_INTERNALS__')
  ) {
    console.warn('[Global] Ignored non-Tauri environment error. 请使用弹出的「KnowClip」桌面窗口，而非 IDE 内嵌浏览器。');
    event.preventDefault();
    return;
  }
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML = `<div style="color:red;padding:20px;font-family:sans-serif;">
      <h2>⚠️ 应用发生异步错误</h2>
      <pre style="background:#1a1a1a;padding:12px;border-radius:6px;overflow:auto;">
Unhandled Promise: ${event.reason}
${stack}
      </pre>
    </div>`;
  }
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />
);

# KnowClip 前端（Tauri 2 + React + Vite）

开发：

```bash
npm install
npm run tauri dev      # 需先启动后端：cd ../backend && python api_server.py
npm run build          # TS 检查 + Vite 产物
```

后端固定地址 `http://127.0.0.1:8000`（见 `src/` 内各 fetch 调用）。

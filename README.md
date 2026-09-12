<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="desktop-app/public/icon.png" width="96"/>
    <img src="desktop-app/public/logo.png" width="260" alt="KnowClip 智能剪辑"/>
  </picture>
</div>

# KnowClip 智能剪辑

**KnowClip AI 智能剪辑**的开源核心（Tauri 2 + React + Python FastAPI）。

给一个几小时的长视频（课程 / 访谈 / 直播回放 / 播客），KnowClip 用本地 Paraformer 模型转出
带字级时间戳的语音识别结果，交给 LLM 分析出多个适合发短视频平台的精彩片段（含标题、描述、
话题标签、评分），你在片段卡片上勾选后批量导出——ffmpeg 流复制，不解码不编码，速度最快。

```
选择视频 → 本地 ASR（Paraformer-large，字级时间戳）
        → LLM 精彩分析（你自己的 API Key，任何 OpenAI 兼容接口）
        → 片段卡片预览
        → 批量导出（ffmpeg -c copy）
```

- **隐私**：视频素材不出本机，ASR 识别完全在本地运行
- **低成本**：唯一花钱的是你自己的 LLM API Key，用多少花多少
- **快**：导出走 ffmpeg 流复制，以毫秒级导出视频片段

[English](#english) · 完整版官网 <https://knowclip.cn>

## 环境要求

- macOS (Apple Silicon / Intel) 或 Windows
- Python 3.10+、Node.js 18+、Rust toolchain（Tauri 2）
- **ffmpeg / ffprobe**（加入 PATH）：`brew install ffmpeg` 或 `winget install ffmpeg`

## 快速开始

```bash
./start-dev.sh
```

一键脚本会自动完成：创建 Python 虚拟环境 → 安装后端依赖 → 安装前端依赖 → 启动后端（127.0.0.1:8000）与桌面窗口。退出时按 `Ctrl+C` 同时关闭前后端。

<details>
<summary>手动分步启动（可选）</summary>

```bash
# 1. 后端
cd backend
pip install -r requirements.txt
python api_server.py            # 监听 127.0.0.1:8000

# 2. 前端（另开一个终端）
cd desktop-app
npm install
npm run tauri dev
```

</details>

首次识别会自动从 ModelScope 下载 Paraformer 模型（约 1GB，缓存在 `~/.cache/modelscope`），之后直接复用。

## LLM 设置

在应用内设置面板填写（OpenAI 兼容三件套）：

| 项 | 说明 |
|---|---|
| API Key | 必填 |
| Base URL | 已预填 DeepSeek 官方地址（OpenAI 兼容格式）；改用 Kimi / GLM / OpenAI 及自建服务时直接改写 |
| 模型名 | 点「获取模型列表」后从下拉框选择（自动拉取该服务支持的模型） |

填好地址和 Key 后，点「获取模型列表」自动拉取该服务的可用模型，在面板外部的下拉框中选择即可。

内置提示词可在面板中修改，输出为自由文本，对模型无格式要求。

## 仓库结构

```
backend/                  Python FastAPI 后端（本地 ASR + LLM 代理 + 批量导出）
├── api_server.py         服务入口（127.0.0.1:8000）
└── asr_core.py           funasr Paraformer 封装（含 VAD 分段，启动后台加载常驻 / MPS·CUDA·CPU 自适应）
desktop-app/              Tauri 2 + React 前端
├── src/hooks/useProjectRecognizer.ts   ASR 任务编排（提取音频 → 提交 → WebSocket 进度）
├── src/hooks/useAutoInference.ts       LLM 流式解析
└── src/utils/subtitleSearch.ts         片段边界文本定位算法
desktop-app/src-tauri/    Rust 壳（本地媒体流服务器，支持 Range 流式播放）
```

## 关于本仓库

本仓库是 KnowClip 的开源版本，**目的是给大家学习参考**一条完整链路的实现：
本地语音识别 → LLM 挑选精彩片段 → 批量导出。

为了让代码更好读、更好理解，我们把主链路之外的功能都去除了：

- **不包含画面加工** — 字幕烧录、贴纸、滤镜、竖屏、BGM 等均已精简
- **无账号、无内置计费** — ASR 本地运行，LLM 用你自己的 Key

> [!NOTE]
> 导出使用 ffmpeg `-c copy` 流复制，切割点会吸附到关键帧，片段开头可能多出零点几秒内容——这是换取极速导出的固有权衡。
> 后端仅监听本机 127.0.0.1 且无鉴权，仅供本机使用，请勿将端口暴露到公网。

需要完整功能请使用 [KnowClip 完整版](https://knowclip.cn)。

## 开发故事

做这个工具的路上踩了不少坑。我把选型过程、踩过的坑和取舍，写成了一系列文章，见 [docs/articles/](./docs/articles/)。

## License

AGPL-3.0（名称与 logo 为商标，AGPL 授权不含商标使用权，详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)，其中亦列明 ASR 模型等第三方组件许可）。

---

<a id="english"></a>
<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="desktop-app/public/icon.png" width="96"/>
    <img src="desktop-app/public/logo.png" width="260" alt="KnowClip"/>
  </picture>
</div>

# KnowClip

The open-source core of **KnowClip AI** (Tauri 2 + React + Python FastAPI):

```
Pick a long video → on-device ASR (Paraformer-large, word-level timestamps)
                  → LLM picks highlight segments (bring your own API key)
                  → preview clip cards → batch export via ffmpeg stream copy
```

- **Private**: video footage never leaves your machine; ASR runs fully locally.
- **Cheap**: the only cost is your own LLM API key.
- **Fast**: exports use ffmpeg stream copy — clips export in milliseconds.

## Quick start

```bash
./start-dev.sh
```

The script bootstraps everything on first run (Python venv, backend & frontend deps),
then starts the backend (127.0.0.1:8000) and the desktop window. Press `Ctrl+C` to stop both.

The Paraformer model (~1GB) downloads automatically from ModelScope on first run.

Requirements: Python 3.10+, Node 18+, Rust toolchain, ffmpeg on PATH.
The Paraformer model (~1GB) downloads automatically from ModelScope on first run.

Any OpenAI-compatible endpoint works in the settings panel —
DeepSeek / Kimi / GLM / OpenAI and self-hosted servers all fine.

## About this repo

This repo is the open-source version of KnowClip, published as a **learning reference** — it shows one complete pipeline end to end: local speech recognition → LLM highlight picking → batch export.

To keep the code easy to read and understand, everything outside this main pipeline was stripped:

- **No rendering pipeline** — subtitle burning, stickers, filters, vertical reframing, and BGM are all removed
- **No account, no built-in billing** — local ASR; bring your own LLM key

Need the full toolbox? [KnowClip](https://knowclip.cn)

License: AGPL-3.0. The KnowClip name and logo are trademarks not licensed under the AGPL — see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

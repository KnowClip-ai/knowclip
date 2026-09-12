# 第三方声明 / Third-Party Notices

本仓库依赖以下第三方开源组件，谨此致谢。

## 本地 ASR 模型（运行时自动下载，不随本仓库分发）

首次识别时从 [ModelScope](https://modelscope.cn) 自动下载以下模型权重：

| 组件 | 用途 | 许可证 | 版权 |
|---|---|---|---|
| [Paraformer-large（VAD+标点联合）](https://modelscope.cn/models/iic/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch) | 中文语音识别（字级时间戳） | Apache-2.0 | Alibaba DAMO Academy |
| [FSMN-VAD](https://modelscope.cn/models/iic/speech_fsmn_vad_zh-cn-16k-common-pytorch) | 语音活动检测 | Apache-2.0 | Alibaba DAMO Academy |
| [CT-Transformer 标点](https://modelscope.cn/models/iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch) | 标点恢复 | Apache-2.0 | Alibaba DAMO Academy |

## 开源软件

| 组件 | 用途 | 许可证 |
|---|---|---|
| [FunASR](https://github.com/modelscope/FunASR) | ASR 推理框架 | MIT |
| [Tauri](https://tauri.app) | 桌面应用框架 | MIT / Apache-2.0 |
| [React](https://react.dev) / [Vite](https://vite.dev) | 前端框架 / 构建 | MIT |
| [FastAPI](https://fastapi.tiangolo.com) / [Uvicorn](https://www.uvicorn.org) | 后端框架 / ASGI 服务器 | MIT / BSD-3 |
| [PyTorch](https://pytorch.org) | 深度学习运行时 | BSD-3 |
| [FFmpeg](https://ffmpeg.org) | 音视频处理（需用户自行安装） | LGPL-2.1 / GPL（视构建配置） |

## 商标说明

"KnowClip"、"KnowClip AI"、"KnowClip 智能剪辑" 名称及本项目中的 logo
为本项目所有者的商标。AGPL-3.0 许可证授予的是代码版权相关权利，
**不包含对上述商标的使用授权**——再分发时如保留或使用相关名称与标识，
须确保不造成来源、赞助或背书的混淆。

## 说明

- 以上模型权重与软件均**不随本仓库分发**，由用户安装依赖或首次运行时按各自许可证获取。
- 各组件的许可证全文以官方仓库为准。
- 本项目自身代码以 [AGPL-3.0](./LICENSE) 许可。

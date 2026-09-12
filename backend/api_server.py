# -*- coding: utf-8 -*-
# api_server.py - 带实时进度推送的字幕识别服务

import asyncio
import json
import os
import re
import time
import uuid
from datetime import datetime
from typing import Dict, List, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
from fastapi.responses import StreamingResponse
# 假设你的 asr_core 有这两个函数，如果没有 progress_callback 支持，见下方的修改建议
from asr_core import (
    process_audio_file,
    get_audio_duration_ms,  # 需要你实现，获取音频总毫秒数
    ensure_model_loaded,
    warmup_async,
    actual_gpu_type
)

app = FastAPI(
    title="KnowClip API",
    description="支持WebSocket实时进度推送和取消功能",
    version="2.0.0"
)


def cleanup_temp_uploads(max_age_days: int = 7) -> None:
    """清理超过 max_age_days 的临时文件。"""
    # temp_uploads/ 目录已不再使用（预览视频已改到前端 appDataDir/preview/）
    # 保留函数占位，若将来有其他临时文件需求可在此扩展
    pass


@app.on_event("startup")
async def _on_startup() -> None:
    cleanup_temp_uploads(max_age_days=7)
    # 启动即在后台加载 ASR 模型并常驻内存（约 30-60 秒，不阻塞端口监听）
    warmup_async()


# CORS 配置（允许Tauri前端访问）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 生产环境建议改为 tauri://localhost
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ========== 任务管理器 ==========
class RecognitionTask:
    def __init__(self, file_path: str):
        self.task_id = str(uuid.uuid4())
        self.file_path = file_path
        self.cancel_event = asyncio.Event()
        self.start_time = time.time()
        self.total_ms = 0
        self.processed_ms = 0
        self.websockets: list[WebSocket] = []
        self.result_data = None
        self.error_msg = None
        self.is_complete = False

    async def broadcast(self, message: dict):
        """向所有连接的WebSocket推送消息"""
        dead_ws = []
        for ws in self.websockets:
            try:
                await ws.send_json(message)
            except:
                dead_ws.append(ws)

        # 清理断开的连接
        for ws in dead_ws:
            if ws in self.websockets:
                self.websockets.remove(ws)


# 全局任务存储
tasks: Dict[str, RecognitionTask] = {}


# ========== 数据模型 ==========
class RecognizeRequest(BaseModel):
    file_path: str
    device: str = "GPU"
    min_repeat: int = 2
    time_gap: float = 0.3




@app.post("/video_info")
async def video_info_endpoint(request: Request):
    """获取视频基本信息（时长、分辨率等）"""
    try:
        body = await request.json()
        video_path = body.get("video_path")
        if not video_path or not os.path.exists(video_path):
            return {"success": False, "error": "文件不存在"}
        duration = get_video_duration(video_path)
        width, height = await _probe_video_size(video_path)
        return {
            "success": True,
            "duration": duration,
            "width": width,
            "height": height,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


@app.post("/recognize")
async def recognize_endpoint(request: RecognizeRequest):
    """
    启动识别任务，立即返回 task_id，通过 WebSocket /ws/{task_id} 接收进度
    """
    if not os.path.exists(request.file_path):
        return {"success": False, "error": "文件不存在"}

    # 创建任务
    task = RecognitionTask(request.file_path)
    tasks[task.task_id] = task

    # 启动后台任务（不等待完成）
    asyncio.create_task(run_recognition(
        task,
        request.device,
        request.min_repeat,
        request.time_gap
    ))

    return {
        "success": True,
        "task_id": task.task_id,
        "message": "识别任务已启动"
    }


@app.websocket("/ws/{task_id}")
async def websocket_endpoint(websocket: WebSocket, task_id: str):
    """
    WebSocket 实时进度推送端点
    前端连接后，会自动收到进度更新
    发送 "cancel" 字符串可取消任务
    """
    await websocket.accept()

    if task_id not in tasks:
        await websocket.send_json({"type": "error", "error": "任务不存在或已过期"})
        await websocket.close()
        return

    task = tasks[task_id]
    task.websockets.append(websocket)

    # 立即发送当前状态
    if task.is_complete:
        await websocket.send_json({"type": "complete", "data": task.result_data})
    elif task.error_msg:
        await websocket.send_json({"type": "error", "error": task.error_msg})
    else:
        await websocket.send_json({
            "type": "connected",
            "current_percent": int((task.processed_ms / task.total_ms * 100)) if task.total_ms > 0 else 0
        })

    try:
        while True:
            # 接收前端指令（主要是取消命令）
            data = await websocket.receive_text()

            if data == "cancel":
                task.cancel_event.set()
                await websocket.send_json({"type": "cancelling", "message": "正在取消识别..."})
                break

    except WebSocketDisconnect:
        pass
    finally:
        if websocket in task.websockets:
            task.websockets.remove(websocket)


@app.get("/")
def read_root():
    return {"message": "字幕识别服务运行中（支持实时进度）", "status": "ok"}


@app.get("/check")
def check_status():
    from asr_core import has_gpu, actual_gpu_type, current_device
    return {
        "gpu_available": has_gpu,
        "gpu_type": actual_gpu_type,
        "current_device": current_device,
        "websocket_support": True
    }


# ========== 视频剪辑模块 ==========
import tempfile
import subprocess
import hashlib
from pathlib import Path


def get_video_real_size(video_path: str) -> tuple:
    """使用 ffprobe 获取视频真实尺寸（考虑 SAR 像素宽高比）"""
    try:
        cmd = [
            'ffprobe',
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height,sample_aspect_ratio',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            video_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        lines = result.stdout.strip().split('\n')

        w = int(lines[0]) if len(lines) > 0 else 1920
        h = int(lines[1]) if len(lines) > 1 else 1080
        sar_str = lines[2] if len(lines) > 2 else '1:1'

        print(f"[DEBUG] ffprobe 原始读取: {w}x{h}, SAR={sar_str}")

        # 解析 SAR 并计算实际显示尺寸
        if sar_str and ':' in sar_str:
            try:
                sar_num, sar_den = map(int, sar_str.split(':'))
                # 实际显示宽度 = 存储宽度 × (SAR分子 / SAR分母)
                # 实际显示高度 = 存储高度（通常 SAR 只影响宽度）
                real_w = int(w * sar_num / sar_den)
                real_h = h
                print(f"[DEBUG] SAR 修正后尺寸: {real_w}x{real_h}")
                return (real_w, real_h)
            except:
                pass

        return (w, h)
    except Exception as e:
        print(f"[WARNING] 获取视频尺寸失败: {e}，使用默认值")
        return (1920, 1080)

def check_ffmpeg():
    """检查FFmpeg是否可用"""
    try:
        result = subprocess.run(
            ['ffmpeg', '-version'],
            capture_output=True,
            text=True,
            timeout=10
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False

def get_video_duration(video_path: str) -> float:
    """获取视频总时长（秒）"""
    try:
        cmd = [
            'ffprobe',
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            video_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return float(result.stdout.strip())
    except:
        return 0


class BatchClipTask:
    """批量剪辑任务（会话保持模式）"""
    def __init__(self, video_path: str, clips: list, output_dir: Optional[str] = None, project_name: Optional[str] = None):
        self.task_id = str(uuid.uuid4())
        self.video_path = video_path
        self.clips = clips  # List[ClipMeta]
        self.output_dir = output_dir
        self.project_name = project_name
        self.actual_output_dir = None
        self.cancel_event = asyncio.Event()
        self.start_time = time.time()
        self.websockets: list[WebSocket] = []
        self.is_complete = False
        self.error_msg = None
        self.current_index = 0  # 当前正在处理的索引
        self.completed_files: list[dict] = []  # 已完成的文件信息
        self.failed_files: list[dict] = []   # 失败的文件信息

    async def broadcast(self, message: dict):
        """向所有连接的WebSocket推送消息"""
        dead_ws = []
        for ws in self.websockets:
            try:
                await ws.send_json(message)
            except:
                dead_ws.append(ws)

        for ws in dead_ws:
            if ws in self.websockets:
                self.websockets.remove(ws)

    def get_sanitized_title(self, title: str) -> str:
        """生成安全的文件名"""
        import unicodedata
        # 1. 过滤 ASCII 控制字符
        safe = ''.join(c for c in title if unicodedata.category(c)[0] != 'C')
        # 2. 过滤 Windows/macOS 不安全的可见字符
        safe = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', safe)
        # 3. 去掉首尾空格和点（Windows 不允许）
        safe = safe.strip(' .')
        # 4. 限制长度
        safe = safe[:50]
        # 5. 空标题兜底
        return safe or f"clip_{self.current_index}"


async def run_batch_clipping(task: BatchClipTask):
    """
    批量剪辑核心函数（增强版，带崩溃恢复和状态持久化）
    """
    # 状态文件路径（用于断点续传和调试）
    state_file = f"/tmp/knowclip_batch_{task.task_id}.json"

    def save_state():
        """保存当前状态到文件"""
        try:
            state = {
                "task_id": task.task_id,
                "video_path": task.video_path,
                "current_index": task.current_index,
                "completed_files": task.completed_files,
                "failed_files": task.failed_files,
                "is_complete": task.is_complete,
                "timestamp": time.time()
            }
            with open(state_file, 'w', encoding='utf-8') as f:
                json.dump(state, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"[Batch] Failed to save state: {e}")

    try:
        # 确定输出根目录（优先使用用户指定的目录）
        video_dir = os.path.dirname(task.video_path)
        if task.output_dir and os.path.isdir(task.output_dir):
            video_dir = task.output_dir

        # 创建项目子文件夹（带生成时间戳）
        if task.project_name:
            safe_project_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', task.project_name).strip(' .') or '未命名项目'
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            video_dir = os.path.join(video_dir, f"{safe_project_name}_{timestamp}")
            os.makedirs(video_dir, exist_ok=True)

        task.actual_output_dir = video_dir

        # 先生成标题描述.txt（即使后续视频失败，文案已保留）
        try:
            txt_path = os.path.join(video_dir, "标题描述.txt")
            lines = []
            for i, clip in enumerate(task.clips):
                title = clip.title or f"片段{i + 1}"
                desc = clip.description or ""
                tags = " ".join(clip.tags) if clip.tags else ""
                lines.append(f"标题：{title}")
                lines.append(f"描述：{desc}{(' ' + ' '.join(tags)) if tags else ''}")
                if i < len(task.clips) - 1:
                    lines.append("")
            if lines:
                with open(txt_path, 'w', encoding='utf-8') as f:
                    f.write('\n'.join(lines))
                print(f"[Batch] Generated 标题描述.txt: {txt_path}")
        except Exception as e:
            print(f"[Batch] Failed to generate 标题描述.txt: {e}")

        total_clips = len(task.clips)

        # 连续失败计数器（用于检测系统性错误）
        consecutive_failures = 0
        MAX_CONSECUTIVE_FAILURES = 3

        # 发送准备状态
        await task.broadcast({
            "type": "batch_preparing",
            "message": f"准备批量剪辑：共 {total_clips} 个片段",
            "total_clips": total_clips,
            "overall_percent": 0
        })

        # 预检查：验证视频文件
        if not os.path.exists(task.video_path):
            raise ValueError(f"视频文件不存在: {task.video_path}")

        # 获取视频总时长（用于验证）
        video_duration = get_video_duration(task.video_path)
        print(f"[Batch] Video duration: {video_duration}s, Total clips: {total_clips}, output_dir: {video_dir}")

        # 逐段处理
        for i, clip_meta in enumerate(task.clips):
            if task.cancel_event.is_set():
                await task.broadcast({
                    "type": "cancelled",
                    "message": "批量剪辑已取消",
                    "completed_count": len(task.completed_files),
                    "failed_count": len(task.failed_files)
                })
                save_state()
                return

            task.current_index = i
            save_state()  # 保存进度

            # 验证时间戳合法性
            if clip_meta.start_ms < 0 or clip_meta.end_ms > video_duration * 1000:
                error_msg = f"时间段越界: {clip_meta.start_ms}-{clip_meta.end_ms}ms (视频总长: {video_duration * 1000:.0f}ms)"
                print(f"[Batch] Validation failed for clip {i}: {error_msg}")
                task.failed_files.append({
                    "index": i,
                    "id": clip_meta.id,
                    "reason": error_msg
                })
                consecutive_failures += 1

                await task.broadcast({
                    "type": "clip_failed",
                    "index": i,
                    "id": clip_meta.id,
                    "reason": error_msg,
                    "overall_percent": int((i / total_clips) * 100)
                })

                # 检查连续失败次数
                if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                    raise RuntimeError(f"连续 {MAX_CONSECUTIVE_FAILURES} 个片段失败，终止批量任务")
                continue

            # 生成输出文件名（使用卡片标题命名）
            safe_title = task.get_sanitized_title(clip_meta.title)
            is_edited = clip_meta.srt_content is not None and len(clip_meta.srt_content) > 0
            edited_suffix = "_edited" if is_edited else ""

            base_name = f"{safe_title}{edited_suffix}"
            output_name = f"{base_name}.mp4"
            output_path = os.path.join(video_dir, output_name)

            # 处理文件名冲突（重复生成加 (1) (2)）
            counter = 1
            while os.path.exists(output_path):
                output_name = f"{base_name}({counter}).mp4"
                output_path = os.path.join(video_dir, output_name)
                counter += 1

            # 计算当前片段的进度权重
            base_percent = int((i / total_clips) * 100)
            clip_weight = int((1 / total_clips) * 100)

            await task.broadcast({
                "type": "clip_start",
                "index": i,
                "id": clip_meta.id,
                "title": clip_meta.title,
                "message": f"开始生成第 {i + 1}/{total_clips} 个片段: {clip_meta.title}",
                "overall_percent": base_percent,
                "clip_percent": 0
            })

            # 生成片段（带重试机制）
            success = False
            retry_count = 0
            max_retries = 1  # 每个片段最多重试1次（总共2次尝试）

            while not success and retry_count <= max_retries:
                try:
                    start_sec = clip_meta.start_ms / 1000.0
                    duration_sec = (clip_meta.end_ms - clip_meta.start_ms) / 1000.0
                    print(f"[Batch] Processing clip {i}/{total_clips}: {start_sec:.2f}s - {start_sec + duration_sec:.2f}s (attempt {retry_count + 1})")

                    # 快速路径：流复制（不解码不编码，直接从源视频拷贝数据，速度最快）
                    cmd = [
                        'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:2',
                        '-ss', str(start_sec),
                        '-i', task.video_path,
                        '-t', str(duration_sec),
                        '-c', 'copy',
                        '-movflags', '+faststart',
                        output_path
                    ]

                    proc = await asyncio.create_subprocess_exec(
                        *cmd,
                        stdout=asyncio.subprocess.DEVNULL,
                        stderr=asyncio.subprocess.PIPE
                    )

                    out_time_ms_pattern = re.compile(r'out_time_ms=(\d+)')
                    out_time_pattern = re.compile(r'out_time=(\d{2}):(\d{2}):(\d{2})\.(\d+)')
                    clip_duration_ms = clip_meta.end_ms - clip_meta.start_ms

                    last_progress_time = time.time()
                    stall_timeout = 60

                    while True:
                        if task.cancel_event.is_set():
                            proc.terminate()
                            try:
                                await asyncio.wait_for(proc.wait(), timeout=5.0)
                            except:
                                proc.kill()
                            # 清理半成品文件并广播取消状态
                            if os.path.exists(output_path):
                                try:
                                    os.remove(output_path)
                                except OSError:
                                    pass
                            await task.broadcast({
                                "type": "cancelled",
                                "message": "批量剪辑已取消",
                                "completed_count": len(task.completed_files),
                                "failed_count": len(task.failed_files)
                            })
                            save_state()
                            return

                        if proc.returncode is not None:
                            break

                        try:
                            line = await asyncio.wait_for(proc.stderr.readline(), timeout=1.0)
                        except asyncio.TimeoutError:
                            if time.time() - last_progress_time > stall_timeout:
                                print(f"[Batch] Clip {i} stalled for {stall_timeout}s, killing...")
                                proc.kill()
                                raise RuntimeError("编码卡死（超过60秒无响应）")
                            continue

                        if not line:
                            break

                        line_str = line.decode('utf-8', errors='ignore')
                        current_ms = 0

                        ms_match = out_time_ms_pattern.search(line_str)
                        if ms_match:
                            current_ms = int(ms_match.group(1)) // 1000
                            last_progress_time = time.time()
                        else:
                            time_match = out_time_pattern.search(line_str)
                            if time_match:
                                hours, minutes, seconds, micros = time_match.groups()
                                current_ms = (int(hours) * 3600 + int(minutes) * 60 + int(seconds)) * 1000 + int(micros[:3])
                                last_progress_time = time.time()

                        if current_ms > 0 and clip_duration_ms > 0:
                            clip_percent = min(99, int((current_ms / clip_duration_ms) * 100))
                            overall_percent = base_percent + int((clip_percent / 100) * clip_weight)

                            await task.broadcast({
                                "type": "clip_progress",
                                "index": i,
                                "id": clip_meta.id,
                                "clip_percent": clip_percent,
                                "overall_percent": overall_percent,
                                "message": f"编码中... {clip_percent}%"
                            })

                    await proc.wait()
                    if proc.returncode != 0:
                        raise RuntimeError(f"FFmpeg返回错误码: {proc.returncode}")

                    if not os.path.exists(output_path) or os.path.getsize(output_path) < 1024:
                        raise RuntimeError("输出文件未生成或过小（<1KB）")

                    # 成功！
                    file_size = os.path.getsize(output_path)
                    task.completed_files.append({
                        "index": i,
                        "id": clip_meta.id,
                        "filename": os.path.basename(output_path),
                        "path": output_path,
                        "size_mb": round(file_size / 1024 / 1024, 2)
                    })

                    await task.broadcast({
                        "type": "clip_complete",
                        "index": i,
                        "id": clip_meta.id,
                        "filename": os.path.basename(output_path),
                        "size_mb": round(file_size / 1024 / 1024, 2),
                        "overall_percent": base_percent + clip_weight,
                        "message": f"片段 {i + 1} 完成"
                    })

                    consecutive_failures = 0
                    success = True

                except Exception as e:
                    retry_count += 1
                    error_msg = str(e)
                    print(f"[Batch] Clip {i} failed (attempt {retry_count}/{max_retries + 1}): {error_msg}")

                    # 清理临时文件
                    if os.path.exists(output_path):
                        try:
                            os.remove(output_path)
                            print(f"[Batch] Cleaned up failed file: {output_path}")
                        except Exception as cleanup_err:
                            print(f"[Batch] Failed to cleanup: {cleanup_err}")

                    if retry_count > max_retries:
                        # 最终失败
                        task.failed_files.append({
                            "index": i,
                            "id": clip_meta.id,
                            "reason": error_msg
                        })
                        consecutive_failures += 1

                        await task.broadcast({
                            "type": "clip_failed",
                            "index": i,
                            "id": clip_meta.id,
                            "reason": error_msg,
                            "overall_percent": base_percent + clip_weight
                        })

                        # 检查连续失败次数
                        if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                            save_state()
                            raise RuntimeError(
                                f"连续 {MAX_CONSECUTIVE_FAILURES} 个片段失败，终止任务以防止资源浪费。请检查视频文件或时间段设置。")
                    else:
                        # 重试前等待
                        await asyncio.sleep(2)
                        print(f"[Batch] Retrying clip {i}...")

        # 全部完成
        task.is_complete = True
        elapsed = time.time() - task.start_time
        save_state()

        # 可选：清理状态文件（保留成功记录）
        try:
            success_state_file = f"/tmp/knowclip_batch_{task.task_id}_success.json"
            with open(success_state_file, 'w', encoding='utf-8') as f:
                json.dump({
                    "task_id": task.task_id,
                    "completed_files": task.completed_files,
                    "failed_files": task.failed_files,
                    "elapsed_seconds": int(elapsed),
                    "timestamp": time.time()
                }, f, ensure_ascii=False, indent=2)
            if os.path.exists(state_file):
                os.remove(state_file)
        except Exception as e:
            print(f"[Batch] Failed to save success state: {e}")

        print(f"[Batch] 批量剪辑完成，总耗时 {elapsed:.2f}s（成功 {len(task.completed_files)} 个，失败 {len(task.failed_files)} 个）")

        await task.broadcast({
            "type": "batch_complete",
            "message": f"批量剪辑完成！成功 {len(task.completed_files)} 个，失败 {len(task.failed_files)} 个，用时 {int(elapsed)} 秒",
            "overall_percent": 100,
            "elapsed_seconds": int(elapsed),
            "completed_files": task.completed_files,
            "failed_files": task.failed_files,
            "output_dir": task.actual_output_dir
        })

    except Exception as e:
        task.error_msg = str(e)
        save_state()
        print(f"[Batch] Fatal error: {e}")
        await task.broadcast({
            "type": "batch_error",
            "error": str(e),
            "message": f"批量剪辑失败: {str(e)}"
        })
    finally:
        # 延迟清理任务（保留10分钟供查询）
        await asyncio.sleep(600)
        if task.task_id in batch_clip_tasks:
            del batch_clip_tasks[task.task_id]
        # 清理状态文件
        try:
            if os.path.exists(state_file):
                os.remove(state_file)
        except:
            pass


# ========== 缩略图生成模块 ==========
THUMB_DIR = Path(tempfile.gettempdir()) / "knowclip_thumbs"
THUMB_DIR.mkdir(exist_ok=True)


def get_thumb_path(video_path: str, start_ms: int, thumb_dir: str = None, clip_id: str = None) -> Path:
    """生成缩略图路径。优先使用自定义目录和 clip_id，回退到临时目录的 video_hash 方案。"""
    if thumb_dir and clip_id:
        return Path(thumb_dir) / f"{clip_id}_{start_ms}.jpg"
    video_hash = hashlib.md5(video_path.encode()).hexdigest()[:8]
    return THUMB_DIR / f"{video_hash}_{start_ms}_v4.jpg"


def get_video_rotation(video_path: str) -> int:
    """获取视频的旋转角度（0, 90, 180, 270）"""
    try:
        cmd = [
            'ffprobe', '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream_tags=rotate',
            '-show_entries', 'stream=side_data_list',
            '-of', 'json',
            video_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        data = json.loads(result.stdout)
        streams = data.get('streams', [])
        if not streams:
            return 0

        # 方法1: 检查 tags.rotate
        rotate = streams[0].get('tags', {}).get('rotate')
        if rotate:
            return int(float(rotate))

        # 方法2: 检查 side_data_list 中的 displaymatrix
        side_data = streams[0].get('side_data_list', [])
        for sd in side_data:
            if sd.get('side_data_type') == 'Display Matrix':
                rotation = sd.get('rotation', 0)
                if rotation:
                    return int(float(rotation))
        return 0
    except Exception:
        return 0


async def extract_single_frame(video_path: str, start_ms: int, output_path: Path) -> tuple[bool, int, int]:
    """提取单帧，使用FFmpeg快速seek。返回 (是否成功, 宽, 高)"""
    start_sec = start_ms / 1000.0
    rotation = get_video_rotation(video_path)

    # 根据旋转角度选择 transpose filter
    transpose_filter = ""
    if rotation == 90:
        transpose_filter = "transpose=1,"
    elif rotation == 180:
        transpose_filter = "transpose=1,transpose=1,"
    elif rotation == 270 or rotation == -90:
        transpose_filter = "transpose=2,"

    # 先按 SAR 把像素拉伸为显示分辨率，再限制最大边为1920
    vf = f"{transpose_filter}scale=trunc(iw*sar/2)*2:ih,setsar=1,scale=1920:1920:force_original_aspect_ratio=decrease"

    cmd = [
        'ffmpeg',
        '-ss', str(start_sec),
        '-i', video_path,
        '-vframes', '1',
        '-q:v', '1',
        '-vf', vf,
        '-y',
        '-an',
        '-sn',
        str(output_path)
    ]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL
    )
    await proc.wait()

    if not output_path.exists():
        return False, 0, 0

    # 读取生成的图片尺寸
    try:
        from PIL import Image
        with Image.open(output_path) as im:
            return True, im.width, im.height
    except Exception:
        return True, 1920, 1080


@app.websocket("/thumb_ws")
async def thumbnail_websocket(websocket: WebSocket):
    """WebSocket 流式缩略图生成：逐个生成，逐个推送"""
    await websocket.accept()
    try:
        data = await websocket.receive_json()
        video_path = data.get("video_path")
        clips = data.get("clips", [])
        thumb_dir = data.get("thumb_dir")

        if not os.path.exists(video_path):
            await websocket.send_json({"type": "error", "error": "视频文件不存在"})
            return

        # 若指定了持久化目录，提前创建
        if thumb_dir:
            Path(thumb_dir).mkdir(parents=True, exist_ok=True)

        # 逐个生成，逐个推送
        for clip in clips:
            clip_id = clip["id"]
            start_ms = clip["start_ms"]

            thumb_path = get_thumb_path(video_path, start_ms, thumb_dir, clip_id)

            # 如果缓存存在，直接返回
            if thumb_path.exists():
                try:
                    from PIL import Image
                    with Image.open(thumb_path) as im:
                        w, h = im.width, im.height
                except Exception:
                    w, h = 1920, 1080
                await websocket.send_json({
                    "type": "thumb",
                    "clip_id": clip_id,
                    "path": str(thumb_path),
                    "width": w,
                    "height": h
                })
                continue

            # 生成缩略图
            success, w, h = await extract_single_frame(video_path, start_ms, thumb_path)

            if success:
                await websocket.send_json({
                    "type": "thumb",
                    "clip_id": clip_id,
                    "path": str(thumb_path),
                    "width": w,
                    "height": h
                })
            else:
                await websocket.send_json({
                    "type": "error",
                    "clip_id": clip_id,
                    "error": "生成失败"
                })

        await websocket.send_json({"type": "complete"})

    except WebSocketDisconnect:
        pass


# 全局批量剪辑任务存储
batch_clip_tasks: Dict[str, BatchClipTask] = {}

# ========== 剪辑API接口 ==========
class ClipMeta(BaseModel):
    """批量剪辑中的单个片段元数据"""
    id: str           # 前端片段ID
    index: int        # 队列中的顺序索引（0-based）
    start_ms: int
    end_ms: int
    srt_content: Optional[str] = None  # 精剪后的SRT，None则使用原始
    title: str = ""   # 用于生成文件名
    description: str = ""  # 片段描述
    tags: list[str] = []   # 片段标签


class BatchClipRequest(BaseModel):
    """批量剪辑请求"""
    video_path: str
    clips: List[ClipMeta]  # 顺序即用户意图顺序
    allow_shuffle: bool = True  # 标记为True表示接受乱序
    output_dir: Optional[str] = None  # 用户指定的输出目录
    project_name: Optional[str] = None  # 项目名称（用于创建子文件夹）


@app.post("/extract_audio")
async def extract_audio_endpoint(request: Request):
    """
    提取视频中的音频轨道为独立音频文件
    - format='aac': AAC, 16kHz, 单声道, 128kbps（ASR专用，体积小）
    - format='wav': WAV pcm_s16le, 48kHz, 立体声（精剪专用）
    - 若前端传入 output_path，直接生成到该路径（按项目分文件夹）
    - 否则保存在视频同级目录，同名替换扩展名
    """
    try:
        body = await request.json()
        video_path = body.get("video_path")
        output_path = body.get("output_path")
        format_type = body.get("format", "wav")

        if not video_path or not os.path.exists(video_path):
            raise HTTPException(status_code=404, detail="视频文件不存在")

        if output_path:
            audio_path = output_path
            os.makedirs(os.path.dirname(audio_path), exist_ok=True)
        else:
            base, _ = os.path.splitext(video_path)
            audio_path = base + ('.aac' if format_type == 'aac' else '.wav')

        # 原始音频缓存检查
        if os.path.exists(audio_path) and os.path.getsize(audio_path) > 1024:
            return {"audio_path": audio_path, "cached": True}

        if format_type == 'aac':
            cmd = [
                'ffmpeg', '-hide_banner', '-loglevel', 'error',
                '-i', video_path,
                '-vn',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-ar', '16000',
                '-ac', '1',
                '-y',
                audio_path
            ]
        else:
            cmd = [
                'ffmpeg', '-hide_banner', '-loglevel', 'error',
                '-i', video_path,
                '-vn',
                '-c:a', 'pcm_s16le',
                '-ar', '48000',
                '-ac', '2',
                '-y',
                audio_path
            ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE
        )
        _, stderr = await proc.communicate()

        if proc.returncode != 0:
            error_msg = stderr.decode('utf-8', errors='ignore') if stderr else "未知错误"
            raise HTTPException(status_code=500, detail=f"FFmpeg 提取失败: {error_msg}")

        if not os.path.exists(audio_path) or os.path.getsize(audio_path) < 1024:
            raise HTTPException(status_code=500, detail="输出文件未生成或过小")

        return {"audio_path": audio_path}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"音频提取失败: {str(e)}")


@app.post("/warmup_asr")
async def warmup_asr_endpoint(request: Request):
    """
    预热 ASR 模型，只加载模型不开始识别
    前端可以在提取音频的同时调用此接口，让模型加载和音频提取并行
    """
    try:
        print("[warmup_asr] 收到预热请求")
        ensure_model_loaded("GPU")
        print("[warmup_asr] 模型已就绪")
        return {
            "success": True,
            "message": "模型已就绪",
            "device": actual_gpu_type
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"模型预热失败: {str(e)}")


@app.post("/clip_batch")
async def clip_batch_endpoint(request: BatchClipRequest):
    """
    启动批量视频剪辑任务（会话保持模式）
    一次性提交多个片段，后端逐个生成，保持FFmpeg进程复用
    """
    try:
        if not os.path.exists(request.video_path):
            return {"success": False, "error": "视频文件不存在"}

        if not request.clips or len(request.clips) == 0:
            return {"success": False, "error": "片段列表为空"}

        # 验证所有片段的时间戳
        video_duration = get_video_duration(request.video_path)
        invalid_clips = []
        for idx, clip in enumerate(request.clips):
            if clip.start_ms < 0 or clip.end_ms > video_duration * 1000:
                invalid_clips.append(f"片段{idx}: {clip.start_ms}-{clip.end_ms}ms")

        if invalid_clips:
            return {
                "success": False,
                "error": f"以下片段时间戳无效（视频总长{video_duration * 1000:.0f}ms）: {', '.join(invalid_clips)}"
            }

        if not check_ffmpeg():
            return {"success": False, "error": "系统未安装FFmpeg"}

        # 创建批量任务
        task = BatchClipTask(
            video_path=request.video_path,
            clips=request.clips,
            output_dir=request.output_dir,
            project_name=request.project_name
        )
        batch_clip_tasks[task.task_id] = task

        # 启动后台任务
        asyncio.create_task(run_batch_clipping(task))

        return {
            "success": True,
            "task_id": task.task_id,
            "message": f"批量剪辑任务已启动，共 {len(request.clips)} 个片段",
            "total_clips": len(request.clips)
        }

    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": f"服务器错误: {str(e)}"}


@app.websocket("/batch_ws/{task_id}")
async def batch_websocket_endpoint(websocket: WebSocket, task_id: str):
    """WebSocket 批量剪辑实时进度推送端点"""
    await websocket.accept()

    if task_id not in batch_clip_tasks:
        await websocket.send_json({"type": "error", "error": "批量任务不存在或已过期"})
        await websocket.close()
        return

    task = batch_clip_tasks[task_id]
    task.websockets.append(websocket)

    # 发送初始状态
    if task.is_complete:
        await websocket.send_json({
            "type": "batch_complete",
            "message": f"批量剪辑已完成",
            "completed_files": task.completed_files,
            "failed_files": task.failed_files,
            "overall_percent": 100,
            "output_dir": task.actual_output_dir
        })
    elif task.error_msg:
        await websocket.send_json({
            "type": "batch_error",
            "error": task.error_msg
        })
    else:
        await websocket.send_json({
            "type": "connected",
            "message": f"已连接批量剪辑任务，共 {len(task.clips)} 个片段",
            "total_clips": len(task.clips),
            "current_index": task.current_index
        })

    try:
        while True:
            data = await websocket.receive_text()
            if data == "cancel":
                task.cancel_event.set()
                await websocket.send_json({"type": "cancelling", "message": "正在取消批量剪辑..."})
                break
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in task.websockets:
            task.websockets.remove(websocket)


# ========== LLM 推理端点 ==========
import httpx


class LLMRequest(BaseModel):
    model: str
    system_prompt: str = ""
    cached_content: str = ""
    user_prompt: str = ""
    enable_thinking: bool = False
    api_base: str = ""
    api_key: str = ""


@app.get("/list_models")
async def list_models_endpoint(api_base: str = "", api_key: str = ""):
    """拉取 OpenAI 兼容服务的可用模型列表（GET {base}/models）"""
    if not api_base:
        return {"success": False, "error": "缺少 api_base"}
    base = api_base.rstrip("/")
    if base.endswith("/chat/completions"):
        base = base[: -len("/chat/completions")]
    try:
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{base}/models", headers=headers)
        data = resp.json()
        models = [m.get("id") for m in data.get("data", []) if isinstance(m, dict) and m.get("id")]
        if not models:
            return {"success": False, "error": f"服务未返回模型列表: {str(data)[:200]}"}
        return {"success": True, "models": models}
    except Exception as e:
        return {"success": False, "error": str(e)}


@app.post("/llm_inference")
async def llm_inference_endpoint(request: LLMRequest):
    """
    代理调用 OpenAI 兼容 LLM API，解决前端 CORS 问题
    流式返回 AI 推理结果（NDJSON 格式）
    cached_content 用于显式缓存固定大文本（如字幕原文）
    enable_thinking 控制是否开启模型思考模式，默认关闭
    """
    if not request.api_key or not request.api_base:
        raise HTTPException(status_code=400, detail="请先在设置面板填写 API 地址（OpenAI 兼容）与 API Key")
    api_key = request.api_key
    base_url = request.api_base
    # 兼容用户输入裸域名或 /v1、/v4 等前缀：不含 /chat/completions 就自动补全
    if base_url and not base_url.rstrip("/").endswith("/chat/completions"):
        base_url = base_url.rstrip("/") + "/chat/completions"

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    # 长视频模式：system_prompt + 字幕原文 + user_prompt，标准 OpenAI 格式
    user_content = request.cached_content
    if request.user_prompt and request.user_prompt.strip():
        user_content += f"\n\n{request.user_prompt}"
    messages = [
        {"role": "system", "content": request.system_prompt},
        {"role": "user", "content": user_content}
    ]

    payload = {
        "model": request.model,
        "messages": messages,
        "stream": True,
    }
    # 思考模式按服务商分别适配（参数互不通用，发错会导致 400 或被无视）：
    # - DeepSeek v4 默认强制思考，关闭必须显式 thinking:{"type":"disabled"}
    # - DashScope/Qwen 用 enable_thinking 开关
    # - 其他端点（如 OpenAI 官方）不发送任何思考参数，遵循服务默认行为
    _host = base_url.split("//")[-1].split("/")[0]
    if "deepseek" in _host:
        if request.enable_thinking:
            payload["enable_thinking"] = True
        else:
            payload["thinking"] = {"type": "disabled"}
    elif "dashscope" in _host or "aliyun" in _host:
        if request.enable_thinking:
            payload["enable_thinking"] = True

    async def generate():
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=600.0)) as client:
                async with client.stream("POST", base_url, headers=headers, json=payload) as response:
                    if response.status_code != 200:
                        err_body = await response.aread()
                        err_text = err_body.decode('utf-8', errors='ignore')[:200]
                        yield json.dumps({"t": "e", "c": f"HTTP {response.status_code}: {err_text}"}, ensure_ascii=False).encode('utf-8') + b"\n"
                        return

                    async for line in response.aiter_lines():
                        if line.startswith("data:"):
                            data_str = line[5:].strip()
                            if data_str == "[DONE]":
                                break
                            try:
                                data = json.loads(data_str)
                                delta = data.get("choices", [{}])[0].get("delta", {})
                                reasoning = delta.get("reasoning_content") or ""
                                content = delta.get("content") or ""
                                if reasoning:
                                    yield json.dumps({"t": "r", "c": reasoning}, ensure_ascii=False).encode('utf-8') + b"\n"
                                if content:
                                    yield json.dumps({"t": "c", "c": content}, ensure_ascii=False).encode('utf-8') + b"\n"
                            except:
                                continue

        except Exception as e:
            yield json.dumps({"t": "e", "c": str(e)}, ensure_ascii=False).encode('utf-8') + b"\n"

    return StreamingResponse(
        generate(),
        media_type="application/x-ndjson"
    )




if __name__ == "__main__":
    print("=" * 60)
    print("启动字幕识别服务...")
    print("API文档: http://127.0.0.1:8000/docs")
    print("WebSocket: ws://127.0.0.1:8000/ws/{task_id}")
    print("=" * 60)
    uvicorn.run(app, host="127.0.0.1", port=8000)
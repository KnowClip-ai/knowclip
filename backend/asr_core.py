# -*- coding: utf-8 -*-
# asr_core.py - 核心识别逻辑，不包含界面

import logging
import warnings
import os
import sys
import platform
from io import StringIO
import json
import re
import time
import threading

# ===== 日志静音配置（必须在import其他库之前）=====
os.environ["TOKENIZERS_PARALLELISM"] = "false"
warnings.filterwarnings("ignore", message=".*trust_remote_code.*")
warnings.filterwarnings("ignore", message=".*Loading remote code failed.*")
warnings.filterwarnings("ignore", category=UserWarning)

logging.getLogger("modelscope").setLevel(logging.ERROR)
logging.getLogger("urllib3").setLevel(logging.ERROR)
logging.getLogger("transformers").setLevel(logging.ERROR)
logging.getLogger("root").setLevel(logging.ERROR)

import torch

# ========== 全局变量 ==========
current_model = None
current_device = None
actual_gpu_type = None
has_gpu = False

# 懒加载与空闲卸载相关
_load_lock = threading.Lock()  # 防止多线程重复加载模型

def detect_device():
    """检测实际可用的加速设备"""
    global actual_gpu_type, has_gpu

    if torch.cuda.is_available():
        try:
            props = torch.cuda.get_device_properties(0)
            total_memory_gb = props.total_memory / (1024 ** 3)
            print(f"检测到NVIDIA GPU: {props.name}, 显存: {total_memory_gb:.1f}GB")
            if total_memory_gb >= 2:
                actual_gpu_type = "cuda"
                has_gpu = True
                return
        except Exception as e:
            print(f"CUDA检测异常: {e}")

    if torch.backends.mps.is_available():
        is_apple_silicon = "arm" in platform.machine().lower() or "arm64" in platform.machine().lower()
        if is_apple_silicon:
            print("检测到Apple Silicon芯片，使用Metal加速")
            actual_gpu_type = "mps"
            has_gpu = True
            return
        else:
            print("Intel Mac检测到MPS但不推荐使用，降级到CPU")

    actual_gpu_type = "cpu"
    has_gpu = False
    print("未检测到可用GPU，使用CPU模式")


def load_model(device_type="gpu"):
    """加载模型"""
    from funasr import AutoModel

    global current_model, current_device

    if device_type == "gpu" and actual_gpu_type in ["cuda", "mps"]:
        real_device = actual_gpu_type
    elif device_type in ["cuda", "mps", "cpu"]:
        real_device = device_type
    else:
        real_device = "cpu"

    print(f"正在加载模型到 {real_device.upper()}...")

    logging.disable(logging.INFO)
    old_stdout = sys.stdout
    sys.stdout = StringIO()
    old_stderr = sys.stderr
    sys.stderr = StringIO()

    # 首次运行自动从 ModelScope 下载模型（约1GB，缓存于 ~/.cache/modelscope）
    try:
        model = AutoModel(
            model="iic/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
            vad_model="iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
            punc_model="iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
            device=real_device,
            disable_update=True,
            trust_remote_code=True,
        )
    finally:
        sys.stdout = old_stdout
        sys.stderr = old_stderr
        logging.disable(logging.NOTSET)

    current_model = model
    current_device = real_device
    print(f"模型已加载到 {real_device.upper()}")
    return model


def ensure_model_loaded(device_choice="GPU"):
    """确保 ASR 模型已加载；模型常驻内存，不卸载"""
    global current_model, current_device
    with _load_lock:
        if current_model is not None:
            return

        # 解析目标设备
        if "GPU" in device_choice and actual_gpu_type in ["cuda", "mps"]:
            target_device = actual_gpu_type
        elif device_choice in ["cuda", "mps", "cpu"]:
            target_device = device_choice
        else:
            target_device = "cpu"

        load_model(target_device)


def warmup_async():
    """在后台线程预加载模型（服务启动时调用，不阻塞端口监听）"""
    threading.Thread(target=lambda: ensure_model_loaded("GPU"), daemon=True).start()




# ========== 启动检测 ==========
detect_device()
# 服务启动时即在后台加载模型并常驻内存



# ========== 工具函数 ==========
def get_audio_duration_ms(audio_path):
    """获取音频文件总时长（毫秒），失败则返回0
    优先使用FFprobe读取元数据（毫秒级），失败时回退到pydub/librosa
    """
    import subprocess
    import json
    import os

    # 方案1：使用 FFprobe 读取容器元数据（最快，大文件也是几十毫秒）
    try:
        cmd = [
            'ffprobe', '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'json',
            audio_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            data = json.loads(result.stdout)
            duration_sec = float(data['format']['duration'])
            return int(duration_sec * 1000)
    except Exception as e:
        pass

    # 方案2：回退到 pydub（读取文件头，比librosa快）
    try:
        from pydub import AudioSegment
        audio = AudioSegment.from_file(audio_path)
        return len(audio)
    except:
        pass

    # 方案3：最后手段 librosa（会解码音频，很慢）
    try:
        import librosa
        y, sr = librosa.load(audio_path, sr=None)
        return int(len(y) / sr * 1000)
    except:
        pass

    return 0


def clean_text_for_srt(text):
    cleaned = re.sub(r"[，。！？、；：“”‘’（）【】{},.!?;:'\"()\[\]…~—-]", '', text)
    return cleaned.strip()


def build_words_from_sentence(sent):
    text = sent.get("text", "")
    timestamps = sent.get("timestamp", [])
    chars = list(text)

    words = []
    if timestamps and len(timestamps) == len(chars):
        for i, char in enumerate(chars):
            start, end = timestamps[i]
            words.append({
                "word": char,
                "start_ms": int(start),
                "end_ms": int(end),
                "duration_ms": int(end - start)
            })
    else:
        start_ms = sent.get("start", 0)
        end_ms = sent.get("end", start_ms + 1000)
        char_duration = (end_ms - start_ms) // len(chars) if chars else 0

        for i, char in enumerate(chars):
            word_start = start_ms + i * char_duration
            word_end = word_start + char_duration
            words.append({
                "word": char,
                "start_ms": int(word_start),
                "end_ms": int(word_end),
                "duration_ms": int(char_duration),
                "approximate": True
            })

    return words


def create_sentence_segment(words):
    if not words:
        return None
    text = "".join([w["word"] for w in words])
    return {
        "text": text,
        "start": words[0]["start_ms"],
        "end": words[-1]["end_ms"],
        "words": words,
        "word_count": len(words)
    }


def group_sentences_by_time_gap(sentences, threshold_ms):
    if not sentences:
        return []

    groups = []
    current_group = [sentences[0]]

    for i in range(1, len(sentences)):
        prev_sent = sentences[i - 1]
        curr_sent = sentences[i]

        prev_end = prev_sent.get("end", 0)
        curr_start = curr_sent.get("start", 0)
        gap = curr_start - prev_end

        if gap > threshold_ms:
            groups.append(current_group)
            current_group = [curr_sent]
        else:
            current_group.append(curr_sent)

    if current_group:
        groups.append(current_group)

    return groups


def recursive_split(words, min_len=2, max_len=15):
    n = len(words)

    if n < min_len * 2:
        if n > 0:
            seg = create_sentence_segment(words)
            return [seg] if seg else []
        return []

    best_L = 0
    best_i = -1

    for L in range(min(max_len, n // 2), min_len - 1, -1):
        max_i = n - L * 2
        for i in range(max_i, -1, -1):
            slice1 = words[i:i + L]
            slice2 = words[i + L:i + L * 2]

            text1 = "".join([w["word"] for w in slice1])
            text2 = "".join([w["word"] for w in slice2])

            if text1 == text2:
                best_L = L
                best_i = i
                break
        if best_L > 0:
            break

    if best_L == 0:
        seg = create_sentence_segment(words)
        return [seg] if seg else []

    L = best_L
    i = best_i

    k = 2
    base_text = "".join([w["word"] for w in words[i:i + L]])

    while True:
        next_start = i + k * L
        if next_start + L > n:
            break

        next_slice = words[next_start:next_start + L]
        next_text = "".join([w["word"] for w in next_slice])

        if next_text == base_text:
            k += 1
        else:
            break

    results = []

    prefix = words[:i]
    if prefix:
        results.extend(recursive_split(prefix, min_len, max_len))

    for idx in range(k - 1):
        start = i + idx * L
        end = start + L
        repeat_seg = words[start:end]
        if repeat_seg:
            seg = create_sentence_segment(repeat_seg)
            if seg:
                results.append(seg)

    last_start = i + (k - 1) * L
    last_part = words[last_start:]
    if last_part:
        seg = create_sentence_segment(last_part)
        if seg:
            results.append(seg)

    return results


def split_by_repetition(sentence_info, min_len=2, max_len=15):
    processed = []

    for sent in sentence_info:
        words = sent.get("words", [])
        if not words and "timestamp" in sent:
            words = build_words_from_sentence(sent)

        if not words:
            continue

        segments = recursive_split(words, min_len, max_len)

        if not segments:
            if not sent.get("words"):
                sent["words"] = words
                sent["word_count"] = len(words)
            processed.append(sent)
        else:
            processed.extend(segments)

    return processed


def generate_srt_content(sentences, keep_pauses=False):
    """
    生成SRT字幕
    如果 keep_pauses=True，结束时间会加上停顿时长（延长显示时间）
    """
    srt_lines = []

    def ms_to_srt_time(ms):
        hours = ms // 3600000
        minutes = (ms % 3600000) // 60000
        seconds = (ms % 60000) // 1000
        milliseconds = ms % 1000
        return f"{hours:02d}:{minutes:02d}:{seconds:02d},{milliseconds:03d}"

    for i, sent in enumerate(sentences, 1):
        raw_text = sent.get("text", "").strip()
        if not raw_text:
            continue

        clean_text = clean_text_for_srt(raw_text)
        if not clean_text:
            continue

        start_ms = int(sent.get("start", 0))
        end_ms = int(sent.get("end", start_ms + 1000))

        # 如果保留停顿时长，延长结束时间
        if keep_pauses:
            pause_ms = sent.get("pause_ms", 0)
            end_ms += pause_ms

        srt_lines.append(str(i))
        srt_lines.append(f"{ms_to_srt_time(start_ms)} --> {ms_to_srt_time(end_ms)}")
        srt_lines.append(clean_text)
        srt_lines.append("")

    return "\n".join(srt_lines) if srt_lines else "1\n00:00:00,000 --> 00:00:05,000\n无内容"


# ========== 主处理函数（供API调用） ==========
def process_audio_file(audio_path, device_choice="GPU", min_repeat_len=2, time_gap_threshold=0.3,
                       progress_callback=None, check_cancel=None):
    """
    处理音频文件，返回结果字典
    device_choice: "GPU" 或 "CPU"
    progress_callback: 回调函数(current_ms, total_ms) -> bool，返回False表示取消
    check_cancel: 检查函数() -> bool，返回True表示应停止
    """
    global current_model, current_device

    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"找不到文件: {audio_path}")

    # 【新增】立即回调0%进度，让用户知道"准备中"（避免前端卡顿感）
    if progress_callback:
        try:
            progress_callback(0, 0)
        except:
            pass

    # 获取音频总时长（用于进度上报）- 使用FFprobe，很快
    total_ms = get_audio_duration_ms(audio_path)
    if total_ms == 0:
        # 如果无法读取时长，按文件大小估算（假设 1MB = 1分钟）
        try:
            file_size_mb = os.path.getsize(audio_path) / (1024 * 1024)
            total_ms = int(file_size_mb * 60 * 1000)
        except:
            total_ms = 600000  # 默认 10 分钟

    # 懒加载：确保模型已加载（首次识别时加载，设备切换时重新加载）
    ensure_model_loaded(device_choice)

    # 执行识别
    try:
        result = current_model.generate(
            input=audio_path,
            sentence_timestamp=True,
        )

        if check_cancel and check_cancel():
            raise InterruptedError("用户取消识别")

    finally:
        if progress_callback and not (check_cancel and check_cancel()):
            try:
                progress_callback(total_ms, total_ms)
            except:
                pass

    # 检查 result 是否被正确赋值
    if result is None:
        raise RuntimeError("识别失败：模型未返回有效结果")

    # 后续处理（生成字幕等）
    raw_text = result[0]["text"]
    original_sentences = result[0].get("sentence_info", [])

    # 过滤无实际字符的段：语音结束后的噪声尾段会被 VAD 切分、标点模型贴标点，
    # 产生只有标点没有文字的"句子"，拼进全文就成了结尾的标点堆
    original_sentences = [
        s for s in original_sentences
        if re.search(r'[\u4e00-\u9fffa-zA-Z0-9]', s.get("text", ""))
    ]
    original_count = len(original_sentences)

    threshold_ms = int(time_gap_threshold * 1000)
    sentence_groups = group_sentences_by_time_gap(original_sentences, threshold_ms)

    final_sentences = []
    for group in sentence_groups:
        group_processed = split_by_repetition(
            group,
            min_len=int(min_repeat_len),
            max_len=15
        )
        final_sentences.extend(group_processed)

    sentence_count = len(final_sentences)

    # 生成SRT
    srt_content = generate_srt_content(final_sentences)

    # 生成纯文本（不含停顿标记，用于预览）
    full_text = "".join([s["text"] for s in final_sentences])

    # 处理信息
    group_info = f"分{len(sentence_groups)}组" if len(sentence_groups) > 1 else "未分组"
    split_info = f"切分{original_count}->{sentence_count}句" if sentence_count != original_count else "未切分"
    display_device = "GPU" if current_device in ["cuda", "mps"] else "CPU"
    info = f"识别完成！共{sentence_count}句 | {split_info} | {group_info} | 间隔>{time_gap_threshold}s | 设备：{display_device}"

    return {
        "text": full_text,
        "sentences": final_sentences,
        "srt": srt_content,
        "info": info,
        "raw_text": raw_text
    }


def render_display_text(sentences, keep_pauses=False, pause_threshold=None):
    """根据参数渲染文本，处理停顿时长"""
    if not keep_pauses:
        return "".join([s["text"] for s in sentences])

    text_parts = []
    for i, sent in enumerate(sentences):
        text_parts.append(sent["text"])
        if i < len(sentences) - 1:
            gap_ms = sentences[i + 1]["start"] - sent["end"]
            gap_s = gap_ms / 1000.0

            if pause_threshold is not None:
                if gap_s < pause_threshold:
                    text_parts.append(f"[{gap_s:.2f}s]")
            else:
                text_parts.append(f"[{gap_s:.2f}s]")

    return "".join(text_parts)
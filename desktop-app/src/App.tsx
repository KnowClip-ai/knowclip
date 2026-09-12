import { useState, useRef, useEffect, useCallback } from 'react';
import { useProjectRecognizer } from './hooks/useProjectRecognizer';
import { useAutoInference } from './hooks/useAutoInference';
import { open } from '@tauri-apps/plugin-dialog';
import { convertFileSrc } from '@tauri-apps/api/core';
import { exists } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { join } from '@tauri-apps/api/path';
import './App.css';
import { loadConfig, saveConfig, DEFAULT_CONFIG as ConfigModuleDefaultConfig, AppConfig } from './config';
import { loadProject, saveProject, getProjectThumbsDir, Project, SubtitleStyle } from './projects';
import { cleanPunctuation } from './utils';
import type { Sentence, HighlightClip, BatchProgress } from './types';
import { ProjectSpacePage } from './components/project/ProjectSpacePage';
import { ProjectCreatePage } from './components/project/ProjectCreatePage';
import { VideoPlayer } from './components/player/VideoPlayer';
import { PlayerProvider } from './components/player/PlayerContext';
import { LongPreviewPage } from './components/project/LongPreviewPage';
import { Gear } from '@phosphor-icons/react';
import { Play, Stop, Sparkle, TextAlignLeft, CheckCircle, XCircle, ArrowsClockwise } from '@phosphor-icons/react';

const DEFAULT_CONFIG: AppConfig = ConfigModuleDefaultConfig as AppConfig;

function App() {
  const [currentPage, setCurrentPage] = useState<'home' | 'project-space' | 'project-create' | 'long-config' | 'long-preview'>('home');
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const currentProjectRef = useRef<Project | null>(null);
  const [file, setFile] = useState<string | null>(null);

  // 修复 WebKit 窗口切换后 accent-color 丢失的问题
  useEffect(() => {
    const fixAccent = () => {
      if (document.hidden) return;
      // 延迟 80ms，等 WebKit 完成重绘后再强制刷新
      setTimeout(() => {
        document.querySelectorAll('input[type="checkbox"], input[type="range"]').forEach(el => {
          const s = (el as HTMLElement).style;
          s.opacity = '0.99';
          void (el as HTMLElement).offsetHeight;
          s.opacity = '';
        });
      }, 80);
    };
    document.addEventListener('visibilitychange', fixAccent);
    window.addEventListener('focus', fixAccent);
    return () => {
      document.removeEventListener('visibilitychange', fixAccent);
      window.removeEventListener('focus', fixAccent);
    };
  }, []);

  // 全局 video 安全卸载：App 卸载（应用关闭）时主动释放硬件解码器
  useEffect(() => {
    return () => {
      const video = videoRef.current;
      if (video) {
        import('./utils/videoTeardown').then(({ teardownVideo }) => {
          teardownVideo(video);
        });
      }
    };
  }, []);

  // HTTP文件服务器生命周期管理（页面级常驻，片段级复用）
  useEffect(() => {
    // 进入 long-preview 时启动服务器
    if (currentPage === 'long-preview' && file && !httpInitializedRef.current) {
      httpInitializedRef.current = true;

      // 判断是否需要分轨模式（有外部音频且未替换音轨时）
      const project = currentProjectRef.current;
      const hasExternalAudio = !!project?.externalAudio;
      const audioPath = hasExternalAudio ? project?.externalAudio?.path : undefined;

      if (audioPath) {
        invoke<{ video_url: string; audio_url?: string }>('start_media_server', { videoPath: file, audioPath })
          .then(result => {
            setVideoServerUrl(result.video_url);
            if (result.audio_url) {
              setAudioServerUrl(result.audio_url);
              // 分轨模式：记录外部音频偏移量用于播放同步
              setAudioOffsetMs(project?.externalAudio?.offsetMs || 0);
            }
          })
          .catch(err => {
            console.error('[HTTP] Failed to start media server:', err);
            setError('启动媒体服务失败: ' + err);
            setVideoLoadError('媒体服务器启动失败，请检查后端服务');
            httpInitializedRef.current = false;
          });
      } else {
        invoke<string>('start_video_server', { videoPath: file })
          .then(url => {
            setVideoServerUrl(url);
          })
          .catch(err => {
            console.error('[HTTP] Failed to start server:', err);
            setError('启动视频服务失败: ' + err);
            setVideoLoadError('视频服务器启动失败，请检查后端服务');
            httpInitializedRef.current = false;
          });
      }
    }

    // 清理：只在从 long-preview 离开时停止
    return () => {
      if (currentPage !== 'long-preview' && httpInitializedRef.current) {
        invoke('stop_video_server').catch(console.error);
        setVideoServerUrl('');
        setAudioServerUrl(null);
        setAudioOffsetMs(0);
        httpInitializedRef.current = false;
        currentProjectRef.current = null;
      }
    };
  }, [currentPage, file]);

  // 配置管理
  const configRef = useRef<AppConfig | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSavingRef = useRef(false);

  const loadConfigFromFile = async (): Promise<AppConfig> => {
    try {
      const config = await loadConfig();
      return config;
    } catch (e) {
      console.error('加载配置失败:', e);
      return DEFAULT_CONFIG;
    }
  };

  const saveConfigToFile = async () => {
    if (!configRef.current) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(async () => {
      if (isSavingRef.current) return;
      isSavingRef.current = true;
      try {
        await saveConfig(configRef.current!);
      } catch (e) {
        console.error('保存配置失败:', e);
      } finally {
        isSavingRef.current = false;
      }
    }, 500);
  };


  useEffect(() => {
    const init = async () => {
      const config = await loadConfigFromFile();
      configRef.current = config;
      setLongVideoStep2Prompt(config.prompts.longStep2);
      setLongVideoModel(config.models.long || '');
      setEnableThinking(config.enableThinking ?? false);
      if (config.localLlm) {
        if (config.localLlm.baseUrl) setLocalBaseUrl(config.localLlm.baseUrl);
        if (config.localLlm.apiKey) setLocalApiKey(config.localLlm.apiKey);
      }
    };
    init();
  }, []);



  const [loading, setLoading] = useState(false);
  const { tasks: recognizingTasks, startRecognition, cancelRecognition } = useProjectRecognizer();

  const [activePlayerClip, setActivePlayerClip] = useState<HighlightClip | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [videoServerUrl, setVideoServerUrl] = useState<string>('');
  const [audioServerUrl, setAudioServerUrl] = useState<string | null>(null);
  const [audioOffsetMs, setAudioOffsetMs] = useState<number>(0);
  const activePlayerClipRef = useRef<HighlightClip | null>(null);
  const playerGlobalBackupRef = useRef<Sentence[]>([]);
  const httpInitializedRef = useRef(false);
  const resizeTimerRef = useRef<number>(0);

  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [thumbDimensions, setThumbDimensions] = useState<Record<string, {width: number; height: number}>>({});
  const [playerAspectRatio, setPlayerAspectRatio] = useState<string>('16/9');
  const [isVideoPortrait, setIsVideoPortrait] = useState(false);
  const [playerContainerSize, setPlayerContainerSize] = useState<{width: number; height: number} | null>(null);
  const playerContainerSizeRef = useRef(playerContainerSize);
  useEffect(() => { playerContainerSizeRef.current = playerContainerSize; }, [playerContainerSize]);

  // 缓存缩略图尺寸，避免 RAF 因 thumbDimensions 变化而重启
  const thumbDimensionsRef = useRef<Record<string, {width: number; height: number}>>({});
  useEffect(() => { thumbDimensionsRef.current = thumbDimensions; }, [thumbDimensions]);

  const thumbWsRef = useRef<WebSocket | null>(null);
  const requestedClipIdsRef = useRef<Set<string>>(new Set());

  // 原始句子数据
  const [originalSentences, setOriginalSentences] = useState<Sentence[]>([]);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isPlayerHovered, setIsPlayerHovered] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const openPlayerReqIdRef = useRef(0);

  const [isDragging, setIsDragging] = useState(false);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const loadingOverlayRef = useRef<HTMLDivElement>(null);


  const videoContainerRef = useRef<HTMLDivElement>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);

  // 播放器上次加载的片段关键字段，用于避免非关键字段（样式、编辑标记）变化导致重新加载
  const lastLoadedClipRef = useRef<{ id: string; startMs: number; endMs: number } | null>(null);

  const lastCheckTimeRef = useRef(0);
  const lastTimeUpdateStateRef = useRef(0);
  const isDraggingProgressRef = useRef(false);

  const [videoLoadError, setVideoLoadError] = useState<string>('');

  // 长视频流程状态
  const [longVideoText, setLongVideoText] = useState('');
  const [longVideoStep2Prompt, setLongVideoStep2Prompt] = useState(ConfigModuleDefaultConfig.prompts.longStep2);
  const [longVideoModel, setLongVideoModel] = useState('');
  const [enableThinking, setEnableThinking] = useState(false);
  const [localBaseUrl, setLocalBaseUrl] = useState('https://api.deepseek.com/v1/chat/completions');
  const [localApiKey, setLocalApiKey] = useState('');
  const [llmModels, setLlmModels] = useState<string[]>([]);
  const [isRefreshingLlmModels, setIsRefreshingLlmModels] = useState(false);

  // 从 OpenAI 兼容服务拉取可用模型列表
  const refreshLlmModels = async () => {
    if (!localBaseUrl.trim()) {
      setError('请先填写 API 地址');
      return;
    }
    setIsRefreshingLlmModels(true);
    try {
      const params = new URLSearchParams({ api_base: localBaseUrl, api_key: localApiKey });
      const res = await fetch(`http://127.0.0.1:8000/list_models?${params.toString()}`);
      const data = await res.json();
      if (data.success && Array.isArray(data.models)) {
        setLlmModels(data.models);
        setInfo(`已获取 ${data.models.length} 个模型`);
        if (data.models.length > 0 && !data.models.includes(longVideoModel)) {
          const first = data.models[0];
          setLongVideoModel(first);
          if (configRef.current) {
            configRef.current.models.long = first;
            saveConfigToFile();
          }
        }
      } else {
        setError(`获取模型列表失败: ${data.error || '未知错误'}`);
      }
    } catch (e) {
      setError(`获取模型列表失败: ${e}`);
    } finally {
      setIsRefreshingLlmModels(false);
    }
  };
  const [showLocalSettings, setShowLocalSettings] = useState(false);
  const localSettingsRef = useRef<HTMLDivElement>(null);
  const localSettingsGearRef = useRef<HTMLSpanElement>(null);

  // 点击外部关闭本地模型设置面板（齿轮按钮自身除外，否则 mousedown 关闭后 click 又会打开）
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (localSettingsRef.current && !localSettingsRef.current.contains(target)
          && !localSettingsGearRef.current?.contains(target)) {
        setShowLocalSettings(false);
      }
    };
    if (showLocalSettings) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showLocalSettings]);

  const [step2Result, setStep2Result] = useState('');
  const [highlightClips, setHighlightClips] = useState<HighlightClip[]>([]);
  const highlightClipsRef = useRef<HighlightClip[]>([]);
  useEffect(() => { highlightClipsRef.current = highlightClips; }, [highlightClips]);

  const [autoInferenceStep, setAutoInferenceStep] = useState<'idle' | 'inferencing' | 'done'>('idle');
  const [autoInferenceError, setAutoInferenceError] = useState('');
  const [inferenceInterrupted, setInferenceInterrupted] = useState(false);
  const autoInferenceAbortRef = useRef<AbortController | null>(null);
  const isInferenceStoppedRef = useRef(false);

  const autoInferenceTextareaRef = useRef<HTMLDivElement>(null);
  const step2RetryCount = useRef(0);
  const hasFirstClipMatched = useRef(false);
  const processedTimeRanges = useRef<Set<string>>(new Set());
  const step2Buffer = useRef('');

  const [selectedClipIds, setSelectedClipIds] = useState<Set<string>>(new Set());
  const [batchProgress, setBatchProgress] = useState<BatchProgress>({
    isProcessing: false,
    currentIndex: 0,
    total: 0,
    currentFilename: '',
    percent: 0,
    elapsedSeconds: 0
  });
  const [parseStats, setParseStats] = useState<{ success: number; fail: number } | null>(null);
  const parseStatsRef = useRef(parseStats);
  useEffect(() => { parseStatsRef.current = parseStats; }, [parseStats]);

  const [info, setInfo] = useState('');
  // 全局 info 浮条：4 秒后自动消失
  useEffect(() => {
    if (!info) return;
    const timer = setTimeout(() => setInfo(''), 4000);
    return () => clearTimeout(timer);
  }, [info]);

  const [promptSaveStatus, setPromptSaveStatus] = useState('');
  const [error, setError] = useState('');

  // 主动保存项目LLM结果（在推理完成后调用，而非防抖监听）
  const saveProjectLLMResults = useCallback(async (clips?: HighlightClip[]) => {
    if (!currentProjectId) return;
    try {
      const project = await loadProject(currentProjectId);
      if (project) {
        project.step2Result = step2Result || project.step2Result;
        project.highlightClips = clips || highlightClipsRef.current;
        project.parseStats = parseStatsRef.current || project.parseStats;
        await saveProject(project);
      }
    } catch (e) {
      console.error('[Project] 保存失败:', e);
    }
  }, [currentProjectId, step2Result]);

  const originalSentencesRef = useRef(originalSentences);
  useEffect(() => { originalSentencesRef.current = originalSentences; }, [originalSentences]);

  // UI 缩放比例：基于播放器容器高度自适应
  // 阈值随屏幕高度变化，确保不同分辨率下全屏/非全屏都有明显差异
  const playerHeight = playerContainerSize?.height ?? 540;
  const screenHeight = window.screen.height;
  const threshold = screenHeight * 0.875;
  const playerScale = playerHeight >= threshold
    ? 1
    : Math.min(0.9, Math.max(0.82, playerHeight / threshold));

  // 播放器打开时禁用页面滚动，关闭时恢复
  useEffect(() => {
    if (activePlayerClip) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [activePlayerClip]);

  const wasFullscreenBeforePlayerRef = useRef(false);
  useEffect(() => {
    const win = getCurrentWindow();
    // 播放器打开时全屏，关闭时恢复进入前的全屏状态
    // 注意：long-preview（精彩片段列表）不强制全屏，用户手动全屏后进入播放器也不会闪
    const shouldBeFullscreen = !!activePlayerClip;
    if (shouldBeFullscreen) {
      win.isFullscreen().then(fs => {
        wasFullscreenBeforePlayerRef.current = fs;
        if (!fs) {
          win.setFullscreen(true).catch(() => {});
        }
      }).catch(() => {});
    } else {
      if (!wasFullscreenBeforePlayerRef.current) {
        win.setFullscreen(false).catch(() => {});
      }
    }
  }, [activePlayerClip, currentPage]);

  // 监听片段变化（优化版：同一视频直接 Seek，不重启播放器）
  // 起播策略：先从 0 自然起播（遮罩+静音盖住预滚），播放建立后再 seek 到
  // 片段起点，定位稳定后揭幕——见 doPlayThenSeek 内注释
  useEffect(() => {
    // 同步 ref
    activePlayerClipRef.current = activePlayerClip;

    if (!activePlayerClip || !videoRef.current) {
      lastLoadedClipRef.current = null;
      return;
    }

    const video = videoRef.current as HTMLVideoElement;
    const clip = activePlayerClip;
    const startTime = clip.startMs / 1000;
    const endTime = clip.endMs / 1000;

    // 如果已经加载过相同的片段关键字段，只同步样式，不重置字幕/不重新加载视频
    const lastLoaded = lastLoadedClipRef.current;
    if (lastLoaded && lastLoaded.id === clip.id && lastLoaded.startMs === clip.startMs && lastLoaded.endMs === clip.endMs) {
      return;
    }

    // 真正的片段切换：加载视频

    lastLoadedClipRef.current = { id: clip.id, startMs: clip.startMs, endMs: clip.endMs };

    // 显示 loading
    const loadingOverlay = loadingOverlayRef.current;
    if (loadingOverlay) {
      loadingOverlay.style.opacity = '1';
      loadingOverlay.style.pointerEvents = 'auto';
    }

    // 设置播放范围（通过 handleTimeUpdate 监听限制）
    setDuration((endTime - startTime));
    setCurrentTime(0);

    // loading 隐藏：改由 play→seek 就位后的 reveal() 统一处理
    // （预滚阶段必须保持遮罩，不能在首个 playing 就揭幕）

    // 执行 play → seek（顺序刻意反转）：
    // 追踪日志证实：在 seek 后的位置上 play，WebKit 会在 play/playing 之后
    // 立即自发 seeking/seeked（解码会话从前一个关键帧重滚并把预滚画面播
    // 出来），即"片头播两次"；而先从 0 自然起播（无待完成 seek，不触发内
    // 部重滚；预滚被遮罩+静音盖住），播放建立后再定位到片段起点——等价
    // 于播放中拖动进度条，不经过该缺陷路径。全程只有一次 play() 调用。
    let removeLoadedMetadata: (() => void) | null = null;
    let removePlaying: (() => void) | null = null;
    let removeSeeked: (() => void) | null = null;
    let revealTimer: ReturnType<typeof setTimeout> | null = null;

    const doPlayThenSeek = () => {

      // 预滚阶段静音（分轨模式视频本就静音；单轨模式揭幕时恢复出声）
      video.muted = true;

      const reveal = () => {
        video.muted = !!audioRef.current;
        if (loadingOverlay) {
          loadingOverlay.style.opacity = '0';
          loadingOverlay.style.pointerEvents = 'none';
        }
        // 分轨模式：视频就位后再起外置音频（预滚阶段的 onPlay 已被守卫拦住）
        if (audioRef.current && audioRef.current.paused && !video.paused) {
          audioRef.current.currentTime = Math.max(0, video.currentTime - audioOffsetMs / 1000);
          audioRef.current.play().catch(() => {});
        }
      };

      const seekToStart = () => {
        if (Math.abs(video.currentTime - startTime) < 0.05) {
          revealTimer = setTimeout(reveal, 200);
          return;
        }
        const onSeekedAtTarget = () => {
          // 定位完成后稍作停留，等解码器稳定输出目标帧再揭幕
          revealTimer = setTimeout(reveal, 200);
        };
        video.addEventListener('seeked', onSeekedAtTarget, { once: true });
        removeSeeked = () => video.removeEventListener('seeked', onSeekedAtTarget);
        video.currentTime = startTime;
      };

      const onPlaying = () => seekToStart();
      video.addEventListener('playing', onPlaying, { once: true });
      removePlaying = () => video.removeEventListener('playing', onPlaying);

      video.play().catch(err => {
        console.error('[Player] Auto-play failed:', err);
      });
    };

    if (video.readyState >= 1) { // HAVE_METADATA
      doPlayThenSeek();
    } else {
      const onLoadedMetadata = () => { doPlayThenSeek(); };
      video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
      removeLoadedMetadata = () => video.removeEventListener('loadedmetadata', onLoadedMetadata);
    }

    return () => {
      removeLoadedMetadata?.();
      removePlaying?.();
      removeSeeked?.();
      if (revealTimer) clearTimeout(revealTimer);
      if (loadingOverlay) {
        loadingOverlay.style.opacity = '0';
        loadingOverlay.style.pointerEvents = 'none';
      }
    };
  }, [activePlayerClip]);

  // 关闭播放器：暂停视频并保存编辑
  const closePlayer = () => {
    // 关闭时使挂起的 openPlayer 异步结果失效，避免旧请求回写当前音频状态
    openPlayerReqIdRef.current += 1;

    // 关键：必须先重置播放状态，否则关闭后 isPlaying 仍为 true，
    // 重新打开时 RAF 会在 activePlayerClipRef 还没设置前就启动，第一帧就会停止
    setIsPlaying(false);

    setPlayerAspectRatio('16/9');
    setPlayerContainerSize(null);

    // 安全卸载视频：主动触发 WebKit 释放硬件解码器，避免下次新建 video DOM 时竞争
    const closingVideo = videoRef.current;
    if (closingVideo) {
      import('./utils/videoTeardown').then(({ teardownVideo }) => {
        // 只 teardown 关闭时捕获的旧元素，避免异步回调误伤重新打开后的新 video
        teardownVideo(closingVideo);
      });
    }

    // 关闭播放器时把片段私有字幕副本写回片段数据
    const currentClip = activePlayerClipRef.current;
    if (currentClip) {
      const updatedClip = { ...currentClip };
      // 保存字幕文本（片段私有副本，深拷贝）
      if (originalSentencesRef.current.length > 0) {
        updatedClip.sourceSentences = JSON.parse(JSON.stringify(originalSentencesRef.current));
      }
      const nextClips = highlightClipsRef.current.map(c => c.id === updatedClip.id ? updatedClip : c);
      highlightClipsRef.current = nextClips;
      setHighlightClips(nextClips);

      if (currentProjectId) {
        (async () => {
          try {
            const project = await loadProject(currentProjectId);
            if (project) {
              project.highlightClips = nextClips;
              await saveProject(project);
            }
          } catch (e) {
            console.error('[Project] 保存失败:', e);
          }
        })();
      }
    }

    // 清理加载遮罩
    const loadingOverlay = loadingOverlayRef.current;
    if (loadingOverlay) {
      loadingOverlay.style.opacity = '0';
      loadingOverlay.style.pointerEvents = 'none';
    }

    // 重置状态
    setActivePlayerClip(null);
    activePlayerClipRef.current = null;
    lastLoadedClipRef.current = null;
    setVideoLoadError('');

    // 恢复全局字幕（播放器期间被临时替换为片段副本）
    setOriginalSentences(playerGlobalBackupRef.current);

    // 关闭播放器后释放大内存对象
    playerGlobalBackupRef.current = [];

    // 注意：不切断 src、不重置解码器、不停止 HTTP 服务器，留在页面级复用
  };
  // 键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && activePlayerClip) {
        closePlayer();
      }
      // 空格键播放/暂停：编辑字幕模式、画幅调整模式、或焦点在输入框/文本区时不触发
      const target = e.target as HTMLElement;
      const isInputFocused = target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      );
      if (e.key === ' ' && activePlayerClip && videoRef.current && !isInputFocused) {
        e.preventDefault();
        if (videoRef.current.paused) {
          videoRef.current.play();
        } else {
          videoRef.current.pause();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activePlayerClip]);

  // 全局拖拽事件（普通模式进度条拖动 seek）
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging || !videoRef.current || !activePlayerClipRef.current) return;
      const clip = activePlayerClipRef.current;
      const progressRect = progressBarRef.current?.getBoundingClientRect();
      if (!progressRect) return;
      const clickPercent = Math.max(0, Math.min(1, (e.clientX - progressRect.left) / progressRect.width));
      const totalMs = clip.endMs - clip.startMs;
      const targetMs = clip.startMs + (totalMs * clickPercent);
      videoRef.current.currentTime = targetMs / 1000;
      requestAnimationFrame(() => {
        setCurrentTime((targetMs - clip.startMs) / 1000);
      });
    };
    const handleMouseUp = () => {
      setIsDragging(false);
      isDraggingProgressRef.current = false;
    };
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  // 识别
  const { handleAutoInference, handleStopAutoInference } = useAutoInference({
    autoInferenceAbortRef,
    autoInferenceTextareaRef,
    step2RetryCount,
    hasFirstClipMatched,
    isInferenceStoppedRef,
    processedTimeRanges,
    step2Buffer,
    longVideoText,
    longVideoStep2Prompt,
    longVideoModel,
    enableThinking,
    localBaseUrl,
    localApiKey,
    originalSentences,
    setError,
    setInfo,
    setStep2Result,
    setCurrentPage,
    setHighlightClips,
    setParseStats,
    setAutoInferenceStep,
    setAutoInferenceError,
    setInferenceInterrupted,
    saveProjectLLMResults
  });

  // 自动推理



  // 真正离开 long-preview 页面时，停止正在进行的推理
  // 用 prevPageRef 避免 React Strict Mode 的组件模拟卸载误触发
  const prevPageRef = useRef(currentPage);
  useEffect(() => {
    const prevPage = prevPageRef.current;
    if (prevPage === 'long-preview' && currentPage !== 'long-preview') {
      if (isInferenceStoppedRef.current === false && autoInferenceAbortRef.current) {
        handleStopAutoInference();
      }
    }
    prevPageRef.current = currentPage;
  }, [currentPage, handleStopAutoInference]);

  // 从持久化目录加载已有缩略图（不依赖后端）
  const loadPersistedThumbnails = useCallback(async (clips: HighlightClip[]) => {
    if (!currentProjectId) return new Set<string>();
    try {
      const thumbDir = await getProjectThumbsDir(currentProjectId);
      const loadedIds = new Set<string>();
      for (const clip of clips) {
        const thumbPath = await join(thumbDir, `${clip.id}_${clip.startMs}.jpg`);
        if (await exists(thumbPath)) {
          const assetUrl = convertFileSrc(thumbPath);
          setThumbnails(prev => {
            if (prev[clip.id]) return prev;
            return { ...prev, [clip.id]: assetUrl };
          });
          // 异步获取图片尺寸
          const img = new Image();
          img.onload = () => {
            setThumbDimensions(prev => ({
              ...prev,
              [clip.id]: { width: img.naturalWidth, height: img.naturalHeight }
            }));
          };
          img.src = assetUrl;
          loadedIds.add(clip.id);
        }
      }
      return loadedIds;
    } catch (e) {
      console.error('加载持久化缩略图失败:', e);
      return new Set<string>();
    }
  }, [currentProjectId]);

  // 缩略图 WebSocket
  const connectThumbWebSocket = useCallback(async (clipsToGenerate: HighlightClip[]) => {
    if (clipsToGenerate.length === 0 || !file || !currentProjectId) return;
    const thumbDir = await getProjectThumbsDir(currentProjectId);
    const ws = new WebSocket(`ws://127.0.0.1:8000/thumb_ws`);
    thumbWsRef.current = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({
        video_path: file,
        thumb_dir: thumbDir,
        clips: clipsToGenerate.map(c => ({
          id: c.id,
          start_ms: c.startMs
        }))
      }));
    };
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case 'thumb':
          if (data.path) {
            setThumbnails((prev: Record<string, string>) => ({
              ...prev,
              [data.clip_id]: convertFileSrc(data.path)
            }));
            if (data.width && data.height) {
              setThumbDimensions((prev: Record<string, {width: number; height: number}>) => ({
                ...prev,
                [data.clip_id]: { width: data.width, height: data.height }
              }));
            }
          }
          break;
        case 'error':
          console.error(`缩略图生成失败: ${data.clip_id}`, data.error);
          break;
        case 'complete':
          ws.close();
          thumbWsRef.current = null;
          break;
      }
    };
    ws.onerror = () => {
      console.error('缩略图WebSocket错误');
    };
  }, [file, currentProjectId]);

  // 组件卸载清理
  useEffect(() => {
    return () => {
      if (thumbWsRef.current) {
        thumbWsRef.current.close();
        thumbWsRef.current = null;
      }
      requestedClipIdsRef.current.clear();
    };
  }, []);

  // 播放器窗口大小变化时实时重算容器尺寸
  useEffect(() => {
    if (!activePlayerClip) return;
    const handleResize = () => {
      clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = window.setTimeout(() => {
        const maxW = window.innerWidth * 0.9;
        const maxH = window.innerHeight * 0.9;
        // 横屏：优先用缩略图比例，避免 metadata 阶段短暂异常比例导致跳变
        const currentClip = activePlayerClipRef.current || activePlayerClip;
        const thumbDim = currentClip ? thumbDimensions[currentClip.id] : undefined;
        const ratio = thumbDim && thumbDim.height > 0
          ? thumbDim.width / thumbDim.height
          : (() => {
              const video = videoRef.current;
              return (video && video.videoWidth && video.videoHeight)
                ? video.videoWidth / video.videoHeight
                : 16 / 9;
            })();
        const vH = 1000;
        const vW = Math.round(vH * ratio);
        const scale = Math.min(maxW / vW, maxH / vH);
        const next = { width: Math.round(vW * scale), height: Math.round(vH * scale) };
        setPlayerContainerSize(next);
      }, 100);
    };
    window.addEventListener('resize', handleResize);
    // 打开播放器后立即按当前窗口尺寸计算一次，避免仅依赖后续 resize 事件
    handleResize();
    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = 0;
    };
  }, [activePlayerClip, thumbDimensions]);

  const openPlayer = async (clip: HighlightClip) => {
    const reqId = ++openPlayerReqIdRef.current;
    const isStale = () => openPlayerReqIdRef.current !== reqId;
    const toFinite = (v: any, fallback: number) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

    // 防御：从 ref 中获取最新的 clip 数据，避免竞态导致旧数据
    const latestClip = highlightClipsRef.current.find(c => c.id === clip.id) || clip;
    // 提前同步 ref，避免 useEffect 执行顺序竞态导致 RAF 启动时 clip 为 null
    activePlayerClipRef.current = latestClip;
    setVideoLoadError('');

      // 横屏比例
      const thumbDim = thumbDimensions[clip.id];
      const ratio = thumbDim && thumbDim.height > 0 ? thumbDim.width / thumbDim.height : 16 / 9;
      const maxW = window.innerWidth * 0.9;
      const maxH = window.innerHeight * 0.9;
      const refH = 1000;
      const refW = refH * ratio;
      const scale = Math.min(maxW / refW, maxH / refH);
      const next = { width: Math.round(refW * scale), height: Math.round(refH * scale) };
      setPlayerContainerSize(next);
      setPlayerAspectRatio('16/9');

    // 备份当前全局字幕，然后加载该片段的私有副本到全局
    playerGlobalBackupRef.current = originalSentencesRef.current;
    if (clip.subtitleEdited && clip.sourceSentences && clip.sourceSentences.length > 0) {
      setOriginalSentences(JSON.parse(JSON.stringify(clip.sourceSentences)));
    } else {
      const rangeSentences = originalSentencesRef.current.filter(s =>
        s.end > clip.startMs && s.start < clip.endMs
      );
      setOriginalSentences(JSON.parse(JSON.stringify(rangeSentences)));
    }

    setActivePlayerClip(clip);
  };

  const playerCtx = {
    activePlayerClip,
    activePlayerClipRef,
    cleanPunctuation,
    closePlayer,
    currentTime,
    duration,
    highlightClipsRef,
    isDragging,
    isDraggingProgressRef,
    isPlayerHovered,
    isPlaying,
    lastCheckTimeRef,
    lastLoadedClipRef,
    lastTimeUpdateStateRef,
    loadingOverlayRef,
    originalSentencesRef,
    progressBarRef,
    setActivePlayerClip,
    setCurrentTime,
    setDuration,
    setHighlightClips,
    setIsDragging,
    setIsPlayerHovered,
    setIsPlaying,
    setOriginalSentences,
    setPlayerAspectRatio,
    setPlayerContainerSize,
    setVideoLoadError,
    thumbDimensions,
    thumbnails,
    videoContainerRef,
    videoLoadError,
    videoRef,
    audioRef,
    videoServerUrl,
    audioServerUrl,
    audioOffsetMs,
    playerContainerRef,
    playerContainerSize,
    playerScale,
  };

// 首页大入口卡片（与商业版一致的排版）
const HomeEntryCard = ({ onClick }: { onClick: () => void }) => {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 380,
        borderRadius: 28,
        padding: '32px 36px',
        cursor: 'pointer',
        position: 'relative',
        overflow: 'hidden',
        minHeight: 260,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        background: 'linear-gradient(135deg, #f093fb 0%, #ff786e 100%)',
        boxShadow: hovered
          ? '0 24px 56px rgba(245, 87, 108, 0.25)'
          : '0 16px 40px rgba(245, 87, 108, 0.25)',
        transform: hovered ? 'translateY(-6px) scale(1.02)' : 'translateY(0) scale(1)',
        transition: 'transform 0.3s ease, box-shadow 0.3s ease',
      }}
    >
      {/* 装饰光晕 */}
      <div
        style={{
          position: 'absolute',
          top: '-50%',
          right: '-30%',
          width: 280,
          height: 280,
          background: 'rgba(255,255,255,0.12)',
          borderRadius: '50%',
          pointerEvents: 'none',
        }}
      />
      <div style={{ position: 'relative', zIndex: 2, textAlign: 'left' }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: 1.5,
            textTransform: 'uppercase',
            opacity: 0.9,
            marginBottom: 16,
            color: '#fff',
          }}
        >
          Long Video
        </div>
        <h2
          style={{
            fontSize: 40,
            fontWeight: 800,
            marginBottom: 20,
            letterSpacing: -1,
            lineHeight: 1.1,
            color: '#fff',
          }}
        >
          长视频
          <br />
          精彩切片
        </h2>
        <p
          style={{
            fontSize: 16,
            color: '#fff',
            opacity: 0.95,
            lineHeight: 1.6,
            marginBottom: 8,
          }}
        >
          AI 提取精彩片段，批量生成带标题、描述、标签的爆款短视频。
        </p>
        <p
          style={{
            fontSize: 15,
            color: '#fff',
            opacity: 0.85,
            lineHeight: 1.6,
            marginBottom: 28,
          }}
        >
          场景：演讲、播客、课程、直播回放等
        </p>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '13px 26px',
            background: '#fff',
            color: '#1d1d1f',
            borderRadius: 999,
            fontSize: 16,
            fontWeight: 700,
            border: 'none',
            cursor: 'pointer',
            opacity: 0.85,
            transition: 'opacity 0.2s, background 0.2s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = '1';
            e.currentTarget.style.background = 'rgba(250, 250, 250, 1)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = '0.85';
            e.currentTarget.style.background = '#fff';
          }}
        >
          立即开始 →
        </button>
      </div>
    </div>
  );
};

  return (
    <div className="container">
      {/* 全局提示浮条 */}
      {(info || loading) && (
        <div style={{
          position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 1000,
          padding: '8px 20px', background: 'rgba(40,40,45,0.92)', color: '#fff',
          borderRadius: '8px', fontSize: '13px', boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
          pointerEvents: 'none', maxWidth: '80%', textAlign: 'center'
        }}>
          {loading ? '正在打开项目...' : info}
        </div>
      )}

      {/* 悬浮播放器（key 已移除：复用同一组件实例，避免频繁重建 video DOM 触发 VTDecoderXPCService 竞争） */}
      {activePlayerClip && (
        <PlayerProvider value={playerCtx as any}>
          <VideoPlayer />
        </PlayerProvider>
      )}

      {/* 首页 */}
      {currentPage === 'home' && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10,
            display: 'flex',
            flexDirection: 'column',
            color: '#1d1d1f',
            overflow: 'hidden',
            background: 'linear-gradient(135deg, #faf8ff 0%, #fff5f7 50%, #f0f9ff 100%)',
          }}
        >
          {/* 顶部栏 */}
          <header
            style={{
              height: 72,
              display: 'flex',
              alignItems: 'center',
              padding: '0 32px',
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 20, fontWeight: 700 }}>
              <img src="./logo.png" alt="KnowClip" style={{ height: 32, display: 'block' }} />
              <span>智能剪辑</span>
            </div>
          </header>

          {/* 主体 */}
          <main
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '40px 24px',
              overflowY: 'auto',
            }}
          >
            <h1 style={{ fontSize: 42, fontWeight: 800, letterSpacing: -1, color: '#1d1d1f', margin: '0 0 48px' }}>
              你想创作什么？
            </h1>
            <HomeEntryCard onClick={() => setCurrentPage('project-space')} />
          </main>
        </div>
      )}

      {/* 长视频项目空间 */}
      {currentPage === 'project-space' && (
        <ProjectSpacePage
          projectType="long"
          onCreateProject={() => {
            setCurrentPage('project-create');
          }}
          onOpenProject={async (projectId) => {
            try {
              setLoading(true);
              const project = await loadProject(projectId);
              if (!project) {
                setError('项目不存在或已损坏');
                setLoading(false);
                return;
              }
              // 检查识别状态
              if (project.recognitionStatus === 'recognizing') {
                setError('项目正在识别中，请稍后再试');
                setLoading(false);
                return;
              }
              // 检查视频文件是否还存在
              const videoExists = await exists(project.videoPath);
              if (!videoExists) {
                setError(`视频文件不存在或已被移动：${project.videoPath}`);
                setLoading(false);
                return;
              }
              // 加载项目数据到状态（安全默认值防止 undefined 导致白屏）
              setCurrentProjectId(project.id);
              currentProjectRef.current = project;
              // 分轨模式：始终使用原始视频，外部音频由播放器/导出时独立处理
              setFile(project.videoPath);
              const loadedSentences = (project.sentences || []).map((s: any, i: number) => {
                const withId = s.id ? s : { ...s, id: `sent-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}` };
                const withOriginalWords = withId.originalWords ? withId : { ...withId, originalWords: withId.words ? JSON.parse(JSON.stringify(withId.words)) : undefined };
                return withOriginalWords.preservePunctuation !== undefined ? withOriginalWords : { ...withOriginalWords, preservePunctuation: false };
              });
              setOriginalSentences(loadedSentences);
              setLongVideoText(project.text || '');
              // 恢复LLM结果（如果有）
              if (project.step2Result) setStep2Result(project.step2Result);
              if (project.parseStats) setParseStats(project.parseStats);

              if (project.highlightClips && project.highlightClips.length > 0) {
                // 已有精彩片段，直接跳转到精彩片段页面
                setHighlightClips(project.highlightClips);
                // 填充已处理时间范围，避免对已有片段的时间段重复提取
                processedTimeRanges.current.clear();
                project.highlightClips.forEach((clip: any) => {
                  processedTimeRanges.current.add(`${clip.startMs}-${clip.endMs}`);
                });
                setAutoInferenceStep('idle');
                setInfo(`已加载项目：${project.name}，共 ${project.highlightClips.length} 个片段`);
                setCurrentPage('long-preview');
              } else {
                // 无精彩片段，进入配置页
                setHighlightClips([]);
                setAutoInferenceStep('idle');
                setInfo(`已加载项目：${project.name}`);
                setCurrentPage('long-config');
              }
              setLoading(false);
            } catch (e) {
              console.error('[Project] Failed to open:', e);
              setError('加载项目失败: ' + e);
              setLoading(false);
            }
          }}
          onBack={() => setCurrentPage('home')}
          recognizingTasks={recognizingTasks}
          onCancelRecognition={(projectId) => cancelRecognition(projectId)}
          error={error}
        />
      )}

      {/* 创建项目页 */}
      {currentPage === 'project-create' && (
        <ProjectCreatePage
          onStartRecognize={async (filePath, name) => {
            setInfo('正在启动识别任务...');
            try {
              const result = await startRecognition(filePath, name);
              if (!result) {
                setError('启动识别失败');
                setCurrentPage('project-create');
              }
            } catch (e) {
              console.error('启动识别失败:', e);
              setError('启动识别失败: ' + (e instanceof Error ? e.message : String(e)));
              setCurrentPage('project-create');
            }
          }}
          onNavigateProjectSpace={() => setCurrentPage('project-space')}
          onNavigateHome={() => setCurrentPage('home')}
        />
      )}
      {/* 长视频配置页 */}
      {currentPage === 'long-config' && (
        <div style={{ padding: '20px 20px 20px', margin: '0 auto', display: 'flex', flexDirection: 'column', height: '100%', gap: '12px', overflow: 'hidden', boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
            <h1 style={{ color: '#f5576c', margin: 0, display: 'flex', alignItems: 'center', gap: '12px' }}><Sparkle weight="fill" size={22} /> AI推理精彩片段</h1>
            <button
              onClick={() => {
                setCurrentPage('project-space');
              }}
              style={{
                padding: '8px 16px',
                background: '#f0f0f0',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '13px',
                color: '#666'
              }}
            >
              返回项目空间
            </button>
          </div>

          {/* 结果展示卡片 */}
          <div style={{ flex: 1, minHeight: '0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ marginBottom: '8px', fontSize: '14px', color: '#666', flexShrink: 0 }}>
              {autoInferenceStep === 'idle' && !inferenceInterrupted ? (
                <><TextAlignLeft weight="fill" size={16} /> 完整字幕（{longVideoText.length} 字）</>
              ) : autoInferenceStep === 'idle' && inferenceInterrupted ? (
                <span style={{ color: '#999' }}>推理已暂停</span>
              ) : autoInferenceStep === 'inferencing' ? (
                <span style={{ color: '#f5576c', fontWeight: 500, display: 'flex', alignItems: 'center' }}>
                  AI 正在阅读字幕原文（约 {longVideoText.length} 字），{enableThinking ? '深度思考模式已开启，分析更深度，预计需要 30–60 秒' : '首次分析预计需要 10–30 秒'}，请耐心等待
                  <span className="thinking-wave"><span></span><span></span><span></span><span></span></span>
                </span>
              ) : (
                <span style={{ color: '#28CA41', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '6px' }}><CheckCircle weight="fill" size={16} /> 推理完成</span>
              )}
            </div>
            <div
              ref={autoInferenceTextareaRef}
              style={{
                flex: 1,
                overflow: 'auto',
                minWidth: 0,
                boxSizing: 'border-box',
                padding: '16px 8px 16px 16px',
                borderRadius: '8px',
                border: autoInferenceStep !== 'idle' ? '2px solid #f5576c' : '1px solid #e0e0e0',
                fontSize: '15px',
                lineHeight: '1.6',
                background: '#fafafa',
                fontFamily: 'monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
              }}
            >{longVideoText}</div>

          </div>

          {autoInferenceError && (
            <div style={{ padding: '12px 16px', background: '#f8d7da', borderRadius: '8px', fontSize: '14px', color: '#721c24', flexShrink: 0 }}>
              <XCircle weight="fill" size={16} /> {autoInferenceError}
            </div>
          )}

          {error && (
            <div style={{ padding: '12px 16px', background: '#f8d7da', borderRadius: '8px', fontSize: '14px', color: '#721c24', flexShrink: 0 }}>
              <XCircle weight="fill" size={16} /> {error}
            </div>
          )}

          {/* 提示词编辑卡片 */}
          <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '12px 16px', background: '#f5f5f7', borderRadius: '8px', flexShrink: 0 }}>
            <div style={{ marginBottom: '8px', fontSize: '14px', color: '#666', fontWeight: 500, flexShrink: 0 }}>
              提示词（可修改）：
            </div>
            <textarea
              value={longVideoStep2Prompt}
              onChange={(e) => setLongVideoStep2Prompt(e.target.value)}
              rows={9}
              style={{
                minWidth: 0,
                boxSizing: 'border-box',
                padding: '12px 8px 12px 12px',
                borderRadius: '8px',
                border: '1px solid #d1d1d6',
                fontSize: '14px',
                lineHeight: '1.5',
                resize: 'none',
                overflow: 'auto'
              }}
            />
            {configRef.current && longVideoStep2Prompt !== configRef.current.prompts.longStep2 && (
              <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexShrink: 0, alignItems: 'center' }}>
                {promptSaveStatus ? (
                  <span style={{ fontSize: '12px', color: '#28CA41' }}>
                    {promptSaveStatus}
                  </span>
                ) : (
                  <>
                    <button
                      onClick={async () => {
                        if (!configRef.current) return;
                        try {
                          configRef.current.prompts.longStep2 = longVideoStep2Prompt;
                          await saveConfig(configRef.current);
                          setPromptSaveStatus('提示词已保存');
                          setError('');
                          setTimeout(() => setPromptSaveStatus(''), 3000);
                        } catch (e) {
                          setError('保存失败: ' + (e instanceof Error ? e.message : String(e)));
                        }
                      }}
                      style={{
                        padding: '6px 12px',
                        background: '#f5576c',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '12px',
                        fontWeight: 500
                      }}
                    >
                      保存提示词
                    </button>
                    <button
                      onClick={async () => {
                        const defaultValue = ConfigModuleDefaultConfig.prompts.longStep2;
                        setLongVideoStep2Prompt(defaultValue);
                        if (configRef.current) {
                          try {
                            configRef.current.prompts.longStep2 = defaultValue;
                            await saveConfig(configRef.current);
                            setPromptSaveStatus('已恢复默认并保存');
                            setError('');
                            setTimeout(() => setPromptSaveStatus(''), 3000);
                          } catch (e) {
                            setError('恢复默认失败: ' + (e instanceof Error ? e.message : String(e)));
                          }
                        }
                      }}
                      style={{
                        padding: '6px 12px',
                        background: '#f0f0f0',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '12px',
                        color: '#666'
                      }}
                    >
                      恢复默认
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {/* 底部操作栏 */}
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            {/* 模型选择 + 设置 */}
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', position: 'relative' }}>
              <span
                ref={localSettingsGearRef}
                onClick={() => {
                  const next = !showLocalSettings;
                  setShowLocalSettings(next);
                  if (next && localBaseUrl.trim() && localApiKey.trim() && llmModels.length === 0) {
                    refreshLlmModels();
                  }
                }}
                title="LLM 服务设置"
                style={{
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: showLocalSettings ? '#f5576c' : '#999',
                  transition: 'color 0.2s',
                  userSelect: 'none',
                }}
              >
                <Gear weight="fill" size={20} />
              </span>
              <select
                value={longVideoModel}
                onChange={(e) => {
                  const newModel = e.target.value;
                  setLongVideoModel(newModel);
                  if (configRef.current) {
                    configRef.current.models.long = newModel;
                    saveConfigToFile();
                  }
                }}
                style={{ padding: '10px', borderRadius: '6px', border: '1px solid #d1d1d6', fontSize: '14px', minWidth: '150px', color: longVideoModel ? '#1d1d1f' : '#999' }}
              >
                {llmModels.length === 0 && (
                  <option value="">{longVideoModel || '请先获取模型列表'}</option>
                )}
                {llmModels.length > 0 && !llmModels.includes(longVideoModel) && longVideoModel && (
                  <option value={longVideoModel}>{longVideoModel}</option>
                )}
                {llmModels.map((id) => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>

              {/* 本地模型设置面板 */}
              {showLocalSettings && (
                <div
                  ref={localSettingsRef}
                  style={{
                    position: 'absolute',
                    bottom: 'calc(100% + 8px)',
                    left: 0,
                    zIndex: 100,
                    background: '#fff',
                    border: '1px solid #e0e0e0',
                    borderRadius: '8px',
                    padding: '16px',
                    boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px',
                    width: '320px',
                  }}
                >
                  <div style={{ fontSize: '14px', fontWeight: 600, color: '#333', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Gear weight="fill" size={16} color="#f5576c" /> LLM 服务设置
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '12px', color: '#666' }}>API 地址</label>
                    <input
                      type="text"
                      value={localBaseUrl}
                      onChange={(e) => {
                        const val = e.target.value;
                        setLocalBaseUrl(val);
                        if (configRef.current) {
                          configRef.current.localLlm = { baseUrl: val, apiKey: localApiKey };
                          saveConfigToFile();
                        }
                      }}
                      placeholder="https://api.deepseek.com/v1/chat/completions"
                      style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid #d1d1d6', fontSize: '13px' }}
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '12px', color: '#666' }}>API Key</label>
                    <input
                      type="password"
                      value={localApiKey}
                      onChange={(e) => {
                        const val = e.target.value;
                        setLocalApiKey(val);
                        if (configRef.current) {
                          configRef.current.localLlm = { baseUrl: localBaseUrl, apiKey: val };
                          saveConfigToFile();
                        }
                      }}
                      placeholder="sk-..."
                      style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid #d1d1d6', fontSize: '13px' }}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <button
                      onClick={refreshLlmModels}
                      disabled={isRefreshingLlmModels}
                      style={{
                        padding: '6px 12px',
                        background: '#f5576c',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: isRefreshingLlmModels ? 'not-allowed' : 'pointer',
                        opacity: isRefreshingLlmModels ? 0.6 : 1,
                        fontSize: '12px',
                        fontWeight: 500,
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '6px',
                      }}
                    >
                      <ArrowsClockwise size={12} weight="bold" />
                      {isRefreshingLlmModels ? '刷新中...' : '获取模型列表'}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* 深度思考开关 */}
            <label className="thinking-toggle">
                <input
                  type="checkbox"
                  checked={enableThinking}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setEnableThinking(next);
                    if (configRef.current) {
                      configRef.current.enableThinking = next;
                      saveConfigToFile();
                    }
                  }}
                />
                <span className="thinking-toggle-slider" />
                <span className="thinking-toggle-label">
                  深度思考
                </span>
              </label>

            <button
              onClick={autoInferenceStep === 'inferencing' ? handleStopAutoInference : handleAutoInference}
              disabled={!longVideoText && autoInferenceStep === 'idle'}
              style={{
                padding: '10px 24px',
                background: autoInferenceStep === 'inferencing' ? '#FFBD2E' : '#f5576c',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: (!longVideoText && autoInferenceStep === 'idle') ? 'not-allowed' : 'pointer',
                opacity: (!longVideoText && autoInferenceStep === 'idle') ? 0.6 : 1,
                fontSize: '14px',
                fontWeight: 500,
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              {autoInferenceStep === 'inferencing' ? <><Stop weight="fill" size={18} /> 停止推理</> : <><Play weight="fill" size={18} /> 开始推理</>}
            </button>
          </div>

        </div>
      )}

      {/* 长视频片段列表页 */}
      {/* 长视频片段列表页 */}
      {currentPage === 'long-preview' && (
        <LongPreviewPage
          highlightClips={highlightClips}
          file={file}
          thumbnails={thumbnails}
          setSelectedClipIds={setSelectedClipIds}
          selectedClipIds={selectedClipIds}
          setError={setError}
          setInfo={setInfo}
          autoInferenceStep={autoInferenceStep}
          batchProgress={batchProgress}
          setBatchProgress={setBatchProgress}
          parseStats={parseStats}
          setHighlightClips={setHighlightClips}
          setCurrentPage={setCurrentPage}
          handleStopAutoInference={handleStopAutoInference}
          connectThumbWebSocket={connectThumbWebSocket}
          loadPersistedThumbnails={loadPersistedThumbnails}
          requestedClipIdsRef={requestedClipIdsRef}
          thumbWsRef={thumbWsRef}
          saveProjectLLMResults={saveProjectLLMResults}
          thumbDimensions={thumbDimensions}
          onOpenPlayer={openPlayer}
          currentProjectId={currentProjectId}
        />
      )}
    </div>
  );
}

export default App;
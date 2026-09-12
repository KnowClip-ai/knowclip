import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { HighlightClip, BatchProgress } from '../../types';
import { formatTimeMs } from '../../utils';
import { FilmStrip, Scissors, XCircle } from '@phosphor-icons/react';
import { confirm, open } from '@tauri-apps/plugin-dialog';
import { videoDir } from '@tauri-apps/api/path';
import { loadProject, listProjects } from '../../projects';

// ========== 长视频卡片列表页面组件 ==========
interface LongPreviewPageProps {
  highlightClips: HighlightClip[];
  file: string | null;
  thumbnails: Record<string, string>;
  setSelectedClipIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  selectedClipIds: Set<string>;
  setError: (error: string) => void;
  setInfo: (info: string) => void;
  autoInferenceStep: 'idle' | 'inferencing' | 'done';
  batchProgress: BatchProgress;
  setBatchProgress: React.Dispatch<React.SetStateAction<BatchProgress>>;
  parseStats: { success: number; fail: number } | null;
  setHighlightClips: React.Dispatch<React.SetStateAction<HighlightClip[]>>;
  setCurrentPage: React.Dispatch<React.SetStateAction<'home' | 'project-space' | 'project-create' | 'long-config' | 'long-preview'>>;
  handleStopAutoInference: () => void;
  connectThumbWebSocket: (clips: HighlightClip[]) => void;
  loadPersistedThumbnails?: (clips: HighlightClip[]) => Promise<Set<string>>;
  requestedClipIdsRef: React.MutableRefObject<Set<string>>;
  thumbWsRef: React.MutableRefObject<WebSocket | null>;
  saveProjectLLMResults: (clips?: HighlightClip[]) => Promise<void>;
  thumbDimensions: Record<string, {width: number; height: number}>;
  onOpenPlayer: (clip: HighlightClip) => void;
  currentProjectId: string | null;
}

export const LongPreviewPage = ({
  highlightClips,
  file,
  thumbnails,
  thumbDimensions,
  setSelectedClipIds,
  selectedClipIds,
  setError,
  setInfo,
  autoInferenceStep,
  batchProgress,
  setBatchProgress,
  parseStats,
  setHighlightClips,
  setCurrentPage,
  handleStopAutoInference,
  connectThumbWebSocket,
  loadPersistedThumbnails,
  requestedClipIdsRef,
  thumbWsRef,
  saveProjectLLMResults,
  onOpenPlayer,
  currentProjectId
}: LongPreviewPageProps) => {
  const [sortMode, setSortMode] = useState<'created' | 'time' | 'score'>('created');
  const clipGridRef = useRef<HTMLDivElement>(null);
  const [portraitMinH, setPortraitMinH] = useState<number | undefined>(undefined);
  const [landscapeMinH, setLandscapeMinH] = useState<number | undefined>(undefined);



  // 注：离开 long-preview 时停止推理的逻辑已移到 App 组件层面，
  // 避免 React Strict Mode 的组件模拟卸载导致误杀正在进行的推理。

  const handleDiscardClip = async (clipId: string) => {
    const ok = await confirm('确认剔除该精彩片段？', { title: '剔除确认', kind: 'warning' });
    if (!ok) return;
    const nextClips = highlightClips.filter(c => c.id !== clipId);
    setHighlightClips(nextClips);
    setSelectedClipIds(prev => {
      const next = new Set(prev);
      next.delete(clipId);
      return next;
    });
    // 延迟保存到下一帧，避免阻塞 UI 移除动画
    requestAnimationFrame(() => {
      saveProjectLLMResults(nextClips);
    });
  };

  const sortedClips = useMemo(() => {
    return [...highlightClips].sort((a, b) => {
      if (sortMode === 'created') {
        // 保持原始数组顺序（生成时间从早到晚）
        return 0;
      } else if (sortMode === 'time') {
        return a.startMs - b.startMs;
      } else {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return a.startMs - b.startMs;
      }
    });
  }, [highlightClips, sortMode]);

  const validClips = sortedClips;

  useEffect(() => {
    const grid = clipGridRef.current;
    if (!grid) return;
    let raf: number;
    const measure = () => {
      const cards = Array.from(grid.children) as HTMLElement[];
      if (cards.length === 0) return;
      // 临时移除 minHeight，测量自然高度
      const saved = cards.map(c => c.style.minHeight);
      cards.forEach(c => { c.style.minHeight = ''; });
      grid.getBoundingClientRect(); // 强制回流
      let maxP = 0;
      let maxL = 0;
      cards.forEach(card => {
        const h = card.getBoundingClientRect().height;
        const isP = card.dataset.isPortrait === 'true';
        if (isP) maxP = Math.max(maxP, h);
        else maxL = Math.max(maxL, h);
      });
      // 恢复之前的 minHeight
      cards.forEach((c, i) => { c.style.minHeight = saved[i]; });
      setPortraitMinH(prev => maxP > 0 ? maxP : prev);
      setLandscapeMinH(prev => maxL > 0 ? maxL : prev);
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    });
    const cards = Array.from(grid.children) as HTMLElement[];
    cards.forEach(card => observer.observe(card));
    measure();
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [sortedClips]);

  const batchWsRef = useRef<WebSocket | null>(null);
  const batchStartTimeRef = useRef<number>(0);
  const batchOutputDirRef = useRef<string>('');
  const batchSelectedClipsRef = useRef<any[]>([]);

  const toggleSelection = (id: string) => {
    setSelectedClipIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  const toggleAll = () => {
    if (selectedClipIds.size === validClips.length) {
      setSelectedClipIds(new Set());
    } else {
      setSelectedClipIds(new Set(validClips.map((c: HighlightClip) => c.id)));
    }
  };



  const handleBatchGenerate = async () => {
    const selectedClips = highlightClips.filter(c => selectedClipIds.has(c.id));
    if (selectedClips.length === 0) {
      setError('请先选择至少一个片段');
      return;
    }
    if (!file) {
      setError('视频文件路径无效');
      return;
    }

    // 分轨模式：如果有外部音频且文件存在，传入 audio_path 和 offset
    let externalAudioPath: string | null = null;
    let externalAudioOffsetMs: number = 0;
    if (currentProjectId) {
      try {
        const project = await loadProject(currentProjectId);
        if (project?.externalAudio?.path) {
          const { exists } = await import('@tauri-apps/plugin-fs');
          try {
            const extExists = await exists(project.externalAudio.path);
            if (extExists) {
              externalAudioPath = project.externalAudio.path;
              externalAudioOffsetMs = project.externalAudio.offsetMs || 0;
            }
          } catch (_) { /* ignore */ }
        }
      } catch (e) {
        // ignore
      }
    }

    let batchClips: any[] = [];
    try {
      batchClips = selectedClips.map((clip, idx) => {
        return {
          id: clip.id,
          index: idx,
          start_ms: Math.round(clip.startMs),
          end_ms: Math.round(clip.endMs),
          title: clip.title || `片段${idx + 1}`,
          description: clip.description || '',
          tags: clip.tags || []
        };
      });
    } catch (err: any) {
      setError(`构造请求数据失败: ${err.message || '未知错误'}`);
      console.error('[Batch] 构造 clip 数据出错:', err);
      return;
    }

    // 选择输出目录
    let outputDir = '';
    try {
      const defaultPath = await videoDir();
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath
      });
      if (!selected) {
        setBatchProgress(prev => ({ ...prev, isProcessing: false }));
        setInfo('');
        return;
      }
      outputDir = selected as string;
    } catch (e) {
      console.error('[Batch] 选择输出目录失败:', e);
      setError('选择输出目录失败');
      setBatchProgress(prev => ({ ...prev, isProcessing: false }));
      return;
    }

    // 获取项目名称（优先从索引读取，更轻量可靠）
    let projectName = '未命名项目';
    if (currentProjectId) {
      try {
        const projects = await listProjects();
        const found = projects.find(p => p.id === currentProjectId);
        if (found?.name) {
          projectName = found.name;
        } else {
          // 索引中没有，回退到完整加载
          const project = await loadProject(currentProjectId);
          projectName = project?.name || '未命名项目';
        }
      } catch (e) {
        console.error('[Batch] 获取项目名称失败:', e);
      }
    }

    batchStartTimeRef.current = Date.now();
    batchOutputDirRef.current = outputDir;
    batchSelectedClipsRef.current = selectedClips;
    setBatchProgress({
      isProcessing: true,
      currentIndex: 0,
      total: selectedClips.length,
      currentFilename: `准备导出 ${selectedClips.length} 个片段...`,
      percent: 0,
      currentFilePercent: 0
    });

    setError('');
    setInfo('正在连接批量剪辑服务...');

    try {
      const response = await fetch('http://127.0.0.1:8000/clip_batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_path: file,
          clips: batchClips,
          allow_shuffle: true,
          output_dir: outputDir,
          project_name: projectName,
          audio_path: externalAudioPath || undefined,
          audio_offset_ms: externalAudioOffsetMs,
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${data.error || '未知错误'}`);
      }

      if (data.success && data.task_id) {
        setInfo(`任务已创建: ${data.task_id}，正在建立连接...`);
        connectBatchWebSocket(data.task_id);
      } else {
        setError(data.error || '启动批量剪辑失败：后端返回失败状态');
        setBatchProgress(prev => ({ ...prev, isProcessing: false }));
        setInfo('');
      }
    } catch (err: any) {
      setError(`启动失败: ${err.message || '请确认后端 api_server.py 已运行且端口 8000 可访问'}`);
      setBatchProgress(prev => ({ ...prev, isProcessing: false }));
      setInfo('');
    }
  };

  const connectBatchWebSocket = useCallback((taskId: string) => {
    if (batchWsRef.current) {
      batchWsRef.current.close();
    }
    const wsUrl = `ws://127.0.0.1:8000/batch_ws/${taskId}`;
    const ws = new WebSocket(wsUrl);
    batchWsRef.current = ws;
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

    ws.onopen = () => {
      setInfo(`已连接任务，准备开始导出...`);
      heartbeatInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send('ping');
        }
      }, 30000);
    };

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        switch (data.type) {
          case 'connected':
            setInfo(`已连接批量剪辑任务，共 ${data.total_clips || '?'} 个片段`);
            break;
          case 'batch_preparing':
            setBatchProgress(prev => ({
              ...prev,
              currentFilename: data.message || '准备中...',
              percent: data.overall_percent || 0
            }));
            break;
          case 'clip_start':
            setBatchProgress(prev => ({
              ...prev,
              currentIndex: (data.index || 0) + 1,
              currentFilename: `正在生成: ${data.title || '片段'}`,
              percent: data.overall_percent || prev.percent,
              currentFilePercent: 0
            }));
            break;
          case 'clip_progress':
            setBatchProgress(prev => ({
              ...prev,
              currentFilePercent: data.clip_percent || 0,
              percent: data.overall_percent || prev.percent,
              currentFilename: data.message || prev.currentFilename
            }));
            break;
          case 'clip_complete':
            setHighlightClips(prev => prev.map(c =>
              c.id === data.id ? { ...c, _generated: true, _failed: false, _outputFile: data.filename } : c
            ));
            setBatchProgress(prev => ({
              ...prev,
              currentFilePercent: 100,
              percent: data.overall_percent || prev.percent
            }));
            setInfo(`片段 ${(data.index || 0) + 1} 完成: ${data.filename || ''}`);
            break;
          case 'clip_failed':
            setHighlightClips(prev => prev.map(c =>
              c.id === data.id ? { ...c, _failed: true, _failReason: data.reason } : c
            ));
            setBatchProgress(prev => ({
              ...prev,
              percent: data.overall_percent || prev.percent
            }));
            break;
          case 'batch_complete': {
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            const elapsedMs = Date.now() - batchStartTimeRef.current;
            const elapsedSec = (elapsedMs / 1000).toFixed(1);
            setBatchProgress({
              isProcessing: false,
              currentIndex: data.completed_files?.length || 0,
              total: (data.completed_files?.length || 0) + (data.failed_files?.length || 0),
              currentFilename: `完成！成功 ${data.completed_files?.length || 0} 个${(data.failed_files?.length || 0) > 0 ? `，失败 ${data.failed_files.length} 个` : ''}（用时 ${elapsedSec} 秒）`,
              percent: 100,
              currentFilePercent: 100,
              elapsedSeconds: parseFloat(elapsedSec)
            });
            setInfo(data.message || `批量剪辑完成！成功 ${data.completed_files?.length || 0} 个`);
            setSelectedClipIds(new Set());
            setTimeout(() => {
              ws.close();
              batchWsRef.current = null;
            }, 1000);
            break;
          }
          case 'batch_error':
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            setError(`批量剪辑失败: ${data.error || '未知错误'}`);
            setBatchProgress(prev => ({ ...prev, isProcessing: false }));
            setInfo('');
            batchWsRef.current = null;
            break;
          case 'cancelled':
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            setInfo('批量剪辑已取消');
            setBatchProgress(prev => ({ ...prev, isProcessing: false }));
            batchWsRef.current = null;
            break;
          case 'error':
            setError(`服务器错误: ${data.error}`);
            break;
        }
      } catch (e) {
        console.error('[Batch WS] Failed to parse message:', e, event.data);
      }
    };

    ws.onerror = (error) => {
      console.error('[Batch WS] Connection error:', error);
      setError('WebSocket连接失败，请检查后端服务');
      setBatchProgress(prev => ({ ...prev, isProcessing: false }));
      setInfo('');
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      batchWsRef.current = null;
    };

    ws.onclose = (event) => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (!event.wasClean && batchProgress.isProcessing) {
        setError('连接异常断开，请刷新页面重试');
        setBatchProgress(prev => ({ ...prev, isProcessing: false }));
      }
      batchWsRef.current = null;
    };

    return () => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };
  }, [setError, setInfo, setBatchProgress, setHighlightClips, setSelectedClipIds, batchProgress.isProcessing]);

  const handleCancelBatch = useCallback(() => {
    if (batchWsRef.current && batchWsRef.current.readyState === WebSocket.OPEN) {
      batchWsRef.current.send('cancel');
      setInfo('正在取消批量剪辑...');
    }
  }, [setInfo]);

  useEffect(() => {
    let cancelled = false;

    const loadAndRequest = async () => {
      // 1. 优先从持久化目录加载已有缩略图（不依赖后端启动）
      let loadedIds = new Set<string>();
      if (loadPersistedThumbnails) {
        loadedIds = await loadPersistedThumbnails(highlightClips);
        loadedIds.forEach(id => requestedClipIdsRef.current.add(id));
      }

      if (cancelled) return;

      // 2. 对仍未加载的缩略图请求后端生成
      const missingThumbs = highlightClips.filter(c =>
        !thumbnails[c.id] &&
        !requestedClipIdsRef.current.has(c.id) &&
        !loadedIds.has(c.id)
      );

      if (missingThumbs.length > 0 && !thumbWsRef.current) {
        missingThumbs.forEach(c => requestedClipIdsRef.current.add(c.id));
        connectThumbWebSocket(missingThumbs);
      }
    };

    loadAndRequest();

    return () => { cancelled = true; };
  }, [highlightClips, connectThumbWebSocket, thumbnails, requestedClipIdsRef, thumbWsRef, loadPersistedThumbnails]);

  useEffect(() => {
    return () => {
      if (thumbWsRef.current) {
        thumbWsRef.current.close();
        thumbWsRef.current = null;
      }
      if (batchWsRef.current) {
        batchWsRef.current.close();
        batchWsRef.current = null;
      }
      requestedClipIdsRef.current.clear();
    };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '20px 0 0 20px', boxSizing: 'border-box' }}>
      <div style={{ flexShrink: 0, paddingRight: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
        <h1 style={{ color: '#f5576c', margin: 0, display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
          <Scissors weight="fill" size={22} /> 精彩片段列表
          {parseStats && (
            <span style={{ fontSize: '14px', color: '#666', fontWeight: 'normal' }}>
              (成功匹配: <span style={{ color: '#f5576c' }}>{parseStats.success}</span> |
               匹配失败: <span style={{ color: '#999' }}>{parseStats.fail}</span>)
            </span>
          )}
        </h1>

        <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-start', margin: '0 16px', minWidth: 0 }}>
          {batchProgress.isProcessing && (
            <div style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '6px 12px',
              minWidth: 0
            }}>
              <span style={{ fontSize: '12px', color: '#333', whiteSpace: 'nowrap', flexShrink: 0 }}>
                导出中：
              </span>
              <div style={{ flex: 1, height: '6px', background: '#ddd', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{
                  width: `${batchProgress.percent}%`,
                  height: '100%',
                  background: '#f5576c',
                  transition: 'width 0.3s ease'
                }} />
              </div>
              <span style={{ fontSize: '12px', color: '#f5576c', fontWeight: 500, whiteSpace: 'nowrap', flexShrink: 0 }}>
                {batchProgress.percent}% ({batchProgress.currentIndex}/{batchProgress.total})
              </span>
              <button
                onClick={handleCancelBatch}
                style={{
                  padding: '2px 8px',
                  fontSize: '11px',
                  color: '#FF5F57',
                  background: '#fff',
                  border: '1px solid #FF5F57',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  lineHeight: '18px',
                  flexShrink: 0
                }}
                onMouseEnter={e => { e.currentTarget.style.background = '#ffebee'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}
              >
                取消
              </button>
            </div>
          )}

          {!batchProgress.isProcessing && batchProgress.total > 0 && (
            <div style={{
              fontSize: '14px',
              fontWeight: 'normal',
              whiteSpace: 'nowrap'
            }}>
              <span style={{ color: '#666' }}>导出视频：</span>
              <span style={{ color: '#f5576c' }}>成功{batchProgress.currentIndex}个</span><span style={{ color: '#999' }}>（用时{batchProgress.elapsedSeconds?.toFixed(1)}秒）</span>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: '10px', flexShrink: 0 }}>
          <button
            onClick={async () => {
              if (await confirm('确定返回AI推理？当前已提取的片段将丢失', { title: '注意' })) {
                if (autoInferenceStep === 'inferencing') {
                  handleStopAutoInference();
                }
                setCurrentPage('long-config');
              }
            }}
            style={{
              padding: '6px 14px',
              fontSize: '13px',
              background: '#f0f0f0',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer'
            }}
          >
            返回AI推理
          </button>
          <button
            onClick={() => {
              if (autoInferenceStep === 'inferencing') {
                handleStopAutoInference();
              }
              setCurrentPage('home');
            }}
            style={{
              padding: '6px 14px',
              fontSize: '13px',
              background: '#666',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer'
            }}
          >
            返回首页
          </button>
        </div>
      </div>

      <div style={{
        padding: '16px',
        background: '#f5f5f7',
        borderRadius: '12px',
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        flexWrap: 'wrap'
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <input
            type="checkbox"
            checked={selectedClipIds.size === validClips.length && validClips.length > 0}
            onChange={toggleAll}
          />
          <span>全选 ({selectedClipIds.size}/{validClips.length})</span>
        </label>

        <div style={{
          display: 'flex',
          gap: '4px',
          background: '#e0e0e0',
          padding: '4px',
          borderRadius: '8px',
          marginLeft: '8px'
        }}>
          <button
            onClick={() => setSortMode('created')}
            style={{
              padding: '6px 12px',
              border: 'none',
              borderRadius: '4px',
              background: sortMode === 'created' ? '#fff' : 'transparent',
              color: sortMode === 'created' ? '#f5576c' : '#666',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: sortMode === 'created' ? 500 : 'normal',
              boxShadow: sortMode === 'created' ? '0 1px 3px rgba(0,0,0,0.12)' : 'none',
              transition: 'all 0.2s ease',
              display: 'flex',
              alignItems: 'center',
              gap: '4px'
            }}
          >
            生成 {sortMode === 'created' && <span style={{ fontSize: '11px' }}>▼</span>}
          </button>
          <button
            onClick={() => setSortMode('time')}
            style={{
              padding: '6px 12px',
              border: 'none',
              borderRadius: '4px',
              background: sortMode === 'time' ? '#fff' : 'transparent',
              color: sortMode === 'time' ? '#f5576c' : '#666',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: sortMode === 'time' ? 500 : 'normal',
              boxShadow: sortMode === 'time' ? '0 1px 3px rgba(0,0,0,0.12)' : 'none',
              transition: 'all 0.2s ease',
              display: 'flex',
              alignItems: 'center',
              gap: '4px'
            }}
          >
            时间 {sortMode === 'time' && <span style={{ fontSize: '11px' }}>▼</span>}
          </button>
          <button
            onClick={() => setSortMode('score')}
            style={{
              padding: '6px 12px',
              border: 'none',
              borderRadius: '4px',
              background: sortMode === 'score' ? '#fff' : 'transparent',
              color: sortMode === 'score' ? '#f5576c' : '#666',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: sortMode === 'score' ? 500 : 'normal',
              boxShadow: sortMode === 'score' ? '0 1px 3px rgba(0,0,0,0.12)' : 'none',
              transition: 'all 0.2s ease',
              display: 'flex',
              alignItems: 'center',
              gap: '4px'
            }}
          >
            评分 {sortMode === 'score' && <span style={{ fontSize: '11px' }}>▼</span>}
          </button>
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: '12px', alignItems: 'center' }}>
          <button
            onClick={handleBatchGenerate}
            disabled={batchProgress.isProcessing || selectedClipIds.size === 0}
            style={{
              padding: '6px 12px',
              background: batchProgress.isProcessing || selectedClipIds.size === 0 ? '#ccc' : '#0078d4',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              fontSize: '13px',
              fontWeight: 500,
              cursor: batchProgress.isProcessing || selectedClipIds.size === 0 ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}
          >
            {batchProgress.isProcessing ? '导出中...' : <><FilmStrip weight="fill" size={18} /> 导出视频</>}
          </button>
        </div>
      </div>
      </div>

      <div className="custom-scrollbar" style={{ flex: 1, overflowY: 'auto', minHeight: 0, paddingRight: '20px' }}>
      <div className="clip-grid" ref={clipGridRef}>
        {sortedClips.map((clip: HighlightClip) => {
          const isGenerated = (clip as any)._generated;
          const isFailed = (clip as any)._failed;
          const isPortrait = thumbDimensions[clip.id]?.height > thumbDimensions[clip.id]?.width;

          return (
            <div
              key={clip.id}
              data-is-portrait={isPortrait}
              style={{
                border: selectedClipIds.has(clip.id) ? '2px solid #f5576c' : '1px solid #e0e0e0',
                borderRadius: '12px',
                overflow: 'hidden',
                background: 'white',
                opacity: clip.isValid ? 1 : 0.6,
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                minHeight: isPortrait ? portraitMinH : landscapeMinH
              }}
            >
              {isGenerated && (
                <div style={{
                  position: 'absolute',
                  top: '12px',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  background: '#28CA41',
                  color: 'white',
                  padding: '4px 12px',
                  borderRadius: '12px',
                  fontSize: '12px',
                  fontWeight: 'bold',
                  zIndex: 10,
                  boxShadow: '0 2px 8px rgba(0,0,0,0.2)'
                }}>
                  已生成
                </div>
              )}
              {isFailed && (
                <div style={{
                  position: 'absolute',
                  top: '12px',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  background: '#FF5F57',
                  color: 'white',
                  padding: '4px 12px',
                  borderRadius: '12px',
                  fontSize: '12px',
                  fontWeight: 'bold',
                  zIndex: 10,
                  boxShadow: '0 2px 8px rgba(0,0,0,0.2)'
                }}>
                  <XCircle weight="fill" size={12} /> 失败
                </div>
              )}

              <div style={{
                position: 'absolute',
                top: '12px',
                right: '12px',
                zIndex: 10
              }}>
                <input
                  type="checkbox"
                  checked={selectedClipIds.has(clip.id)}
                  onChange={() => toggleSelection(clip.id)}
                  onClick={(e) => e.stopPropagation()}
                  disabled={!clip.isValid}
                  style={{ width: '20px', height: '20px', cursor: clip.isValid ? 'pointer' : 'not-allowed' }}
                />
              </div>

              <div style={{
                position: 'absolute',
                top: '12px',
                left: '12px',
                zIndex: 10
              }}>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDiscardClip(clip.id); }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = '#ffffff';
                      e.currentTarget.style.transform = 'scale(1.1)';
                      const tip = e.currentTarget.nextElementSibling as HTMLElement;
                      if (tip) tip.style.opacity = '1';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = 'rgba(255,255,255,0.9)';
                      e.currentTarget.style.transform = 'scale(1)';
                      const tip = e.currentTarget.nextElementSibling as HTMLElement;
                      if (tip) tip.style.opacity = '0';
                    }}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'rgba(255,255,255,0.9)',
                      fontSize: '18px',
                      lineHeight: '18px',
                      cursor: 'pointer',
                      width: '18px',
                      height: '18px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: 0,
                      textShadow: '0 1px 4px rgba(0,0,0,0.6)',
                      transition: 'color 0.2s, transform 0.2s',
                      userSelect: 'none'
                    }}
                  >
                    ×
                  </button>
                  <div style={{
                    position: 'absolute',
                    top: '28px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    background: 'rgba(0,0,0,0.75)',
                    color: '#fff',
                    fontSize: '11px',
                    padding: '3px 8px',
                    borderRadius: '4px',
                    whiteSpace: 'nowrap',
                    opacity: 0,
                    transition: 'opacity 0.2s',
                    pointerEvents: 'none',
                    zIndex: 20
                  }}>
                    剔除
                  </div>
                </div>
              </div>

              <div style={{
                position: 'absolute',
                top: '12px',
                left: '36px',
                background: clip.score >= 90 ? '#28CA41' : clip.score >= 70 ? '#FFBD2E' : '#FF5F57',
                color: 'white',
                padding: '4px 12px',
                borderRadius: '12px',
                fontSize: '12px',
                fontWeight: 'bold',
                zIndex: 10
              }}>
                {clip.score}分
              </div>

              {(clip.isEdited || clip.subtitleEdited) && (
                <div style={{
                  position: 'absolute',
                  top: '12px',
                  right: '40px',
                  zIndex: 10
                }}>
                  <span style={{
                    background: '#FFBD2E',
                    color: 'white',
                    padding: '4px 8px',
                    borderRadius: '12px',
                    fontSize: '11px',
                    fontWeight: 'bold',
                    whiteSpace: 'nowrap'
                  }}>
                    已编辑
                  </span>
                </div>
              )}

              <div
                style={{
                  background: '#1a1a1a',
                  position: 'relative',
                  overflow: 'hidden',
                  width: '100%',
                  paddingBottom: isPortrait ? '133.33%' : '75%',
                  flexShrink: 0
                }}
              >
                {thumbnails[clip.id] ? (
                  <img
                    src={thumbnails[clip.id]}
                    style={{
                      position: 'absolute',
                      top: '-1px',
                      left: '-1px',
                      width: 'calc(100% + 2px)',
                      height: 'calc(100% + 2px)',
                      objectFit: 'cover',
                      display: 'block'
                    }}
                    alt=""
                  />
                ) : (
                  <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', background: '#1a1a1a' }} />
                )}

                <div
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenPlayer(clip);
                  }}
                  style={{
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: '64px',
                    height: '64px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 10,
                    cursor: 'pointer',
                    borderRadius: '50%',
                    transition: 'transform 0.2s, background 0.2s',
                    background: 'rgba(0,0,0,0.3)'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = 'translate(-50%, -50%) scale(1.1)';
                    e.currentTarget.style.background = 'rgba(0,0,0,0.5)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'translate(-50%, -50%) scale(1)';
                    e.currentTarget.style.background = 'rgba(0,0,0,0.3)';
                  }}
                >
                  <svg width="44" height="44" viewBox="0 0 24 24" fill="none">
                    <path d="M8 5.14v13.72c0 .9 1.03 1.46 1.82.97l11.12-6.86c.78-.48.78-1.64 0-2.12L9.82 4.17c-.79-.49-1.82.07-1.82.97z" fill="rgba(255,255,255,0.95)" />
                  </svg>
                </div>

                <div style={{
                  position: 'absolute',
                  bottom: '8px',
                  right: '8px',
                  background: 'rgba(0,0,0,0.85)',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  fontSize: '11px',
                  fontFamily: 'monospace',
                  color: '#fff',
                  zIndex: 10
                }}>
                  {formatTimeMs(clip.endMs - clip.startMs, false)}
                </div>

              </div>

              <div
                style={{ padding: '10px', display: 'flex', flexDirection: 'column', position: 'relative' }}
              >
                {isPortrait ? (
                  <>
                    <h3 style={{
                      margin: 0,
                      fontSize: '15px',
                      fontWeight: 600,
                      color: '#1d1d1f',
                      lineHeight: 1.4,
                      wordBreak: 'break-all',
                      textAlign: 'justify'
                    }}>
                      {clip.title}
                    </h3>
                  </>
                ) : (
                  <>
                    <h3 style={{
                      margin: '0 0 4px 0',
                      fontSize: '15px',
                      fontWeight: 600,
                      color: '#1d1d1f',
                      lineHeight: 1.4,
                      wordBreak: 'break-all',
                      textAlign: 'justify'
                    }}>
                      {clip.title}
                    </h3>
                    <div style={{ fontSize: '13px', color: '#666', lineHeight: 1.5, marginBottom: '8px', wordBreak: 'break-all', textAlign: 'justify' }}>
                      {clip.description}
                    </div>
                    <div style={{ marginBottom: '8px' }}>
                      {clip.tags.map((tag: string, i: number) => (
                        <span key={i} style={{
                          display: 'inline-block',
                          marginRight: '10px',
                          marginBottom: '4px',
                          fontSize: '12px',
                          color: '#007AFF'
                        }}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {sortedClips.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px', color: '#666' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>📝</div>
          <p>暂无精彩片段，可返回 AI 推理重新提取</p>
        </div>
      )}
      <div style={{ height: '20px', flexShrink: 0 }} />
      </div>
    </div>
  );
};


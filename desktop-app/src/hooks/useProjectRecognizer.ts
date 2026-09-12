// hooks/useProjectRecognizer.ts - 后台项目识别任务管理
import { useState, useRef, useCallback } from 'react';
import { saveProject, deleteProject, generateProjectId, generateProjectName, isProjectNameExists, Project } from '../projects';

export interface RecognizingTask {
  projectId: string;
  taskId: string;
  progress: {
    isProcessing: boolean;
    percent: number;
    processedSeconds: number;
    totalSeconds: number;
    elapsedSeconds?: number;
    message: string;
  };
  ws: WebSocket | null;
  isCancelling?: boolean;
}

export interface UseProjectRecognizerReturn {
  tasks: Record<string, RecognizingTask>;
  startRecognition: (filePath: string, projectName?: string) => Promise<{ projectId: string; taskId: string } | null>;
  cancelRecognition: (projectId: string) => void;
}

/**
 * 检查 MP4 文件的 moov box 是否在文件开头（前 1MB 内）
 */
async function checkMoovAtStart(filePath: string): Promise<boolean> {
  try {
    const { open } = await import('@tauri-apps/plugin-fs');
    const file = await open(filePath, { read: true });
    const buffer = new Uint8Array(1024 * 1024);
    const bytesRead = await file.read(buffer);
    await file.close();
    if (bytesRead === 0 || bytesRead === null) return false;
    const view = new DataView(buffer.buffer, 0, bytesRead);
    let offset = 0;
    while (offset < bytesRead - 8) {
      const size = view.getUint32(offset, false);
      if (size === 0 || size > bytesRead - offset) break;
      const type = new TextDecoder('latin1').decode(buffer.subarray(offset + 4, offset + 8));
      if (type === 'moov') return true;
      offset += size;
    }
    return false;
  } catch (e) {
    console.error('[checkMoovAtStart] failed:', e);
    return false;
  }
}

export function useProjectRecognizer(): UseProjectRecognizerReturn {
  const [tasks, setTasks] = useState<Record<string, RecognizingTask>>({});
  const wsMapRef = useRef<Record<string, WebSocket>>({});
  const loadingTimersRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  const updateTask = useCallback((projectId: string, updates: Partial<RecognizingTask> | ((prev: RecognizingTask) => RecognizingTask)) => {
    setTasks(prev => {
      const task = prev[projectId];
      if (!task) return prev;
      const next = typeof updates === 'function' ? updates(task) : { ...task, ...updates };
      return { ...prev, [projectId]: next };
    });
  }, []);

  const removeTask = useCallback((projectId: string) => {
    // 清除加载计时器
    const timer = loadingTimersRef.current[projectId];
    if (timer) {
      clearInterval(timer);
      delete loadingTimersRef.current[projectId];
    }
    setTasks(prev => {
      const { [projectId]: _, ...rest } = prev;
      return rest;
    });
  }, []);

  const startRecognition = useCallback(async (filePath: string, projectName?: string): Promise<{ projectId: string; taskId: string } | null> => {
    const projectId = generateProjectId();
    let name = projectName || generateProjectName(filePath);
    const projectType: 'long' | 'short' = 'long';

    // 自动处理重名
    if (await isProjectNameExists(name, projectType)) {
      let suffix = 1;
      let candidate = `${name}(${suffix})`;
      while (await isProjectNameExists(candidate, projectType)) {
        suffix++;
        candidate = `${name}(${suffix})`;
      }
      name = candidate;
    }

    // === 1. 立即创建空项目 + 前端任务状态 ===
    const project: Project = {
      id: projectId,
      name,
      videoPath: filePath,
      sentences: [],
      srt: '',
      text: '',
      rawText: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      projectType,
      recognitionStatus: 'recognizing',
      proxyStatus: undefined,
      externalAudio: undefined,
      replacedVideoPath: undefined
    };
    await saveProject(project);

    const initialTask: RecognizingTask = {
      projectId,
      taskId: '',
      progress: {
        isProcessing: true,
        percent: 0,
        processedSeconds: 0,
        totalSeconds: 0,
        message: '正在识别字幕...'
      },
      ws: null
    };
    setTasks(prev => ({ ...prev, [projectId]: initialTask }));

    // 启动加载倒计时（从项目创建就开始显示，AAC提取在后台跑）
    const loadingStartTime = Date.now();
    loadingTimersRef.current[projectId] = setInterval(() => {
      const seconds = Math.floor((Date.now() - loadingStartTime) / 1000);
      updateTask(projectId, (task) => ({
        ...task,
        progress: {
          ...task.progress,
          message: `正在识别字幕...${seconds}s`
        }
      }));
    }, 1000);

    // 准备音频目录
    const { appDataDir } = await import('@tauri-apps/api/path');
    const dataDir = await appDataDir();
    const { mkdir } = await import('@tauri-apps/plugin-fs');
    const { join } = await import('@tauri-apps/api/path');
    const audioDir = await join(dataDir, 'projects', 'audio');
    await mkdir(audioDir, { recursive: true }).catch(() => {});

    // === 2. 并行阶段1：提取AAC + 预热ASR模型 ===
    let asrAudioPath = '';

    // 先启动ASR模型预热（不阻塞）
    const warmupPromise = fetch('http://127.0.0.1:8000/warmup_asr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    }).catch(err => {
      console.warn('[warmup_asr] 预热请求失败:', err);
    });

    // 同时启动AAC提取（不阻塞）
    const extractAacPromise = (async () => {
      // 从视频提取AAC
      const aacPath = await join(audioDir, `extracted_${projectId}.aac`);
      try {
        const response = await fetch('http://127.0.0.1:8000/extract_audio', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            video_path: filePath,
            output_path: aacPath,
            format: 'aac'
          })
        });
        const data = await response.json();
        if (data.audio_path) {
          asrAudioPath = data.audio_path;
        } else {
          console.error('AAC提取失败');
          asrAudioPath = filePath;
        }
      } catch (e) {
        console.error('AAC提取失败:', e);
        asrAudioPath = filePath;
      }
    })();

    // 等待AAC提取完成（模型预热在后台跑，不阻塞）
    await extractAacPromise;

    // === 3. ASR识别 ===

    // 启动ASR识别（网络异常时清理项目，避免留下永久"识别中"的僵尸项目）
    let recognizeData: any;
    try {
      const recognizeResp = await fetch('http://127.0.0.1:8000/recognize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_path: asrAudioPath,
          device: 'GPU',
          min_repeat: 2,
          time_gap: 0.3
        })
      });
      recognizeData = await recognizeResp.json();
    } catch (e) {
      console.error('提交识别请求失败:', e);
      await deleteProject(projectId);
      removeTask(projectId);
      throw new Error('无法连接本地后端，请确认 KnowClip 后端服务已启动');
    }
    if (!recognizeData.success || !recognizeData.task_id) {
      await deleteProject(projectId);
      removeTask(projectId);
      return null;
    }

    const taskId = recognizeData.task_id;
    updateTask(projectId, { taskId });

    // 5. 建立 WebSocket
    const connectWebSocket = (retryCount = 0) => {
      const MAX_RETRIES = 5;
      const RECONNECT_DELAY = Math.min(1000 * Math.pow(2, retryCount), 10000);
      const ws = new WebSocket(`ws://127.0.0.1:8000/ws/${taskId}`);

      let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
      let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
      let isActive = true;

      ws.onopen = () => {
        retryCount = 0;
        heartbeatInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send('ping');
          }
        }, 30000);
      };

      ws.onmessage = async (event) => {
        if (event.data === 'pong') return;
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'preparing':
            updateTask(projectId, {
              progress: {
                isProcessing: true,
                percent: 0,
                processedSeconds: 0,
                totalSeconds: 0,
                message: msg.message || '正在分析文件...'
              }
            });
            break;
          case 'init':
          case 'progress': {
            const timer = loadingTimersRef.current[projectId];
            if (timer && (msg.percent || 0) > 0) {
              clearInterval(timer);
              delete loadingTimersRef.current[projectId];
            }
            updateTask(projectId, {
              progress: {
                isProcessing: true,
                percent: msg.percent || 0,
                processedSeconds: msg.processed_seconds || 0,
                totalSeconds: msg.total_seconds || 0,
                message: msg.message || '正在识别字幕...'
              }
            });
            break;
          }
          case 'complete': {
            isActive = false;
            const timer = loadingTimersRef.current[projectId];
            if (timer) {
              clearInterval(timer);
              delete loadingTimersRef.current[projectId];
            }
            if (heartbeatInterval) {
              clearInterval(heartbeatInterval);
              heartbeatInterval = null;
            }
            ws.close();

            if (msg.data && Array.isArray(msg.data.sentences)) {
              const validSentences = msg.data.sentences
                .filter((sent: any) => sent && sent.words && Array.isArray(sent.words))
                .sort((a: any, b: any) => a.start - b.start);

              const sentencesWithIndex = validSentences.map((sent: any, idx: number) => {
                let initialPauseAfter = undefined;
                let initialPauseMs = undefined;
                if (idx < validSentences.length - 1) {
                  const nextSent = validSentences[idx + 1];
                  const gapMs = nextSent.start - sent.end;
                  if (gapMs > 0) {
                    initialPauseMs = gapMs;
                    initialPauseAfter = `[${(gapMs / 1000).toFixed(2)}s]`;
                  }
                }
                return {
                  ...sent,
                  id: sent.id || `sent-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
                  originalWords: sent.words ? JSON.parse(JSON.stringify(sent.words)) : undefined,
                  preservePunctuation: false,
                  originalIndex: idx + 1,
                  isCopy: false,
                  splitFrom: undefined,
                  segments: undefined,
                  initialPauseAfter,
                  initialPauseMs,
                  pause_after: initialPauseAfter,
                  pause_ms: initialPauseMs
                };
              });

              const displayText = msg.data.text || msg.data.raw_text || '';
              const wordCount = sentencesWithIndex.reduce((sum: number, s: any) => sum + (s.text?.length || 0), 0);

              const completedProject: Project = {
                ...project,
                sentences: sentencesWithIndex,
                srt: msg.data.srt || '',
                text: displayText,
                rawText: msg.data.raw_text || displayText,
                updatedAt: new Date().toISOString(),
                recognitionStatus: 'completed',
                wordCount
              };
              await saveProject(completedProject);
            } else {
              await saveProject({
                ...project,
                updatedAt: new Date().toISOString(),
                recognitionStatus: 'failed'
              });
            }

            updateTask(projectId, {
              progress: {
                isProcessing: false,
                percent: 100,
                processedSeconds: msg.processed_seconds || 0,
                totalSeconds: msg.total_seconds || 0,
                elapsedSeconds: msg.elapsed_seconds || 0,
                message: '识别完成'
              }
            });

            removeTask(projectId);
            break;
          }
          case 'error':
            isActive = false;
            if (heartbeatInterval) {
              clearInterval(heartbeatInterval);
              heartbeatInterval = null;
            }
            ws.close();
            await saveProject({
              ...project,
              updatedAt: new Date().toISOString(),
              recognitionStatus: 'failed'
            });
            removeTask(projectId);
            break;
          case 'cancelled':
            isActive = false;
            if (heartbeatInterval) {
              clearInterval(heartbeatInterval);
              heartbeatInterval = null;
            }
            ws.close();
            await deleteProject(projectId);
            removeTask(projectId);
            break;
          case 'cancelling':
            updateTask(projectId, (task) => ({
              ...task,
              progress: {
                ...task.progress,
                message: msg.message || '正在取消...'
              }
            }));
            break;
        }
      };

      ws.onerror = (err) => {
        console.error('Recognizer WS error:', err);
        if (retryCount >= MAX_RETRIES) {
          saveProject({
            ...project,
            updatedAt: new Date().toISOString(),
            recognitionStatus: 'failed'
          }).catch(console.error);
          removeTask(projectId);
        }
      };

      ws.onclose = (event) => {
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }
        delete wsMapRef.current[projectId];
        if (!event.wasClean && retryCount < MAX_RETRIES && isActive) {
          reconnectTimeout = setTimeout(() => {
            connectWebSocket(retryCount + 1);
          }, RECONNECT_DELAY);
        }
      };

      wsMapRef.current[projectId] = ws;
      updateTask(projectId, { ws });

      return () => {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      };
    };

    connectWebSocket();

    // 不等待warmupPromise（如果失败了也不影响）
    warmupPromise.catch(() => {});

    return { projectId, taskId };
  }, [updateTask, removeTask]);

  const cancelRecognition = useCallback((projectId: string) => {
    // 清除加载计时器
    const timer = loadingTimersRef.current[projectId];
    if (timer) {
      clearInterval(timer);
      delete loadingTimersRef.current[projectId];
    }
    // 通知后端取消（不等待后端完成）
    const ws = wsMapRef.current[projectId];
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send('cancel');
      ws.close();
    }
    delete wsMapRef.current[projectId];

    // 前端立即删除项目并移除任务，不等待后端确认
    deleteProject(projectId).catch(console.error);
    removeTask(projectId);
  }, [removeTask]);

  return { tasks, startRecognition, cancelRecognition };
}

import { useCallback } from 'react';
import type { HighlightClip, Sentence } from '../types';
import { locateTextInSubtitles } from '../utils/subtitleSearch';
import { HIDDEN_PROMPT_SUFFIX } from '../config';

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export interface UseAutoInferenceOptions {
  autoInferenceAbortRef: React.MutableRefObject<AbortController | null>;
  autoInferenceTextareaRef: React.MutableRefObject<HTMLDivElement | null>;
  step2RetryCount: React.MutableRefObject<number>;
  hasFirstClipMatched: React.MutableRefObject<boolean>;
  isInferenceStoppedRef: React.MutableRefObject<boolean>;
  processedTimeRanges: React.MutableRefObject<Set<string>>;
  step2Buffer: React.MutableRefObject<string>;
  longVideoText: string;
  longVideoStep2Prompt: string;
  longVideoModel: string;
  enableThinking: boolean;
  localBaseUrl: string;
  localApiKey: string;
  originalSentences: Sentence[];
  setError: (error: string) => void;
  setInfo: (info: string) => void;
  setStep2Result: (result: string) => void;
  setCurrentPage: React.Dispatch<React.SetStateAction<any>>;
  setHighlightClips: React.Dispatch<React.SetStateAction<HighlightClip[]>>;
  setParseStats: React.Dispatch<React.SetStateAction<any>>;
  setAutoInferenceStep: React.Dispatch<React.SetStateAction<any>>;
  setAutoInferenceError: React.Dispatch<React.SetStateAction<string>>;
  setInferenceInterrupted: React.Dispatch<React.SetStateAction<boolean>>;
  saveProjectLLMResults: (clips?: HighlightClip[]) => Promise<void>;
}

export function useAutoInference(options: UseAutoInferenceOptions) {
  const {
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
  } = options;

  const handleAutoInference = useCallback(async () => {
    if (!longVideoText) {
      setError('没有可用的字幕文本');
      return;
    }
    if (!localBaseUrl.trim() || !localApiKey.trim()) {
      setError('请先点击齿轮图标，在 LLM 服务设置中填写 API 地址与 API Key');
      return;
    }
    step2RetryCount.current = 0;
    hasFirstClipMatched.current = false;
    isInferenceStoppedRef.current = false;
    setInferenceInterrupted(false);
    processedTimeRanges.current.clear();
    step2Buffer.current = '';
    setHighlightClips([]);
    setParseStats({ success: 0, fail: 0 });
    setAutoInferenceStep('inferencing');
    setAutoInferenceError('');
    setError('');
    setStep2Result('');
    setParseStats({ success: 0, fail: 0 });
    if (autoInferenceTextareaRef.current) {
      autoInferenceTextareaRef.current.innerHTML = '';
    }
    autoInferenceAbortRef.current = new AbortController();
    const abortController = autoInferenceAbortRef.current;

    const extractSingleClip = (segment: string): HighlightClip | null => {
      if (isInferenceStoppedRef.current) return null;
      try {
        const lines = segment.split('\n');
        let title = '未命名片段';
        let content = '';
        let description = '';
        let tagsStr = '';
        let score = 80;
        let currentField: string | null = null;
        const contentLines: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmedLine = line.trim();
          if (/^片段标题[：:]/.test(trimmedLine)) {
            currentField = 'title';
            title = trimmedLine.replace(/^片段标题[：:]\s*/, '').trim();
          } else if (/^片段内容[：:]/.test(trimmedLine)) {
            currentField = 'content';
            const firstLine = trimmedLine.replace(/^片段内容[：:]\s*/, '');
            if (firstLine) contentLines.push(firstLine);
          } else if (/^片段描述[：:]/.test(trimmedLine)) {
            currentField = 'description';
            description = trimmedLine.replace(/^片段描述[：:]\s*/, '').trim();
          } else if (/^片段标签[：:]/.test(trimmedLine)) {
            currentField = 'tags';
            tagsStr = trimmedLine.replace(/^片段标签[：:]\s*/, '').trim();
          } else if (/^片段评分[：:]/.test(trimmedLine)) {
            currentField = 'score';
            const scoreMatch = trimmedLine.match(/(\d+)/);
            if (scoreMatch) score = parseInt(scoreMatch[1], 10);
          } else if (/^片段/.test(trimmedLine)) {
            currentField = null;
          } else if (currentField === 'content') {
            contentLines.push(line);
          }
        }
        content = contentLines.join('\n').trim();
        if (!content || content.length < 10) return null;
        const tags = tagsStr
          .split(/[,\s，]+/)
          .map(t => t.trim())
          .filter(t => t.startsWith('#'))
          .slice(0, 5);
        const location = locateTextInSubtitles(content, longVideoText, originalSentences);
        if (!location) return null;
        const timeKey = `${location.startMs}-${location.endMs}`;
        if (processedTimeRanges.current.has(timeKey)) {
          return null;
        }
        processedTimeRanges.current.add(timeKey);
        return {
          id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          title,
          content,
          description,
          tags: tags.length > 0 ? tags : ['#精彩片段'],
          score: isNaN(score) ? 80 : Math.min(100, Math.max(0, score)),
          startMs: location.startMs,
          endMs: location.endMs,
          matchedText: location.matchedText,
          isValid: true,
          matchConfidence: location.confidence,
          sourceSentences: JSON.parse(JSON.stringify(originalSentences.filter(s =>
            s.end > location.startMs && s.start < location.endMs
          ))),
          isEdited: false
        };
      } catch (e) {
        return null;
      }
    };

    const processStream = async (): Promise<boolean> => {
      const systemPrompt = `${longVideoStep2Prompt}\n\n${HIDDEN_PROMPT_SUFFIX}`;
      const cachedContent = `${longVideoText}`;

      const response2 = await fetch('http://127.0.0.1:8000/llm_inference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: longVideoModel,
          system_prompt: systemPrompt,
          cached_content: cachedContent,
          user_prompt: '',
          enable_thinking: enableThinking,
          api_base: localBaseUrl,
          api_key: localApiKey,
        }),
        signal: autoInferenceAbortRef.current!.signal
      });
      if (!response2.ok) {
        let msg = `请求失败: ${response2.status}`;
        try {
          const errData = await response2.json();
          if (errData?.detail) msg = errData.detail;
        } catch { /* 忽略非 JSON 响应 */ }
        throw new Error(msg);
      }
      const reader2 = response2.body?.getReader();
      const decoder2 = new TextDecoder();
      if (!reader2) throw new Error('无法读取响应流');
      let ndjsonBuffer = '';
      let displayHTML = '';
      let extractBuffer = '';
      let isInReasoning = false;
      // 清空显示框，准备显示当前 Step2 的内容
      if (autoInferenceTextareaRef.current) {
        autoInferenceTextareaRef.current.innerHTML = '';
      }
      let successCount = 0;
      let failCount = 0;
      let lastProcessTime = Date.now();
      try {
        while (true) {
          if (isInferenceStoppedRef.current) {
            throw new Error('AbortError');
          }
          if (autoInferenceAbortRef.current?.signal.aborted) {
            throw new Error('AbortError');
          }
          const { done, value } = await reader2.read();
          if (done) break;
          const chunk = decoder2.decode(value, { stream: true });
          ndjsonBuffer += chunk;

          // 解析 NDJSON，分离 reasoning 和 content
          const lines = ndjsonBuffer.split('\n');
          ndjsonBuffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const data = JSON.parse(line);
              if (data.t === 'r') {
                if (!isInReasoning) {
                  displayHTML = '';
                  isInReasoning = true;
                }
                displayHTML += '<span style="color:#888;font-size:14px;">' + escapeHtml(data.c) + '</span>';
              } else if (data.t === 'c') {
                if (isInReasoning) {
                  displayHTML = '';
                  isInReasoning = false;
                }
                displayHTML += escapeHtml(data.c);
                extractBuffer += data.c;
              } else if (data.t === 'e') {
                displayHTML += '<span style="color:#f5576c;">❌ 错误：' + escapeHtml(data.c) + '</span>';
              }
            } catch {
              // 忽略解析失败的行
            }
          }

          // 更新显示框（思考过程灰色斜体，结束后清屏只显示正式内容）
          if (autoInferenceTextareaRef.current) {
            autoInferenceTextareaRef.current.innerHTML = displayHTML;
            autoInferenceTextareaRef.current.scrollTop = autoInferenceTextareaRef.current.scrollHeight;
          }
          lastProcessTime = Date.now();

          // 从 extractBuffer 中提取片段（只匹配正式内容，不匹配思考过程）
          const regex = /片段标题[：:][\s\S]*?片段评分[：:]\s*\d+/;
          const match = extractBuffer.match(regex);
          if (match) {
            extractBuffer = extractBuffer.slice(match.index! + match[0].length);
            const segment = match[0];
            const clip = extractSingleClip(segment);
            if (clip) {
              successCount++;
              setParseStats({ success: successCount, fail: failCount });
              setHighlightClips(prev => [...prev, clip]);
              await new Promise(resolve => setTimeout(resolve, 10));
              saveProjectLLMResults();
              if (!hasFirstClipMatched.current) {
                hasFirstClipMatched.current = true;
                setCurrentPage('long-preview');
              }
            } else {
              failCount++;
              setParseStats({ success: successCount, fail: failCount });
              if (failCount >= 3 && !hasFirstClipMatched.current && successCount === 0) {
                if (step2RetryCount.current === 0) {
                  step2RetryCount.current = 1;
                  reader2.cancel();
                  return false;
                } else {
                  throw new Error('精彩片段无法匹配原始字幕，建议检查字幕质量或调整提示词');
                }
              }
            }
          }
          const now = Date.now();
          if (extractBuffer.length > 20000) {
            const lastTitleIdx = extractBuffer.lastIndexOf('片段标题');
            if (lastTitleIdx > 0 && lastTitleIdx < extractBuffer.length - 100) {
              extractBuffer = extractBuffer.slice(lastTitleIdx);
            } else {
              extractBuffer = extractBuffer.slice(-10000);
            }
          }
          if (now - lastProcessTime > 30000 && extractBuffer.length > 5000) {
            console.warn('Buffer 处理卡顿，强制清理');
            extractBuffer = '';
          }
        }
        // 尝试解析最后残留的不完整 NDJSON 行
        if (ndjsonBuffer.trim()) {
          try {
            const data = JSON.parse(ndjsonBuffer.trim());
            if (data.t === 'c') {
              extractBuffer += data.c;
              displayHTML += escapeHtml(data.c);
            } else if (data.t === 'r') {
              displayHTML += '<span style="color:#888;font-size:14px;">' + escapeHtml(data.c) + '</span>';
            }
          } catch {
            // 忽略解析失败的残留行
          }
        }
        setStep2Result(extractBuffer);

        // 流正常结束但未提取到任何有效片段，触发重试
        if (successCount === 0) {
          if (step2RetryCount.current === 0) {
            step2RetryCount.current = 1;
            const reason = failCount > 0
              ? `模型返回的 ${failCount} 个片段均无法匹配字幕，正在自动重试...（1/2）`
              : '模型未返回任何有效片段，正在自动重试...（1/2）';
            return false;
          } else {
            const suggestion = failCount > 0
              ? '精彩片段无法匹配原始字幕，建议检查字幕质量或调整提示词'
              : '模型未返回有效内容，建议调整提示词或切换模型后重试';
            throw new Error(suggestion);
          }
        }

        return true;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw err;
        }
        if ((err as Error).message.includes('精彩片段无法匹配')) {
          throw err;
        }
        console.error('[Step2] 未预期错误:', err);
        throw err;
      }
    };

    try {
      setAutoInferenceStep('inferencing');
      const success = await processStream();
      if (!success) {
        step2Buffer.current = '';
        processedTimeRanges.current.clear();
        setHighlightClips([]);
        setParseStats({ success: 0, fail: 0 });
        await new Promise(resolve => setTimeout(resolve, 1000));
        const retrySuccess = await processStream();
        if (!retrySuccess) {
          throw new Error('自动重试机制异常');
        }
      }
      setAutoInferenceStep('done');
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
      } else {
        console.error('[Inference] 错误:', err);
        setAutoInferenceError(err instanceof Error ? err.message : '推理失败');
      }
    } finally {
      if (autoInferenceAbortRef.current === abortController) {
        autoInferenceAbortRef.current = null;
      }
      step2RetryCount.current = 0;
      // 成功时保持 'done'（顶部绿色提示），失败/中断回 'idle'
      setAutoInferenceStep((prev: string) => (prev === 'done' ? 'done' : 'idle'));
    }
  }, [autoInferenceAbortRef, autoInferenceTextareaRef, step2RetryCount, hasFirstClipMatched, isInferenceStoppedRef, processedTimeRanges, step2Buffer, longVideoText, longVideoStep2Prompt, longVideoModel, enableThinking, originalSentences, setError, setInfo, setStep2Result, setCurrentPage, setHighlightClips, setParseStats, setAutoInferenceStep, setAutoInferenceError, setInferenceInterrupted, saveProjectLLMResults]);

  const handleStopAutoInference = useCallback(() => {
    isInferenceStoppedRef.current = true;
    setInferenceInterrupted(true);
    setAutoInferenceStep('idle');
    step2RetryCount.current = 0;
    if (autoInferenceAbortRef.current) {
      try {
        autoInferenceAbortRef.current.abort();
      } catch (e) {
        console.error('[Stop] Abort 失败:', e);
      }
    } else {
      console.warn('[Stop] AbortController 为 null，可能已自然结束或已停止');
    }
  }, [autoInferenceAbortRef, isInferenceStoppedRef, step2RetryCount, setInferenceInterrupted, setAutoInferenceStep]);

  return { handleAutoInference, handleStopAutoInference };
}

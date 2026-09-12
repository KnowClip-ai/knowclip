import { CONSTANTS } from './constants';

// ========== 工具函数 ==========

/**
 * 格式化时间（毫秒）为 MM:SS.ms 格式
 */
export const formatTimeMs = (ms: number, showMilliseconds = true): string => {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / CONSTANTS.TIME.MS_PER_SECOND);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (!showMilliseconds) {
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  const milliseconds = Math.floor((ms % CONSTANTS.TIME.MS_PER_SECOND) / 10);
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(2, '0')}`;
};

/**
 * 格式化时长（秒）为 X时X分X秒 格式
 */
export const formatDuration = (seconds: number): string => {
  if (seconds <= 0) return '0秒';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  let result = '';
  if (hours > 0) result += `${hours}时`;
  if (minutes > 0) result += `${minutes}分`;
  result += `${secs}秒`;
  return result;
};

/**
 * 清除文本中的标点符号
 */
export const cleanPunctuation = (text: string): string => {
  return text.replace(/[，。！？、；："'（）【】《》…—～｜,.!?;:()\[\]{}]/g, '');
};

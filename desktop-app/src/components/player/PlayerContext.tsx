/**
 * PlayerContext - 播放器状态上下文
 *
 * 开源精简版：仅保留播放、被动字幕展示、缩略图所需字段。
 * App.tsx 组装 playerCtx 后通过 PlayerProvider 注入。
 */
import React, { createContext, useContext } from 'react';
import type { HighlightClip, SubtitleStyle, Sentence } from '../../types';

export interface PlayerContextValue {
  // Core playback
  activePlayerClip: HighlightClip | null;
  activePlayerClipRef: React.RefObject<HighlightClip | null>;
  videoServerUrl: string;
  audioServerUrl: string | null;
  /** 外部音频偏移量（毫秒），正数=外部音频延后于视频 */
  audioOffsetMs: number;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  videoLoadError: string;
  setVideoLoadError: React.Dispatch<React.SetStateAction<string>>;
  // Playback state
  isPlaying: boolean;
  setIsPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  currentTime: number;
  setCurrentTime: React.Dispatch<React.SetStateAction<number>>;
  duration: number;
  setDuration: React.Dispatch<React.SetStateAction<number>>;
  // Player UI
  playerContainerSize: { width: number; height: number } | null;
  setPlayerContainerSize: React.Dispatch<React.SetStateAction<{ width: number; height: number } | null>>;
  playerContainerRef: React.RefObject<HTMLDivElement | null>;
  isPlayerHovered: boolean;
  setIsPlayerHovered: React.Dispatch<React.SetStateAction<boolean>>;
  playerScale: number;
  playerAspectRatio: string;
  setPlayerAspectRatio: React.Dispatch<React.SetStateAction<string>>;
  videoContainerRef: React.RefObject<HTMLDivElement | null>;
  cleanPunctuation: (text: string) => string;
  // Thumbnails
  thumbnails: Record<string, string>;
  thumbDimensions: Record<string, { width: number; height: number }>;
  // Callbacks
  closePlayer: () => void;
  // Refs
  progressBarRef: React.RefObject<HTMLDivElement | null>;
  loadingOverlayRef: React.RefObject<HTMLDivElement | null>;
  // Data refs
  originalSentencesRef: React.RefObject<Sentence[]>;
  highlightClipsRef: React.RefObject<HighlightClip[]>;
  setHighlightClips: React.Dispatch<React.SetStateAction<HighlightClip[]>>;
  setOriginalSentences: React.Dispatch<React.SetStateAction<Sentence[]>>;
  setActivePlayerClip: React.Dispatch<React.SetStateAction<HighlightClip | null>>;
  // Misc
  isDragging: boolean;
  setIsDragging: React.Dispatch<React.SetStateAction<boolean>>;
  isDraggingProgressRef: React.RefObject<boolean>;
  lastTimeUpdateStateRef: React.RefObject<number>;
  lastCheckTimeRef: React.RefObject<number>;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) {
    throw new Error('usePlayer must be used within a PlayerProvider');
  }
  return ctx;
}

interface PlayerProviderProps {
  value: PlayerContextValue;
  children: React.ReactNode;
}

export function PlayerProvider({ value, children }: PlayerProviderProps) {
  return (
    <PlayerContext.Provider value={value}>
      {children}
    </PlayerContext.Provider>
  );
}

export { PlayerContext };

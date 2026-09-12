// ========== 类型定义 ==========

export interface Word {
  word: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  approximate?: boolean;
  is_composite?: boolean;
}

export type TextSegment =
  | { type: 'normal'; text: string; wordIndices?: number[] }
  | { type: 'composite'; text: string; id: string; originalText: string; wordIndices?: number[] };

export interface Sentence {
  id?: string;
  text: string;
  start: number;
  end: number;
  words: Word[];
  originalWords?: Word[];
  word_count: number;
  originalIndex: number;
  splitFrom?: number;
  isCopy?: boolean;
  pause_after?: string;
  pause_ms?: number;
  segments?: TextSegment[];
  initialPauseAfter?: string;
  initialPauseMs?: number;
  groupId?: string;
  type?: 'normal' | 'blank';
  blankPosition?: 'head' | 'tail';
  preservePunctuation?: boolean;
}

export interface HistoryState {
  sentences: Sentence[];
  deletedSentences: Sentence[];
  action: string;
}

export interface ProgressState {
  isProcessing: boolean;
  taskId: string | null;
  percent: number;
  processedSeconds: number;
  totalSeconds: number;
  elapsedSeconds?: number;
  message: string;
}

export interface SubtitleStyle {
  fontFamily: string;
  fontSize: number;
  position: number;
  preset: 'white-black' | 'black-white' | 'yellow-black' | 'white-none' | 'black-none' | 'yellow';
  /** 字体文件的绝对路径（导出时由前端传入后端，确保前后端使用同一字体） */
  fontPath?: string;
}

export type VideoType = 'A' | 'B';

// ========== 长视频精彩切片类型 ==========

export interface VerticalPair {
  id: number;
  startT: number;
  endT: number;
  startX: number;
  endX: number;
  startXEdited?: boolean;
  endXEdited?: boolean;
}

export interface VerticalConfig {
  enabled: boolean;
  coordinates: Array<{ t: number; x_norm: number }>;
  pairs?: VerticalPair[];
  /** 镜头缓动强度 0~1，0=线性匀速 1=缓入缓出 */
  smoothTracking: number;
  /** 丝滑追焦强度 0~1，0=直出 1=平滑跟随 */
  cameraEasing: number;
  subtitleStyle?: SubtitleStyle;
  source?: { width: number; height: number; fps: number };
  cropTop?: number;
  cropBottom?: number;
  cropLeft?: number;
  cropRight?: number;
}

export interface HighlightClip {
  id: string;
  title: string;
  description: string;
  tags: string[];
  score: number;
  content: string;
  startMs: number;
  endMs: number;
  matchedText: string;
  isValid: boolean;
  matchConfidence?: number;
  sourceSentences: Sentence[];
  isEdited?: boolean;
  subtitleEdited?: boolean;
  subtitleStyle?: SubtitleStyle;
  _generated?: boolean;
  _failed?: boolean;
  _outputFile?: string;
  vertical?: VerticalConfig;
  segmentFile?: string;
  filter?: string;
  /** 音频配置 */
  audio?: {
    voiceGain: number;
    bgmUrl: string | null;
    bgmVolume: number;
    fadeInDuration: number;
    fadeOutDuration: number;
    noiseReduction?: boolean;
    hpFreq?: number;
    lpFreq?: number;
    rnnoiseEnabled?: boolean;
  };
  /** 文字贴纸（横屏局部） */
  textOverlays?: TextOverlay[];
  /** 文字贴纸（竖屏局部） */
  verticalTextOverlays?: TextOverlay[];
}

export interface BatchProgress {
  isProcessing: boolean;
  currentIndex: number;
  total: number;
  currentFilename: string;
  percent: number;
  currentFilePercent?: number;
  elapsedSeconds?: number;
}

// ========== 文字贴纸（Text Overlay）类型 ==========

export interface TextOverlayStyle {
  id: string;
  name: string;
  fontFamily: string;
  fontSize: number;        // 相对画面高度的比例，如 0.05 = 5%
  color: string;
  fontWeight: number;
  letterSpacing?: number;
  textShadow?: string;
  backgroundColor?: string;
  borderRadius?: number;
  padding?: string;
  animationType: 'fade' | 'slide-up' | 'slide-down' | 'zoom' | 'none';
  extraCss?: React.CSSProperties;     // 外层容器样式
  titleCss?: React.CSSProperties;     // 标题特有样式
  contentCss?: React.CSSProperties;   // 内容特有样式
  titleContentGap?: string;           // 标题和内容之间的间距
  previewText?: string;               // 面板预览文字，默认"文"
  previewCss?: { textShadow?: string; titleTextShadow?: string }; // 控制面板样式按钮预览专用（不影响实际渲染）
  // 该样式下阴影/描边的默认开关（未指定则按 renderer 内部启发式计算）
  titleShadowEnabled?: boolean;
  textShadowEnabled?: boolean;
  titleOutlineEnabled?: boolean;
  textOutlineEnabled?: boolean;
  /** 多行内容时是否让每行背景宽度以最长行为准保持一致（如综艺感花字） */
  equalContentLineWidth?: boolean;
}

export interface TextOverlay {
  id: string;
  title?: string;
  text: string;
  styleId: string;
  intervalSec: number;     // 间隔时间 0-100s（0=始终显示）
  durationSec: number;     // 持续时间 0-100s
  fadeInSec: number;       // 淡入时长 0-1s
  fadeOutSec: number;      // 淡出时长 0-1s
  position: { x: number; y: number }; // 画面归一化坐标 0-1，默认中心
  fontSizeScale?: number;  // 字号缩放 0.2~3.0（默认 1.0）
  titleFontFamily?: string; // 标题字体（覆盖样式默认字体）
  textFontFamily?: string;  // 内容字体（覆盖样式默认字体）
  titleColor?: string;      // 标题颜色（覆盖样式默认颜色）
  textColor?: string;       // 内容颜色（覆盖样式默认颜色）
  titleShadowEnabled?: boolean; // 标题阴影开关（默认true）
  textShadowEnabled?: boolean;  // 内容阴影开关（默认true）
  titleOutlineEnabled?: boolean; // 标题描边开关（默认false）
  textOutlineEnabled?: boolean;  // 内容描边开关（默认false）
  pngPath?: string;              // 前端截图 PNG 绝对路径（导出时优先传给后端）
  pngAnchorX?: number;           // PNG 内定位锚点 X（0-1），对应 position 布局中心
  pngAnchorY?: number;           // PNG 内定位锚点 Y（0-1）
  pngPixelRatio?: number;        // PNG 物理像素比（如 Retina 下为 2），导出时后端按此缩放
  pngVersion?: number;           // 截图缓存版本号，修改时递增触发重截
  createdAt: number;
}

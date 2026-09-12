// projects.ts - 项目数据管理模块
import { appDataDir, join } from '@tauri-apps/api/path';
import { readTextFile, writeTextFile, exists, mkdir, remove } from '@tauri-apps/plugin-fs';
import { Sentence, TextOverlay } from './types';

export interface SubtitleStyle {
  fontFamily: string;
  fontSize: number;
  position: number;
  preset: 'white-black' | 'black-white' | 'yellow-black' | 'white-none' | 'black-none' | 'yellow';
  /** 字体文件的绝对路径（导出时由前端传入后端，确保前后端使用同一字体） */
  fontPath?: string;
}

export interface ExternalAudioInfo {
  /** 外部音频文件路径 */
  path: string;
  /** 相对于视频的偏移量（毫秒），正数=延后，负数=提前 */
  offsetMs: number;
  /** 匹配置信度 0-1 */
  confidence: number;
}

export interface Project {
  id: string;
  name: string;
  videoPath: string;
  sentences: Sentence[];
  srt: string;
  text: string;
  rawText: string;
  createdAt: string;
  updatedAt: string;
  // 项目类型：长视频 / 短视频
  projectType: 'long' | 'short';
  // 外部音频（领夹麦等替代音源）
  externalAudio?: ExternalAudioInfo;
  // 可选的LLM推理结果（持久化）
  step1Result?: string;
  step2Result?: string;
  highlightClips?: any[];
  parseStats?: { success: number; fail: number };
  // 字幕样式（全局）
  subtitleStyle?: SubtitleStyle;
  // 竖屏字幕样式（全局）
  verticalSubtitleStyle?: SubtitleStyle;
  // 滤镜（全局）
  filter?: string;
  // 字幕显示（全局，按项目记忆）
  showSubtitle?: boolean;
  // 音频配置（全局）
  audioConfig?: {
    voiceGain: number;
    bgmUrl: string | null;
    bgmVolume: number;
    fadeInDuration: number;
    fadeOutDuration: number;
    noiseReduction: boolean;
    hpFreq: number;
    lpFreq: number;
    rnnoiseEnabled: boolean;
  };
  // 文字贴纸（横屏全局）
  textOverlays?: TextOverlay[];
  // 文字贴纸（竖屏全局）
  verticalTextOverlays?: TextOverlay[];
  // 识别状态（用于项目空间展示后台识别进度）
  recognitionStatus?: 'recognizing' | 'completed' | 'failed' | 'cancelled';
  // 识别完成后统计的总字数
  wordCount?: number;
  // 是否置顶
  isPinned?: boolean;
  // 代理视频文件路径（480p H.264 低清预览用）
  proxyVideoPath?: string;
  // 代理文件生成状态
  proxyStatus?: 'pending' | 'ready' | 'failed';
  // 长视频替换音轨后的视频路径
  replacedVideoPath?: string;
  // 短视频编辑进度（用于持久化编辑状态）
  shortEditProgress?: {
    sentences: any[];
    deletedSentences: any[];
    lastEditedAt: string;

  };
}

const PROJECTS_DIR = 'projects';
const INDEX_FILE = 'projects_index.json';

async function getProjectsDir(): Promise<string> {
  const dataDir = await appDataDir();
  return await join(dataDir, PROJECTS_DIR);
}

async function ensureProjectsDir(): Promise<string> {
  const dir = await getProjectsDir();
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

async function getIndexPath(): Promise<string> {
  const dir = await getProjectsDir();
  return await join(dir, INDEX_FILE);
}

export interface ProjectIndexEntry {
  id: string;
  name: string;
  videoPath: string;
  createdAt: string;
  updatedAt: string;
  sentenceCount: number;
  // 项目类型
  projectType?: 'long' | 'short';
  // 识别状态
  recognitionStatus?: 'recognizing' | 'completed' | 'failed' | 'cancelled';
  // 识别完成后统计的总字数
  wordCount?: number;
  // 精彩片段数量
  highlightClipCount?: number;
  // 是否置顶
  isPinned?: boolean;
}

async function loadIndex(): Promise<ProjectIndexEntry[]> {
  try {
    const indexPath = await getIndexPath();
    if (await exists(indexPath)) {
      const content = await readTextFile(indexPath);
      return JSON.parse(content);
    }
  } catch (e) {
    console.error('加载项目索引失败:', e);
  }
  return [];
}

async function saveIndex(index: ProjectIndexEntry[]): Promise<void> {
  const indexPath = await getIndexPath();
  await writeTextFile(indexPath, JSON.stringify(index, null, 2));
}

async function getProjectFilePath(projectId: string): Promise<string> {
  const dir = await ensureProjectsDir();
  return await join(dir, `project_${projectId}.json`);
}

/**
 * 获取项目缩略图目录路径
 */
export async function getProjectThumbsDir(projectId: string): Promise<string> {
  const dir = await getProjectsDir();
  return await join(dir, 'thumbs', projectId);
}

/**
 * 获取项目提取音频的文件路径（持久化到前端项目目录，按 projectId 命名区分）
 */
export async function getProjectAudioPath(projectId: string): Promise<string> {
  const dir = await getProjectsDir();
  return await join(dir, 'audio', `extracted_${projectId}.wav`);
}

/**
 * 获取项目外部音频的文件路径
 */
export async function getProjectExternalAudioPath(projectId: string): Promise<string> {
  const dir = await getProjectsDir();
  return await join(dir, 'audio', `external_${projectId}.aac`);
}

/**
 * 获取长视频替换音轨后的视频路径
 */
export async function getProjectReplacedVideoPath(projectId: string): Promise<string> {
  const dir = await getProjectsDir();
  return await join(dir, 'replaced', `replaced_${projectId}.mp4`);
}

/**
 * 获取项目代理视频的文件路径（480p H.264 低清预览用）
 */
export async function getProjectProxyPath(projectId: string): Promise<string> {
  const dir = await getProjectsDir();
  return await join(dir, 'proxy', `proxy_${projectId}.mp4`);
}

/**
 * 获取所有项目列表（从索引读取，轻量）
 * @param projectType 可选，按类型过滤
 */
export async function listProjects(projectType?: 'long' | 'short'): Promise<ProjectIndexEntry[]> {
  const index = await loadIndex();
  if (projectType) {
    if (projectType === 'long') {
      // 长视频空间：显式 long + 旧数据（无 projectType 的默认为 long）
      return index.filter(p => p.projectType === 'long' || !p.projectType);
    }
    // 短视频空间：只显示显式 short 的项目
    return index.filter(p => p.projectType === 'short');
  }
  return index;
}

/**
 * 加载单个项目的完整数据
 */
export async function loadProject(projectId: string): Promise<Project | null> {
  try {
    const filePath = await getProjectFilePath(projectId);
    if (!(await exists(filePath))) {
      return null;
    }
    const content = await readTextFile(filePath);
    const project = JSON.parse(content);
    // 兼容旧数据：没有 projectType 的默认为 long
    if (!project.projectType) {
      project.projectType = 'long';
    }
    // 兼容旧数据：smoothTracking / cameraEasing 从 boolean 迁移到 number
    if (project.highlightClips) {
      for (const clip of project.highlightClips) {
        if (clip.vertical) {
          if (typeof clip.vertical.smoothTracking === 'boolean') {
            clip.vertical.smoothTracking = clip.vertical.smoothTracking ? 1.0 : 0;
          }
          if (typeof clip.vertical.cameraEasing === 'boolean') {
            clip.vertical.cameraEasing = clip.vertical.cameraEasing ? 1.0 : 0;
          }
        }
      }
    }
    return project;
  } catch (e) {
    console.error('加载项目失败:', e);
    return null;
  }
}

/**
 * 保存项目（创建或更新）
 */
export async function isProjectNameExists(name: string, projectType: 'long' | 'short', excludeId?: string): Promise<boolean> {
  const index = await loadIndex();
  return index.some(p =>
    p.name === name &&
    p.projectType === projectType &&
    p.id !== excludeId
  );
}

export async function saveProject(project: Project): Promise<void> {
  // 检查同类型下是否有同名项目（排除自己）
  const index = await loadIndex();
  const duplicate = index.find(p =>
    p.name === project.name &&
    p.projectType === project.projectType &&
    p.id !== project.id
  );
  if (duplicate) {
    throw new Error(`项目名称"${project.name}"已存在`);
  }

  const dir = await ensureProjectsDir();
  const filePath = await join(dir, `project_${project.id}.json`);

  project.updatedAt = new Date().toISOString();

  // 保存完整项目数据
  await writeTextFile(filePath, JSON.stringify(project, null, 2));

  // 更新索引（复用上面已加载的 index）
  const existingIdx = index.findIndex(p => p.id === project.id);
  const entry: ProjectIndexEntry = {
    id: project.id,
    name: project.name,
    videoPath: project.videoPath,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    sentenceCount: project.sentences?.length || 0,
    projectType: project.projectType,
    recognitionStatus: project.recognitionStatus,
    wordCount: project.wordCount,
    highlightClipCount: project.highlightClips?.length || 0,
    isPinned: project.isPinned
  };

  if (existingIdx >= 0) {
    index[existingIdx] = entry;
  } else {
    index.push(entry);
  }

  // 排序：置顶项目在前，然后按创建时间倒序
  index.sort((a, b) => {
    if (a.isPinned && !b.isPinned) return -1;
    if (!a.isPinned && b.isPinned) return 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  await saveIndex(index);
}

/**
 * 切换项目置顶状态
 */
export async function togglePinProject(projectId: string): Promise<boolean> {
  try {
    const project = await loadProject(projectId);
    if (!project) return false;

    const newPinned = !project.isPinned;
    project.isPinned = newPinned;
    project.updatedAt = new Date().toISOString();

    // 保存完整项目
    const filePath = await getProjectFilePath(projectId);
    await writeTextFile(filePath, JSON.stringify(project, null, 2));

    // 更新索引
    const index = await loadIndex();
    const idx = index.findIndex(p => p.id === projectId);
    if (idx >= 0) {
      index[idx].isPinned = newPinned;
      index[idx].updatedAt = project.updatedAt;
    }

    // 排序：置顶在前，然后按创建时间倒序
    index.sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    await saveIndex(index);

    return newPinned;
  } catch (e) {
    console.error('切换置顶失败:', e);
    return false;
  }
}

/**
 * 删除项目（同时清理缩略图目录）
 */
export async function deleteProject(projectId: string): Promise<void> {
  try {
    const filePath = await getProjectFilePath(projectId);
    if (await exists(filePath)) {
      await remove(filePath);
    }

    // 清理缩略图目录
    const thumbsDir = await getProjectThumbsDir(projectId);
    if (await exists(thumbsDir)) {
      await remove(thumbsDir, { recursive: true });
    }

    // 清理代理视频文件
    const proxyPath = await getProjectProxyPath(projectId);
    if (await exists(proxyPath)) {
      await remove(proxyPath);
    }

    // 清理提取的音频文件
    const audioPath = await getProjectAudioPath(projectId);
    if (await exists(audioPath)) {
      await remove(audioPath);
    }

    // 清理外部音频文件
    const externalAudioPath = await getProjectExternalAudioPath(projectId);
    if (await exists(externalAudioPath)) {
      await remove(externalAudioPath);
    }
    // 清理外部音频转码后的 ASR 文件
    const externalAsrPath = externalAudioPath.replace(/\.aac$/, '_asr.aac');
    if (await exists(externalAsrPath)) {
      await remove(externalAsrPath);
    }
    // 清理外部音频 ASR 净化后的文件
    const externalAsrCleanedPath = externalAudioPath.replace(/\.aac$/, '_asr_cleaned.aac');
    if (await exists(externalAsrCleanedPath)) {
      await remove(externalAsrCleanedPath);
    }
    // 清理从视频提取的 AAC 文件
    const { join } = await import('@tauri-apps/api/path');
    const { appDataDir } = await import('@tauri-apps/api/path');
    const dataDir = await appDataDir();
    const extractedAacPath = await join(dataDir, 'projects', 'audio', `extracted_${projectId}.aac`);
    if (await exists(extractedAacPath)) {
      await remove(extractedAacPath);
    }
    // 清理从视频提取的 AAC 净化后的文件
    const extractedAacCleanedPath = await join(dataDir, 'projects', 'audio', `extracted_${projectId}_cleaned.aac`);
    if (await exists(extractedAacCleanedPath)) {
      await remove(extractedAacCleanedPath);
    }

    // 清理替换音轨后的视频文件
    const replacedVideoPath = await getProjectReplacedVideoPath(projectId);
    if (await exists(replacedVideoPath)) {
      await remove(replacedVideoPath);
    }

    const index = await loadIndex();
    const newIndex = index.filter(p => p.id !== projectId);
    await saveIndex(newIndex);
  } catch (e) {
    console.error('删除项目失败:', e);
    throw e;
  }
}

/**
 * 生成唯一项目ID
 */
export function generateProjectId(): string {
  return `proj_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 从视频路径生成默认项目名称
 */
export function generateProjectName(videoPath: string): string {
  const fileName = videoPath.split(/[\\/]/).pop() || '未命名项目';
  const nameWithoutExt = fileName.replace(/\.[^/.]+$/, '');
  return nameWithoutExt;
}

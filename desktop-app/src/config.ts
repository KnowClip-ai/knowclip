// config.ts
import { appConfigDir, join } from '@tauri-apps/api/path';
import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';

export interface AppConfig {
  version: number;
  prompts: {
    longStep2: string;
    short: string;
  };
  models: {
    long: string;
    short: string;
  };
  asr?: {
    coeff: number;
    lastTestedAt: string;
  };
  favoriteFilters?: string[];
  favoriteTextStyles?: string[];
  enableThinking?: boolean;
  enableThinkingShort?: boolean;
  localLlm?: {
    baseUrl: string;
    apiKey: string;
  };
  localLlmModels?: string[];
}

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  prompts: {
    longStep2: `通读全文，从原文中找出10个精彩片段。

要求：
片段标题：符合短视频平台爆款逻辑，不超过30个字。
片段字数：300-500字
片段内容：要兼顾精彩与结构完整性。
片段描述：生成吸引人观看的理由，100字以内。
片段标签：提供5个带"#"的话题标签，须精准匹配片段主题，以提升平台搜索与推荐曝光。
片段评分：精彩程度占60%，结构完整性占40%。`,
    short: `通读全文，通过删除和保留句子，让整体变得更流畅。`
  },
  models: {
    long: '',
    short: ''
  },
  favoriteFilters: [],
  enableThinking: false,
  enableThinkingShort: false
};

const CONFIG_FILE_NAME = 'prompt.json';

export async function loadConfig(): Promise<AppConfig> {
  try {
    const dir = await appConfigDir();
    const filePath = await join(dir, CONFIG_FILE_NAME);

    if (await exists(filePath)) {
      const content = await readTextFile(filePath);
      const parsed = JSON.parse(content);
      return { ...DEFAULT_CONFIG, ...parsed };
    }
    return DEFAULT_CONFIG;
  } catch (e) {
    console.error('读取配置失败:', e);
    return DEFAULT_CONFIG;
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  const dir = await appConfigDir();
  const filePath = await join(dir, CONFIG_FILE_NAME);


  // 检查目录是否存在，不存在则创建
  const dirExists = await exists(dir);

  if (!dirExists) {
    try {
      await mkdir(dir, { recursive: true });
    } catch (e) {
      console.error('[Config] 创建目录失败:', e);
      throw new Error(`创建配置目录失败: ${e}`);
    }
  }

  // 再次确认目录存在
  const checkAgain = await exists(dir);
  if (!checkAgain) {
    throw new Error('目录创建后仍不存在，权限可能不足');
  }

  // 写入文件
  try {
    await writeTextFile(filePath, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('[Config] 写入文件失败:', e);
    throw e;
  }
}

/** 隐藏提示词：每次发请求时自动拼接在显式提示词后面，UI 不可见 */
export const HIDDEN_PROMPT_SUFFIX = `【输出片段内容 - 绝对约束】
1. 原文提取：提取的片段内容必须包含原文的所有特征，包括错别字、语病、口语化表达、特殊标点。如果原文有错别字，你必须保留错别字。
2. 禁止优化：即使你觉得原文不通顺，也绝对不要修改它。你的任务是"复制粘贴"，而不是"编辑"。

【严格输出格式 - 必须遵守】
每个片段必须严格按以下格式输出，不得添加markdown标记（如**、##、---）：
片段标题：[标题文本，单行]
片段字数：[字符数]
片段内容：[直接引用原文，不带引号，单行]
片段描述：[吸引点击的描述，单行，100字以内]
片段标签：[#标签]
片段评分：[数字1-100]`;
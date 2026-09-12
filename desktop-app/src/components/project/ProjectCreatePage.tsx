import React, { useState, useEffect } from 'react';
import { open, message } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { FolderOpen } from '@phosphor-icons/react';
import { generateProjectName } from '../../projects';

interface ProjectCreatePageProps {
  onStartRecognize: (filePath: string, projectName: string) => void | Promise<void>;
  onNavigateProjectSpace: () => void;
  onNavigateHome: () => void;
}

const SUPPORTED_EXTS = ['mp4', 'mov'];

const isSupportedFormat = (filePath: string): boolean => {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return SUPPORTED_EXTS.includes(ext);
};

export const ProjectCreatePage: React.FC<ProjectCreatePageProps> = ({
  onStartRecognize,
  onNavigateProjectSpace,
  onNavigateHome
}) => {
  const [isDragging, setIsDragging] = useState(false);

  // 注册 Tauri 全局拖拽事件监听
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupDragDrop = async () => {
      try {
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === 'over') {
            setIsDragging(true);
          } else if (payload.type === 'leave') {
            setIsDragging(false);
          } else if (payload.type === 'drop') {
            setIsDragging(false);
            const paths = payload.paths;
            const videoPath = paths.find((p: string) =>
              /\.(mp4|mov)$/i.test(p)
            );
            if (videoPath) {
              if (!isSupportedFormat(videoPath)) {
                message('不支持该格式，请选择 H.264 或 HEVC 编码的 mp4 / mov 格式视频', { title: '格式不支持', kind: 'error' });
                return;
              }
              handleStartRecognize(videoPath);
            }
          }
        });
      } catch (e) {
        console.error('DragDrop setup failed:', e);
      }
    };

    setupDragDrop();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const handleStartRecognize = async (videoPath: string) => {
    onNavigateProjectSpace(); // 立即跳转到项目空间，不等识别启动完成
    await onStartRecognize(videoPath, generateProjectName(videoPath));
  };

  const handleFileSelect = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          { name: '视频文件', extensions: ['mp4', 'mov'] }
        ]
      });
      if (selected && typeof selected === 'string') {
        if (!isSupportedFormat(selected)) {
          message('不支持该格式，请选择 H.264 或 HEVC 编码的 mp4 / mov 格式视频', { title: '格式不支持', kind: 'error' });
          return;
        }
        handleStartRecognize(selected);
      }
    } catch (e) {
      message('选择文件失败', { title: '错误', kind: 'error' });
    }
  };

  return (
    <div style={{ padding: '20px', maxWidth: '800px', margin: '0 auto' }}>
      {/* 标题 + 右上角导航 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '32px' }}>
        <h1 style={{ color: '#f5576c', margin: 0 }}>🎬 创建新项目</h1>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button
            onClick={onNavigateProjectSpace}
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
          <button
            onClick={onNavigateHome}
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
            返回首页
          </button>
        </div>
      </div>

      {/* 16:9 虚线框 */}
      <div
        style={{
          aspectRatio: '16/9',
          marginBottom: '20px',
          padding: '20px',
          border: isDragging ? '2px solid #f5576c' : '2px dashed #f5576c',
          borderRadius: '8px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: isDragging ? '#fff0f2' : 'transparent',
          transition: 'all 0.2s ease'
        }}
        onClick={handleFileSelect}
      >
        <div style={{ textAlign: 'center', color: '#666' }}>
          <div style={{ marginBottom: '12px' }}><FolderOpen weight="fill" size={48} color="#f5576c" /></div>
          <div style={{ fontSize: '15px', fontWeight: 500, marginBottom: '6px' }}>
            拖拽/点击选择视频文件
          </div>
          <div style={{ fontSize: '13px', color: '#999' }}>
            支持 mp4, mov 格式（H.264 / HEVC 编码）
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProjectCreatePage;

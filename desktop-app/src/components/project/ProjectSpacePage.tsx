import React, { useState, useEffect, useRef } from 'react';
import { FolderPlus, Clock, TextT, Folder, FilmStrip, Star, HourglassMedium } from '@phosphor-icons/react';
import { listProjects, deleteProject, togglePinProject, ProjectIndexEntry } from '../../projects';
import { confirm } from '@tauri-apps/plugin-dialog';
import { RecognizingTask } from '../../hooks/useProjectRecognizer';

interface ProjectSpacePageProps {
  onCreateProject: () => void;
  onOpenProject: (projectId: string) => void;
  onBack: () => void;
  recognizingTasks: Record<string, RecognizingTask>;
  onCancelRecognition: (projectId: string) => void;
  projectType?: 'long' | 'short';
  error?: string;
}

export const ProjectSpacePage: React.FC<ProjectSpacePageProps> = ({
  onCreateProject,
  onOpenProject,
  onBack,
  recognizingTasks,
  onCancelRecognition,
  projectType = 'long',
  error: globalError
}) => {
  const [projects, setProjects] = useState<ProjectIndexEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const prevTaskKeysRef = useRef<string>('');

  const loadProjects = async () => {
    try {
      setLoading(true);
      setError('');
      const list = await listProjects(projectType);
      setProjects(list);
    } catch (e) {
      setError('加载项目列表失败');
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProjects();
  }, []);

  // 当识别任务状态变化（新增或完成）时，刷新列表
  useEffect(() => {
    const currentKeys = Object.keys(recognizingTasks).sort().join(',');
    const prevKeys = prevTaskKeysRef.current;
    prevTaskKeysRef.current = currentKeys;

    if (currentKeys !== prevKeys) {
      loadProjects();
    }
  }, [recognizingTasks]);

  const handleDelete = async (e: React.MouseEvent, project: ProjectIndexEntry) => {
    e.stopPropagation();
    const confirmed = await confirm(
      `将清除该项目下的全部字幕、片段缓存，已生成的视频不会被清除。`,
      { title: '确认删除该项目？', kind: 'warning' }
    );
    if (confirmed) {
      try {
        await deleteProject(project.id);
        await loadProjects();
      } catch (e) {
        setError('删除失败');
      }
    }
  };

  const handleCancel = (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation();
    onCancelRecognition(projectId);
  };

  const formatDate = (isoString: string) => {
    const d = new Date(isoString);
    return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  const formatDuration = (seconds: number): string => {
    if (seconds < 60) return `${Math.ceil(seconds)}秒`;
    const m = Math.floor(seconds / 60);
    const s = Math.ceil(seconds % 60);
    return `${m}分${s}秒`;
  };

  const isRecognizing = (projectId: string) => {
    const task = recognizingTasks[projectId];
    return !!task && task.progress.isProcessing;
  };

  const isCancelling = (projectId: string) => {
    return !!recognizingTasks[projectId]?.isCancelling;
  };

  const getTaskProgress = (projectId: string) => {
    return recognizingTasks[projectId]?.progress;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '20px 24px 24px', boxSizing: 'border-box' }}>
      <div style={{ flexShrink: 0, maxWidth: '1000px', width: '100%', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '32px' }}>
        <h1 style={{ color: '#f5576c', margin: 0 }}>
          🎬 长视频精彩切片 - 项目空间
        </h1>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button
            onClick={onBack}
            style={{
              padding: '10px 20px',
              background: '#f0f0f0',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              fontSize: '14px'
            }}
          >
            返回首页
          </button>
          <button
            onClick={onCreateProject}
            style={{
              padding: '10px 24px',
              background: '#f5576c',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}
          >
            <FolderPlus weight="fill" size={16} /> 创建项目
          </button>
        </div>
      </div>

      {globalError && (
        <div style={{ color: '#FF3B30', marginBottom: '16px', padding: '12px', background: '#ffe6e6', borderRadius: '8px' }}>
          {globalError}
        </div>
      )}
      {error && (
        <div style={{ color: '#FF3B30', marginBottom: '16px', padding: '12px', background: '#ffe6e6', borderRadius: '8px' }}>
          {error}
        </div>
      )}
      </div>

      <div className="custom-scrollbar" style={{ flex: 1, overflowY: 'auto', minHeight: 0, maxWidth: '1000px', width: '100%', margin: '0 auto' }}>
      {loading ? (
        <div style={{ textAlign: 'center', padding: '60px', color: '#666' }}>
          <div style={{ marginBottom: '12px', display: 'flex', justifyContent: 'center' }}>
            <HourglassMedium size={32} weight="fill" color="#666" />
          </div>
          加载中...
        </div>
      ) : projects.length === 0 ? (
        <div style={{
          textAlign: 'center',
          padding: '80px 20px',
          background: '#f9f9f9',
          borderRadius: '16px'
        }}>
          <div style={{ fontSize: '64px', marginBottom: '16px' }}>🎬</div>
          <h2 style={{ color: '#666', margin: '0 0 12px 0' }}>暂无项目</h2>
          <p style={{ color: '#999', margin: '0 0 24px 0' }}>
            点击右上角"创建项目"开始你的第一个长视频切片
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '16px' }}>
          {projects.map(project => {
            const recognizing = isRecognizing(project.id);
            const progress = getTaskProgress(project.id);
            const isCompleted = project.recognitionStatus === 'completed';
            const isFailed = project.recognitionStatus === 'failed' || project.recognitionStatus === 'cancelled';

            return (
              <div
                key={project.id}
                onClick={() => {
                  if (recognizing) return;
                  onOpenProject(project.id);
                }}
                style={{
                  padding: '20px 24px',
                  background: 'white',
                  borderRadius: '12px',
                  border: '1px solid #e8e8e8',
                  cursor: recognizing ? 'default' : 'pointer',
                  transition: 'all 0.2s ease',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '16px',
                  position: 'relative'
                }}
                onMouseEnter={(e) => {
                  if (!recognizing) {
                    e.currentTarget.style.borderColor = '#f5576c';
                    e.currentTarget.style.boxShadow = '0 4px 12px rgba(245, 87, 108, 0.1)';
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = '#e8e8e8';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                {/* 置顶星星 */}
                <div
                  onClick={async (e) => {
                    e.stopPropagation();
                    await togglePinProject(project.id);
                    await loadProjects();
                  }}
                  style={{
                    position: 'absolute',
                    top: '4px',
                    left: '4px',
                    cursor: 'pointer',
                    padding: '4px',
                    borderRadius: '4px',
                    color: '#c7c7cc',
                    transition: 'color 0.15s ease',
                    zIndex: 5
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = '#f5576c'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = '#c7c7cc'; }}
                  title={project.isPinned ? '取消置顶' : '置顶'}
                >
                  {project.isPinned ? (
                    <Star weight="fill" size={16} color="#FFD700" />
                  ) : (
                    <Star weight="regular" size={16} />
                  )}
                </div>

                <div style={{
                  width: '48px',
                  height: '48px',
                  borderRadius: '12px',
                  background: '#fff0f2',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '24px',
                  flexShrink: 0
                }}>
                  {recognizing ? (
                    <HourglassMedium size={24} weight="fill" color="#666" />
                  ) : (
                    '🎬'
                  )}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: '16px',
                    fontWeight: 600,
                    color: '#1d1d1f',
                    marginBottom: '4px',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}>
                    {project.name}
                  </div>

                  {/* 识别中：进度条 + 预计时间 */}
                  {recognizing && progress && (
                    <div style={{ marginBottom: '8px' }}>
                      <div style={{
                        width: '100%',
                        height: '6px',
                        background: '#f0f0f0',
                        borderRadius: '3px',
                        overflow: 'hidden',
                        marginBottom: '4px'
                      }}>
                        <div style={{
                          width: `${progress.percent}%`,
                          height: '100%',
                          background: '#f5576c',
                          borderRadius: '3px',
                          transition: 'width 0.3s ease'
                        }} />
                      </div>
                      <div style={{ fontSize: '12px', color: '#f5576c' }}>
                        {progress.message || '准备中...'}
                      </div>
                    </div>
                  )}

                  {/* 失败状态 */}
                  {isFailed && (
                    <div style={{ fontSize: '13px', color: '#FF3B30', marginBottom: '4px' }}>
                      ❌ 识别失败/已取消
                    </div>
                  )}

                  {/* 识别完成后只显示一行：日期 + 字数 + 精彩片段 */}
                  {isCompleted && (
                    <div style={{ fontSize: '13px', color: '#666', display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><Clock weight="fill" size={13} /> {formatDate(project.updatedAt)}</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><TextT weight="fill" size={13} /> 字幕{project.wordCount || project.sentenceCount}字</span>
                      {typeof project.highlightClipCount === 'number' && project.highlightClipCount > 0 && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><FilmStrip weight="fill" size={13} /> 精彩片段{project.highlightClipCount}条</span>
                      )}
                    </div>
                  )}
                </div>

                {/* 按钮区 */}
                {recognizing ? (
                  isCancelling(project.id) ? (
                    <span style={{
                      padding: '8px 14px',
                      color: '#999',
                      fontSize: '13px',
                      whiteSpace: 'nowrap',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px'
                    }}>
                      <span style={{
                        display: 'inline-block',
                        width: '12px',
                        height: '12px',
                        border: '2px solid #e0e0e0',
                        borderTopColor: '#999',
                        borderRadius: '50%',
                        animation: 'spin 1s linear infinite'
                      }} />
                      正在取消...
                    </span>
                  ) : (
                    <button
                      onClick={(e) => handleCancel(e, project.id)}
                      style={{
                        padding: '8px 14px',
                        background: 'transparent',
                        color: '#FF3B30',
                        border: '1px solid #FF3B30',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        opacity: 0.9,
                        transition: 'opacity 0.2s',
                        whiteSpace: 'nowrap'
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.9'; }}
                    >
                      取消
                    </button>
                  )
                ) : (
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <button
                      onClick={(e) => handleDelete(e, project)}
                      style={{
                        padding: '8px 14px',
                        background: 'transparent',
                        color: '#FF3B30',
                        border: '1px solid #FF3B30',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        opacity: 0.7,
                        transition: 'opacity 0.2s',
                        whiteSpace: 'nowrap'
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; }}
                    >
                      删除
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      </div>
    </div>
  );
};

export default ProjectSpacePage;

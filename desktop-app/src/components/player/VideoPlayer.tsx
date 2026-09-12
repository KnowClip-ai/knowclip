// @ts-nocheck
import React from 'react';
import { formatTimeMs } from '../../utils';
import { XCircle } from '@phosphor-icons/react';

import { usePlayer } from './PlayerContext';

const VideoPlayer: React.FC = () => {
  const {
    activePlayerClip,
    activePlayerClipRef,
    closePlayer,
    currentTime,
    duration,
    isDragging,
    isDraggingProgressRef,
    isPlayerHovered,
    isPlaying,
    lastTimeUpdateStateRef,
    loadingOverlayRef,
    progressBarRef,
    setIsDragging,
    setIsPlayerHovered,
    setIsPlaying,
    setPlayerAspectRatio,
    setVideoLoadError,
    setCurrentTime,
    setDuration,
    thumbDimensions,
    thumbnails,
    videoContainerRef,
    videoLoadError,
    videoRef,
    audioRef,
    videoServerUrl,
    audioServerUrl,
    audioOffsetMs,
    playerScale,
    playerContainerSize,
    playerContainerRef,
  } = usePlayer();

  // video DOM 复用：片段切换时重置直接操作过的样式，避免残留
  React.useEffect(() => {
    const video = videoRef.current;
    if (!video || !activePlayerClip) return;
    // 切换片段时重置可能被上一片段设置的 transform/width/height
    video.style.transform = '';
    video.style.width = '';
    video.style.height = '';
  }, [activePlayerClip?.id]);

  // 强制收敛 video 内联样式，保证完整画面渲染
  React.useLayoutEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.style.transform = '';
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.objectFit = 'contain';
    video.style.objectPosition = 'center center';
  }, [activePlayerClip?.id, playerContainerSize?.width, playerContainerSize?.height]);

  return activePlayerClip ? (
        <>
          <div
            style={{
              position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
              background: 'rgba(0,0,0,0.85)',
              backdropFilter: 'blur(10px)',
              zIndex: 9998
            }}
            onWheel={(e) => e.stopPropagation()}
          />
          <div
            ref={playerContainerRef}
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: playerContainerSize ? playerContainerSize.width : 960,
              height: playerContainerSize ? playerContainerSize.height : 540,
              maxWidth: '90vw',
              maxHeight: '90vh',
              overflow: 'hidden',
              borderRadius: '16px',
              background: '#000',
              zIndex: 9999,
              userSelect: 'none',
              WebkitUserSelect: 'none',
              MozUserSelect: 'none',
              msUserSelect: 'none'
            }}
            onWheel={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onMouseEnter={() => setIsPlayerHovered(true)}
            onMouseLeave={() => setIsPlayerHovered(false)}
          >
            <div
              style={{
                width: '100%',
                height: '100%',
                background: 'transparent',
                position: 'relative',
                boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)'
              }}
            >
              <button
                onClick={closePlayer}
                style={{
                  position: 'absolute',
                  top: '8px',
                  right: '12px',
                  zIndex: 100,
                  background: 'transparent',
                  border: 'none',
                  color: 'rgba(255,255,255,0.9)',
                  width: '28px',
                  height: '28px',
                  borderRadius: '0',
                  fontSize: '28px',
                  lineHeight: '28px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '0',
                  textShadow: '0 2px 8px rgba(0,0,0,0.5)',
                  transition: 'color 0.2s, transform 0.2s',
                  pointerEvents: 'auto',
                  userSelect: 'none'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = '#ffffff';
                  e.currentTarget.style.transform = 'scale(1.1)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = 'rgba(255,255,255,0.9)';
                  e.currentTarget.style.transform = 'scale(1)';
                }}
              >
                ×
              </button>

              <div
                style={{
                  position: 'absolute',
                  top: '16px',
                  left: '16px',
                  right: '60px',
                  zIndex: 50,
                  opacity: (isPlaying && !isPlayerHovered) ? 0 : 1,
                  pointerEvents: (isPlaying && !isPlayerHovered) ? 'none' : 'auto',
                  transition: 'opacity 250ms ease-out',
                  userSelect: 'none',
                  zoom: playerScale < 1 ? playerScale : undefined
                }}
              >
                <h2 style={{
                  margin: '0 0 4px 0',
                  fontSize: '15px',
                  fontWeight: 600,
                  color: 'white',
                  textShadow: '0 1px 4px rgba(0,0,0,0.8)',
                  letterSpacing: '-0.01em',
                  lineHeight: 1.2
                }}>
                  {activePlayerClip.title}
                </h2>
                <div style={{
                  fontSize: '12px',
                  color: 'rgba(255,255,255,0.8)',
                  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                  textShadow: '0 1px 2px rgba(0,0,0,0.8)'
                }}>
                  {formatTimeMs(activePlayerClip.startMs)} - {formatTimeMs(activePlayerClip.endMs)}
                  {((activePlayerClipRef.current?.isEdited ?? activePlayerClip.isEdited) || (activePlayerClipRef.current?.subtitleEdited ?? activePlayerClip.subtitleEdited)) && (
                    <span style={{ color: '#FF9500', marginLeft: '8px', fontSize: '11px' }}>已编辑</span>
                  )}
                </div>
              </div>

              {!videoServerUrl && !videoLoadError && (
                <div style={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'rgba(255,255,255,0.4)',
                  fontSize: '14px'
                }}>
                  正在加载视频资源...
                </div>
              )}

              {videoLoadError && (
                <div style={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#ff6b6b',
                  fontSize: '14px',
                  padding: '20px',
                  textAlign: 'center'
                }}>
                  <div style={{ marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}><XCircle weight="fill" size={16} /> 视频加载失败</div>
                  <div style={{ fontSize: '12px', opacity: 0.7 }}>{videoLoadError}</div>
                </div>
              )}

              {videoServerUrl && (
                <div style={{ width: '100%', height: '100%', position: 'relative' }}>
                  <div
                    ref={loadingOverlayRef}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      zIndex: 20,
                      opacity: 0,
                      pointerEvents: 'none',
                      transition: 'opacity 0.15s linear',
                      background: '#000'
                    }}
                  >
                    {activePlayerClip?.id && thumbnails[activePlayerClip.id] && (
                      <div style={{
                        position: 'absolute',
                        inset: 0,
                        backgroundImage: `url(${thumbnails[activePlayerClip.id]})`,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                        filter: 'brightness(0.4)',
                        transform: 'translateZ(0)'
                      }} />
                    )}
                    <div style={{
                      position: 'absolute',
                      top: '50%',
                      left: '50%',
                      transform: 'translate(-50%, -50%) translateZ(0)',
                      zIndex: 2,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '12px'
                    }}>
                      <div className="loading-spinner" style={{
                        width: '40px',
                        height: '40px',
                        border: '3px solid rgba(255,255,255,0.15)',
                        borderTopColor: '#f5576c',
                        borderRadius: '50%',
                        willChange: 'transform'
                      }} />
                      <span style={{
                        color: '#fff',
                        fontSize: '13px',
                        opacity: 0.9,
                        textShadow: '0 1px 2px rgba(0,0,0,0.8)'
                      }}>加载中...</span>
                    </div>
                  </div>

                  <style>{`
                    @keyframes spin {
                      from { transform: rotate(0deg); }
                      to { transform: rotate(360deg); }
                    }
                    .loading-spinner {
                      animation: spin 0.8s linear infinite;
                      contain: strict;
                    }
                  `}</style>

                  <div
                    ref={videoContainerRef}
                    style={{
                      width: '100%',
                      height: '100%',
                      position: 'relative',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                  >
                    <div style={{
                      width: '100%',
                      height: '100%'
                    }}>
                      {/* 分轨模式：独立 audio 元素（隐藏） */}
                      {audioServerUrl && (
                        <audio
                          ref={audioRef}
                          src={audioServerUrl}
                          crossOrigin="anonymous"
                          preload="metadata"
                          style={{ display: 'none' }}
                        />
                      )}
                      <video
                        ref={videoRef}
                        src={videoServerUrl}
                        crossOrigin="anonymous"
                        poster={activePlayerClip?.id ? thumbnails[activePlayerClip.id] : undefined}
                        preload="auto"
                        playsInline
                        controls={false}
                        muted={!!audioServerUrl}
                        style={{
                          width: '100%',
                          height: '100%',
                          // 横屏模式必须完整显示画面，避免窗口态被 cover 裁切
                          objectFit: 'contain',
                          display: 'block',
                          position: 'relative',
                          left: 0,
                          zIndex: 1,
                          backgroundColor: 'transparent',
                        }}
                    onLoadedMetadata={(e) => {
                      const video = e.currentTarget;
                      const clip = activePlayerClipRef.current;
                      if (!clip) return;
                      // 横屏下这里只更新方向标记，不在这里改容器尺寸。
                      // 缩略图阶段容器已是正确比例，metadata 阶段强制重算会引发首帧跳变/错位。
                      const vW = video.videoWidth;
                      const vH = video.videoHeight;
                      if (vW > 0 && vH > 0) setPlayerAspectRatio(`${vW} / ${vH}`);
                      // 真实视频帧切入时再次兜底，确保横屏不吃到遗留内联尺寸
                      video.style.transform = '';
                      video.style.width = '100%';
                      video.style.height = '100%';
                      video.style.objectFit = 'contain';
                      video.style.objectPosition = 'center center';
                    }}
                    onTimeUpdate={(e) => {
                      const video = e.currentTarget;
                      const clip = activePlayerClipRef.current;
                      if (!clip) return;
                      const relativeTime = Math.max(0, video.currentTime * 1000 - clip.startMs) / 1000;
                      const clipDuration = (clip.endMs - clip.startMs) / 1000;
                      const now = Date.now();
                      if (now - lastTimeUpdateStateRef.current >= 100) {
                        lastTimeUpdateStateRef.current = now;
                        setCurrentTime(Math.min(relativeTime, clipDuration));
                        setDuration(clipDuration);
                      }
                      if (video.currentTime * 1000 >= clip.endMs - 50) {
                        // 到达片段终点，自动暂停
                        video.pause();
                        video.currentTime = clip.endMs / 1000;
                        setCurrentTime(clipDuration);
                        setIsPlaying(false);
                      }
                      // 起点钳制留 250ms 容忍带：WKWebView 解码器偶发从前一个
                      // 关键帧回滚会使时钟瞬时回跳，立刻纠正会被放大成"片头重播"
                      if (video.currentTime * 1000 < clip.startMs - 250) {
                        video.currentTime = clip.startMs / 1000;
                        setCurrentTime(0);
                      }
                    }}
                    onPlay={() => {
                      setIsPlaying(true);
                      // 分轨模式：同步播放独立 audio（应用外部音频偏移量）
                      if (audioRef.current && audioRef.current.paused && videoRef.current) {
                        // 起播预滚阶段（还没定位到片段起点）先不启动外置音频，
                        // 由 App 的 reveal() 在视频就位后统一启动
                        const clip = activePlayerClipRef.current;
                        if (clip && videoRef.current.currentTime < clip.startMs / 1000 - 0.5) return;
                        const offsetSec = audioOffsetMs / 1000;
                        audioRef.current.currentTime = Math.max(0, videoRef.current.currentTime - offsetSec);
                        audioRef.current.play().catch(() => {});
                      }
                    }}
                    onSeeked={() => {
                      // 分轨模式：同步 audio 播放位置（应用外部音频偏移量）
                      if (audioRef.current && videoRef.current) {
                        const offsetSec = audioOffsetMs / 1000;
                        audioRef.current.currentTime = Math.max(0, videoRef.current.currentTime - offsetSec);
                      }
                    }}
                    onPause={() => {
                      setIsPlaying(false);
                      // 分轨模式：同步暂停独立 audio
                      if (audioRef.current && !audioRef.current.paused) {
                        audioRef.current.pause();
                      }
                    }}
                    onError={(e) => {
                      const videoEl = e.target as HTMLVideoElement;
                      setVideoLoadError(`加载失败 (代码: ${videoEl.error?.code})`);
                    }}
                  />
                    </div>
                  </div>

                  {/* 画面点击覆盖层：点击播放/暂停 */}
                  <div
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const y = e.clientY - rect.top;
                      const height = rect.height;
                      if (y > 60 && y < height - 70) {
                        if (!videoRef.current || !activePlayerClipRef.current) return;
                        const clip = activePlayerClipRef.current;
                        const totalMs = clip.endMs - clip.startMs;
                        const currentMs = (videoRef.current.currentTime * 1000) - clip.startMs;
                        if (!isPlaying && Math.abs(currentMs - totalMs) < 100) {
                          videoRef.current.currentTime = clip.startMs / 1000;
                          setCurrentTime(0);
                        }
                        if (isPlaying) {
                          videoRef.current.pause();
                          setIsPlaying(false);
                        } else {
                          videoRef.current.play();
                          setIsPlaying(true);
                        }
                      }
                    }}
                    style={{
                      position: 'absolute',
                      inset: '20px 0 20px 0',
                      zIndex: 30,
                      cursor: 'pointer',
                      pointerEvents: 'auto'
                    }}
                  />

                  <div
                    style={{
                      position: 'absolute',
                      bottom: 0,
                      left: 0,
                      right: 0,
                      background: 'linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.3) 60%, transparent 100%)',
                      padding: '16px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      userSelect: 'none',
                      zIndex: 40,
                      zoom: playerScale < 1 ? playerScale : undefined
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div
                      ref={progressBarRef}
                      style={{
                        width: '100%',
                        height: '4px',
                        background: 'rgba(255,255,255,0.3)',
                        borderRadius: '2px',
                        cursor: 'pointer',
                        position: 'relative',
                        marginTop: '0',
                        transition: 'width 0.15s ease'
                      }}
                      onMouseDown={(e) => {
                        if (!videoRef.current || !activePlayerClipRef.current) return;
                        // 点击/拖拽进度条时暂停视频（所有视频都生效）
                        if (isPlaying) {
                          videoRef.current.pause();
                          setIsPlaying(false);
                        }
                        isDraggingProgressRef.current = true;
                        const rect = e.currentTarget.getBoundingClientRect();
                        const clickPercent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                        const clip = activePlayerClipRef.current;
                        const totalMs = clip.endMs - clip.startMs;
                        const targetMs = clip.startMs + (totalMs * clickPercent);
                        videoRef.current.currentTime = targetMs / 1000;
                        setCurrentTime(targetMs / 1000 - clip.startMs / 1000);
                        setIsDragging(true);
                      }}
                    >
                      <div style={{
                        height: '100%',
                        background: '#f5576c',
                        borderRadius: '2px',
                        width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%`,
                        transition: isDragging ? 'none' : 'width 0.1s linear'
                      }} />
                      {isDragging && (
                        <div style={{
                          position: 'absolute',
                          top: '50%',
                          left: `${duration > 0 ? (currentTime / duration) * 100 : 0}%`,
                          transform: 'translate(-50%, -50%)',
                          width: '12px',
                          height: '12px',
                          background: '#f5576c',
                          borderRadius: '50%',
                          boxShadow: '0 0 4px rgba(0,0,0,0.5)'
                        }} />
                      )}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', WebkitUserSelect: 'none', userSelect: 'none' }}>
                      <button
                        onClick={() => {
                          if (!videoRef.current || !activePlayerClipRef.current) return;
                          const clip = activePlayerClipRef.current;
                          const totalMs = clip.endMs - clip.startMs;
                          const currentMs = (videoRef.current.currentTime * 1000) - clip.startMs;
                          if (!isPlaying && Math.abs(currentMs - totalMs) < 100) {
                            videoRef.current.currentTime = clip.startMs / 1000;
                            setCurrentTime(0);
                          }
                          if (isPlaying) {
                            videoRef.current.pause();
                            setIsPlaying(false);
                          } else {
                            videoRef.current.play();
                            setIsPlaying(true);
                          }
                        }}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'white',
                          fontSize: '20px',
                          cursor: 'pointer',
                          width: '28px',
                          height: '28px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: 0,
                          opacity: 0.9,
                          transition: 'opacity 0.2s',
                          lineHeight: '28px'
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
                        onMouseLeave={(e) => e.currentTarget.style.opacity = '0.9'}
                      >
                        {isPlaying ? '⏸' : '▶'}
                      </button>

                      <span style={{
                        color: 'rgba(255,255,255,0.9)',
                        fontSize: '12px',
                        fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                        fontVariantNumeric: 'tabular-nums',
                        minWidth: '120px',
                        userSelect: 'none',
                        whiteSpace: 'nowrap',
                        flexShrink: 0
                      }}>
                        {formatTimeMs(currentTime * 1000)} / {formatTimeMs(duration * 1000)}
                      </span>

                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
  ) : null;
};

export { VideoPlayer };

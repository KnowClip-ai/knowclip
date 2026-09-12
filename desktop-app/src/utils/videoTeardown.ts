/**
 * 极简版：只执行卸载操作，不等待延迟。
 * 适用于 DOM 不会被立即销毁的场景（如全局 video 移回隐藏容器）。
 */
export function teardownVideo(video: HTMLVideoElement | null): void {
  if (!video) return;
  try {
    video.pause();
  } catch {
    // ignore
  }
  video.src = '';
  try {
    video.load();
  } catch {
    // ignore
  }
}

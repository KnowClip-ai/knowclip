use std::fs;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Mutex, mpsc};
use std::thread;
use once_cell::sync::Lazy;

use axum::Router;
use tower_http::{services::ServeDir, cors::CorsLayer};

/// 全局状态：保存当前视频服务器的退出通道
/// 用于优雅关闭服务器线程，防止端口泄漏
static SERVER_EXIT_TX: Lazy<Mutex<Option<mpsc::Sender<()>>>> = Lazy::new(|| Mutex::new(None));

/// 在临时目录中创建指向源文件的符号链接（优先）或硬链接
fn create_link(src: &str, dst: &Path) -> Result<(), String> {
    #[cfg(unix)]
    let link_ok = std::os::unix::fs::symlink(src, dst).is_ok();
    #[cfg(windows)]
    let link_ok = std::os::windows::fs::symlink_file(src, dst).is_ok();

    if !link_ok {
        fs::hard_link(src, dst)
            .map_err(|e| format!("创建文件链接失败（符号链接和硬链接均不可用）: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn start_video_server(video_path: String) -> Result<String, String> {
    let urls = start_media_server(video_path, None)?;
    Ok(urls.video_url)
}

#[derive(serde::Serialize)]
struct MediaServerUrls {
    video_url: String,
    audio_url: Option<String>,
}

#[tauri::command]
fn start_media_server(video_path: String, audio_path: Option<String>) -> Result<MediaServerUrls, String> {
    // 先停止旧服务器，防止端口泄漏
    stop_video_server();

    let port = portpicker::pick_unused_port().ok_or("没有可用端口")?;

    let video_path_obj = Path::new(&video_path);
    let video_ext = video_path_obj
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4");

    // 创建临时目录，用于挂载 ServeDir
    let temp_dir = std::env::temp_dir().join(format!("tauri-video-{}", port));
    fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("创建临时目录失败: {}", e))?;

    // 视频链接：固定 URL 文件名，避免中文/特殊字符编码问题
    let video_link_name = format!("video.{}", video_ext);
    let video_link = temp_dir.join(&video_link_name);
    create_link(&video_path, &video_link)?;

    // 音频链接（可选）
    let audio_url = audio_path.map(|path| {
        let audio_path_obj = Path::new(&path);
        let audio_ext = audio_path_obj
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("aac");
        let audio_link_name = format!("audio.{}", audio_ext);
        let audio_link = temp_dir.join(&audio_link_name);
        // 音频链接失败不阻断主流程，仅记录日志
        if let Err(e) = create_link(&path, &audio_link) {
            eprintln!("[media-server] 创建音频链接失败: {}", e);
            return None;
        }
        Some(format!("http://127.0.0.1:{}/{}", port, audio_link_name))
    }).flatten();

    let (tx, rx) = mpsc::channel();
    *SERVER_EXIT_TX.lock().unwrap() = Some(tx);

    thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("创建 tokio runtime 失败");
        rt.block_on(async {
            let app = Router::new()
                .nest_service("/", ServeDir::new(&temp_dir))
                .layer(CorsLayer::permissive());

            let addr = SocketAddr::from(([127, 0, 0, 1], port));
            let listener = match tokio::net::TcpListener::bind(&addr).await {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[media-server] 绑定端口 {} 失败: {}", port, e);
                    return;
                }
            };

            let server = axum::serve(listener, app).with_graceful_shutdown(async {
                // 在阻塞线程中等待关闭信号
                let _ = tokio::task::spawn_blocking(move || rx.recv()).await;
            });

            if let Err(e) = server.await {
                eprintln!("[media-server] 服务器异常: {}", e);
            }

            // 服务器停止后，清理临时目录
            let _ = fs::remove_dir_all(&temp_dir);
        });
    });

    Ok(MediaServerUrls {
        video_url: format!("http://127.0.0.1:{}/{}", port, video_link_name),
        audio_url,
    })
}

#[tauri::command]
fn stop_video_server() {
    if let Some(tx) = SERVER_EXIT_TX.lock().unwrap().take() {
        let _ = tx.send(());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            start_video_server,
            start_media_server,
            stop_video_server
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

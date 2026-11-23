//! 看屏幕：找到用户正在使用的窗口，并在用户授权后截取该窗口，交给前端的视觉模型分析。
//!
//! 用户在桌宠的对话面板中发消息、点击「允许」时，前台窗口是桌宠自己，
//! 因此在后台持续记录「最近一个不属于桌宠的前台窗口」，作为截图的目标。

use serde::Serialize;

/// 截取的窗口
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
  id: u32,
  title: String,
  app_name: String,
}

/// 截图最长边超过该值时缩小，减少传输与编码开销（发送给模型前前端还会再检查一次）
#[cfg(any(windows, target_os = "macos"))]
const MAX_SIDE: u32 = 2048;

/// 开始记录用户最近使用的窗口（仅 Windows 需要）
pub fn start_tracking() {
  #[cfg(windows)]
  tracker::start();
}

/// 获取截图的目标窗口：用户最近使用的、不属于桌宠的窗口
#[tauri::command]
pub async fn get_target_window() -> Result<Option<WindowInfo>, String> {
  tauri::async_runtime::spawn_blocking(imp::target_window)
    .await
    .map_err(|e| e.to_string())?
}

/// 截取指定窗口，返回 PNG 图片的 data URL
#[tauri::command]
pub async fn capture_window(id: u32) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || imp::capture(id))
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(windows)]
mod tracker {
  use std::{
    sync::atomic::{AtomicU32, Ordering},
    thread,
    time::Duration,
  };

  use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

  /// 最近一个不属于桌宠的前台窗口（与 xcap 的窗口 id 一致，即 HWND 的低 32 位），0 表示还没有
  static LAST_FOREGROUND: AtomicU32 = AtomicU32::new(0);

  pub fn start() {
    thread::spawn(|| {
      let own_pid = std::process::id();
      loop {
        let hwnd = unsafe { GetForegroundWindow() };
        if !hwnd.is_null() {
          let mut pid = 0u32;
          unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
          if pid != 0 && pid != own_pid {
            LAST_FOREGROUND.store(hwnd as usize as u32, Ordering::Relaxed);
          }
        }
        thread::sleep(Duration::from_millis(300));
      }
    });
  }

  pub fn last_foreground() -> Option<u32> {
    match LAST_FOREGROUND.load(Ordering::Relaxed) {
      0 => None,
      id => Some(id),
    }
  }
}

#[cfg(any(windows, target_os = "macos"))]
mod imp {
  use image::imageops;
  use xcap::Window;

  use super::{WindowInfo, MAX_SIDE};

  fn all_windows() -> Result<Vec<Window>, String> {
    Window::all().map_err(|e| format!("无法获取窗口列表：{e}"))
  }

  /// 可以作为截图目标的窗口：不属于桌宠、未最小化、有标题、尺寸不过小
  fn is_candidate(window: &Window, own_pid: u32) -> bool {
    window.pid().map(|pid| pid != own_pid).unwrap_or(false)
      && !window.is_minimized().unwrap_or(true)
      && !window.title().unwrap_or_default().trim().is_empty()
      && window.width().unwrap_or(0) >= 80
      && window.height().unwrap_or(0) >= 60
  }

  fn info(window: &Window) -> Option<WindowInfo> {
    Some(WindowInfo {
      id: window.id().ok()?,
      title: window.title().unwrap_or_default(),
      app_name: window.app_name().unwrap_or_default(),
    })
  }

  pub fn target_window() -> Result<Option<WindowInfo>, String> {
    let own_pid = std::process::id();
    let mut candidates: Vec<Window> = all_windows()?.into_iter().filter(|w| is_candidate(w, own_pid)).collect();

    // 优先使用记录下的最近前台窗口
    #[cfg(windows)]
    if let Some(id) = super::tracker::last_foreground() {
      if let Some(window) = candidates.iter().find(|w| w.id().ok() == Some(id)) {
        return Ok(info(window));
      }
    }

    // 否则取有焦点的窗口，再否则取层级最高的窗口（桌宠置顶在最上层，紧挨着的通常就是用户刚才在用的窗口）
    if let Some(window) = candidates.iter().find(|w| w.is_focused().unwrap_or(false)) {
      return Ok(info(window));
    }
    candidates.sort_by_key(|w| std::cmp::Reverse(w.z().unwrap_or(i32::MIN)));
    Ok(candidates.first().and_then(info))
  }

  pub fn capture(id: u32) -> Result<String, String> {
    let window = all_windows()?
      .into_iter()
      .find(|w| w.id().ok() == Some(id))
      .ok_or("窗口已经关闭了")?;
    if window.is_minimized().unwrap_or(false) {
      return Err("窗口已最小化，请先把它恢复显示".into());
    }

    let mut image = window.capture_image().map_err(|e| format!("截取窗口失败：{e}"))?;
    let (width, height) = image.dimensions();
    if width.max(height) > MAX_SIDE {
      let scale = MAX_SIDE as f64 / width.max(height) as f64;
      let size = |v: u32| ((v as f64 * scale).round() as u32).max(1);
      image = imageops::thumbnail(&image, size(width), size(height));
    }
    crate::capture::encode_rgba_png(&image)
  }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
  use super::WindowInfo;

  pub fn target_window() -> Result<Option<WindowInfo>, String> {
    Err("当前系统暂不支持截取窗口，可以把截图粘贴到对话框中".into())
  }

  pub fn capture(_id: u32) -> Result<String, String> {
    Err("当前系统暂不支持截取窗口，可以把截图粘贴到对话框中".into())
  }
}

#[cfg(all(test, any(windows, target_os = "macos")))]
mod tests {
  use base64::{engine::general_purpose::STANDARD, Engine};

  /// 需要桌面环境：先打开一个标题为 desktop-pet-capture-test 的窗口，
  /// 设置环境变量 CAPTURE_TEST_OUT 可以把截图保存下来查看
  #[test]
  #[ignore = "需要桌面环境与测试窗口"]
  fn captures_window_by_title() {
    // 与 Tauri 应用一致，使用 Per-Monitor V2 的 DPI 感知模式（测试程序默认不感知 DPI）
    #[cfg(windows)]
    unsafe {
      windows_sys::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(
        windows_sys::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
      );
    }

    let window = xcap::Window::all()
      .unwrap()
      .into_iter()
      .find(|w| w.title().unwrap_or_default() == "desktop-pet-capture-test")
      .expect("没有找到测试窗口");

    let url = super::imp::capture(window.id().unwrap()).unwrap();
    let bytes = STANDARD.decode(url.trim_start_matches("data:image/png;base64,")).unwrap();
    let image = image::load_from_memory(&bytes).unwrap();
    assert!(image.width() > 100 && image.height() > 100);

    if let Ok(path) = std::env::var("CAPTURE_TEST_OUT") {
      std::fs::write(path, bytes).unwrap();
    }
  }
}

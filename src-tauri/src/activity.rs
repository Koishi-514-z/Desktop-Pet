//! 主动交互：用户当前的活动状态——多久没有操作键盘鼠标、前台是什么应用、是否全屏。
//! 前端定时查询，据此判断用户在不在电脑前、在做什么、现在适不适合打扰。
//! 窗口标题只交给前端在本地判断应用的类型，是否发送给模型由用户在设置中决定。

use serde::Serialize;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySnapshot {
  /// 距离用户最后一次操作键盘或鼠标的秒数；无法获取时为空
  idle_seconds: Option<u64>,
  /// 前台窗口；无法获取或者前台是桌面时为空
  foreground: Option<ForegroundWindow>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundWindow {
  /// 进程名（不含扩展名），如 Code、chrome、WINWORD
  app: String,
  /// 窗口标题
  title: String,
  /// 是否全屏：窗口覆盖了它所在的整个显示器（如游戏、全屏视频、演示）
  fullscreen: bool,
  /// 是否是桌宠自己的窗口（用户正在和桌宠互动）
  own: bool,
}

/// 用户当前的活动状态（目前只支持 Windows，其他系统返回空的状态）
#[tauri::command]
pub fn activity_snapshot() -> ActivitySnapshot {
  imp::snapshot()
}

#[cfg(windows)]
mod imp {
  use std::path::Path;

  use windows_sys::Win32::{
    Foundation::{CloseHandle, HWND, RECT},
    Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST},
    System::{
      SystemInformation::GetTickCount,
      Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION},
    },
    UI::{
      Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO},
      WindowsAndMessaging::{GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId},
    },
  };

  use super::{ActivitySnapshot, ForegroundWindow};

  /// 桌面（显示桌面图标的窗口）的窗口类：前台是桌面时不算在使用某个应用，也不算全屏
  const DESKTOP_CLASSES: &[&str] = &["Progman", "WorkerW"];

  pub fn snapshot() -> ActivitySnapshot {
    ActivitySnapshot { idle_seconds: idle_seconds(), foreground: foreground() }
  }

  fn idle_seconds() -> Option<u64> {
    let mut info = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    if unsafe { GetLastInputInfo(&mut info) } == 0 {
      return None;
    }
    // 两者都是开机以来的毫秒数（约 49.7 天回绕一次），用回绕减法得到间隔
    let idle_ms = unsafe { GetTickCount() }.wrapping_sub(info.dwTime);
    Some(u64::from(idle_ms) / 1000)
  }

  fn foreground() -> Option<ForegroundWindow> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_null() || DESKTOP_CLASSES.contains(&class_name(hwnd).as_str()) {
      return None;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    Some(ForegroundWindow {
      app: process_name(pid).unwrap_or_default(),
      title: window_text(hwnd),
      fullscreen: is_fullscreen(hwnd),
      own: pid == std::process::id(),
    })
  }

  fn window_text(hwnd: HWND) -> String {
    let mut buffer = [0u16; 512];
    let length = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    String::from_utf16_lossy(&buffer[..length.max(0) as usize])
  }

  fn class_name(hwnd: HWND) -> String {
    let mut buffer = [0u16; 256];
    let length = unsafe { GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    String::from_utf16_lossy(&buffer[..length.max(0) as usize])
  }

  /// 进程的可执行文件名（不含扩展名）
  fn process_name(pid: u32) -> Option<String> {
    if pid == 0 {
      return None;
    }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
      return None;
    }
    let mut buffer = [0u16; 1024];
    let mut size = buffer.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buffer.as_mut_ptr(), &mut size) };
    unsafe { CloseHandle(handle) };
    if ok == 0 {
      return None;
    }
    let path = String::from_utf16_lossy(&buffer[..size as usize]);
    Path::new(&path).file_stem().map(|stem| stem.to_string_lossy().into_owned())
  }

  /// 窗口是否覆盖了它所在的整个显示器。
  /// 普通的最大化窗口不会盖住任务栏，因此不算全屏（任务栏设为自动隐藏时会被误判，可以在设置中关闭「全屏时不打扰」）
  fn is_fullscreen(hwnd: HWND) -> bool {
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
      return false;
    }
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    if monitor.is_null() {
      return false;
    }
    let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
    if unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
      return false;
    }
    let screen = info.rcMonitor;
    rect.left <= screen.left && rect.top <= screen.top && rect.right >= screen.right && rect.bottom >= screen.bottom
  }
}

#[cfg(not(windows))]
mod imp {
  use super::ActivitySnapshot;

  pub fn snapshot() -> ActivitySnapshot {
    ActivitySnapshot::default()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reports_idle_time_and_serializes_in_camel_case() {
    let snapshot = activity_snapshot();
    #[cfg(windows)]
    assert!(snapshot.idle_seconds.is_some());
    let json = serde_json::to_value(&snapshot).unwrap();
    assert!(json.get("idleSeconds").is_some());
    assert!(json.get("foreground").is_some());
  }
}

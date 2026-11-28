//! 应用程序与窗口管理（「应用与窗口」技能）：列出打开的窗口与已安装的应用，打开应用，
//! 切换、最小化、最大化、还原、关闭窗口，以及把窗口放到指定位置（排列窗口的布局由前端计算）。
//!
//! 目前只支持 Windows：
//! - 窗口：与 Alt+Tab 中出现的窗口一致（可见、没有所有者、不是工具窗口、没有被系统隐藏），不包括桌宠自己；
//! - 已安装的应用：开始菜单中的应用（Get-StartApps），包括商店应用，用 `shell:AppsFolder\<AppID>` 打开；
//! - 位置：窗口实际看得到的范围（不含 Windows 10/11 窗口四周透明的边框），以物理像素计，与显示器的工作区一致。

use serde::{Deserialize, Serialize};

/// 一个打开的窗口
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppWindow {
  /// 窗口句柄
  id: i64,
  title: String,
  /// 进程的可执行文件名（不含扩展名），如 Code、chrome、WindowsTerminal
  app: String,
  pid: u32,
  minimized: bool,
  maximized: bool,
  /// 是否是前台窗口
  active: bool,
  /// 所在显示器的序号（见 Monitor）
  monitor: usize,
  x: i32,
  y: i32,
  width: i32,
  height: i32,
}

/// 一个显示器的工作区（不含任务栏）
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Monitor {
  index: usize,
  primary: bool,
  x: i32,
  y: i32,
  width: i32,
  height: i32,
}

#[derive(Serialize)]
pub struct WindowsSnapshot {
  windows: Vec<AppWindow>,
  monitors: Vec<Monitor>,
}

/// 开始菜单中的一个应用
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
  name: String,
  app_id: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowAction {
  Focus,
  Minimize,
  Maximize,
  Restore,
  /// 相当于点窗口的关闭按钮：应用可以提示保存，不会强制结束进程
  Close,
}

/// 把窗口放到的位置（看得到的范围，物理像素）
#[derive(Clone, Copy, Deserialize)]
pub struct WindowRect {
  id: i64,
  x: i32,
  y: i32,
  width: i32,
  height: i32,
}

async fn blocking<T: Send + 'static>(task: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(task).await.map_err(|e| e.to_string())?
}

/// 打开的窗口与显示器
#[tauri::command]
pub async fn apps_list_windows() -> Result<WindowsSnapshot, String> {
  blocking(imp::list_windows).await
}

/// 开始菜单中的应用（结果缓存一段时间）
#[tauri::command]
pub async fn apps_list_installed() -> Result<Vec<InstalledApp>, String> {
  blocking(imp::list_installed).await
}

/// 打开开始菜单中的应用
#[tauri::command]
pub async fn apps_launch(app_id: String) -> Result<(), String> {
  blocking(move || imp::launch(&app_id)).await
}

#[tauri::command]
pub async fn apps_window_action(id: i64, action: WindowAction) -> Result<(), String> {
  blocking(move || imp::window_action(id, action)).await
}

/// 依次把窗口放到指定的位置（最小化、最大化的窗口先还原）
#[tauri::command]
pub async fn apps_set_window_rects(rects: Vec<WindowRect>) -> Result<(), String> {
  blocking(move || imp::set_window_rects(&rects)).await
}

/// 解析 Get-StartApps 输出的 JSON：只有一个应用时是对象，多个时是数组
fn parse_start_apps(json: &str) -> Result<Vec<InstalledApp>, String> {
  let value: serde_json::Value = serde_json::from_str(json.trim()).map_err(|e| format!("无法解析开始菜单中的应用：{e}"))?;
  let items = match value {
    serde_json::Value::Array(items) => items,
    serde_json::Value::Null => vec![],
    item => vec![item],
  };
  let mut apps: Vec<InstalledApp> = items
    .iter()
    .filter_map(|item| {
      let name = item.get("Name")?.as_str()?.trim().to_string();
      let app_id = item.get("AppID")?.as_str()?.trim().to_string();
      (!name.is_empty() && !app_id.is_empty()).then_some(InstalledApp { name, app_id })
    })
    .collect();
  apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
  apps.dedup_by(|a, b| a.app_id == b.app_id);
  Ok(apps)
}

#[cfg(windows)]
mod imp {
  use std::{
    os::windows::process::CommandExt,
    process::Command,
    sync::Mutex,
    time::{Duration, Instant},
  };

  use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, RECT},
    Graphics::{
      Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS},
      Gdi::{EnumDisplayMonitors, GetMonitorInfoW, MonitorFromWindow, HDC, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST},
    },
    System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION},
    UI::{
      Input::KeyboardAndMouse::{keybd_event, KEYEVENTF_KEYUP, VK_MENU},
      WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetForegroundWindow, GetWindow, GetWindowLongPtrW, GetWindowRect, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, IsZoomed, PostMessageW, SetForegroundWindow,
        SetWindowPos, ShowWindow, GWL_EXSTYLE, GW_OWNER, SWP_NOACTIVATE, SWP_NOZORDER, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE,
        WM_CLOSE, WS_EX_TOOLWINDOW,
      },
    },
  };

  use super::{parse_start_apps, AppWindow, InstalledApp, Monitor, WindowAction, WindowRect, WindowsSnapshot};

  /// 桌面、任务栏等系统窗口
  const SYSTEM_CLASSES: &[&str] = &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];
  /// 开始菜单中的应用缓存多久
  const INSTALLED_CACHE: Duration = Duration::from_secs(600);
  const CREATE_NO_WINDOW: u32 = 0x0800_0000;

  static INSTALLED: Mutex<Option<(Instant, Vec<InstalledApp>)>> = Mutex::new(None);

  fn hwnd(id: i64) -> Result<HWND, String> {
    let hwnd = id as isize as HWND;
    if id == 0 || unsafe { IsWindow(hwnd) } == 0 {
      return Err("找不到这个窗口，它可能已经关闭了，请重新获取窗口列表".into());
    }
    Ok(hwnd)
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

  fn process_name(pid: u32) -> String {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
      return String::new();
    }
    let mut buffer = [0u16; 1024];
    let mut size = buffer.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buffer.as_mut_ptr(), &mut size) };
    unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
    if ok == 0 {
      return String::new();
    }
    let path = String::from_utf16_lossy(&buffer[..size as usize]);
    std::path::Path::new(&path).file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default()
  }

  /// 被系统隐藏的窗口（如后台的 UWP 应用、其他虚拟桌面上的窗口）
  fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked = 0u32;
    let result = unsafe {
      DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED as u32, (&mut cloaked as *mut u32).cast(), size_of::<u32>() as u32)
    };
    result == 0 && cloaked != 0
  }

  /// 窗口实际看得到的范围；Windows 10/11 的窗口四周有一圈透明的边框，GetWindowRect 会把它算进去
  fn visible_rect(hwnd: HWND) -> RECT {
    let mut rect = RECT::default();
    let result = unsafe {
      DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS as u32, (&mut rect as *mut RECT).cast(), size_of::<RECT>() as u32)
    };
    if result != 0 {
      unsafe { GetWindowRect(hwnd, &mut rect) };
    }
    rect
  }

  /// 是否是 Alt+Tab 中会出现的窗口
  fn is_app_window(hwnd: HWND, own_pid: u32) -> bool {
    if unsafe { IsWindowVisible(hwnd) } == 0 || !unsafe { GetWindow(hwnd, GW_OWNER) }.is_null() {
      return false;
    }
    let ex_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
    if ex_style & WS_EX_TOOLWINDOW != 0 || is_cloaked(hwnd) || window_text(hwnd).trim().is_empty() {
      return false;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    pid != own_pid && !SYSTEM_CLASSES.contains(&class_name(hwnd).as_str())
  }

  unsafe extern "system" fn collect_window(hwnd: HWND, data: LPARAM) -> windows_sys::core::BOOL {
    unsafe { (*(data as *mut Vec<HWND>)).push(hwnd) };
    1
  }

  unsafe extern "system" fn collect_monitor(monitor: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> windows_sys::core::BOOL {
    unsafe { (*(data as *mut Vec<HMONITOR>)).push(monitor) };
    1
  }

  fn monitors() -> (Vec<HMONITOR>, Vec<super::Monitor>) {
    let mut handles: Vec<HMONITOR> = Vec::new();
    unsafe { EnumDisplayMonitors(std::ptr::null_mut(), std::ptr::null(), Some(collect_monitor), &mut handles as *mut _ as LPARAM) };
    let infos = handles
      .iter()
      .enumerate()
      .map(|(index, &monitor)| {
        let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        unsafe { GetMonitorInfoW(monitor, &mut info) };
        let work = info.rcWork;
        Monitor {
          index,
          // MONITORINFOF_PRIMARY
          primary: info.dwFlags & 1 != 0,
          x: work.left,
          y: work.top,
          width: work.right - work.left,
          height: work.bottom - work.top,
        }
      })
      .collect();
    (handles, infos)
  }

  pub fn list_windows() -> Result<WindowsSnapshot, String> {
    let own_pid = std::process::id();
    let mut handles: Vec<HWND> = Vec::new();
    unsafe { EnumWindows(Some(collect_window), &mut handles as *mut _ as LPARAM) };
    let (monitor_handles, monitors) = monitors();
    let foreground = unsafe { GetForegroundWindow() };

    // EnumWindows 按 Z 序（从上到下）返回，最近用过的窗口在前
    let windows = handles
      .into_iter()
      .filter(|&hwnd| is_app_window(hwnd, own_pid))
      .map(|hwnd| {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        let rect = visible_rect(hwnd);
        let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
        AppWindow {
          id: hwnd as isize as i64,
          title: window_text(hwnd),
          app: process_name(pid),
          pid,
          minimized: unsafe { IsIconic(hwnd) } != 0,
          maximized: unsafe { IsZoomed(hwnd) } != 0,
          active: hwnd == foreground,
          monitor: monitor_handles.iter().position(|&m| m == monitor).unwrap_or(0),
          x: rect.left,
          y: rect.top,
          width: rect.right - rect.left,
          height: rect.bottom - rect.top,
        }
      })
      .collect();
    Ok(WindowsSnapshot { windows, monitors })
  }

  pub fn list_installed() -> Result<Vec<InstalledApp>, String> {
    let mut cache = INSTALLED.lock().map_err(|e| e.to_string())?;
    if let Some((at, apps)) = cache.as_ref() {
      if at.elapsed() < INSTALLED_CACHE {
        return Ok(apps.clone());
      }
    }
    // 输出改为 UTF-8，否则中文系统上应用名称会是乱码（控制台默认 GBK）
    let output = Command::new("powershell.exe")
      .args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress",
      ])
      .creation_flags(CREATE_NO_WINDOW)
      .output()
      .map_err(|e| format!("无法读取开始菜单中的应用：{e}"))?;
    if !output.status.success() {
      return Err(format!("无法读取开始菜单中的应用：{}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    let apps = parse_start_apps(&String::from_utf8_lossy(&output.stdout))?;
    *cache = Some((Instant::now(), apps.clone()));
    Ok(apps)
  }

  pub fn launch(app_id: &str) -> Result<(), String> {
    let app_id = app_id.trim();
    if app_id.is_empty() || app_id.contains(['\r', '\n', '"']) {
      return Err("无效的应用 ID".into());
    }
    // 只能打开开始菜单中的应用，不能借此运行任意程序或命令
    if !list_installed()?.iter().any(|app| app.app_id == app_id) {
      return Err("开始菜单中没有这个应用，请先用 list_installed_apps 查找".into());
    }
    Command::new("explorer.exe")
      .arg(format!("shell:AppsFolder\\{app_id}"))
      .spawn()
      .map_err(|e| format!("打开应用失败：{e}"))?;
    Ok(())
  }

  /// 切换到窗口。系统只允许前台进程把别的窗口切到前台：失败时模拟按一下 Alt（常用的解决办法），再试一次
  fn focus(hwnd: HWND) -> Result<(), String> {
    if unsafe { IsIconic(hwnd) } != 0 {
      unsafe { ShowWindow(hwnd, SW_RESTORE) };
    }
    if unsafe { SetForegroundWindow(hwnd) } == 0 {
      unsafe {
        keybd_event(VK_MENU as u8, 0, 0, 0);
        keybd_event(VK_MENU as u8, 0, KEYEVENTF_KEYUP, 0);
      }
      if unsafe { SetForegroundWindow(hwnd) } == 0 {
        return Err("系统不允许切换到这个窗口（可能是以管理员身份运行的程序）".into());
      }
    }
    Ok(())
  }

  pub fn window_action(id: i64, action: WindowAction) -> Result<(), String> {
    let hwnd = hwnd(id)?;
    match action {
      WindowAction::Focus => focus(hwnd)?,
      WindowAction::Minimize => {
        unsafe { ShowWindow(hwnd, SW_MINIMIZE) };
      }
      WindowAction::Maximize => {
        unsafe { ShowWindow(hwnd, SW_MAXIMIZE) };
      }
      WindowAction::Restore => {
        unsafe { ShowWindow(hwnd, SW_RESTORE) };
      }
      WindowAction::Close => {
        if unsafe { PostMessageW(hwnd, WM_CLOSE, 0, 0) } == 0 {
          return Err("无法关闭这个窗口".into());
        }
      }
    }
    Ok(())
  }

  pub fn set_window_rects(rects: &[WindowRect]) -> Result<(), String> {
    for rect in rects {
      let hwnd = hwnd(rect.id)?;
      if unsafe { IsIconic(hwnd) } != 0 || unsafe { IsZoomed(hwnd) } != 0 {
        unsafe { ShowWindow(hwnd, SW_RESTORE) };
      }
      // 加上四周透明的边框，让看得到的范围正好是目标位置（并排的窗口之间不会留缝）
      let mut outer = RECT::default();
      unsafe { GetWindowRect(hwnd, &mut outer) };
      let visible = visible_rect(hwnd);
      let (left, top) = (visible.left - outer.left, visible.top - outer.top);
      let (right, bottom) = (outer.right - visible.right, outer.bottom - visible.bottom);
      let ok = unsafe {
        SetWindowPos(
          hwnd,
          std::ptr::null_mut(),
          rect.x - left,
          rect.y - top,
          rect.width + left + right,
          rect.height + top + bottom,
          SWP_NOZORDER | SWP_NOACTIVATE,
        )
      };
      if ok == 0 {
        return Err("无法移动这个窗口（可能是以管理员身份运行的程序）".into());
      }
    }
    Ok(())
  }
}

#[cfg(not(windows))]
mod imp {
  use super::{InstalledApp, WindowAction, WindowRect, WindowsSnapshot};

  const UNSUPPORTED: &str = "应用与窗口管理暂时只支持 Windows";

  pub fn list_windows() -> Result<WindowsSnapshot, String> {
    Err(UNSUPPORTED.into())
  }

  pub fn list_installed() -> Result<Vec<InstalledApp>, String> {
    Err(UNSUPPORTED.into())
  }

  pub fn launch(_: &str) -> Result<(), String> {
    Err(UNSUPPORTED.into())
  }

  pub fn window_action(_: i64, _: WindowAction) -> Result<(), String> {
    Err(UNSUPPORTED.into())
  }

  pub fn set_window_rects(_: &[WindowRect]) -> Result<(), String> {
    Err(UNSUPPORTED.into())
  }
}

#[cfg(test)]
mod tests {
  use super::parse_start_apps;

  #[test]
  fn parses_start_apps() {
    let apps = parse_start_apps(
      r#"[{"Name":"Visual Studio Code","AppID":"Microsoft.VisualStudioCode"},{"Name":"终端","AppID":"Microsoft.WindowsTerminal_8wekyb3d8bbwe!App"},{"Name":"","AppID":"x"},{"Name":"Visual Studio Code","AppID":"Microsoft.VisualStudioCode"}]"#,
    )
    .unwrap();
    assert_eq!(apps.len(), 2);
    assert_eq!(apps[0].name, "Visual Studio Code");
    assert_eq!(apps[1].app_id, "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App");

    // 只有一个应用时 ConvertTo-Json 输出对象而不是数组
    assert_eq!(parse_start_apps(r#"{"Name":"记事本","AppID":"notepad"}"#).unwrap().len(), 1);
    assert!(parse_start_apps("").is_err());
  }
}

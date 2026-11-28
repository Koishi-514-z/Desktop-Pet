use std::sync::Mutex;

use tauri::{
  menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
  AppHandle, Manager, State, WebviewWindow,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

mod activity;
mod apps;
mod capture;
mod diagnostics;
mod files;
mod memory;
mod screen;

const MAIN_WINDOW: &str = "main";

/// 将窗口铺满主显示器的工作区（不遮挡任务栏），作为桌宠的透明画布
fn fit_to_work_area(window: &WebviewWindow) -> tauri::Result<()> {
  let monitor = match window.current_monitor()? {
    Some(monitor) => Some(monitor),
    None => window.primary_monitor()?,
  };

  if let Some(monitor) = monitor {
    let area = monitor.work_area();
    window.set_position(area.position)?;
    window.set_size(area.size)?;
  }
  Ok(())
}

fn toggle_visibility(app: &AppHandle) {
  let Some(window) = app.get_webview_window(MAIN_WINDOW) else { return };
  if window.is_visible().unwrap_or(false) {
    let _ = window.hide();
  } else {
    let _ = window.show();
  }
}

/// 当前注册的显示 / 隐藏快捷键
#[derive(Default)]
struct ToggleShortcutState(Mutex<Option<Shortcut>>);

/// 设置显示 / 隐藏桌宠窗口的全局快捷键（效果与托盘菜单的「显示 / 隐藏」相同），
/// 传入 None 或空字符串表示取消注册。快捷键格式与划词、截图相同，如 `Ctrl+Alt+KeyS`
#[tauri::command]
fn set_toggle_shortcut(
  app: AppHandle,
  state: State<'_, ToggleShortcutState>,
  shortcut: Option<String>,
) -> Result<(), String> {
  let global_shortcut = app.global_shortcut();
  let mut current = state.0.lock().map_err(|e| e.to_string())?;

  if let Some(old) = current.take() {
    let _ = global_shortcut.unregister(old);
  }

  let Some(accelerator) = shortcut.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) else {
    return Ok(());
  };

  let parsed: Shortcut = accelerator
    .parse()
    .map_err(|e| format!("无效的快捷键 {accelerator}：{e}"))?;

  // 只能查到本应用注册的快捷键（划词、截图），其他程序占用的在注册时才会失败
  if global_shortcut.is_registered(parsed) {
    return Err(format!("快捷键 {accelerator} 已被桌宠的其他功能占用"));
  }

  global_shortcut
    .on_shortcut(parsed, |app, _shortcut, event| {
      if event.state() == ShortcutState::Pressed {
        toggle_visibility(app);
      }
    })
    .map_err(|e| format!("注册快捷键 {accelerator} 失败，可能已被其他程序占用：{e}"))?;

  *current = Some(parsed);
  Ok(())
}

/// 创建托盘图标：窗口不在任务栏显示，托盘是显示/隐藏与退出的入口
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
  let toggle = MenuItem::with_id(app, "toggle", "显示 / 隐藏", true, None::<&str>)?;
  let always_on_top = CheckMenuItem::with_id(app, "always_on_top", "始终置顶", true, true, None::<&str>)?;
  let reset_position = MenuItem::with_id(app, "reset_position", "重置窗口位置", true, None::<&str>)?;
  let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
  let separator = PredefinedMenuItem::separator(app)?;

  let menu = Menu::with_items(app, &[&toggle, &always_on_top, &reset_position, &separator, &quit])?;

  let always_on_top_item = always_on_top.clone();
  let mut builder = TrayIconBuilder::with_id("main-tray")
    .tooltip("Desktop Pet")
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(move |app, event| match event.id().as_ref() {
      "toggle" => toggle_visibility(app),
      "always_on_top" => {
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
          let checked = always_on_top_item.is_checked().unwrap_or(true);
          let _ = window.set_always_on_top(checked);
        }
      }
      "reset_position" => {
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
          let _ = fit_to_work_area(&window);
        }
      }
      "quit" => app.exit(0),
      _ => {}
    })
    // 左键单击托盘图标：显示 / 隐藏桌宠
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
      } = event
      {
        toggle_visibility(tray.app_handle());
      }
    });

  if let Some(icon) = app.default_window_icon() {
    builder = builder.icon(icon.clone());
  }

  builder.build(app)?;
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_global_shortcut::Builder::new().build())
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_opener::init())
    .manage(capture::CaptureState::default())
    .manage(ToggleShortcutState::default())
    .invoke_handler(tauri::generate_handler![
      set_toggle_shortcut,
      capture::set_capture_shortcut,
      capture::take_screenshot,
      screen::get_target_window,
      screen::capture_window,
      activity::activity_snapshot,
      apps::apps_list_windows,
      apps::apps_list_installed,
      apps::apps_launch,
      apps::apps_window_action,
      apps::apps_set_window_rects,
      diagnostics::diagnostics_snapshot,
      memory::memory_search,
      memory::memory_similar,
      memory::memory_get,
      memory::memory_list,
      memory::memory_stats,
      memory::memory_add,
      memory::memory_update,
      memory::memory_reinforce,
      memory::memory_archive,
      memory::memory_restore,
      memory::memory_delete,
      memory::memory_events,
      memory::memory_undo,
      memory::memory_changes_since,
      memory::memory_forget_preview,
      memory::memory_forget,
      memory::memory_consolidation_groups,
      memory::memory_pending_embeddings,
      memory::memory_set_embeddings,
      files::files_default_roots,
      files::files_validate_root,
      files::files_search,
      files::files_list,
      files::files_read,
      files::files_read_bytes,
      files::files_plan_organize,
      files::files_move,
      files::files_create_folder,
      files::files_preview_write,
      files::files_write,
      files::files_undo_write,
      files::files_check_targets,
      files::files_snapshot_targets,
      files::files_settle_targets,
      files::office_support,
      files::pdf_print_html,
      files::pdf_plan_compose,
      files::pdf_compose,
      files::script_runtimes,
      files::script_inspect,
      files::script_run,
      files::script_inspect_code,
      files::script_run_code,
      files::script_cancel,
      files::files_reveal,
      files::open_url,
      memory::memory_database_path,
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      setup_tray(app.handle())?;
      screen::start_tracking();
      app.manage(memory::MemoryState::open(app.handle()));

      // 窗口在配置中初始隐藏，定位完成后再显示，避免启动时闪烁
      if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        fit_to_work_area(&window)?;
        window.show()?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}

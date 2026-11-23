use tauri::{
  menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
  AppHandle, Manager, WebviewWindow,
};

mod capture;

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
    .manage(capture::CaptureState::default())
    .invoke_handler(tauri::generate_handler![capture::set_capture_shortcut, capture::take_screenshot])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      setup_tray(app.handle())?;

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

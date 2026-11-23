//! 划词：按下全局快捷键后，模拟一次「复制」获取当前应用中选中的文字，并通知前端。
//!
//! 流程：等待用户松开修饰键 → 备份剪贴板 → 模拟 Ctrl+C（macOS 为 Cmd+C）
//! → 等待剪贴板变化并读取文字 → 恢复剪贴板原有内容 → 发送 `selection-captured` 事件。

use std::{
  sync::Mutex,
  thread,
  time::{Duration, Instant},
};

use arboard::{Clipboard, ImageData};
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// 划词结果事件
pub const CAPTURED_EVENT: &str = "selection-captured";

/// 等待用户松开快捷键中修饰键的最长时间
const MODIFIER_RELEASE_TIMEOUT: Duration = Duration::from_millis(1000);
/// 模拟复制后等待剪贴板变化的最长时间
const COPY_TIMEOUT: Duration = Duration::from_millis(600);
const POLL_INTERVAL: Duration = Duration::from_millis(15);

#[derive(Clone, Serialize)]
pub struct CapturedSelection {
  /// 选中的文字；没有选中任何文字时为 None
  text: Option<String>,
  /// 获取失败时的错误信息
  error: Option<String>,
}

/// 当前注册的划词快捷键
#[derive(Default)]
pub struct SelectionState {
  shortcut: Mutex<Option<Shortcut>>,
}

/// 设置划词快捷键，传入 None 或空字符串表示取消注册。
/// 快捷键格式如 `Ctrl+Alt+KeyQ`、`Ctrl+Shift+Space`。
#[tauri::command]
pub fn set_selection_shortcut(
  app: AppHandle,
  state: State<'_, SelectionState>,
  shortcut: Option<String>,
) -> Result<(), String> {
  let global_shortcut = app.global_shortcut();
  let mut current = state.shortcut.lock().map_err(|e| e.to_string())?;

  if let Some(old) = current.take() {
    let _ = global_shortcut.unregister(old);
  }

  let Some(accelerator) = shortcut.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) else {
    return Ok(());
  };

  let parsed: Shortcut = accelerator
    .parse()
    .map_err(|e| format!("无效的快捷键 {accelerator}：{e}"))?;

  global_shortcut
    .on_shortcut(parsed, |app, _shortcut, event| {
      if event.state() != ShortcutState::Pressed {
        return;
      }
      let app = app.clone();
      // 模拟按键与等待剪贴板都是阻塞操作，放到独立线程中执行
      thread::spawn(move || {
        let payload = match capture() {
          Ok(text) => CapturedSelection { text, error: None },
          Err(error) => CapturedSelection { text: None, error: Some(error) },
        };
        let _ = app.emit(CAPTURED_EVENT, payload);
      });
    })
    .map_err(|e| format!("注册快捷键 {accelerator} 失败，可能已被其他程序占用：{e}"))?;

  *current = Some(parsed);
  Ok(())
}

/// 获取当前选中的文字
fn capture() -> Result<Option<String>, String> {
  // 用户此时还按着快捷键，直接发送 Ctrl+C 会变成 Ctrl+Alt+C 之类的组合
  wait_for_modifiers_released();

  let mut clipboard = Clipboard::new().map_err(|e| format!("无法访问剪贴板：{e}"))?;
  let backup = ClipboardBackup::save(&mut clipboard);
  let detector = ChangeDetector::new(&mut clipboard)?;

  send_copy()?;

  let deadline = Instant::now() + COPY_TIMEOUT;
  let mut changed = false;
  while Instant::now() < deadline {
    thread::sleep(POLL_INTERVAL);
    if detector.changed(&mut clipboard) {
      changed = true;
      break;
    }
  }

  let text = if changed {
    // 部分应用会分多次写入剪贴板，稍等片刻再读取
    thread::sleep(Duration::from_millis(40));
    clipboard.get_text().ok().filter(|text| !text.trim().is_empty())
  } else {
    None
  };

  if changed || detector.modified_clipboard() {
    backup.restore(&mut clipboard);
  }
  Ok(text)
}

fn send_copy() -> Result<(), String> {
  let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("无法模拟按键：{e}"))?;

  #[cfg(target_os = "macos")]
  let (modifier, key) = (Key::Meta, Key::Unicode('c'));
  // Windows 上直接使用虚拟键码 VK_C，避免受键盘布局与输入法影响
  #[cfg(windows)]
  let (modifier, key) = (Key::Control, Key::Other(0x43));
  #[cfg(not(any(windows, target_os = "macos")))]
  let (modifier, key) = (Key::Control, Key::Unicode('c'));

  let result = enigo
    .key(modifier, Direction::Press)
    .and_then(|_| enigo.key(key, Direction::Click));
  // 无论成功与否都要松开修饰键
  let release = enigo.key(modifier, Direction::Release);
  result.and(release).map_err(|e| format!("模拟复制失败：{e}"))
}

#[cfg(windows)]
fn wait_for_modifiers_released() {
  use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
  };

  let deadline = Instant::now() + MODIFIER_RELEASE_TIMEOUT;
  while Instant::now() < deadline {
    let held = [VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN]
      .iter()
      .any(|&vk| unsafe { GetAsyncKeyState(vk as i32) } as u16 & 0x8000 != 0);
    if !held {
      return;
    }
    thread::sleep(POLL_INTERVAL);
  }
}

#[cfg(not(windows))]
fn wait_for_modifiers_released() {
  // 其他平台没有简便的方式查询按键状态，留出松开按键的时间
  thread::sleep(Duration::from_millis(250).min(MODIFIER_RELEASE_TIMEOUT));
}

/// 剪贴板原有内容的备份（仅支持文本与图片，其他格式无法恢复）
enum ClipboardBackup {
  Text(String),
  Image(ImageData<'static>),
  Empty,
}

impl ClipboardBackup {
  fn save(clipboard: &mut Clipboard) -> Self {
    if let Ok(text) = clipboard.get_text() {
      return Self::Text(text);
    }
    if let Ok(image) = clipboard.get_image() {
      return Self::Image(image.to_owned_img());
    }
    Self::Empty
  }

  fn restore(self, clipboard: &mut Clipboard) {
    let _ = match self {
      Self::Text(text) => clipboard.set_text(text),
      Self::Image(image) => clipboard.set_image(image),
      Self::Empty => clipboard.clear(),
    };
  }
}

/// 判断模拟复制后剪贴板是否发生了变化
#[cfg(windows)]
struct ChangeDetector {
  sequence: u32,
}

#[cfg(windows)]
impl ChangeDetector {
  fn new(_clipboard: &mut Clipboard) -> Result<Self, String> {
    Ok(Self { sequence: clipboard_sequence() })
  }

  fn changed(&self, _clipboard: &mut Clipboard) -> bool {
    clipboard_sequence() != self.sequence
  }

  /// 检测过程本身是否改动了剪贴板
  fn modified_clipboard(&self) -> bool {
    false
  }
}

#[cfg(windows)]
fn clipboard_sequence() -> u32 {
  // 剪贴板内容每次变化，序列号都会递增
  unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() }
}

/// 其他平台：先写入一个标记文本，复制后内容不再是标记即视为发生了变化
#[cfg(not(windows))]
struct ChangeDetector {
  marker: String,
}

#[cfg(not(windows))]
impl ChangeDetector {
  fn new(clipboard: &mut Clipboard) -> Result<Self, String> {
    let marker = format!("__desktop_pet_selection_{:?}__", Instant::now());
    clipboard
      .set_text(marker.clone())
      .map_err(|e| format!("无法写入剪贴板：{e}"))?;
    Ok(Self { marker })
  }

  fn changed(&self, clipboard: &mut Clipboard) -> bool {
    clipboard.get_text().map(|text| text != self.marker).unwrap_or(false)
  }

  fn modified_clipboard(&self) -> bool {
    true
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_shortcuts() {
    for accelerator in ["Ctrl+Alt+KeyQ", "Ctrl+Shift+Space", "Alt+KeyX", "Ctrl+Alt+Digit1", "Shift+F2"] {
      assert!(accelerator.parse::<Shortcut>().is_ok(), "{accelerator}");
    }
    assert!("Ctrl+".parse::<Shortcut>().is_err());
  }
}

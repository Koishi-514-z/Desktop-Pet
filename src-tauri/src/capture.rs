//! 划词与截图：通过全局快捷键获取其他应用中的内容，并以 `capture-result` 事件通知前端。
//!
//! - 划词：等待用户松开修饰键 → 备份剪贴板 → 模拟 Ctrl+C（macOS 为 Cmd+C）
//!   → 等待剪贴板变化，读取文字（没有文字时读取图片）→ 恢复剪贴板原有内容。
//! - 截图：调起系统截图工具（Windows 为「截图工具」，macOS 为 screencapture），
//!   等待截图写入剪贴板后读取图片。

use std::{
  collections::HashMap,
  io::Cursor,
  sync::Mutex,
  thread,
  time::{Duration, Instant},
};

use arboard::{Clipboard, ImageData};
use base64::{engine::general_purpose::STANDARD, Engine};
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use image::{ImageFormat, RgbaImage};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// 划词 / 截图结果事件
pub const RESULT_EVENT: &str = "capture-result";

/// 等待用户松开快捷键中修饰键的最长时间
const MODIFIER_RELEASE_TIMEOUT: Duration = Duration::from_millis(1000);
/// 模拟复制后等待剪贴板变化的最长时间
const COPY_TIMEOUT: Duration = Duration::from_millis(600);
const POLL_INTERVAL: Duration = Duration::from_millis(15);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureKind {
  /// 划词：获取选中的文字（或图片）
  Selection,
  /// 截图：框选屏幕区域
  Screenshot,
}

/// 获取到的内容
enum Captured {
  Text(String),
  /// PNG 图片的 data URL
  Image(String),
}

#[derive(Clone, Serialize)]
pub struct CaptureResult {
  kind: CaptureKind,
  text: Option<String>,
  /// PNG 图片的 data URL
  image: Option<String>,
  /// 获取失败时的错误信息
  error: Option<String>,
}

impl CaptureResult {
  fn new(kind: CaptureKind, result: Result<Option<Captured>, String>) -> Self {
    let (text, image, error) = match result {
      Ok(Some(Captured::Text(text))) => (Some(text), None, None),
      Ok(Some(Captured::Image(image))) => (None, Some(image), None),
      Ok(None) => (None, None, None),
      Err(error) => (None, None, Some(error)),
    };
    Self { kind, text, image, error }
  }
}

/// 当前注册的快捷键
#[derive(Default)]
pub struct CaptureState {
  shortcuts: Mutex<HashMap<CaptureKind, Shortcut>>,
}

/// 设置划词 / 截图快捷键，传入 None 或空字符串表示取消注册。
/// 快捷键格式如 `Ctrl+Alt+KeyQ`、`Ctrl+Shift+Space`。
#[tauri::command]
pub fn set_capture_shortcut(
  app: AppHandle,
  state: State<'_, CaptureState>,
  kind: CaptureKind,
  shortcut: Option<String>,
) -> Result<(), String> {
  let global_shortcut = app.global_shortcut();
  let mut shortcuts = state.shortcuts.lock().map_err(|e| e.to_string())?;

  if let Some(old) = shortcuts.remove(&kind) {
    let _ = global_shortcut.unregister(old);
  }

  let Some(accelerator) = shortcut.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) else {
    return Ok(());
  };

  let parsed: Shortcut = accelerator
    .parse()
    .map_err(|e| format!("无效的快捷键 {accelerator}：{e}"))?;

  if shortcuts.values().any(|other| other.id() == parsed.id()) {
    return Err(format!("快捷键 {accelerator} 已被划词或截图占用"));
  }

  global_shortcut
    .on_shortcut(parsed, move |app, _shortcut, event| {
      if event.state() != ShortcutState::Pressed {
        return;
      }
      let app = app.clone();
      // 模拟按键与等待剪贴板都是阻塞操作，放到独立线程中执行
      thread::spawn(move || {
        let result = match kind {
          CaptureKind::Selection => capture_selection(),
          CaptureKind::Screenshot => capture_screenshot().map(|image| image.map(Captured::Image)),
        };
        // 截图被取消时不打扰用户
        if kind == CaptureKind::Screenshot && matches!(result, Ok(None)) {
          return;
        }
        let _ = app.emit(RESULT_EVENT, CaptureResult::new(kind, result));
      });
    })
    .map_err(|e| format!("注册快捷键 {accelerator} 失败，可能已被其他程序占用：{e}"))?;

  shortcuts.insert(kind, parsed);
  Ok(())
}

/// 截图（供对话面板中的截图按钮使用），返回 PNG 图片的 data URL，取消时返回 None
#[tauri::command]
pub async fn take_screenshot() -> Result<Option<String>, String> {
  tauri::async_runtime::spawn_blocking(capture_screenshot)
    .await
    .map_err(|e| e.to_string())?
}

// ===== 划词 =====

fn capture_selection() -> Result<Option<Captured>, String> {
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

  let captured = if changed {
    // 部分应用会分多次写入剪贴板，稍等片刻再读取
    thread::sleep(Duration::from_millis(40));
    match clipboard.get_text() {
      Ok(text) if !text.trim().is_empty() => Some(Captured::Text(text)),
      // 选中的是图片（如浏览器中的图片）
      _ => clipboard.get_image().ok().map(encode_png).transpose()?.map(Captured::Image),
    }
  } else {
    None
  };

  if changed || detector.modified_clipboard() {
    backup.restore(&mut clipboard);
  }
  Ok(captured)
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

// ===== 截图 =====

/// 等待用户完成截图的最长时间
#[cfg(windows)]
const SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(60);

/// 每次截图的编号。再次发起截图时，之前仍在等待的截图会自动放弃，
/// 这样用户按 Esc 取消截图工具后，不必等到超时就能重新截图
#[cfg(windows)]
static SCREENSHOT_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[cfg(windows)]
fn capture_screenshot() -> Result<Option<String>, String> {
  use std::sync::atomic::Ordering;

  let generation = SCREENSHOT_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
  let mut clipboard = Clipboard::new().map_err(|e| format!("无法访问剪贴板：{e}"))?;
  let mut sequence = clipboard_sequence();

  // 调起系统自带的截图工具，截图完成后会自动复制到剪贴板
  std::process::Command::new("explorer")
    .arg("ms-screenclip:")
    .spawn()
    .map_err(|e| format!("无法打开截图工具：{e}"))?;

  let deadline = Instant::now() + SCREENSHOT_TIMEOUT;
  while Instant::now() < deadline {
    thread::sleep(Duration::from_millis(100));
    if SCREENSHOT_GENERATION.load(Ordering::SeqCst) != generation {
      return Ok(None);
    }
    let current = clipboard_sequence();
    if current == sequence {
      continue;
    }
    sequence = current;
    thread::sleep(Duration::from_millis(80));
    if let Ok(image) = clipboard.get_image() {
      return encode_png(image).map(Some);
    }
  }
  Ok(None)
}

#[cfg(target_os = "macos")]
fn capture_screenshot() -> Result<Option<String>, String> {
  // -i 交互式框选，-c 保存到剪贴板；用户按 Esc 取消时返回非零状态码
  let status = std::process::Command::new("screencapture")
    .args(["-i", "-c"])
    .status()
    .map_err(|e| format!("无法打开截图工具：{e}"))?;
  if !status.success() {
    return Ok(None);
  }
  let mut clipboard = Clipboard::new().map_err(|e| format!("无法访问剪贴板：{e}"))?;
  match clipboard.get_image() {
    Ok(image) => encode_png(image).map(Some),
    Err(_) => Ok(None),
  }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn capture_screenshot() -> Result<Option<String>, String> {
  Err("当前系统暂不支持截图，可以把图片粘贴或拖到对话框中".into())
}

/// 将剪贴板中的图片编码为 PNG 的 data URL
fn encode_png(image: ImageData<'_>) -> Result<String, String> {
  let rgba = RgbaImage::from_raw(image.width as u32, image.height as u32, image.bytes.into_owned())
    .ok_or("剪贴板中的图片数据无效")?;
  encode_rgba_png(&rgba)
}

/// 将 RGBA 图片编码为 PNG 的 data URL
pub(crate) fn encode_rgba_png(rgba: &RgbaImage) -> Result<String, String> {
  let mut buffer = Cursor::new(Vec::new());
  rgba
    .write_to(&mut buffer, ImageFormat::Png)
    .map_err(|e| format!("图片编码失败：{e}"))?;
  Ok(format!("data:image/png;base64,{}", STANDARD.encode(buffer.into_inner())))
}

// ===== 剪贴板 =====

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
    match clipboard.get_text() {
      Ok(text) => text != self.marker,
      // 复制的是图片时读不到文字
      Err(_) => clipboard.get_image().is_ok(),
    }
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

  #[test]
  fn encodes_png_data_url() {
    let image = ImageData {
      width: 2,
      height: 1,
      bytes: vec![255, 0, 0, 255, 0, 0, 255, 255].into(),
    };
    let url = encode_png(image).unwrap();
    assert!(url.starts_with("data:image/png;base64,"));

    let bytes = STANDARD.decode(url.trim_start_matches("data:image/png;base64,")).unwrap();
    let decoded = image::load_from_memory_with_format(&bytes, ImageFormat::Png).unwrap().to_rgba8();
    assert_eq!(decoded.dimensions(), (2, 1));
    assert_eq!(decoded.get_pixel(1, 0).0, [0, 0, 255, 255]);
  }

  #[test]
  fn rejects_invalid_image_data() {
    let image = ImageData { width: 4, height: 4, bytes: vec![0; 3].into() };
    assert!(encode_png(image).is_err());
  }
}

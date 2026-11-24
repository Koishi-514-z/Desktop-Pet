//! 写入与修改文件。
//!
//! - 纯文本类文件（write_file / edit_file）：先生成预览（不改动文件），用户确认后再写入；
//!   写入时校验文件在确认期间没有被改动过；修改时保持原来的编码与换行符
//! - 由脚本修改的文件（如「Office 文档」技能修改 Word、Excel、PowerPoint）：运行前检查并备份，
//!   运行后对比内容、记录改动（见本文件末尾的 snapshot_targets / settle_targets）
//!
//! 修改前会把原内容备份到应用数据目录，以便撤销。不提供删除文件的能力——唯一的例外是撤销：
//! 撤销「新建文件」时会删除这个文件，且只在它之后没有被改动过时才会删除。

use std::{
  borrow::Cow,
  collections::HashSet,
  fs::{self, OpenOptions},
  io::Write,
  path::{Component, Path, PathBuf},
  sync::atomic::{AtomicU64, Ordering},
  time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use super::read::TEXT_EXTENSIONS;
use super::roots::Roots;

/// 可以修改的文本文件的最大大小（与读取上限一致，超过时无法完整读取）
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// 备份的总大小上限（至少保留最新的一份）
const MAX_BACKUP_TOTAL_BYTES: u64 = 500 * 1024 * 1024;
/// 预览中每段改动最多显示的行数
const PREVIEW_LINES: usize = 24;
/// 预览中每行最多显示的字数
const PREVIEW_LINE_CHARS: usize = 320;
/// 预览的最大字数
const PREVIEW_MAX_CHARS: usize = 8000;
/// 最多保留的备份数量
const MAX_BACKUPS: usize = 50;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEdit {
  pub old_text: String,
  pub new_text: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteRequest {
  pub path: String,
  /// 文件的完整内容：新建文件，或覆盖整个文件
  pub content: Option<String>,
  /// 文件已存在时是否允许覆盖
  #[serde(default)]
  pub overwrite: bool,
  /// 依次执行的查找替换，原文必须在文件中只出现一次
  #[serde(default)]
  pub edits: Vec<TextEdit>,
  /// 追加到文件末尾的内容
  pub append: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WritePreview {
  pub path: String,
  pub created: bool,
  /// 原文件内容的哈希，写入时用来确认文件没有被改动过；新建文件时为空
  pub before_hash: Option<String>,
  pub after_hash: String,
  /// 一句话说明，如「修改了 2 处」
  pub summary: String,
  /// 改动预览：- 开头为删除的行，+ 开头为新增的行
  pub preview: String,
  /// 写入使用的编码
  pub encoding: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
  pub path: String,
  pub created: bool,
  /// 原文件的备份，用于撤销；新建文件时为空
  pub backup_id: Option<String>,
  pub after_hash: String,
  pub summary: String,
  pub preview: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum TextEncoding {
  Utf8 { bom: bool },
  Utf16Le,
  Utf16Be,
  Gb18030,
  /// 系统的 ANSI 编码（如中文 Windows 上的 GBK），用于新建批处理文件
  Ansi(&'static encoding_rs::Encoding),
}

impl TextEncoding {
  fn label(self) -> &'static str {
    match self {
      Self::Utf8 { bom: false } => "UTF-8",
      Self::Utf8 { bom: true } => "UTF-8（带 BOM）",
      Self::Utf16Le => "UTF-16 LE",
      Self::Utf16Be => "UTF-16 BE",
      Self::Gb18030 => "GBK",
      Self::Ansi(encoding) => encoding.name(),
    }
  }
}

/// 系统的 ANSI 编码：cmd 按它读取批处理文件
#[cfg(windows)]
fn system_encoding() -> TextEncoding {
  // SAFETY: GetACP 没有参数，只返回当前的代码页
  let code_page = unsafe { windows_sys::Win32::Globalization::GetACP() };
  let encoding = match code_page {
    936 => encoding_rs::GBK,
    950 => encoding_rs::BIG5,
    932 => encoding_rs::SHIFT_JIS,
    949 => encoding_rs::EUC_KR,
    874 | 1250..=1258 => encoding_rs::Encoding::for_label(format!("windows-{code_page}").as_bytes()).unwrap_or(encoding_rs::WINDOWS_1252),
    // 65001（UTF-8）等
    _ => return TextEncoding::Utf8 { bom: false },
  };
  TextEncoding::Ansi(encoding)
}

#[cfg(not(windows))]
fn system_encoding() -> TextEncoding {
  TextEncoding::Utf8 { bom: false }
}

/// 新建文本文件时使用的编码与换行符（是否 CRLF）：
/// - 批处理（.bat / .cmd）：cmd 按系统编码读取（中文 Windows 上为 GBK），并且需要 CRLF 换行，否则跳转标签等可能出错
/// - PowerShell（.ps1）：Windows PowerShell 5.1 会把没有 BOM 的文件当作系统编码，中文会乱码，因此使用带 BOM 的 UTF-8
/// - Shell（.sh）与其他文件：UTF-8、LF 换行（Bash 遇到 CR 会出错）
fn new_file_format(extension: &str) -> (TextEncoding, bool) {
  match extension {
    "bat" | "cmd" => (system_encoding(), true),
    "ps1" => (TextEncoding::Utf8 { bom: true }, true),
    _ => (TextEncoding::Utf8 { bom: false }, false),
  }
}

/// 把批处理代码编码为 cmd 能正确读取的内容（系统编码、CRLF），用于运行一段临时的批处理代码
pub(super) fn batch_bytes(code: &str) -> Result<Vec<u8>, String> {
  let (encoding, crlf) = new_file_format("bat");
  encode(&normalize_newlines(code), encoding, crlf)
}

/// 已有的文本文件
struct TextFile {
  /// 换行符为 CRLF 时已统一换成 \n
  text: String,
  encoding: TextEncoding,
  crlf: bool,
}

struct WritePlan {
  path: PathBuf,
  before: Option<Vec<u8>>,
  bytes: Vec<u8>,
  preview: WritePreview,
}

/// FNV-1a 哈希（附带长度），用来判断文件是否被改动过；结果跨版本稳定，可以保存下来用于撤销
pub fn content_hash(bytes: &[u8]) -> String {
  let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
  for &byte in bytes {
    hash ^= u64::from(byte);
    hash = hash.wrapping_mul(0x0100_0000_01b3);
  }
  format!("{hash:016x}-{}", bytes.len())
}

/// 严格解码：任何无法解码的字节都视为失败，避免写回时破坏文件
fn decode_exact(bytes: &[u8]) -> Option<(String, TextEncoding)> {
  if let Some((encoding, bom_length)) = encoding_rs::Encoding::for_bom(bytes) {
    let text = encoding.decode_without_bom_handling_and_without_replacement(&bytes[bom_length..])?;
    let kind = if encoding == encoding_rs::UTF_8 {
      TextEncoding::Utf8 { bom: true }
    }
    else if encoding == encoding_rs::UTF_16LE {
      TextEncoding::Utf16Le
    }
    else {
      TextEncoding::Utf16Be
    };
    return Some((text.into_owned(), kind));
  }
  if bytes.contains(&0) {
    return None;
  }
  if let Ok(text) = std::str::from_utf8(bytes) {
    return Some((text.to_string(), TextEncoding::Utf8 { bom: false }));
  }
  let text = encoding_rs::GB18030.decode_without_bom_handling_and_without_replacement(bytes)?;
  Some((text.into_owned(), TextEncoding::Gb18030))
}

fn encode(text: &str, encoding: TextEncoding, crlf: bool) -> Result<Vec<u8>, String> {
  let text: Cow<str> = if crlf { text.replace('\n', "\r\n").into() } else { text.into() };
  Ok(match encoding {
    TextEncoding::Utf8 { bom } => {
      let mut bytes = if bom { vec![0xEF, 0xBB, 0xBF] } else { Vec::new() };
      bytes.extend_from_slice(text.as_bytes());
      bytes
    }
    TextEncoding::Utf16Le => [0xFF, 0xFE].into_iter().chain(text.encode_utf16().flat_map(u16::to_le_bytes)).collect(),
    TextEncoding::Utf16Be => [0xFE, 0xFF].into_iter().chain(text.encode_utf16().flat_map(u16::to_be_bytes)).collect(),
    TextEncoding::Gb18030 => encoding_rs::GB18030.encode(&text).0.into_owned(),
    TextEncoding::Ansi(encoding) => {
      let (bytes, _, unmappable) = encoding.encode(&text);
      if unmappable {
        return Err(format!(
          "内容中有 {} 编码无法表示的字符（如 emoji 或生僻字）。批处理文件需要用系统编码保存，请去掉这些字符",
          encoding.name()
        ));
      }
      bytes.into_owned()
    }
  })
}

fn normalize_newlines(text: &str) -> String {
  text.replace("\r\n", "\n")
}

fn read_existing(bytes: &[u8]) -> Result<TextFile, String> {
  let (text, encoding) = decode_exact(bytes).ok_or("无法识别这个文件的编码，或它不是文本文件，无法修改")?;
  // 所有换行都是 CRLF 时统一成 \n 处理，写回时再换回去；混用两种换行的文件保持原样
  let newlines = text.matches('\n').count();
  let crlf = newlines > 0 && text.matches("\r\n").count() == newlines;
  let text = if crlf { normalize_newlines(&text) } else { text };
  Ok(TextFile { text, encoding, crlf })
}

/// 文件是否为隐藏文件，或位于隐藏的文件夹中（如 .git 中的文件、Office 打开文档时生成的 ~$ 临时文件）
fn is_hidden(roots: &Roots, path: &Path) -> Result<bool, String> {
  let root = roots.paths().iter().find(|root| path.starts_with(root)).ok_or("不在授权访问的文件夹内")?;
  Ok(path.strip_prefix(root).unwrap_or(path).components().any(|component| match component {
    Component::Normal(name) => {
      let name = name.to_string_lossy();
      name.starts_with('.') || name.starts_with('~')
    }
    _ => false,
  }))
}

/// 检查文件能否用 write_file / edit_file 写入：只能写入纯文本类文件（包括 .bat、.cmd、.ps1、.sh 等脚本，运行前另有确认）。
/// Word、Excel、PowerPoint 由「Office 文档」技能通过脚本修改；不能写入隐藏的文件或文件夹
fn check_writable(roots: &Roots, path: &Path) -> Result<(), String> {
  let extension = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
  match extension.as_str() {
    "docx" | "xlsx" | "pptx" | "doc" | "xls" | "ppt" | "docm" | "xlsm" | "pptm" => {
      return Err("Word、Excel、PowerPoint 文件请用「Office 文档」技能的 run_office_script 新建或修改".into());
    }
    "pdf" => return Err("不能直接写入 PDF 文件；可以先写成 Word 文档，再用「Office 文档」技能导出为 PDF".into()),
    "" => return Err("只能写入带扩展名的文件（如 .txt、.md、.json）".into()),
    other if !TEXT_EXTENSIONS.contains(&other) => {
      return Err(format!("不能写入 .{extension} 文件，只能写入纯文本类文件（如 .txt、.md、.json、代码文件）"));
    }
    _ => {}
  }
  if is_hidden(roots, path)? {
    return Err("不能写入隐藏的文件或文件夹".into());
  }
  Ok(())
}

fn line_count(text: &str) -> usize {
  if text.is_empty() { 0 } else { text.trim_end_matches('\n').split('\n').count() }
}

/// 把一段文字按行加上前缀写入预览，行数与每行的长度都有上限
pub(super) fn push_lines(preview: &mut String, prefix: &str, text: &str) {
  if text.is_empty() {
    return;
  }
  let lines: Vec<&str> = text.trim_end_matches('\n').split('\n').collect();
  for line in lines.iter().take(PREVIEW_LINES) {
    let line = line.trim_end_matches('\r');
    let shown: String = line.chars().take(PREVIEW_LINE_CHARS).collect();
    let more = if line.chars().count() > PREVIEW_LINE_CHARS { "…" } else { "" };
    preview.push_str(&format!("{prefix}{shown}{more}\n"));
  }
  if lines.len() > PREVIEW_LINES {
    preview.push_str(&format!("  …（还有 {} 行）\n", lines.len() - PREVIEW_LINES));
  }
}

/// 覆盖整个文件时的预览：去掉前后相同的行，只显示中间改动的部分
fn diff_preview(before: &str, after: &str) -> String {
  let old: Vec<&str> = before.split('\n').collect();
  let new: Vec<&str> = after.split('\n').collect();
  let prefix = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
  let max_suffix = old.len().min(new.len()) - prefix;
  let suffix = old.iter().rev().zip(new.iter().rev()).take(max_suffix).take_while(|(a, b)| a == b).count();
  let mut preview = format!("第 {} 行起：\n", prefix + 1);
  push_lines(&mut preview, "- ", &old[prefix..old.len() - suffix].join("\n"));
  push_lines(&mut preview, "+ ", &new[prefix..new.len() - suffix].join("\n"));
  preview
}

fn limit_preview(preview: String) -> String {
  let preview = preview.trim_end().to_string();
  if preview.chars().count() <= PREVIEW_MAX_CHARS {
    return preview;
  }
  let shown: String = preview.chars().take(PREVIEW_MAX_CHARS).collect();
  format!("{shown}\n…（预览过长，已截断）")
}

/// 在文本上依次执行查找替换与追加，返回新文本、说明与预览。
/// LLM 给出的文字统一使用 \n 换行；CRLF 文件已在读取时统一成 \n，写回时再换回去
fn apply_edits(text: &str, edits: &[TextEdit], append: Option<&str>) -> Result<(String, String, String), String> {
  let mut text = text.to_string();
  let mut preview = String::new();
  let normalize = normalize_newlines;

  for (index, edit) in edits.iter().enumerate() {
    let old = normalize(&edit.old_text);
    let new = normalize(&edit.new_text);
    let label = if edits.len() > 1 { format!("第 {} 处修改", index + 1) } else { "修改".to_string() };
    if old.is_empty() {
      return Err(format!("{label}的原文不能为空"));
    }
    if old == new {
      return Err(format!("{label}的原文与新内容相同"));
    }
    let position = text.find(&old).ok_or_else(|| {
      let excerpt: String = old.chars().take(60).collect();
      format!("{label}的原文没有在文件中找到：「{excerpt}」。请先用 read_file 读取文件，原文需要与文件内容完全一致（包括空格与标点）")
    })?;
    let count = text.matches(&old).count();
    if count > 1 {
      return Err(format!("{label}的原文在文件中出现了 {count} 次，请包含更多上下文，使它只出现一次"));
    }
    let line = text[..position].matches('\n').count() + 1;
    preview.push_str(&format!("第 {line} 行：\n"));
    push_lines(&mut preview, "- ", &old);
    push_lines(&mut preview, "+ ", &new);
    preview.push('\n');
    text.replace_range(position..position + old.len(), &new);
  }

  let mut summary = Vec::new();
  if !edits.is_empty() {
    summary.push(format!("修改了 {} 处", edits.len()));
  }
  if let Some(append) = append {
    let append = normalize(append);
    if append.trim().is_empty() {
      return Err("追加的内容不能为空".into());
    }
    if !text.is_empty() && !text.ends_with('\n') {
      text.push('\n');
    }
    preview.push_str("末尾追加：\n");
    push_lines(&mut preview, "+ ", &append);
    summary.push(format!("在末尾追加了 {} 行", line_count(&append)));
    text.push_str(&append);
  }
  Ok((text, summary.join("，"), preview))
}

/// 写入后的文件内容与改动说明
struct Change {
  bytes: Vec<u8>,
  summary: String,
  preview: String,
  encoding: &'static str,
}

/// 纯文本文件：修改时保持原文件的编码与换行符，新建时按文件类型选择（见 new_file_format）
fn plan_text(before: Option<&[u8]>, request: &WriteRequest, extension: &str) -> Result<Change, String> {
  let existing = before.map(read_existing).transpose()?;
  let (text, encoding, crlf, summary, preview) = match (&existing, &request.content) {
    (None, Some(content)) => {
      let text = normalize_newlines(content);
      let mut preview = String::new();
      push_lines(&mut preview, "+ ", &text);
      let summary = format!("新建文件，共 {} 行", line_count(&text));
      let (encoding, crlf) = new_file_format(extension);
      (text, encoding, crlf, summary, preview)
    }
    (Some(file), Some(content)) => {
      let text = normalize_newlines(content);
      let summary = format!("覆盖整个文件（原来 {} 行，现在 {} 行）", line_count(&file.text), line_count(&text));
      let preview = diff_preview(&file.text, &text);
      (text, file.encoding, file.crlf, summary, preview)
    }
    (Some(file), None) => {
      let (text, summary, preview) = apply_edits(&file.text, &request.edits, request.append.as_deref())?;
      (text, file.encoding, file.crlf, summary, preview)
    }
    (None, None) => return Err("没有要写入的内容".into()),
  };

  // 不能借由写入把文件清空（变相删除内容）
  if text.trim().is_empty() {
    return Err(if existing.is_some() { "不能清空文件的全部内容".into() } else { "文件内容不能为空".into() });
  }
  if existing.as_ref().is_some_and(|file| file.text == text) {
    return Err("修改后的内容与原来相同".into());
  }
  Ok(Change { bytes: encode(&text, encoding, crlf)?, summary, preview, encoding: encoding.label() })
}

fn plan(roots: &Roots, request: &WriteRequest) -> Result<WritePlan, String> {
  let editing = !request.edits.is_empty() || request.append.is_some();
  if request.content.is_some() && editing {
    return Err("content 不能与 edits、append 同时使用".into());
  }
  if request.content.is_none() && !editing {
    return Err("没有要写入的内容".into());
  }
  // 已存在的文件会被规范化（解析符号链接），确保真实位置也在授权文件夹内
  let path = roots.resolve_new(&request.path)?;
  if path.is_dir() {
    return Err(format!("{} 是文件夹", path.display()));
  }
  check_writable(roots, &path)?;

  let before = if path.exists() {
    let size = fs::metadata(&path).map_err(|e| format!("读取文件失败：{e}"))?.len();
    if size > MAX_FILE_BYTES {
      return Err("文件太大（超过 4 MB），无法修改".into());
    }
    Some(fs::read(&path).map_err(|e| format!("读取文件失败：{e}"))?)
  }
  else {
    None
  };
  match (&before, &request.content) {
    (None, None) => return Err(format!("找不到 {}；新建文件请用 write_file", request.path)),
    (Some(_), Some(_)) if !request.overwrite => {
      return Err(format!(
        "{} 已经存在。修改部分内容请用 edit_file；确实要覆盖整个文件时，需要设置 overwrite",
        path.display()
      ))
    }
    _ => {}
  }

  let extension = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
  let change = plan_text(before.as_deref(), request, &extension)?;
  if change.bytes.len() as u64 > MAX_FILE_BYTES {
    return Err("写入后的文件太大（超过 4 MB）".into());
  }

  Ok(WritePlan {
    preview: WritePreview {
      path: path.display().to_string(),
      created: before.is_none(),
      before_hash: before.as_deref().map(content_hash),
      after_hash: content_hash(&change.bytes),
      summary: change.summary,
      preview: limit_preview(change.preview),
      encoding: change.encoding,
    },
    path,
    before,
    bytes: change.bytes,
  })
}

/// 生成写入预览，不改动文件
pub fn preview(roots: &Roots, request: &WriteRequest) -> Result<WritePreview, String> {
  plan(roots, request).map(|plan| plan.preview)
}

fn backup_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
  if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
    return Err("无效的备份".into());
  }
  Ok(dir.join(format!("{id}.bak")))
}

/// 保存原文件的备份，只保留最近的若干份
fn save_backup(dir: &Path, bytes: &[u8]) -> Result<String, String> {
  static COUNTER: AtomicU64 = AtomicU64::new(0);
  fs::create_dir_all(dir).map_err(|e| format!("无法创建备份文件夹：{e}"))?;
  let millis = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
  let id = format!("{millis}-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
  fs::write(backup_path(dir, &id)?, bytes).map_err(|e| format!("无法备份原文件：{e}"))?;

  // 从新到旧保留，超过数量或总大小上限的旧备份删除（最新的一份总是保留）
  let mut backups: Vec<(SystemTime, u64, PathBuf)> = fs::read_dir(dir)
    .map(|entries| {
      entries
        .filter_map(|entry| {
          let path = entry.ok()?.path();
          let metadata = path.metadata().ok()?;
          (path.extension()? == "bak").then_some((metadata.modified().ok()?, metadata.len(), path))
        })
        .collect()
    })
    .unwrap_or_default();
  backups.sort_by(|a, b| b.0.cmp(&a.0));
  let mut total = 0;
  for (index, (_, size, path)) in backups.into_iter().enumerate() {
    total += size;
    if index > 0 && (index >= MAX_BACKUPS || total > MAX_BACKUP_TOTAL_BYTES) {
      let _ = fs::remove_file(path);
    }
  }
  Ok(id)
}

/// 写入文件：expected_hash 为预览时原文件的哈希，用来确认文件在用户确认期间没有被改动过
pub fn apply(roots: &Roots, request: &WriteRequest, expected_hash: Option<&str>, backup_dir: &Path) -> Result<WriteResult, String> {
  let plan = plan(roots, request)?;
  if plan.preview.before_hash.as_deref() != expected_hash {
    return Err("文件在确认期间被改动了（或被新建、移走），没有写入，请重新读取后再试".into());
  }

  let backup_id = match &plan.before {
    Some(before) => {
      let id = save_backup(backup_dir, before)?;
      fs::write(&plan.path, &plan.bytes).map_err(|e| format!("写入文件失败（文件可能正在被使用）：{e}"))?;
      Some(id)
    }
    None => {
      if let Some(parent) = plan.path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建文件夹：{e}"))?;
      }
      // create_new：如果文件恰好在这期间被创建，不会覆盖它
      let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&plan.path)
        .map_err(|e| format!("无法新建文件：{e}"))?;
      file.write_all(&plan.bytes).map_err(|e| format!("写入文件失败：{e}"))?;
      None
    }
  };

  Ok(WriteResult {
    path: plan.preview.path,
    created: plan.preview.created,
    backup_id,
    after_hash: plan.preview.after_hash,
    summary: plan.preview.summary,
    preview: plan.preview.preview,
  })
}

/// 撤销一次写入：恢复原文件的内容；新建的文件则删除它；被脚本删除的文件（after_hash 为空）从备份恢复。
/// 文件在写入之后又被改动过时不撤销，避免丢失之后的修改
pub fn undo(roots: &Roots, path: &str, backup_id: Option<&str>, after_hash: Option<&str>, backup_dir: &Path) -> Result<(), String> {
  let Some(after_hash) = after_hash else {
    // 文件被脚本删除了：从备份恢复，不覆盖之后新建的同名文件
    let path = roots.resolve_new(path)?;
    if path.exists() {
      return Err("这个位置在之后又有了同名的文件，为了不覆盖它，没有撤销".into());
    }
    let backup = backup_path(backup_dir, backup_id.ok_or("没有原文件的备份，无法恢复")?)?;
    let before = fs::read(&backup).map_err(|_| "原文件的备份已经不存在（只保留最近 50 份），无法撤销".to_string())?;
    if let Some(parent) = path.parent() {
      fs::create_dir_all(parent).map_err(|e| format!("无法创建文件夹：{e}"))?;
    }
    fs::write(&path, before).map_err(|e| format!("恢复文件失败：{e}"))?;
    let _ = fs::remove_file(backup);
    return Ok(());
  };
  let path = roots.resolve(path)?;
  let current = fs::read(&path).map_err(|e| format!("读取文件失败：{e}"))?;
  if content_hash(&current) != after_hash {
    return Err("文件在这之后又被修改过，为了不丢失这些修改，没有撤销".into());
  }
  match backup_id {
    Some(id) => {
      let backup = backup_path(backup_dir, id)?;
      let before = fs::read(&backup).map_err(|_| "原文件的备份已经不存在（只保留最近 50 份），无法撤销".to_string())?;
      fs::write(&path, before).map_err(|e| format!("恢复文件失败（文件可能正在被使用）：{e}"))?;
      let _ = fs::remove_file(backup);
    }
    None => fs::remove_file(&path).map_err(|e| format!("无法撤销新建的文件：{e}"))?,
  }
  Ok(())
}

// ===== 由脚本修改的文件：运行前检查并备份，运行后对比内容、记录改动，以便撤销 =====

/// 一次最多涉及的文件数量
const MAX_TARGETS: usize = 20;
/// 运行前备份的单个文件的最大大小
const MAX_TARGET_BYTES: u64 = 100 * 1024 * 1024;

/// 运行前对一个文件的检查结果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetInfo {
  pub path: String,
  /// 文件是否已经存在（不存在表示将由脚本新建）
  pub exists: bool,
  pub size: u64,
}

/// 运行前的快照
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetSnapshot {
  pub path: String,
  /// 运行前文件的备份；运行前文件不存在时为空
  pub backup_id: Option<String>,
  /// 运行前的内容哈希；运行前文件不存在时为空
  pub before_hash: Option<String>,
}

/// 运行后一个文件的改动
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetChange {
  pub path: String,
  /// 内容有变化（包括新建与删除）
  pub changed: bool,
  /// 运行前不存在、运行后存在
  pub created: bool,
  /// 运行前存在、运行后不存在
  pub deleted: bool,
  /// 运行前的备份，用于撤销；没有变化时已删除
  pub backup_id: Option<String>,
  /// 运行后的内容哈希；文件被删除时为空
  pub after_hash: Option<String>,
  /// 无法确认改动时的原因（如文件仍被占用）
  pub error: Option<String>,
}

/// 文件是否正被其他程序打开着（如在 Word、Excel 中打开）：
/// 以不共享的方式打开文件，文件已被其他程序打开时会遇到共享冲突（错误码 32）
#[cfg(windows)]
fn in_use(path: &Path) -> bool {
  use std::os::windows::fs::OpenOptionsExt;
  matches!(OpenOptions::new().read(true).write(true).share_mode(0).open(path), Err(error) if error.raw_os_error() == Some(32))
}

#[cfg(not(windows))]
fn in_use(_path: &Path) -> bool {
  false
}

fn file_name(path: &Path) -> String {
  path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn check_target(roots: &Roots, path: &str) -> Result<(PathBuf, TargetInfo), String> {
  let resolved = roots.resolve_new(path)?;
  if resolved.is_dir() {
    return Err(format!("{} 是文件夹", resolved.display()));
  }
  if is_hidden(roots, &resolved)? {
    return Err(format!("不能修改隐藏的文件或文件夹：{}", resolved.display()));
  }
  let extension = resolved.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
  if matches!(extension.as_str(), "docm" | "xlsm" | "pptm" | "dotm" | "xltm" | "potm") {
    return Err(format!("不能修改带宏的 Office 文件：{}", file_name(&resolved)));
  }
  let (exists, size) = match fs::metadata(&resolved) {
    Ok(metadata) => (true, metadata.len()),
    Err(_) => (false, 0),
  };
  if exists && size > MAX_TARGET_BYTES {
    return Err(format!("「{}」太大（超过 100 MB），无法备份", file_name(&resolved)));
  }
  if exists && in_use(&resolved) {
    return Err(format!("「{}」正在被其他程序使用（可能在 Office 中打开着），请先关闭它再试", file_name(&resolved)));
  }
  let info = TargetInfo { path: resolved.display().to_string(), exists, size };
  Ok((resolved, info))
}

fn check_all(roots: &Roots, paths: &[String]) -> Result<Vec<(PathBuf, TargetInfo)>, String> {
  if paths.is_empty() {
    return Err("需要列出脚本会新建或修改的文件".into());
  }
  if paths.len() > MAX_TARGETS {
    return Err(format!("一次最多修改 {MAX_TARGETS} 个文件"));
  }
  let mut seen = HashSet::new();
  let mut targets = Vec::new();
  for path in paths {
    let (resolved, info) = check_target(roots, path)?;
    if seen.insert(resolved.clone()) {
      targets.push((resolved, info));
    }
  }
  Ok(targets)
}

/// 运行前检查脚本会新建或修改的文件：在授权的文件夹内、不是隐藏文件、没有被其他程序打开（不会改动文件）
pub fn check_targets(roots: &Roots, paths: &[String]) -> Result<Vec<TargetInfo>, String> {
  Ok(check_all(roots, paths)?.into_iter().map(|(_, info)| info).collect())
}

/// 运行前再检查一次，并备份已有的文件
pub fn snapshot_targets(roots: &Roots, paths: &[String], backup_dir: &Path) -> Result<Vec<TargetSnapshot>, String> {
  let mut snapshots = Vec::new();
  for (path, info) in check_all(roots, paths)? {
    let snapshot = if info.exists {
      let bytes = fs::read(&path).map_err(|e| format!("备份「{}」失败：{e}", file_name(&path)))?;
      TargetSnapshot { path: info.path, backup_id: Some(save_backup(backup_dir, &bytes)?), before_hash: Some(content_hash(&bytes)) }
    }
    else {
      TargetSnapshot { path: info.path, backup_id: None, before_hash: None }
    };
    snapshots.push(snapshot);
  }
  Ok(snapshots)
}

/// 读取运行后的文件内容。Office 退出后可能稍晚才释放文件，读取失败时重试几次；文件不存在时返回 None
fn read_after(path: &Path) -> Result<Option<Vec<u8>>, String> {
  for attempt in 0..10 {
    if !path.exists() {
      return Ok(None);
    }
    match fs::read(path) {
      Ok(bytes) => return Ok(Some(bytes)),
      Err(error) if attempt == 9 => return Err(format!("无法读取「{}」，它可能仍被占用：{error}", file_name(path))),
      Err(_) => std::thread::sleep(std::time::Duration::from_millis(300)),
    }
  }
  unreachable!()
}

/// 运行后对比文件，返回每个文件的改动；没有变化的文件删除备份
pub fn settle_targets(roots: &Roots, snapshots: &[TargetSnapshot], backup_dir: &Path) -> Vec<TargetChange> {
  snapshots
    .iter()
    .map(|snapshot| {
      let unchanged = |error: String| TargetChange {
        path: snapshot.path.clone(),
        changed: false,
        created: false,
        deleted: false,
        backup_id: snapshot.backup_id.clone(),
        after_hash: None,
        error: Some(error),
      };
      let path = match roots.resolve_new(&snapshot.path) {
        Ok(path) => path,
        Err(error) => return unchanged(error),
      };
      let after_hash = match read_after(&path) {
        Ok(bytes) => bytes.map(|bytes| content_hash(&bytes)),
        Err(error) => return unchanged(error),
      };
      let changed = after_hash != snapshot.before_hash;
      if !changed {
        if let Some(backup) = snapshot.backup_id.as_deref().and_then(|id| backup_path(backup_dir, id).ok()) {
          let _ = fs::remove_file(backup);
        }
      }
      TargetChange {
        path: path.display().to_string(),
        changed,
        created: snapshot.before_hash.is_none() && after_hash.is_some(),
        deleted: snapshot.before_hash.is_some() && after_hash.is_none(),
        backup_id: if changed { snapshot.backup_id.clone() } else { None },
        after_hash,
        error: None,
      }
    })
    .collect()
}

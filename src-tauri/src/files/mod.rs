//! 本地文件：在用户授权的文件夹内查找、读取、整理、写入与修改文件，以及在文件夹中显示文件、用浏览器打开链接。
//!
//! 授权的文件夹由前端（设置中）传入，每次操作都会在 Rust 端重新规范化并校验路径，
//! 不提供删除文件与打开（运行）文件的能力。

mod office_check;
mod office_check_docx;
mod office_check_xlsx;
mod office_text;
mod ops;
mod pdf;
mod read;
mod roots;
mod script;
mod write;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod read_tests;
#[cfg(test)]
mod office_tests;
#[cfg(test)]
mod script_tests;
#[cfg(test)]
mod pdf_tests;
#[cfg(test)]
mod office_text_tests;
#[cfg(test)]
mod office_check_tests;
#[cfg(test)]
mod office_check_docs_tests;

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_opener::OpenerExt;

use pdf::{OutputPlan, OutputResult, PdfOutput, PrintRequest, PrintResult};
use ops::{FileEntry, FileMove, MoveReport, OrganizeBy, SearchRequest, SearchResult};
use roots::Roots;
use script::{CodeRequest, OfficeSupport, RunRequest, RunResult, Runtime, ScriptInfo};
use write::{TargetChange, TargetInfo, TargetSnapshot, WritePreview, WriteRequest, WriteResult};

/// 读取文件内容时默认最多返回的字数
const DEFAULT_MAX_CHARS: usize = 24_000;
/// 拖进对话框的文件（直接发送内容）的最大大小
const MAX_EXTRACT_BYTES: usize = 60 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedFolder {
  name: String,
  path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
  entries: Vec<FileEntry>,
  /// 文件夹中的条目总数（entries 可能被截断）
  total: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
  path: String,
  name: String,
  size: u64,
  content: String,
  /// 内容是否被截断
  truncated: bool,
  /// 内容的总字数
  total_chars: usize,
  format: &'static str,
  encoding: Option<&'static str>,
}

/// 在后台线程中执行文件操作，避免阻塞界面
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// 常用的文件夹（桌面、文档、下载、图片），作为默认的授权文件夹
#[tauri::command]
pub fn files_default_roots(app: AppHandle) -> Vec<NamedFolder> {
  let path = app.path();
  [
    ("桌面", path.desktop_dir()),
    ("文档", path.document_dir()),
    ("下载", path.download_dir()),
    ("图片", path.picture_dir()),
  ]
  .into_iter()
  .filter_map(|(name, dir)| {
    let dir = dunce::canonicalize(dir.ok()?).ok()?;
    dir.is_dir().then(|| NamedFolder { name: name.to_string(), path: dir.display().to_string() })
  })
  .collect()
}

/// 检查一个文件夹能否被授权，返回规范化后的路径
#[tauri::command]
pub fn files_validate_root(path: String) -> Result<String, String> {
  roots::validate_root(&path).map(|path| path.display().to_string())
}

#[tauri::command]
pub async fn files_search(roots: Vec<String>, request: SearchRequest) -> Result<SearchResult, String> {
  blocking(move || ops::search(&Roots::new(&roots)?, &request)).await
}

#[tauri::command]
pub async fn files_list(roots: Vec<String>, folder: String, limit: Option<usize>) -> Result<ListResult, String> {
  blocking(move || {
    let (entries, total) = ops::list(&Roots::new(&roots)?, &folder, limit.unwrap_or(200))?;
    Ok(ListResult { entries, total })
  })
  .await
}

#[tauri::command]
pub async fn files_read(roots: Vec<String>, path: String, max_chars: Option<usize>) -> Result<ReadResult, String> {
  blocking(move || {
    let path = Roots::new(&roots)?.resolve(&path)?;
    if path.is_dir() {
      return Err(format!("{} 是文件夹，不能读取内容", path.display()));
    }
    let size = path.metadata().map(|m| m.len()).unwrap_or(0);
    let text = read::read_text(&path)?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(read_result(path.display().to_string(), name, size, text, max_chars.unwrap_or(DEFAULT_MAX_CHARS)))
  })
  .await
}

fn read_result(path: String, name: String, size: u64, text: read::FileText, max_chars: usize) -> ReadResult {
  let total_chars = text.content.chars().count();
  let truncated = total_chars > max_chars;
  let content = if truncated { text.content.chars().take(max_chars).collect() } else { text.content };
  ReadResult { name, path, size, content, truncated, total_chars, format: text.format, encoding: text.encoding }
}

/// 读取拖进对话框的文件的文字（前端拿不到文件在电脑上的位置，只能把内容发过来）。
/// 请求体为文件内容的原始字节；文件名（URL 编码）与最多返回的字数放在请求头 x-file-name、x-max-chars 中
#[tauri::command]
pub async fn files_extract_bytes(request: tauri::ipc::Request<'_>) -> Result<ReadResult, String> {
  let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
    return Err("需要发送文件的内容".into());
  };
  let header = |name: &str| request.headers().get(name).and_then(|value| value.to_str().ok()).map(str::to_string);
  let (name, max_chars) = (header("x-file-name"), header("x-max-chars"));
  let bytes = bytes.clone();
  blocking(move || extract_bytes(name.as_deref(), max_chars.as_deref(), &bytes)).await
}

/// files_extract_bytes 的处理：name 为 URL 编码的文件名（只保留文件名，用来判断文件类型），max_chars 为最多返回的字数
fn extract_bytes(name: Option<&str>, max_chars: Option<&str>, bytes: &[u8]) -> Result<ReadResult, String> {
  let name = name.map(pdf::percent_decode).ok_or("缺少文件名")?;
  let name = name.rsplit(['/', '\\']).next().unwrap_or_default().to_string();
  let max_chars = max_chars.and_then(|value| value.parse().ok()).unwrap_or(DEFAULT_MAX_CHARS);
  if bytes.len() > MAX_EXTRACT_BYTES {
    return Err(format!("文件太大（超过 {} MB）", MAX_EXTRACT_BYTES >> 20));
  }
  let text = read::read_bytes(&name, bytes)?;
  Ok(read_result(String::new(), name, bytes.len() as u64, text, max_chars))
}

/// 「音频理解」读取授权文件夹中的音频文件：原样返回字节（前端收到 ArrayBuffer），最大 max_bytes
#[tauri::command]
pub async fn files_read_bytes(roots: Vec<String>, path: String, max_bytes: u64) -> Result<tauri::ipc::Response, String> {
  blocking(move || {
    let path = Roots::new(&roots)?.resolve(&path)?;
    if path.is_dir() {
      return Err(format!("{} 是文件夹", path.display()));
    }
    let size = path.metadata().map(|m| m.len()).map_err(|e| e.to_string())?;
    if size > max_bytes {
      return Err(format!("文件太大（{} MB，最大 {} MB）", size / 1024 / 1024, max_bytes / 1024 / 1024));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("读取 {} 失败：{e}", path.display()))?;
    Ok(tauri::ipc::Response::new(bytes))
  })
  .await
}

/// 生成整理计划（不会移动文件）
#[tauri::command]
pub async fn files_plan_organize(
  roots: Vec<String>,
  folder: String,
  by: OrganizeBy,
  utc_offset_minutes: Option<i64>,
) -> Result<Vec<FileMove>, String> {
  blocking(move || ops::plan_organize(&Roots::new(&roots)?, &folder, by, utc_offset_minutes.unwrap_or(0))).await
}

/// 执行移动，目标重名时自动加上编号；返回实际完成与失败的移动
#[tauri::command]
pub async fn files_move(roots: Vec<String>, moves: Vec<FileMove>) -> Result<MoveReport, String> {
  blocking(move || Ok(ops::apply_moves(&Roots::new(&roots)?, &moves))).await
}

#[tauri::command]
pub async fn files_create_folder(roots: Vec<String>, path: String) -> Result<String, String> {
  blocking(move || ops::create_folder(&Roots::new(&roots)?, &path)).await
}

/// 修改文件前备份原文件的位置
fn backup_dir(app: &AppHandle) -> Result<PathBuf, String> {
  app.path().app_data_dir().map(|dir| dir.join("file-backups")).map_err(|e| format!("找不到应用数据目录：{e}"))
}

/// 生成写入预览（不会改动文件）
#[tauri::command]
pub async fn files_preview_write(roots: Vec<String>, request: WriteRequest) -> Result<WritePreview, String> {
  blocking(move || write::preview(&Roots::new(&roots)?, &request)).await
}

/// 写入文件；expected_hash 为预览时原文件的哈希，文件在这期间被改动过时不写入
#[tauri::command]
pub async fn files_write(
  app: AppHandle,
  roots: Vec<String>,
  request: WriteRequest,
  expected_hash: Option<String>,
) -> Result<WriteResult, String> {
  let dir = backup_dir(&app)?;
  blocking(move || write::apply(&Roots::new(&roots)?, &request, expected_hash.as_deref(), &dir)).await
}

/// 撤销一次写入：恢复原内容，新建的文件则删除，被脚本删除的文件（after_hash 为空）从备份恢复；文件之后又被改动过时不撤销
#[tauri::command]
pub async fn files_undo_write(
  app: AppHandle,
  roots: Vec<String>,
  path: String,
  backup_id: Option<String>,
  after_hash: Option<String>,
) -> Result<(), String> {
  let dir = backup_dir(&app)?;
  blocking(move || write::undo(&Roots::new(&roots)?, &path, backup_id.as_deref(), after_hash.as_deref(), &dir)).await
}

/// 运行脚本前检查它会新建或修改的文件：在授权的文件夹内、没有被其他程序打开（不会改动文件）
#[tauri::command]
pub async fn files_check_targets(roots: Vec<String>, paths: Vec<String>) -> Result<Vec<TargetInfo>, String> {
  blocking(move || write::check_targets(&Roots::new(&roots)?, &paths)).await
}

/// 运行脚本前备份它会修改的文件
#[tauri::command]
pub async fn files_snapshot_targets(app: AppHandle, roots: Vec<String>, paths: Vec<String>) -> Result<Vec<TargetSnapshot>, String> {
  let dir = backup_dir(&app)?;
  blocking(move || write::snapshot_targets(&Roots::new(&roots)?, &paths, &dir)).await
}

/// 运行脚本后对比文件，返回改动；没有变化的文件删除备份
#[tauri::command]
pub async fn files_settle_targets(app: AppHandle, roots: Vec<String>, snapshots: Vec<TargetSnapshot>) -> Result<Vec<TargetChange>, String> {
  let dir = backup_dir(&app)?;
  blocking(move || Ok(write::settle_targets(&Roots::new(&roots)?, &snapshots, &dir))).await
}

/// 本机可以用来新建与修改 Office 文件的方式：Microsoft Office 程序与 Python 库
#[tauri::command]
pub async fn office_support() -> Result<OfficeSupport, String> {
  blocking(|| Ok(script::office_support())).await
}

/// 把 HTML 打印成 PDF（前端在调用前已经征得用户同意，并备份了要覆盖的文件）
#[tauri::command]
pub async fn pdf_print_html(roots: Vec<String>, request: PrintRequest) -> Result<PrintResult, String> {
  blocking(move || pdf::print_html(&Roots::new(&roots)?, &request)).await
}

/// 检查按页重新组合 PDF 的计划：每个新文件由哪些页面组成（不会改动文件）
#[tauri::command]
pub async fn pdf_plan_compose(roots: Vec<String>, outputs: Vec<PdfOutput>) -> Result<Vec<OutputPlan>, String> {
  blocking(move || pdf::plan_compose(&Roots::new(&roots)?, &outputs)).await
}

/// 按页重新组合 PDF：合并、拆分、提取、删除、调整顺序、旋转页面（前端在调用前已经征得用户同意）
#[tauri::command]
pub async fn pdf_compose(roots: Vec<String>, outputs: Vec<PdfOutput>) -> Result<Vec<OutputResult>, String> {
  blocking(move || pdf::compose(&Roots::new(&roots)?, &outputs)).await
}

/// 自动检查生成的 Office 文件，返回发现的问题（目前检查演示文稿）；不支持检查的类型返回空列表
#[tauri::command]
pub async fn office_check(roots: Vec<String>, path: String) -> Result<Vec<office_check::QualityIssue>, String> {
  blocking(move || office_check::check_file(&Roots::new(&roots)?.resolve(&path)?)).await
}

/// 本机可用的脚本解释器
#[tauri::command]
pub async fn script_runtimes() -> Result<Vec<Runtime>, String> {
  blocking(|| Ok(script::runtimes())).await
}

/// 检查脚本能否运行，返回展示给用户确认的命令与脚本内容（不会运行脚本）
#[tauri::command]
pub async fn script_inspect(roots: Vec<String>, request: RunRequest) -> Result<ScriptInfo, String> {
  blocking(move || script::inspect(&Roots::new(&roots)?, &request)).await
}

/// 运行脚本（前端在调用前已经征得用户同意），等待结束后返回输出
#[tauri::command]
pub async fn script_run(roots: Vec<String>, request: RunRequest) -> Result<RunResult, String> {
  blocking(move || script::run(&Roots::new(&roots)?, &request)).await
}

/// 检查一段代码能否运行，返回展示给用户确认的命令与完整代码（不会运行）
#[tauri::command]
pub async fn script_inspect_code(roots: Vec<String>, request: CodeRequest) -> Result<ScriptInfo, String> {
  blocking(move || script::inspect_code(&Roots::new(&roots)?, &request)).await
}

/// 直接运行一段代码（前端在调用前已经征得用户同意），不写入用户的文件夹
#[tauri::command]
pub async fn script_run_code(roots: Vec<String>, request: CodeRequest) -> Result<RunResult, String> {
  blocking(move || script::run_code(&Roots::new(&roots)?, &request)).await
}

/// 取消正在运行的脚本，结束它启动的所有进程
#[tauri::command]
pub fn script_cancel(run_id: String) -> bool {
  script::cancel(&run_id)
}

/// 在系统的文件管理器中显示文件（不会打开或运行它）
#[tauri::command]
pub fn files_reveal(app: AppHandle, roots: Vec<String>, path: String) -> Result<(), String> {
  let path = Roots::new(&roots)?.resolve(&path)?;
  app.opener().reveal_item_in_dir(path).map_err(|e| format!("无法打开文件夹：{e}"))
}

/// 用系统浏览器打开网址（只允许 http 与 https）
#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> Result<(), String> {
  let parsed = Url::parse(&url).map_err(|_| format!("无效的网址：{url}"))?;
  if !matches!(parsed.scheme(), "http" | "https") {
    return Err(format!("只能打开网页链接：{url}"));
  }
  app.opener().open_url(parsed.as_str(), None::<&str>).map_err(|e| format!("无法打开链接：{e}"))
}

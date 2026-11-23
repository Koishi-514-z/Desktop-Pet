//! 文件操作：查找、列出、整理计划与移动。所有路径都必须位于授权文件夹内

use std::{
  fs,
  path::{Path, PathBuf},
  time::{Duration, Instant, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use super::read::{decode, TEXT_EXTENSIONS};
use super::roots::Roots;

/// 查找时最多检查的文件数量、目录深度与耗时
const MAX_SCANNED: usize = 50_000;
const MAX_DEPTH: usize = 12;
const SEARCH_TIMEOUT: Duration = Duration::from_secs(5);
/// 按内容查找时，单个文件与总共最多读取的字节数
const MAX_CONTENT_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CONTENT_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

/// 查找时跳过的目录（依赖、缓存、版本库、系统目录）
const SKIP_DIRS: &[&str] = &[
  "node_modules", "__pycache__", "target", "$recycle.bin", "system volume information", "appdata", ".git", ".svn",
  ".cache", ".venv", "venv",
];

/// 整理时不移动的文件（快捷方式与系统文件）
const KEEP_FILES: &[&str] = &["desktop.ini", "thumbs.db", ".ds_store"];
const KEEP_EXTENSIONS: &[&str] = &["lnk", "url", "webloc"];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
  pub path: String,
  pub name: String,
  pub is_dir: bool,
  pub size: u64,
  /// 修改时间，毫秒时间戳
  pub modified_at: Option<i64>,
  /// 小写的扩展名，不含点
  pub extension: String,
}

impl FileEntry {
  fn from_path(path: &Path, metadata: &fs::Metadata) -> Self {
    Self {
      path: path.display().to_string(),
      name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
      is_dir: metadata.is_dir(),
      size: if metadata.is_dir() { 0 } else { metadata.len() },
      modified_at: metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64),
      extension: extension_of(path),
    }
  }
}

fn extension_of(path: &Path) -> String {
  path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

fn is_hidden(name: &str) -> bool {
  name.starts_with('.') || name.starts_with('~')
}

fn default_limit() -> usize {
  50
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
  /// 在这些文件夹中查找（必须位于授权文件夹内），为空时查找所有授权文件夹
  #[serde(default)]
  pub folders: Vec<String>,
  /// 文件名需要包含的所有关键词（不区分大小写）
  #[serde(default)]
  pub keywords: Vec<String>,
  /// 文件类型（扩展名，不含点）
  #[serde(default)]
  pub extensions: Vec<String>,
  /// 文件内容需要包含的文字（只检查文本文件）
  #[serde(default)]
  pub contains: Option<String>,
  #[serde(default)]
  pub modified_after: Option<i64>,
  #[serde(default)]
  pub modified_before: Option<i64>,
  #[serde(default)]
  pub min_size: Option<u64>,
  #[serde(default)]
  pub max_size: Option<u64>,
  /// 是否也查找文件夹
  #[serde(default)]
  pub include_dirs: bool,
  #[serde(default = "default_limit")]
  pub limit: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
  /// 按修改时间从新到旧
  pub entries: Vec<FileEntry>,
  /// 检查过的文件与文件夹数量
  pub scanned: usize,
  /// 是否因为数量、深度或耗时的限制没有查找完
  pub truncated: bool,
}

/// 在授权文件夹中查找文件
pub fn search(roots: &Roots, request: &SearchRequest) -> Result<SearchResult, String> {
  let folders: Vec<PathBuf> = if request.folders.is_empty() {
    roots.paths().to_vec()
  } else {
    request.folders.iter().map(|folder| roots.resolve(folder)).collect::<Result<_, _>>()?
  };

  let keywords: Vec<String> = request.keywords.iter().map(|k| k.trim().to_lowercase()).filter(|k| !k.is_empty()).collect();
  let extensions: Vec<String> = request
    .extensions
    .iter()
    .map(|e| e.trim().trim_start_matches('.').to_lowercase())
    .filter(|e| !e.is_empty())
    .collect();
  let contains = request.contains.as_deref().map(str::trim).filter(|c| !c.is_empty()).map(str::to_lowercase);

  let started = Instant::now();
  let mut entries = Vec::new();
  let mut scanned = 0;
  let mut truncated = false;
  let mut content_bytes = 0u64;
  let mut stack: Vec<(PathBuf, usize)> = folders.into_iter().map(|folder| (folder, 0)).collect();
  let mut visited = std::collections::HashSet::new();

  while let Some((dir, depth)) = stack.pop() {
    if !visited.insert(dir.clone()) {
      continue;
    }
    let Ok(read_dir) = fs::read_dir(&dir) else { continue };
    for item in read_dir.flatten() {
      scanned += 1;
      if scanned > MAX_SCANNED || started.elapsed() > SEARCH_TIMEOUT {
        truncated = true;
        break;
      }
      let name = item.file_name().to_string_lossy().into_owned();
      // 不跟随符号链接，避免跳出授权文件夹或陷入循环
      let Ok(file_type) = item.file_type() else { continue };
      if file_type.is_symlink() || is_hidden(&name) {
        continue;
      }
      let path = item.path();
      if file_type.is_dir() {
        if SKIP_DIRS.contains(&name.to_lowercase().as_str()) {
          continue;
        }
        if depth + 1 < MAX_DEPTH {
          stack.push((path.clone(), depth + 1));
        } else {
          truncated = true;
        }
        if !request.include_dirs {
          continue;
        }
      }

      let lower_name = name.to_lowercase();
      if !keywords.iter().all(|keyword| lower_name.contains(keyword)) {
        continue;
      }
      let Ok(metadata) = item.metadata() else { continue };
      let entry = FileEntry::from_path(&path, &metadata);
      if !extensions.is_empty() && !extensions.contains(&entry.extension) {
        continue;
      }
      if let Some(after) = request.modified_after {
        if entry.modified_at.is_none_or(|modified| modified < after) {
          continue;
        }
      }
      if let Some(before) = request.modified_before {
        if entry.modified_at.is_none_or(|modified| modified > before) {
          continue;
        }
      }
      if request.min_size.is_some_and(|min| entry.size < min) || request.max_size.is_some_and(|max| entry.size > max) {
        continue;
      }
      if let Some(text) = &contains {
        if entry.is_dir || !TEXT_EXTENSIONS.contains(&entry.extension.as_str()) || entry.size > MAX_CONTENT_FILE_BYTES {
          continue;
        }
        if content_bytes + entry.size > MAX_CONTENT_TOTAL_BYTES {
          truncated = true;
          continue;
        }
        content_bytes += entry.size;
        let matched = fs::read(&path)
          .ok()
          .and_then(|bytes| decode(&bytes))
          .is_some_and(|(content, _)| content.to_lowercase().contains(text.as_str()));
        if !matched {
          continue;
        }
      }
      entries.push(entry);
    }
    if truncated && (scanned > MAX_SCANNED || started.elapsed() > SEARCH_TIMEOUT) {
      break;
    }
  }

  entries.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
  if entries.len() > request.limit {
    entries.truncate(request.limit);
    truncated = true;
  }
  Ok(SearchResult { entries, scanned, truncated })
}

/// 列出文件夹中的内容：文件夹在前，再按名称排序
pub fn list(roots: &Roots, folder: &str, limit: usize) -> Result<(Vec<FileEntry>, usize), String> {
  let folder = roots.resolve(folder)?;
  if !folder.is_dir() {
    return Err(format!("{} 不是文件夹", folder.display()));
  }
  let mut entries: Vec<FileEntry> = fs::read_dir(&folder)
    .map_err(|e| format!("无法读取文件夹：{e}"))?
    .flatten()
    .filter(|item| !is_hidden(&item.file_name().to_string_lossy()))
    .filter_map(|item| {
      let file_type = item.file_type().ok()?;
      if file_type.is_symlink() {
        return None;
      }
      Some(FileEntry::from_path(&item.path(), &item.metadata().ok()?))
    })
    .collect();
  let total = entries.len();
  entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
  entries.truncate(limit);
  Ok((entries, total))
}

// ===== 整理 =====

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrganizeBy {
  /// 按文件类型分到「图片」「文档」等文件夹
  Type,
  /// 按修改月份分到「2026-11」这样的文件夹
  Month,
  /// 按扩展名分到「PDF」「JPG」这样的文件夹
  Extension,
}

/// 一次移动
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMove {
  pub from: String,
  pub to: String,
}

/// 文件类型对应的文件夹名
pub fn category_of(extension: &str) -> &'static str {
  match extension {
    "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "heic" | "heif" | "svg" | "tif" | "tiff" | "ico" | "raw"
    | "psd" => "图片",
    "pdf" | "doc" | "docx" | "txt" | "md" | "rtf" | "odt" | "wps" | "pages" => "文档",
    "xls" | "xlsx" | "csv" | "ods" | "et" | "numbers" => "表格",
    "ppt" | "pptx" | "key" | "odp" | "dps" => "演示文稿",
    "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "tgz" => "压缩包",
    "mp3" | "wav" | "flac" | "aac" | "ogg" | "m4a" | "wma" | "ape" => "音频",
    "mp4" | "mkv" | "avi" | "mov" | "wmv" | "flv" | "webm" | "m4v" | "rmvb" => "视频",
    "exe" | "msi" | "dmg" | "pkg" | "deb" | "rpm" | "apk" | "appx" | "msix" => "安装程序",
    "js" | "ts" | "py" | "java" | "c" | "cpp" | "h" | "cs" | "go" | "rs" | "html" | "css" | "json" | "xml" | "yml"
    | "yaml" | "sh" | "bat" | "ps1" | "ipynb" | "sql" | "vue" => "代码",
    "epub" | "mobi" | "azw3" => "电子书",
    "ttf" | "otf" | "woff" | "woff2" => "字体",
    _ => "其他",
  }
}

/// 把毫秒时间戳（已加上时区偏移）换算为「年-月」
fn year_month(timestamp: i64) -> String {
  // Howard Hinnant 的 civil_from_days 算法
  let days = timestamp.div_euclid(86_400_000);
  let z = days + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z - era * 146_097;
  let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let month = if mp < 10 { mp + 3 } else { mp - 9 };
  let year = yoe + era * 400 + i64::from(month <= 2);
  format!("{year}-{month:02}")
}

/// 生成整理计划：把文件夹中直接包含的文件（不含子文件夹中的）按规则分到子文件夹中
pub fn plan_organize(roots: &Roots, folder: &str, by: OrganizeBy, utc_offset_minutes: i64) -> Result<Vec<FileMove>, String> {
  let folder = roots.resolve(folder)?;
  if !folder.is_dir() {
    return Err(format!("{} 不是文件夹", folder.display()));
  }

  let mut moves = Vec::new();
  for item in fs::read_dir(&folder).map_err(|e| format!("无法读取文件夹：{e}"))?.flatten() {
    let name = item.file_name().to_string_lossy().into_owned();
    let Ok(file_type) = item.file_type() else { continue };
    if !file_type.is_file() || is_hidden(&name) || KEEP_FILES.contains(&name.to_lowercase().as_str()) {
      continue;
    }
    let path = item.path();
    let extension = extension_of(&path);
    if KEEP_EXTENSIONS.contains(&extension.as_str()) {
      continue;
    }
    let group = match by {
      OrganizeBy::Type => category_of(&extension).to_string(),
      OrganizeBy::Extension if extension.is_empty() => "无扩展名".to_string(),
      OrganizeBy::Extension => extension.to_uppercase(),
      OrganizeBy::Month => {
        let modified = item
          .metadata()
          .ok()
          .and_then(|m| m.modified().ok())
          .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
          .map(|duration| duration.as_millis() as i64)
          .unwrap_or(0);
        year_month(modified + utc_offset_minutes * 60_000)
      }
    };
    moves.push(FileMove { from: path.display().to_string(), to: folder.join(group).join(&name).display().to_string() });
  }
  moves.sort_by(|a, b| a.to.cmp(&b.to));
  Ok(moves)
}

// ===== 移动 =====

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveFailure {
  pub from: String,
  pub error: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveReport {
  /// 实际完成的移动（目标重名时会加上编号）
  pub moved: Vec<FileMove>,
  pub failed: Vec<MoveFailure>,
}

/// 目标已存在时加上编号：报告.pdf → 报告 (1).pdf
fn unique_path(path: &Path) -> PathBuf {
  if !path.exists() {
    return path.to_path_buf();
  }
  let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
  let extension = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
  (1..)
    .map(|n| path.with_file_name(format!("{stem} ({n}){extension}")))
    .find(|candidate| !candidate.exists())
    .unwrap_or_else(|| path.to_path_buf())
}

fn move_one(roots: &Roots, item: &FileMove) -> Result<FileMove, String> {
  let from = roots.resolve(&item.from)?;
  let to = roots.resolve_new(&item.to)?;
  if from == to {
    return Err("目标与原位置相同".into());
  }
  if to.starts_with(&from) {
    return Err("不能把文件夹移动到它自己里面".into());
  }
  let parent = to.parent().ok_or("无效的目标路径")?;
  fs::create_dir_all(parent).map_err(|e| format!("无法创建文件夹：{e}"))?;
  let to = unique_path(&to);

  if fs::rename(&from, &to).is_err() {
    // 跨磁盘移动文件时 rename 会失败，改为复制后删除原文件
    if !from.is_file() {
      return Err("无法移动（文件可能正在被使用）".into());
    }
    fs::copy(&from, &to).map_err(|e| format!("无法移动：{e}"))?;
    if let Err(error) = fs::remove_file(&from) {
      let _ = fs::remove_file(&to);
      return Err(format!("无法移动（文件可能正在被使用）：{error}"));
    }
  }
  Ok(FileMove { from: from.display().to_string(), to: to.display().to_string() })
}

/// 依次执行移动，单个失败不影响其他
pub fn apply_moves(roots: &Roots, moves: &[FileMove]) -> MoveReport {
  let mut report = MoveReport { moved: Vec::new(), failed: Vec::new() };
  for item in moves {
    match move_one(roots, item) {
      Ok(done) => report.moved.push(done),
      Err(error) => report.failed.push(MoveFailure { from: item.from.clone(), error }),
    }
  }
  report
}

/// 新建文件夹（已存在时直接返回）
pub fn create_folder(roots: &Roots, path: &str) -> Result<String, String> {
  let path = roots.resolve_new(path)?;
  fs::create_dir_all(&path).map_err(|e| format!("无法创建文件夹：{e}"))?;
  Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
  use super::year_month;

  #[test]
  fn converts_timestamps_to_months() {
    assert_eq!(year_month(0), "1970-01");
    // 2026-11-23 12:00 UTC
    assert_eq!(year_month(1_795_435_200_000), "2026-11");
    // 2024-02-29（闰日）
    assert_eq!(year_month(1_709_164_800_000), "2024-02");
    assert_eq!(year_month(1_709_251_199_000), "2024-02");
    assert_eq!(year_month(1_709_251_200_000), "2024-03");
  }
}

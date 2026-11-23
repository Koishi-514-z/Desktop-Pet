//! 授权文件夹：所有文件操作都只能在用户授权的文件夹内进行

use std::path::{Component, Path, PathBuf};

/// 不允许授权的系统目录（小写，按路径前缀匹配）
#[cfg(windows)]
const SYSTEM_DIRS: &[&str] = &["windows", "program files", "program files (x86)", "programdata"];
#[cfg(not(windows))]
const SYSTEM_DIRS: &[&str] = &["system", "library", "usr", "bin", "sbin", "etc", "var", "private", "dev", "proc", "boot"];

/// 用户授权的文件夹（已规范化）
#[derive(Debug, Clone)]
pub struct Roots(Vec<PathBuf>);

impl Roots {
  /// 规范化授权文件夹，跳过不存在的；一个可用的都没有时报错
  pub fn new(roots: &[String]) -> Result<Self, String> {
    let roots: Vec<PathBuf> = roots
      .iter()
      .filter_map(|root| dunce::canonicalize(root).ok())
      .filter(|root| root.is_dir())
      .collect();
    if roots.is_empty() {
      return Err("还没有授权任何可访问的文件夹，请在 设置 → 工具 中添加".into());
    }
    Ok(Self(roots))
  }

  pub fn paths(&self) -> &[PathBuf] {
    &self.0
  }

  pub fn contains(&self, path: &Path) -> bool {
    self.0.iter().any(|root| path.starts_with(root))
  }

  /// 解析已存在的路径：规范化（解析符号链接）后必须位于某个授权文件夹内
  pub fn resolve(&self, path: &str) -> Result<PathBuf, String> {
    let raw = Path::new(path.trim());
    if !raw.is_absolute() {
      return Err(format!("请使用完整路径：{path}"));
    }
    let resolved = dunce::canonicalize(raw).map_err(|_| format!("找不到 {path}"))?;
    if !self.contains(&resolved) {
      return Err(format!("{path} 不在授权访问的文件夹内"));
    }
    Ok(resolved)
  }

  /// 解析可能还不存在的路径（如移动的目标）：不能包含 ..，最近的已存在上级目录必须位于授权文件夹内
  pub fn resolve_new(&self, path: &str) -> Result<PathBuf, String> {
    let raw = Path::new(path.trim());
    if !raw.is_absolute() {
      return Err(format!("请使用完整路径：{path}"));
    }
    if raw.components().any(|component| matches!(component, Component::ParentDir)) {
      return Err(format!("路径中不能包含 ..：{path}"));
    }

    // 找到最近的已存在的上级目录，规范化后再拼接剩余部分
    let mut existing = raw.to_path_buf();
    let mut rest = Vec::new();
    while !existing.exists() {
      let name = existing.file_name().ok_or_else(|| format!("无效的路径：{path}"))?.to_os_string();
      rest.push(name);
      existing = existing.parent().ok_or_else(|| format!("无效的路径：{path}"))?.to_path_buf();
    }
    let mut resolved = dunce::canonicalize(&existing).map_err(|_| format!("无效的路径：{path}"))?;
    for name in rest.into_iter().rev() {
      resolved.push(name);
    }

    if !self.contains(&resolved) {
      return Err(format!("{path} 不在授权访问的文件夹内"));
    }
    Ok(resolved)
  }
}

/// 检查一个文件夹能否被授权：必须存在，不能是磁盘根目录或系统目录
pub fn validate_root(path: &str) -> Result<PathBuf, String> {
  let resolved = dunce::canonicalize(path.trim()).map_err(|_| format!("找不到文件夹 {path}"))?;
  if !resolved.is_dir() {
    return Err(format!("{path} 不是文件夹"));
  }
  if resolved.parent().is_none() {
    return Err("不能授权整个磁盘，请选择具体的文件夹".into());
  }

  // 磁盘根目录下的第一级目录（如 C:\Windows、/usr）
  let first = resolved
    .components()
    .find_map(|component| match component {
      Component::Normal(name) => Some(name.to_string_lossy().to_lowercase()),
      _ => None,
    })
    .unwrap_or_default();
  if SYSTEM_DIRS.contains(&first.as_str()) {
    return Err(format!("不能授权系统目录 {}", resolved.display()));
  }
  Ok(resolved)
}

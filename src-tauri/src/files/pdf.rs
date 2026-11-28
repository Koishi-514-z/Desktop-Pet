//! PDF：把 HTML 打印成 PDF（无界面运行本机的 Edge / Chrome，不需要 Office），
//! 以及按页重新组合 PDF（合并、拆分、提取、删除、调整顺序、旋转页面）。
//!
//! 生成 PDF 时 HTML 由 LLM 编写，可能受到文档内容的影响，因此：
//! - 只允许内联的样式与 data: 图片（内容安全策略），不运行脚本，并通过不存在的代理切断网络，避免把内容发送出去；
//! - HTML 中引用的本机图片（file:/// 网址）必须位于授权的文件夹内，生成前转成 data: 内联。

use std::{
  collections::{HashMap, HashSet},
  fs,
  path::{Path, PathBuf},
  process::{Command, Stdio},
  sync::atomic::Ordering,
  thread,
  time::{Duration, Instant},
};

use base64::Engine;
use lopdf::{Dictionary, Document, Object, ObjectId};
use serde::{Deserialize, Serialize};

use super::roots::Roots;
use super::script::{find_in_path, kill_tree, Registration};

/// HTML 的最大长度（字符）
const MAX_HTML_CHARS: usize = 400_000;
/// 内联的单个图片与全部图片的最大大小
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_IMAGES_BYTES: u64 = 60 * 1024 * 1024;
/// 打印 PDF 默认与最长的等待时间（秒）
const DEFAULT_PRINT_TIMEOUT: u64 = 60;
const MAX_PRINT_TIMEOUT: u64 = 300;
/// 重新组合时：输入的 PDF 的最大大小、一次最多生成的文件数、每个文件最多由几部分组成、最多多少页
const MAX_INPUT_BYTES: u64 = 200 * 1024 * 1024;
const MAX_OUTPUTS: usize = 20;
const MAX_PARTS: usize = 50;
const MAX_OUTPUT_PAGES: usize = 5000;

/// 加在 HTML 前面的内容：内容安全策略（只允许内联样式与 data: 图片、字体，禁止脚本与网络请求），
/// 以及默认的纸张（A4）、页边距、中文字体，打印背景色。HTML 中自己的样式写在后面，会覆盖这些默认值
const HTML_PREAMBLE: &str = concat!(
  "<!DOCTYPE html>\n",
  "<meta charset=\"utf-8\">\n",
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:\">\n",
  "<style>@page{size:A4;margin:16mm 15mm}",
  "html{-webkit-print-color-adjust:exact;print-color-adjust:exact}",
  "body{margin:0;font-family:\"Microsoft YaHei\",\"PingFang SC\",\"Noto Sans CJK SC\",sans-serif;line-height:1.6}</style>\n",
);

// ===== 浏览器 =====

/// 本机用来打印 PDF 的浏览器：Edge（Windows 自带）优先，其次 Chrome / Chromium
pub fn find_browser() -> Option<(PathBuf, &'static str)> {
  let mut candidates: Vec<(PathBuf, &'static str)> = Vec::new();
  #[cfg(windows)]
  for variable in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
    if let Some(dir) = std::env::var_os(variable).map(PathBuf::from) {
      candidates.push((dir.join(r"Microsoft\Edge\Application\msedge.exe"), "Microsoft Edge"));
      candidates.push((dir.join(r"Google\Chrome\Application\chrome.exe"), "Google Chrome"));
    }
  }
  #[cfg(target_os = "macos")]
  {
    candidates.push(("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge".into(), "Microsoft Edge"));
    candidates.push(("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".into(), "Google Chrome"));
  }
  if let Some(found) = candidates.into_iter().find(|(path, _)| path.is_file()) {
    return Some(found);
  }
  for (names, label) in [
    (&["msedge", "microsoft-edge"][..], "Microsoft Edge"),
    (&["chrome", "google-chrome"][..], "Google Chrome"),
    (&["chromium", "chromium-browser"][..], "Chromium"),
  ] {
    if let Some(path) = find_in_path(names) {
      return Some((path, label));
    }
  }
  None
}

/// 本机用来打印 PDF 的浏览器名称
pub fn browser_name() -> Option<&'static str> {
  find_browser().map(|(_, name)| name)
}

// ===== HTML 转 PDF =====

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintRequest {
  /// 运行 id，用于取消
  pub run_id: String,
  /// 要生成的 PDF 的完整路径
  pub path: String,
  pub html: String,
  pub timeout_seconds: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintResult {
  pub path: String,
  pub pages: usize,
  pub size: u64,
  pub browser: &'static str,
  pub duration_ms: u64,
  pub cancelled: bool,
  pub timed_out: bool,
}

fn image_media_type(path: &Path) -> Option<&'static str> {
  let extension = path.extension()?.to_string_lossy().to_lowercase();
  Some(match extension.as_str() {
    "png" => "image/png",
    "jpg" | "jpeg" => "image/jpeg",
    "gif" => "image/gif",
    "webp" => "image/webp",
    "bmp" => "image/bmp",
    "svg" => "image/svg+xml",
    "ico" => "image/x-icon",
    _ => return None,
  })
}

/// 解码网址中的 %XX
pub(super) fn percent_decode(text: &str) -> String {
  let bytes = text.as_bytes();
  let hex = |byte: u8| (byte as char).to_digit(16).map(|value| value as u8);
  let mut output = Vec::with_capacity(bytes.len());
  let mut index = 0;
  while index < bytes.len() {
    if bytes[index] == b'%'
      && index + 2 < bytes.len()
      && let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2]))
    {
      output.push(high * 16 + low);
      index += 3;
      continue;
    }
    output.push(bytes[index]);
    index += 1;
  }
  String::from_utf8_lossy(&output).into_owned()
}

/// file:/// 网址对应的本机路径
fn file_url_path(url: &str) -> String {
  let path = percent_decode(&url["file:///".len()..]);
  let path = path.split(['?', '#']).next().unwrap_or_default().to_string();
  if cfg!(windows) {
    path.replace('/', "\\")
  }
  else {
    format!("/{path}")
  }
}

/// 网址在 HTML 中结束的位置（引号、括号、空白、尖括号）
fn url_end(text: &str, start: usize) -> usize {
  text[start..]
    .find(|c: char| matches!(c, '"' | '\'' | '(' | ')' | '<' | '>' | '`') || c.is_whitespace())
    .map_or(text.len(), |offset| start + offset)
}

/// 准备交给浏览器的 HTML：检查内容，把引用的本机图片转为 data: 内联，加上内容安全策略与默认样式
pub fn prepare_html(roots: &Roots, html: &str) -> Result<String, String> {
  if html.trim().is_empty() {
    return Err("HTML 是空的".into());
  }
  if html.chars().count() > MAX_HTML_CHARS {
    return Err(format!("HTML 太长（超过 {MAX_HTML_CHARS} 字），请分成几个文件生成后再合并"));
  }
  // 只做 ASCII 小写转换，字节位置与原文一致
  let lowered = html.to_ascii_lowercase();
  if lowered.contains("http-equiv") {
    return Err("HTML 中不能使用 <meta http-equiv>".into());
  }

  let mut output = String::with_capacity(html.len());
  let mut cursor = 0;
  let mut total = 0u64;
  let mut inlined: HashMap<String, String> = HashMap::new();
  while let Some(offset) = lowered[cursor..].find("file:///") {
    let start = cursor + offset;
    let end = url_end(html, start);
    let url = &html[start..end];
    output.push_str(&html[cursor..start]);
    if let Some(data) = inlined.get(url) {
      output.push_str(data);
    }
    else {
      let raw = file_url_path(url);
      let path = roots.resolve(&raw).map_err(|error| format!("HTML 中引用的图片 {raw}：{error}"))?;
      let media_type = image_media_type(&path).ok_or_else(|| format!("HTML 中只能引用图片文件：{}", path.display()))?;
      let size = fs::metadata(&path).map_err(|e| format!("读取图片 {} 失败：{e}", path.display()))?.len();
      total += size;
      if size > MAX_IMAGE_BYTES || total > MAX_IMAGES_BYTES {
        return Err(format!("引用的图片太大（单个最大 {} MB，合计最大 {} MB）", MAX_IMAGE_BYTES >> 20, MAX_IMAGES_BYTES >> 20));
      }
      let bytes = fs::read(&path).map_err(|e| format!("读取图片 {} 失败：{e}", path.display()))?;
      let data = format!("data:{media_type};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes));
      output.push_str(&data);
      inlined.insert(url.to_string(), data);
    }
    cursor = end;
  }
  output.push_str(&html[cursor..]);

  // 去掉 HTML 自己的 <!DOCTYPE>，统一放在最前面；内容安全策略必须出现在任何内容之前
  let body = output.trim_start();
  let body = if body.len() >= 9 && body[..9].eq_ignore_ascii_case("<!doctype") {
    body.find('>').map_or("", |end| &body[end + 1..])
  }
  else {
    body
  };
  Ok(format!("{HTML_PREAMBLE}{body}"))
}

/// 临时文件夹，用完自动删除
struct TempDir(PathBuf);

impl TempDir {
  fn create(run_id: &str) -> Result<Self, String> {
    let name: String = run_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(64).collect();
    let dir = std::env::temp_dir().join("desktop-pet-pdf").join(if name.is_empty() { "print" } else { &name });
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("profile")).map_err(|e| format!("无法创建临时文件夹：{e}"))?;
    Ok(Self(dir))
  }
}

impl Drop for TempDir {
  fn drop(&mut self) {
    // 浏览器退出后可能稍晚才释放用户数据文件夹
    for _ in 0..10 {
      if fs::remove_dir_all(&self.0).is_ok() || !self.0.exists() {
        return;
      }
      thread::sleep(Duration::from_millis(200));
    }
  }
}

fn check_pdf_path(roots: &Roots, path: &str) -> Result<PathBuf, String> {
  let resolved = roots.resolve_new(path)?;
  let extension = resolved.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
  if extension != "pdf" {
    return Err(format!("要生成的文件必须是 .pdf：{}", resolved.display()));
  }
  if resolved.is_dir() {
    return Err(format!("{} 是文件夹", resolved.display()));
  }
  Ok(resolved)
}

/// 页数（无法解析时为 0）
fn page_count(bytes: &[u8]) -> usize {
  std::panic::catch_unwind(|| Document::load_mem(bytes).map(|doc| doc.get_pages().len()).unwrap_or(0)).unwrap_or(0)
}

fn write_output(path: &Path, bytes: &[u8]) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| format!("无法创建文件夹 {}：{e}", parent.display()))?;
  }
  fs::write(path, bytes).map_err(|e| format!("保存 {} 失败：{e}", path.display()))
}

/// 把 HTML 打印成 PDF（前端在调用前已经征得用户同意，并备份了要覆盖的文件）
pub fn print_html(roots: &Roots, request: &PrintRequest) -> Result<PrintResult, String> {
  let target = check_pdf_path(roots, &request.path)?;
  let (browser, browser_name) = find_browser().ok_or("没有找到 Microsoft Edge 或 Google Chrome，无法把 HTML 生成 PDF")?;
  let html = prepare_html(roots, &request.html)?;
  let timeout = Duration::from_secs(request.timeout_seconds.unwrap_or(DEFAULT_PRINT_TIMEOUT).clamp(10, MAX_PRINT_TIMEOUT));

  let (_registration, cancelled_flag) = Registration::new(&request.run_id)?;
  let temp = TempDir::create(&request.run_id)?;
  let page = temp.0.join("page.html");
  let printed = temp.0.join("output.pdf");
  fs::write(&page, html).map_err(|e| format!("无法创建临时文件：{e}"))?;

  let mut command = Command::new(&browser);
  command
    .arg("--headless")
    .args(["--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync"])
    .args(["--disable-background-networking", "--disable-component-update", "--mute-audio"])
    // 所有网络请求都发往不存在的代理（内容安全策略之外的第二道保护）。
    // 脚本由内容安全策略禁止：--blink-settings=scriptEnabled=false 会让无界面打印不输出文件
    .args(["--proxy-server=127.0.0.1:9", "--proxy-bypass-list=<-loopback>"])
    // 独立的用户数据文件夹：不影响用户正在使用的浏览器
    .arg(format!("--user-data-dir={}", temp.0.join("profile").display()))
    // 不在页面上加日期、网址等页眉页脚（新旧两种写法）
    .args(["--no-pdf-header-footer", "--print-to-pdf-no-header"])
    .arg(format!("--print-to-pdf={}", printed.display()))
    .arg(&page)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    command.creation_flags(super::script::CREATE_NO_WINDOW);
  }

  let started = Instant::now();
  let mut child = command.spawn().map_err(|e| format!("无法启动 {browser_name}：{e}"))?;
  let (mut cancelled, mut timed_out) = (false, false);
  let status = loop {
    match child.try_wait() {
      Ok(Some(status)) => break Some(status),
      Ok(None) => {}
      Err(error) => {
        kill_tree(&mut child);
        return Err(format!("等待 {browser_name} 结束时出错：{error}"));
      }
    }
    cancelled = cancelled_flag.load(Ordering::SeqCst);
    timed_out = started.elapsed() >= timeout;
    if cancelled || timed_out {
      kill_tree(&mut child);
      break None;
    }
    thread::sleep(Duration::from_millis(50));
  };
  let duration_ms = started.elapsed().as_millis() as u64;
  if status.is_none() {
    return Ok(PrintResult { path: target.display().to_string(), pages: 0, size: 0, browser: browser_name, duration_ms, cancelled, timed_out });
  }

  let bytes = fs::read(&printed).ok().filter(|bytes| bytes.starts_with(b"%PDF"));
  let Some(bytes) = bytes else {
    let code = status.and_then(|status| status.code()).map_or_else(|| "未知".to_string(), |code| code.to_string());
    return Err(format!("{browser_name} 没有生成 PDF（退出码 {code}），可以稍后再试"));
  };
  write_output(&target, &bytes)?;
  Ok(PrintResult {
    path: target.display().to_string(),
    pages: page_count(&bytes),
    size: bytes.len() as u64,
    browser: browser_name,
    duration_ms,
    cancelled: false,
    timed_out: false,
  })
}

// ===== 按页重新组合 PDF =====

/// 新 PDF 中的一部分：某个 PDF 的若干页
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPart {
  pub path: String,
  /// 页码，如「1-3,5,8-」「10-1」（倒序）；省略时为全部页面
  pub pages: Option<String>,
  /// 顺时针旋转的角度（90 的倍数）
  pub rotate: Option<i64>,
}

/// 要生成的一个 PDF：依次由几部分组成
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfOutput {
  pub path: String,
  pub parts: Vec<PdfPart>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartPlan {
  pub path: String,
  /// 源文件的总页数
  pub total_pages: usize,
  /// 选中的页码（从 1 开始，按新文件中的顺序）
  pub pages: Vec<u32>,
  pub rotate: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputPlan {
  pub path: String,
  pub exists: bool,
  pub pages: usize,
  pub parts: Vec<PartPlan>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputResult {
  pub path: String,
  pub pages: usize,
  pub size: u64,
}

fn name_of(path: &Path) -> String {
  path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// 解析页码：「1-3,5,8-」，「-」也可以写成「~」「–」「至」「到」；end / last 表示最后一页；前一个数大于后一个时倒序
pub fn parse_pages(spec: Option<&str>, total: usize, name: &str) -> Result<Vec<u32>, String> {
  let total_u32 = total as u32;
  let spec = spec.map(str::trim).unwrap_or_default();
  if spec.is_empty() || matches!(spec.to_lowercase().as_str(), "all" | "全部") {
    return Ok((1..=total_u32).collect());
  }
  let number = |text: &str| -> Result<u32, String> {
    let text = text.trim();
    let value = match text.to_lowercase().as_str() {
      "end" | "last" | "末页" | "最后" | "最后一页" => total_u32,
      _ => text.parse::<u32>().map_err(|_| format!("无法识别的页码「{text}」，请写成 1-3,5,8- 这样的形式"))?,
    };
    if value == 0 {
      return Err("页码从 1 开始".into());
    }
    if value > total_u32 {
      return Err(format!("「{name}」只有 {total} 页，没有第 {value} 页"));
    }
    Ok(value)
  };

  let mut pages = Vec::new();
  for part in spec.split([',', '，', '、', ';', '；']).map(str::trim).filter(|part| !part.is_empty()) {
    let normalized = part.replace(['~', '–', '—', '至', '到'], "-");
    match normalized.split_once('-') {
      None => pages.push(number(&normalized)?),
      Some((start, end)) => {
        let start = if start.trim().is_empty() { 1 } else { number(start)? };
        let end = if end.trim().is_empty() { total_u32 } else { number(end)? };
        if start <= end {
          pages.extend(start..=end);
        }
        else {
          pages.extend((end..=start).rev());
        }
      }
    }
    if pages.len() > MAX_OUTPUT_PAGES {
      return Err(format!("一个文件最多 {MAX_OUTPUT_PAGES} 页"));
    }
  }
  if pages.is_empty() {
    return Err(format!("没有选中「{name}」的任何页面"));
  }
  Ok(pages)
}

fn normalize_rotation(rotate: Option<i64>) -> Result<i64, String> {
  let rotate = rotate.unwrap_or(0);
  if rotate % 90 != 0 {
    return Err(format!("旋转角度必须是 90 的倍数（如 90、180、270、-90），不能是 {rotate}"));
  }
  Ok(rotate.rem_euclid(360))
}

/// 读取并解析一个 PDF；不规范的 PDF 可能让解析库 panic，不能影响整个应用
fn load_pdf(bytes: &[u8], name: &str) -> Result<Document, String> {
  let doc = std::panic::catch_unwind(|| Document::load_mem(bytes))
    .map_err(|_| format!("无法解析「{name}」（文件可能已损坏）"))?
    .map_err(|e| format!("无法读取「{name}」（可能已损坏）：{e}"))?;
  if doc.was_encrypted() || doc.is_encrypted() {
    return Err(format!("「{name}」已加密，不能修改"));
  }
  if doc.get_pages().is_empty() {
    return Err(format!("「{name}」中没有页面"));
  }
  Ok(doc)
}

/// 读取所有要用到的 PDF（生成前全部读入内存，因此输出可以覆盖输入的文件）
struct Inputs {
  files: HashMap<PathBuf, (Vec<u8>, usize)>,
}

impl Inputs {
  fn load(roots: &Roots, outputs: &[PdfOutput]) -> Result<Self, String> {
    let mut files = HashMap::new();
    for part in outputs.iter().flat_map(|output| &output.parts) {
      let path = roots.resolve(&part.path)?;
      if files.contains_key(&path) {
        continue;
      }
      if path.is_dir() {
        return Err(format!("{} 是文件夹", path.display()));
      }
      let name = name_of(&path);
      if !name.to_lowercase().ends_with(".pdf") {
        return Err(format!("只能组合 PDF 文件：{name}（Office 文件可以先导出为 PDF）"));
      }
      let size = fs::metadata(&path).map_err(|e| format!("读取「{name}」失败：{e}"))?.len();
      if size > MAX_INPUT_BYTES {
        return Err(format!("「{name}」太大（超过 {} MB）", MAX_INPUT_BYTES >> 20));
      }
      let bytes = fs::read(&path).map_err(|e| format!("读取「{name}」失败：{e}"))?;
      let pages = load_pdf(&bytes, &name)?.get_pages().len();
      files.insert(path, (bytes, pages));
    }
    Ok(Self { files })
  }
}

fn validate_outputs(outputs: &[PdfOutput]) -> Result<(), String> {
  if outputs.is_empty() {
    return Err("需要列出要生成的 PDF".into());
  }
  if outputs.len() > MAX_OUTPUTS {
    return Err(format!("一次最多生成 {MAX_OUTPUTS} 个文件"));
  }
  for output in outputs {
    if output.parts.is_empty() {
      return Err(format!("「{}」没有指定由哪些页面组成", output.path));
    }
    if output.parts.len() > MAX_PARTS {
      return Err(format!("一个文件最多由 {MAX_PARTS} 部分组成"));
    }
  }
  Ok(())
}

fn plan_with(roots: &Roots, outputs: &[PdfOutput], inputs: &Inputs) -> Result<Vec<OutputPlan>, String> {
  validate_outputs(outputs)?;
  let mut seen = HashSet::new();
  let mut plans = Vec::new();
  for output in outputs {
    let target = check_pdf_path(roots, &output.path)?;
    if !seen.insert(target.clone()) {
      return Err(format!("{} 重复出现了，每个文件只能生成一次", target.display()));
    }
    let mut parts = Vec::new();
    for part in &output.parts {
      let path = roots.resolve(&part.path)?;
      let total_pages = inputs.files[&path].1;
      parts.push(PartPlan {
        pages: parse_pages(part.pages.as_deref(), total_pages, &name_of(&path))?,
        rotate: normalize_rotation(part.rotate)?,
        path: path.display().to_string(),
        total_pages,
      });
    }
    let pages = parts.iter().map(|part| part.pages.len()).sum();
    if pages > MAX_OUTPUT_PAGES {
      return Err(format!("一个文件最多 {MAX_OUTPUT_PAGES} 页"));
    }
    plans.push(OutputPlan { path: target.display().to_string(), exists: target.exists(), pages, parts });
  }
  Ok(plans)
}

/// 检查要生成的 PDF，返回每个文件由哪些页面组成（不会改动文件）
pub fn plan_compose(roots: &Roots, outputs: &[PdfOutput]) -> Result<Vec<OutputPlan>, String> {
  validate_outputs(outputs)?;
  let inputs = Inputs::load(roots, outputs)?;
  plan_with(roots, outputs, &inputs)
}

/// 页面从上级的页面树节点继承的属性
fn inherited(doc: &Document, page: &Dictionary, key: &[u8]) -> Option<Object> {
  let mut parent = page.get(b"Parent").and_then(Object::as_reference).ok();
  for _ in 0..64 {
    let dict = doc.get_dictionary(parent?).ok()?;
    if let Ok(value) = dict.get(key) {
      return Some(value.clone());
    }
    parent = dict.get(b"Parent").and_then(Object::as_reference).ok();
  }
  None
}

/// 整数值（可能是间接引用）
fn integer(doc: &Document, object: &Object) -> i64 {
  match object {
    Object::Reference(id) => doc.get_object(*id).and_then(Object::as_i64).unwrap_or(0),
    other => other.as_i64().unwrap_or(0),
  }
}

/// 按计划组合出一个新的 PDF
fn build(plan: &OutputPlan, inputs: &Inputs) -> Result<Vec<u8>, String> {
  let mut out = Document::with_version("1.7");
  let pages_id = out.new_object_id();
  let mut kids: Vec<Object> = Vec::new();

  for part in &plan.parts {
    let path = PathBuf::from(&part.path);
    let mut doc = load_pdf(&inputs.files[&path].0, &name_of(&path))?;
    let next_id = out.objects.keys().map(|id| id.0).max().unwrap_or(0).max(out.max_id) + 1;
    doc.renumber_objects_with(next_id);
    let page_ids = doc.get_pages();

    // 先取出选中页面的字典：补上继承的属性，指向新的页面树，加上旋转
    let mut pages: Vec<(ObjectId, Dictionary)> = Vec::new();
    for number in &part.pages {
      let id = *page_ids.get(number).ok_or_else(|| format!("「{}」中找不到第 {number} 页", name_of(&path)))?;
      let mut dict = doc.get_dictionary(id).map_err(|e| format!("「{}」第 {number} 页已损坏：{e}", name_of(&path)))?.clone();
      for key in [&b"Resources"[..], b"MediaBox", b"CropBox", b"Rotate"] {
        if !dict.has(key)
          && let Some(value) = inherited(&doc, &dict, key)
        {
          dict.set(key.to_vec(), value);
        }
      }
      if !dict.has(b"Resources") {
        dict.set("Resources", Dictionary::new());
      }
      if !dict.has(b"MediaBox") {
        dict.set("MediaBox", vec![0.into(), 0.into(), 612.into(), 792.into()]);
      }
      let rotate = (dict.get(b"Rotate").map(|value| integer(&doc, value)).unwrap_or(0) + part.rotate).rem_euclid(360);
      if rotate == 0 {
        dict.remove(b"Rotate");
      }
      else {
        dict.set("Rotate", rotate);
      }
      dict.set("Parent", pages_id);
      pages.push((id, dict));
    }

    out.max_id = out.max_id.max(doc.objects.keys().map(|id| id.0).max().unwrap_or(0));
    out.objects.extend(doc.objects);
    // 同一页出现多次时，之后的每次都复制一个新的页面对象（共用内容与资源）
    let mut used = HashSet::new();
    for (id, dict) in pages {
      let id = if used.insert(id) {
        out.objects.insert(id, Object::Dictionary(dict));
        id
      }
      else {
        out.add_object(dict)
      };
      kids.push(id.into());
    }
  }

  let count = kids.len() as i64;
  let mut pages = Dictionary::new();
  pages.set("Type", "Pages");
  pages.set("Kids", kids);
  pages.set("Count", count);
  out.objects.insert(pages_id, Object::Dictionary(pages));
  let mut catalog = Dictionary::new();
  catalog.set("Type", "Catalog");
  catalog.set("Pages", pages_id);
  let catalog_id = out.add_object(catalog);
  out.trailer.set("Root", catalog_id);

  // 去掉没有用到的对象（未选中的页面、原来的目录等），重新编号
  out.prune_objects();
  out.renumber_objects();
  out.max_id = out.objects.keys().map(|id| id.0).max().unwrap_or(0);
  let mut bytes = Vec::new();
  out.save_to(&mut bytes).map_err(|e| format!("生成「{}」失败：{e}", name_of(Path::new(&plan.path))))?;
  Ok(bytes)
}

/// 按页重新组合 PDF（前端在调用前已经征得用户同意，并备份了要覆盖的文件）。
/// 先生成所有文件再写入：任何一个出错时都不改动文件
pub fn compose(roots: &Roots, outputs: &[PdfOutput]) -> Result<Vec<OutputResult>, String> {
  validate_outputs(outputs)?;
  let inputs = Inputs::load(roots, outputs)?;
  let plans = plan_with(roots, outputs, &inputs)?;
  let built: Vec<(PathBuf, Vec<u8>, usize)> = plans
    .iter()
    .map(|plan| {
      let bytes = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| build(plan, &inputs))).map_err(|_| format!("生成「{}」时出错（源文件可能不规范）", plan.path))??;
      Ok((PathBuf::from(&plan.path), bytes, plan.pages))
    })
    .collect::<Result<_, String>>()?;
  let mut results = Vec::new();
  for (path, bytes, pages) in built {
    write_output(&path, &bytes)?;
    results.push(OutputResult { path: path.display().to_string(), pages, size: bytes.len() as u64 });
  }
  Ok(results)
}

//! 运行脚本：只能运行授权文件夹中已有的脚本文件（Python、JavaScript、PowerShell、批处理、Shell），
//! 每次运行前由前端请求用户同意。
//!
//! - 参数直接传给解释器，不经过 shell 拼接，避免命令注入
//! - 标准输入关闭，脚本等待输入时不会卡住；Windows 上不弹出控制台窗口
//! - 超时或取消时结束整个进程树
//! - 输出过长时保留开头与结尾，自动识别 UTF-8 / GBK 编码

use std::{
  collections::{HashMap, HashSet, VecDeque},
  fs,
  io::Read,
  path::{Path, PathBuf},
  process::{Child, Command, Stdio},
  sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, LazyLock, Mutex,
  },
  thread,
  time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

use super::read::decode;
use super::roots::Roots;

/// 默认与最长的运行时间（秒）
const DEFAULT_TIMEOUT: u64 = 60;
const MAX_TIMEOUT: u64 = 600;
/// 输出保留的开头与结尾（字节）
const OUTPUT_HEAD_BYTES: usize = 32 * 1024;
const OUTPUT_TAIL_BYTES: usize = 32 * 1024;
/// 预览脚本内容时最多读取的字节数、显示的行数与字数
const PREVIEW_READ_BYTES: u64 = 256 * 1024;
const PREVIEW_LINES: usize = 160;
const PREVIEW_CHARS: usize = 12_000;
/// 参数的数量与长度上限
const MAX_ARGS: usize = 30;
const MAX_ARG_CHARS: usize = 4000;

/// 正在运行的脚本：运行 id → 取消标记
static RUNNING: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// 脚本的种类
#[derive(Debug, Clone, Copy, PartialEq)]
enum ScriptKind {
  Python,
  JavaScript,
  PowerShell,
  Batch,
  Shell,
}

impl ScriptKind {
  fn of(path: &Path) -> Result<Self, String> {
    let extension = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    match extension.as_str() {
      "py" | "pyw" => Ok(Self::Python),
      "js" | "mjs" | "cjs" => Ok(Self::JavaScript),
      "ps1" => Ok(Self::PowerShell),
      "bat" | "cmd" if cfg!(windows) => Ok(Self::Batch),
      "sh" => Ok(Self::Shell),
      "bat" | "cmd" => Err("批处理脚本只能在 Windows 上运行".into()),
      "" => Err("只能运行带扩展名的脚本文件（.py、.js、.ps1、.bat、.cmd、.sh）".into()),
      _ => Err(format!("不能运行 .{extension} 文件，只能运行脚本文件（.py、.js、.ps1、.bat、.cmd、.sh）")),
    }
  }

  fn label(self) -> &'static str {
    match self {
      Self::Python => "Python 脚本",
      Self::JavaScript => "JavaScript 脚本",
      Self::PowerShell => "PowerShell 脚本",
      Self::Batch => "批处理脚本",
      Self::Shell => "Shell 脚本",
    }
  }
}

// ===== 查找解释器 =====

/// 在 PATH 中查找程序，跳过 Windows 应用商店的占位程序（WindowsApps 中的 python.exe 只会打开应用商店）
/// 与 WSL 的 bash（System32\bash.exe）
fn find_in_path(names: &[&str]) -> Option<PathBuf> {
  let path = std::env::var_os("PATH")?;
  for dir in std::env::split_paths(&path) {
    let lowered = dir.to_string_lossy().to_lowercase();
    if lowered.contains("windowsapps") {
      continue;
    }
    for name in names {
      let file = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
      let candidate = dir.join(&file);
      if *name == "bash" && cfg!(windows) && lowered.ends_with("system32") {
        continue;
      }
      if candidate.is_file() {
        return Some(candidate);
      }
    }
  }
  None
}

/// 解释器与放在脚本路径之前的参数
struct Interpreter {
  program: PathBuf,
  args: Vec<String>,
}

fn interpreter(kind: ScriptKind) -> Result<Interpreter, String> {
  let found = |program: Option<PathBuf>, args: &[&str]| program.map(|program| Interpreter { program, args: args.iter().map(|a| a.to_string()).collect() });
  let result = match kind {
    ScriptKind::Python => found(find_in_path(&["python", "python3"]), &[]).or_else(|| found(find_in_path(&["py"]), &["-3"])),
    ScriptKind::JavaScript => found(find_in_path(&["node"]), &[]),
    ScriptKind::PowerShell => {
      let args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
      let windows_powershell = std::env::var_os("SystemRoot")
        .map(|root| PathBuf::from(root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe"))
        .filter(|path| path.is_file());
      found(find_in_path(&["pwsh"]).or(windows_powershell).or_else(|| find_in_path(&["powershell"])), &args)
    }
    // 批处理由系统的 cmd 运行：直接以脚本路径作为程序，Rust 会安全地转义参数
    ScriptKind::Batch => Some(Interpreter { program: PathBuf::new(), args: Vec::new() }),
    ScriptKind::Shell => {
      let git_bash = [r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files (x86)\Git\bin\bash.exe"]
        .into_iter()
        .map(PathBuf::from)
        .find(|path| cfg!(windows) && path.is_file());
      found(find_in_path(&["bash"]).or(git_bash).or_else(|| find_in_path(&["sh"])), &[])
    }
  };
  result.ok_or_else(|| {
    let name = match kind {
      ScriptKind::Python => "Python",
      ScriptKind::JavaScript => "Node.js",
      ScriptKind::PowerShell => "PowerShell",
      ScriptKind::Shell => "Bash（Windows 上可以安装 Git for Windows）",
      ScriptKind::Batch => "cmd",
    };
    format!("没有找到 {name}，请先安装并加入 PATH")
  })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
  /// 脚本类型，如 Python 脚本
  pub kind: &'static str,
  /// 解释器路径；没有找到时为空
  pub path: Option<String>,
}

/// 本机可用的解释器
pub fn runtimes() -> Vec<Runtime> {
  let kinds = [ScriptKind::Python, ScriptKind::JavaScript, ScriptKind::PowerShell, ScriptKind::Batch, ScriptKind::Shell];
  kinds
    .into_iter()
    .filter(|kind| *kind != ScriptKind::Batch || cfg!(windows))
    .map(|kind| Runtime {
      kind: kind.label(),
      path: match kind {
        ScriptKind::Batch => Some("cmd".into()),
        _ => interpreter(kind).ok().map(|found| found.program.display().to_string()),
      },
    })
    .collect()
}

// ===== 准备运行 =====

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
  /// 由前端生成，用于取消
  pub run_id: String,
  pub path: String,
  #[serde(default)]
  pub args: Vec<String>,
  /// 工作目录，省略时为脚本所在的文件夹
  pub working_dir: Option<String>,
  pub timeout_seconds: Option<u64>,
}

/// 运行前展示给用户确认的信息
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptInfo {
  pub path: String,
  pub name: String,
  pub kind: &'static str,
  /// 完整的命令，用于展示
  pub command: String,
  pub working_dir: String,
  pub timeout_seconds: u64,
  /// 脚本内容的开头
  pub preview: String,
  /// 脚本的总行数
  pub lines: usize,
  pub preview_truncated: bool,
}

struct Prepared {
  info: ScriptInfo,
  program: PathBuf,
  args: Vec<String>,
  working_dir: PathBuf,
  timeout: Duration,
  /// 通过标准输入传给解释器的代码；为空时标准输入关闭
  stdin: Option<Vec<u8>>,
  /// 需要写入临时文件再运行的批处理代码（cmd 不能从标准输入可靠地运行多行批处理）
  batch: Option<Vec<u8>>,
  /// 见 CodeRequest::cleanup_office
  cleanup_office: bool,
}

fn check_args(args: &[String]) -> Result<(), String> {
  if args.len() > MAX_ARGS {
    return Err(format!("参数太多（最多 {MAX_ARGS} 个）"));
  }
  if args.iter().any(|arg| arg.chars().count() > MAX_ARG_CHARS || arg.contains('\0')) {
    return Err(format!("参数太长（每个最多 {MAX_ARG_CHARS} 字）或包含无效字符"));
  }
  Ok(())
}

fn resolve_working_dir(roots: &Roots, dir: Option<&str>, default: PathBuf) -> Result<PathBuf, String> {
  let working_dir = match dir.map(str::trim).filter(|dir| !dir.is_empty()) {
    Some(dir) => roots.resolve(dir)?,
    None => default,
  };
  if !working_dir.is_dir() {
    return Err(format!("工作目录 {} 不是文件夹", working_dir.display()));
  }
  Ok(working_dir)
}

fn display_command(program: &str, args: &[String]) -> String {
  std::iter::once(program.to_string()).chain(args.iter().cloned()).map(|part| quote(&part)).collect::<Vec<_>>().join(" ")
}

fn quote(arg: &str) -> String {
  if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
    return arg.to_string();
  }
  format!("\"{}\"", arg.replace('"', "\\\""))
}

fn read_preview(path: &Path) -> (String, usize, bool) {
  let mut bytes = Vec::new();
  let _ = fs::File::open(path).and_then(|file| file.take(PREVIEW_READ_BYTES).read_to_end(&mut bytes));
  let text = decode(&bytes).map(|(text, _)| text).unwrap_or_else(|| "（无法识别脚本内容的编码）".into());
  let lines = text.lines().count();
  let shown: Vec<&str> = text.lines().take(PREVIEW_LINES).collect();
  let mut preview = shown.join("\n");
  let mut truncated = lines > PREVIEW_LINES || bytes.len() as u64 >= PREVIEW_READ_BYTES;
  if preview.chars().count() > PREVIEW_CHARS {
    preview = preview.chars().take(PREVIEW_CHARS).collect();
    truncated = true;
  }
  (preview, lines, truncated)
}

fn prepare(roots: &Roots, request: &RunRequest) -> Result<Prepared, String> {
  let path = roots.resolve(&request.path)?;
  if !path.is_file() {
    return Err(format!("{} 不是文件", path.display()));
  }
  let kind = ScriptKind::of(&path)?;
  let found = interpreter(kind)?;
  let default_dir = path.parent().map(Path::to_path_buf).ok_or("无效的脚本路径")?;
  let working_dir = resolve_working_dir(roots, request.working_dir.as_deref(), default_dir)?;
  check_args(&request.args)?;

  let (program, mut args) = if kind == ScriptKind::Batch {
    (path.clone(), Vec::new())
  }
  else {
    let mut args = found.args;
    if kind == ScriptKind::PowerShell {
      args.push("-File".into());
    }
    args.push(path.display().to_string());
    (found.program, args)
  };
  args.extend(request.args.iter().cloned());

  let timeout_seconds = request.timeout_seconds.unwrap_or(DEFAULT_TIMEOUT).clamp(1, MAX_TIMEOUT);
  let command = display_command(&program.display().to_string(), &args);
  let (preview, lines, preview_truncated) = read_preview(&path);

  Ok(Prepared {
    info: ScriptInfo {
      path: path.display().to_string(),
      name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
      kind: kind.label(),
      command,
      working_dir: working_dir.display().to_string(),
      timeout_seconds,
      preview,
      lines,
      preview_truncated,
    },
    program,
    args,
    working_dir,
    timeout: Duration::from_secs(timeout_seconds),
    stdin: None,
    batch: None,
    cleanup_office: false,
  })
}

/// 检查脚本能否运行，返回展示给用户确认的信息（不会运行脚本）
pub fn inspect(roots: &Roots, request: &RunRequest) -> Result<ScriptInfo, String> {
  prepare(roots, request).map(|prepared| prepared.info)
}

// ===== 直接运行一段代码 =====

/// 直接运行的代码的最大字数：授权卡片中要展示全部代码，不能太长（前端工具参数的上限与此一致）
pub(super) const MAX_CODE_CHARS: usize = 40_000;
/// Windows 命令行的长度上限约为 32767 个字符，PowerShell 代码编码后作为参数传入。
/// 这是系统的限制，不能放宽：更长的 PowerShell 代码需要写成 .ps1 文件后运行
const MAX_ENCODED_COMMAND_CHARS: usize = 30_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeRequest {
  /// 由前端生成，用于取消
  pub run_id: String,
  /// python、javascript、powershell、batch、shell
  pub language: String,
  pub code: String,
  #[serde(default)]
  pub args: Vec<String>,
  /// 工作目录，省略时为第一个授权文件夹
  pub working_dir: Option<String>,
  pub timeout_seconds: Option<u64>,
  /// 运行结束后，结束脚本启动的、没有正常退出的 Office 后台进程（通过 COM 调用 Office 时使用）
  #[serde(default)]
  pub cleanup_office: bool,
}

fn code_kind(language: &str) -> Result<ScriptKind, String> {
  match language.trim().to_lowercase().as_str() {
    "python" | "py" => Ok(ScriptKind::Python),
    "javascript" | "js" | "node" => Ok(ScriptKind::JavaScript),
    "powershell" | "ps1" | "pwsh" => Ok(ScriptKind::PowerShell),
    "batch" | "bat" | "cmd" if cfg!(windows) => Ok(ScriptKind::Batch),
    "batch" | "bat" | "cmd" => Err("批处理只能在 Windows 上运行".into()),
    "shell" | "bash" | "sh" => Ok(ScriptKind::Shell),
    other => Err(format!("不支持的语言：{other}，可以是 python、javascript、powershell、batch、shell")),
  }
}

fn code_label(kind: ScriptKind) -> &'static str {
  match kind {
    ScriptKind::Python => "Python 代码",
    ScriptKind::JavaScript => "JavaScript 代码",
    ScriptKind::PowerShell => "PowerShell 代码",
    ScriptKind::Batch => "批处理代码",
    ScriptKind::Shell => "Shell 代码",
  }
}

/// PowerShell 单引号字符串：' 写成 ''
fn powershell_string(text: &str) -> String {
  format!("'{}'", text.replace('\'', "''"))
}

fn prepare_code(roots: &Roots, request: &CodeRequest) -> Result<Prepared, String> {
  let kind = code_kind(&request.language)?;
  let code = request.code.replace("\r\n", "\n");
  if code.trim().is_empty() {
    return Err("代码不能为空".into());
  }
  let chars = code.chars().count();
  if chars > MAX_CODE_CHARS {
    return Err(format!("代码太长（{chars} 字，最多 {MAX_CODE_CHARS} 字）。较长的脚本请用 write_file 写成文件后用 run_script 运行"));
  }
  let default_dir = roots.paths().first().cloned().ok_or("还没有授权任何文件夹")?;
  let working_dir = resolve_working_dir(roots, request.working_dir.as_deref(), default_dir)?;
  check_args(&request.args)?;

  let found = interpreter(kind)?;
  let user_args = request.args.iter().cloned();
  let (program, args, stdin, batch, shown_args): (PathBuf, Vec<String>, Option<Vec<u8>>, Option<Vec<u8>>, Vec<String>) = match kind {
    // 解释器从标准输入读取代码：python -、node -、bash -s
    ScriptKind::Python | ScriptKind::JavaScript => {
      let args: Vec<String> = found.args.into_iter().chain(["-".to_string()]).chain(user_args).collect();
      (found.program, args.clone(), Some(code.into_bytes()), None, args)
    }
    ScriptKind::Shell => {
      let args: Vec<String> = found.args.into_iter().chain(["-s".to_string(), "--".to_string()]).chain(user_args).collect();
      (found.program, args.clone(), Some(code.into_bytes()), None, args)
    }
    // PowerShell 从标准输入读取多行代码不可靠，改用 -EncodedCommand（UTF-16LE 的 Base64）；
    // 参数通过 $args 传入，输出使用 UTF-8
    ScriptKind::PowerShell => {
      let arg_list = request.args.iter().map(|arg| powershell_string(arg)).collect::<Vec<_>>().join(", ");
      let script = format!(
        "$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n$args = @({arg_list})\n{code}"
      );
      let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
      let encoded = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(utf16)
      };
      if encoded.len() > MAX_ENCODED_COMMAND_CHARS {
        return Err("PowerShell 代码太长，无法直接运行。请用 write_file 写成 .ps1 文件后用 run_script 运行".into());
      }
      let shown: Vec<String> = found.args.iter().cloned().chain(["-EncodedCommand".to_string(), "（编码后的代码）".to_string()]).collect();
      let args: Vec<String> = found.args.into_iter().chain(["-OutputFormat".to_string(), "Text".to_string(), "-EncodedCommand".to_string(), encoded]).collect();
      (found.program, args, None, None, shown)
    }
    // cmd 不能从标准输入可靠地运行多行批处理（跳转标签等会失效），写入系统临时目录中的临时文件，运行结束后删除
    ScriptKind::Batch => {
      let bytes = super::write::batch_bytes(&code)?;
      let args: Vec<String> = user_args.collect();
      let shown: Vec<String> = std::iter::once("（临时批处理文件）".to_string()).chain(args.iter().cloned()).collect();
      (PathBuf::from("cmd"), args, None, Some(bytes), shown)
    }
  };

  let timeout_seconds = request.timeout_seconds.unwrap_or(DEFAULT_TIMEOUT).clamp(1, MAX_TIMEOUT);
  let shown_program = if kind == ScriptKind::Batch { "cmd".to_string() } else { program.display().to_string() };
  let command = display_command(&shown_program, &shown_args);
  let code_text = request.code.replace("\r\n", "\n");
  Ok(Prepared {
    info: ScriptInfo {
      path: String::new(),
      name: code_label(kind).to_string(),
      kind: code_label(kind),
      command,
      working_dir: working_dir.display().to_string(),
      timeout_seconds,
      lines: code_text.lines().count(),
      // 代码不是文件，用户无法另外查看，授权卡片中展示全部代码
      preview: code_text,
      preview_truncated: false,
    },
    program,
    args,
    working_dir,
    timeout: Duration::from_secs(timeout_seconds),
    stdin,
    batch,
    cleanup_office: request.cleanup_office,
  })
}

/// 检查代码能否运行，返回展示给用户确认的信息（不会运行代码）
pub fn inspect_code(roots: &Roots, request: &CodeRequest) -> Result<ScriptInfo, String> {
  prepare_code(roots, request).map(|prepared| prepared.info)
}

/// 直接运行一段代码（不写入用户的文件夹），等待结束后返回输出
pub fn run_code(roots: &Roots, request: &CodeRequest) -> Result<RunResult, String> {
  execute(prepare_code(roots, request)?, &request.run_id)
}

// ===== 运行 =====

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
  pub command: String,
  /// 退出码；被结束时为空
  pub exit_code: Option<i32>,
  pub stdout: String,
  pub stderr: String,
  /// 输出过长，中间部分被省略
  pub stdout_truncated: bool,
  pub stderr_truncated: bool,
  pub timed_out: bool,
  pub cancelled: bool,
  pub duration_ms: u64,
  /// 补充说明，如结束了残留的 Office 后台进程
  pub note: Option<String>,
}

/// 收集输出：保留开头与结尾
#[derive(Default)]
struct Capture {
  head: Vec<u8>,
  tail: VecDeque<u8>,
  total: usize,
}

impl Capture {
  fn push(&mut self, bytes: &[u8]) {
    self.total += bytes.len();
    for &byte in bytes {
      if self.head.len() < OUTPUT_HEAD_BYTES {
        self.head.push(byte);
      }
      else {
        if self.tail.len() == OUTPUT_TAIL_BYTES {
          self.tail.pop_front();
        }
        self.tail.push_back(byte);
      }
    }
  }

  fn finish(self) -> (String, bool) {
    let truncated = self.total > self.head.len() + self.tail.len();
    let mut text = decode_output(&self.head);
    if truncated {
      text.push_str(&format!("\n……（中间省略了 {} 字节）……\n", self.total - self.head.len() - self.tail.len()));
    }
    let tail: Vec<u8> = self.tail.into_iter().collect();
    text.push_str(&decode_output(&tail));
    (text, truncated)
  }
}

/// 识别输出的编码：UTF-8，或 Windows 中文系统控制台常用的 GBK
/// PowerShell 以 -EncodedCommand 运行时，错误输出是 CLIXML（以 #< CLIXML 开头的 XML），把其中的文字还原出来
pub fn clixml_to_text(text: &str) -> String {
  let Some(start) = text.find("#< CLIXML") else { return text.to_string() };
  let mut output = text[..start].to_string();
  let mut rest = &text[start..];
  while let Some(open) = rest.find("<S S=\"") {
    let tail = &rest[open..];
    let Some(content_start) = tail.find('>') else { break };
    let content = &tail[content_start + 1..];
    let Some(end) = content.find("</S>") else { break };
    output.push_str(&unescape_clixml(&content[..end]));
    rest = &content[end + "</S>".len()..];
  }
  output.trim_end().to_string()
}

fn unescape_clixml(text: &str) -> String {
  let text = text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&");
  // _xHHHH_ 形式的转义字符，如 _x000D__x000A_ 为换行
  let mut output = String::new();
  let mut rest = text.as_str();
  while let Some(position) = rest.find("_x") {
    output.push_str(&rest[..position]);
    let tail = &rest[position..];
    let decoded = tail
      .get(2..6)
      .filter(|hex| hex.chars().all(|c| c.is_ascii_hexdigit()) && tail.get(6..7) == Some("_"))
      .and_then(|hex| u32::from_str_radix(hex, 16).ok())
      .and_then(char::from_u32);
    match decoded {
      Some(c) => {
        output.push(c);
        rest = &tail[7..];
      }
      None => {
        output.push_str("_x");
        rest = &tail[2..];
      }
    }
  }
  output.push_str(rest);
  output.replace("\r\n", "\n")
}

pub fn decode_output(bytes: &[u8]) -> String {
  if let Ok(text) = std::str::from_utf8(bytes) {
    return text.to_string();
  }
  let (text, _, had_errors) = encoding_rs::GB18030.decode(bytes);
  if had_errors { String::from_utf8_lossy(bytes).into_owned() } else { text.into_owned() }
}

/// 在后台线程中读取输出，读完后通过通道返回
fn read_output(mut reader: impl Read + Send + 'static) -> mpsc::Receiver<Capture> {
  let (sender, receiver) = mpsc::channel();
  thread::spawn(move || {
    let mut capture = Capture::default();
    let mut buffer = [0u8; 8192];
    while let Ok(count) = reader.read(&mut buffer) {
      if count == 0 {
        break;
      }
      capture.push(&buffer[..count]);
    }
    let _ = sender.send(capture);
  });
  receiver
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 结束脚本及它启动的所有子进程
fn kill_tree(child: &mut Child) {
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("taskkill")
      .args(["/PID", &child.id().to_string(), "/T", "/F"])
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .creation_flags(CREATE_NO_WINDOW)
      .status();
  }
  #[cfg(unix)]
  {
    // 脚本运行在独立的进程组中，结束整个进程组
    let _ = Command::new("kill").args(["-KILL", &format!("-{}", child.id())]).status();
  }
  let _ = child.kill();
  let _ = child.wait();
}

/// 运行期间登记取消标记，结束时自动移除
struct Registration(String);

impl Registration {
  fn new(run_id: &str) -> Result<(Self, Arc<AtomicBool>), String> {
    let flag = Arc::new(AtomicBool::new(false));
    let mut running = RUNNING.lock().map_err(|_| "内部错误".to_string())?;
    if running.contains_key(run_id) {
      return Err("这个脚本已经在运行".into());
    }
    running.insert(run_id.to_string(), flag.clone());
    Ok((Self(run_id.to_string()), flag))
  }
}

impl Drop for Registration {
  fn drop(&mut self) {
    if let Ok(mut running) = RUNNING.lock() {
      running.remove(&self.0);
    }
  }
}

/// 取消正在运行的脚本；脚本已经结束时返回 false
pub fn cancel(run_id: &str) -> bool {
  RUNNING
    .lock()
    .ok()
    .and_then(|running| running.get(run_id).map(|flag| flag.store(true, Ordering::SeqCst)))
    .is_some()
}

/// 运行脚本，等待结束（或超时、被取消）后返回输出
pub fn run(roots: &Roots, request: &RunRequest) -> Result<RunResult, String> {
  execute(prepare(roots, request)?, &request.run_id)
}

/// 临时的批处理文件，用完自动删除
struct TempScript(PathBuf);

impl TempScript {
  fn create(run_id: &str, bytes: &[u8]) -> Result<Self, String> {
    let dir = std::env::temp_dir().join("desktop-pet-scripts");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建临时文件夹：{e}"))?;
    let name: String = run_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(64).collect();
    let path = dir.join(format!("{}.bat", if name.is_empty() { "script" } else { &name }));
    fs::write(&path, bytes).map_err(|e| format!("无法创建临时文件：{e}"))?;
    Ok(Self(path))
  }
}

impl Drop for TempScript {
  fn drop(&mut self) {
    let _ = fs::remove_file(&self.0);
  }
}

fn execute(prepared: Prepared, run_id: &str) -> Result<RunResult, String> {
  let (_registration, cancelled_flag) = Registration::new(run_id)?;
  let office_before = if prepared.cleanup_office { office_processes() } else { HashMap::new() };
  let temp_script = prepared.batch.as_deref().map(|bytes| TempScript::create(run_id, bytes)).transpose()?;
  let program = temp_script.as_ref().map(|temp| temp.0.clone()).unwrap_or(prepared.program);

  let mut command = Command::new(&program);
  command
    .args(&prepared.args)
    .current_dir(&prepared.working_dir)
    .stdin(if prepared.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    // 让 Python 以 UTF-8 输出，避免中文乱码
    .env("PYTHONIOENCODING", "utf-8")
    .env("PYTHONUTF8", "1");
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
  }
  #[cfg(unix)]
  {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
  }

  let started = Instant::now();
  let mut child = command.spawn().map_err(|e| format!("无法启动脚本：{e}"))?;
  // 在后台写入代码，写完后关闭标准输入，解释器读到结尾后开始运行
  if let (Some(code), Some(mut stdin)) = (prepared.stdin, child.stdin.take()) {
    thread::spawn(move || {
      use std::io::Write;
      let _ = stdin.write_all(&code);
    });
  }
  let stdout = read_output(child.stdout.take().ok_or("无法读取脚本的输出")?);
  let stderr = read_output(child.stderr.take().ok_or("无法读取脚本的输出")?);

  let mut timed_out = false;
  let mut cancelled = false;
  let exit_code = loop {
    match child.try_wait() {
      Ok(Some(status)) => break status.code(),
      Ok(None) => {}
      Err(error) => {
        kill_tree(&mut child);
        return Err(format!("等待脚本结束时出错：{error}"));
      }
    }
    if cancelled_flag.load(Ordering::SeqCst) {
      cancelled = true;
    }
    else if started.elapsed() >= prepared.timeout {
      timed_out = true;
    }
    if cancelled || timed_out {
      kill_tree(&mut child);
      break None;
    }
    thread::sleep(Duration::from_millis(50));
  };

  // 脚本启动的后台进程可能仍占用输出管道，最多再等 2 秒
  let collect = |receiver: mpsc::Receiver<Capture>| receiver.recv_timeout(Duration::from_secs(2)).unwrap_or_default().finish();
  let (stdout, stdout_truncated) = collect(stdout);
  let (stderr, stderr_truncated) = collect(stderr);
  let stderr = clixml_to_text(&stderr);
  let note = if prepared.cleanup_office { cleanup_office(&office_before) } else { None };

  Ok(RunResult {
    command: prepared.info.command,
    exit_code,
    stdout,
    stderr,
    stdout_truncated,
    stderr_truncated,
    timed_out,
    cancelled,
    duration_ms: started.elapsed().as_millis() as u64,
    note,
  })
}

// ===== Office =====

/// Office 程序的进程名（小写）
const OFFICE_PROCESSES: &[&str] = &["winword.exe", "excel.exe", "powerpnt.exe"];

/// 正在运行的 Office 进程：进程 id → 进程名
#[cfg(windows)]
pub(super) fn office_processes() -> HashMap<u32, String> {
  use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
  use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
  };
  let mut processes = HashMap::new();
  // SAFETY: 标准的进程快照遍历，entry 的 dwSize 已设置，快照句柄用完后关闭
  unsafe {
    let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if snapshot == INVALID_HANDLE_VALUE {
      return processes;
    }
    let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
    let mut found = Process32FirstW(snapshot, &mut entry) != 0;
    while found {
      let length = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
      let name = String::from_utf16_lossy(&entry.szExeFile[..length]).to_lowercase();
      if OFFICE_PROCESSES.contains(&name.as_str()) {
        processes.insert(entry.th32ProcessID, name);
      }
      found = Process32NextW(snapshot, &mut entry) != 0;
    }
    CloseHandle(snapshot);
  }
  processes
}

#[cfg(not(windows))]
pub(super) fn office_processes() -> HashMap<u32, String> {
  HashMap::new()
}

/// 有可见窗口的进程：用户自己打开的 Office 有窗口，脚本启动的 Office 在后台运行，没有可见窗口
#[cfg(windows)]
fn processes_with_visible_windows() -> HashSet<u32> {
  use windows_sys::Win32::Foundation::{HWND, LPARAM};
  use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, IsWindowVisible};

  unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> windows_sys::core::BOOL {
    // SAFETY: lparam 是下面传入的 HashSet 的指针，只在 EnumWindows 调用期间使用
    let pids = unsafe { &mut *(lparam as *mut HashSet<u32>) };
    if unsafe { IsWindowVisible(hwnd) } != 0 {
      let mut pid = 0;
      unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
      pids.insert(pid);
    }
    1
  }

  let mut pids = HashSet::new();
  // SAFETY: 回调只在调用期间访问 pids
  unsafe { EnumWindows(Some(collect), &mut pids as *mut HashSet<u32> as LPARAM) };
  pids
}

/// 结束脚本启动后没有正常退出的 Office 后台进程（如脚本超时、出错时没有调用 Quit）。
/// 通过 COM 启动的 Office 不是脚本的子进程，结束脚本时不会随之结束，残留的进程会一直占用文件。
/// 只结束运行前不存在、并且没有可见窗口的 Office 进程，不影响用户自己打开的 Office
#[cfg(windows)]
fn cleanup_office(before: &HashMap<u32, String>) -> Option<String> {
  use std::os::windows::process::CommandExt;
  // 正常退出的 Office 也需要一点时间才会结束，最多等几秒
  let deadline = Instant::now() + Duration::from_secs(8);
  let leftovers = loop {
    let visible = processes_with_visible_windows();
    let leftovers: Vec<(u32, String)> = office_processes()
      .into_iter()
      .filter(|(pid, _)| !before.contains_key(pid) && !visible.contains(pid))
      .collect();
    if leftovers.is_empty() || Instant::now() >= deadline {
      break leftovers;
    }
    thread::sleep(Duration::from_millis(300));
  };
  if leftovers.is_empty() {
    return None;
  }
  for (pid, _) in &leftovers {
    let _ = Command::new("taskkill")
      .args(["/PID", &pid.to_string(), "/F"])
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .creation_flags(CREATE_NO_WINDOW)
      .status();
  }
  // 等进程真正退出、释放文件后再返回，之后对比文件改动时才能读取到文件
  let deadline = Instant::now() + Duration::from_secs(5);
  while Instant::now() < deadline {
    let running = office_processes();
    if leftovers.iter().all(|(pid, _)| !running.contains_key(pid)) {
      break;
    }
    thread::sleep(Duration::from_millis(200));
  }
  let names = leftovers.iter().map(|(_, name)| name.as_str()).collect::<Vec<_>>().join("、");
  Some(format!("脚本结束后有 {} 个 Office 后台进程没有退出（{names}），已经结束它们", leftovers.len()))
}

#[cfg(not(windows))]
fn cleanup_office(_before: &HashMap<u32, String>) -> Option<String> {
  None
}

/// 本机可以用来新建与修改 Office 文件的方式
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeSupport {
  /// 已安装的 Microsoft Office 程序（可以通过 COM 调用）
  pub word: bool,
  pub excel: bool,
  pub powerpoint: bool,
  /// 已安装的 Python 库：python-docx、openpyxl、python-pptx
  pub python_libraries: Vec<&'static str>,
}

/// Office 程序是否注册了 COM 接口（如 Word.Application）
#[cfg(windows)]
fn com_registered(prog_id: &str) -> bool {
  use windows_sys::Win32::System::Registry::{RegCloseKey, RegOpenKeyExW, HKEY, HKEY_CLASSES_ROOT, KEY_READ};
  let key: Vec<u16> = format!("{prog_id}\\CLSID").encode_utf16().chain([0]).collect();
  let mut handle: HKEY = std::ptr::null_mut();
  // SAFETY: key 以 0 结尾；打开成功后关闭句柄
  unsafe {
    if RegOpenKeyExW(HKEY_CLASSES_ROOT, key.as_ptr(), 0, KEY_READ, &mut handle) != 0 {
      return false;
    }
    RegCloseKey(handle);
  }
  true
}

#[cfg(not(windows))]
fn com_registered(_prog_id: &str) -> bool {
  false
}

/// 已安装的 Python 库（只检查是否存在，不导入）
fn python_libraries() -> Vec<&'static str> {
  const LIBRARIES: [(&str, &str); 3] = [("docx", "python-docx"), ("openpyxl", "openpyxl"), ("pptx", "python-pptx")];
  let Ok(python) = interpreter(ScriptKind::Python) else { return Vec::new() };
  let code = "import importlib.util as u; print(' '.join(m for m in ('docx', 'openpyxl', 'pptx') if u.find_spec(m)))";
  let mut command = Command::new(&python.program);
  command.args(&python.args).args(["-c", code]).stdin(Stdio::null()).stderr(Stdio::null());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
  }
  let Ok(output) = command.output() else { return Vec::new() };
  let found = String::from_utf8_lossy(&output.stdout).to_string();
  let modules: HashSet<&str> = found.split_whitespace().collect();
  LIBRARIES.into_iter().filter(|(module, _)| modules.contains(module)).map(|(_, package)| package).collect()
}

pub fn office_support() -> OfficeSupport {
  OfficeSupport {
    word: com_registered("Word.Application"),
    excel: com_registered("Excel.Application"),
    powerpoint: com_registered("PowerPoint.Application"),
    python_libraries: python_libraries(),
  }
}

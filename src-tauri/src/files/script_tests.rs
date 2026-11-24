//! 运行脚本的测试

use std::{fs, path::PathBuf, thread, time::Duration};

use super::roots::Roots;
use super::script::{cancel, clixml_to_text, decode_output, inspect, inspect_code, run, run_code, runtimes, CodeRequest, RunRequest};

struct TempDir(PathBuf);

impl TempDir {
  fn new(name: &str) -> Self {
    let dir = std::env::temp_dir().join(format!("desktop-pet-script-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("root/sub")).unwrap();
    Self(dunce::canonicalize(&dir).unwrap())
  }

  fn write(&self, relative: &str, content: &str) -> String {
    let path = self.0.join(relative);
    fs::write(&path, content).unwrap();
    path.display().to_string()
  }

  fn roots(&self) -> Roots {
    Roots::new(&[self.0.join("root").display().to_string()]).unwrap()
  }
}

impl Drop for TempDir {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.0);
  }
}

fn request(run_id: &str, path: &str, args: &[&str]) -> RunRequest {
  RunRequest { run_id: run_id.into(), path: path.into(), args: args.iter().map(|a| a.to_string()).collect(), working_dir: None, timeout_seconds: None }
}

#[test]
fn decodes_utf8_and_gbk_output() {
  assert_eq!(decode_output("你好".as_bytes()), "你好");
  // 「你好」的 GBK 编码（Windows 中文系统的控制台输出）
  assert_eq!(decode_output(&[0xC4, 0xE3, 0xBA, 0xC3]), "你好");
}

#[test]
fn converts_powershell_clixml_errors_to_text() {
  let clixml = "#< CLIXML
<Objs Version=\"1.1.0.1\" xmlns=\"http://schemas.microsoft.com/powershell/2004/04\"><S S=\"Error\">无法将类型为“System.Int32”的对象强制转换为类型“System.String”。_x000D__x000A_</S><S S=\"Error\">所在位置 行:20 字符: 36_x000D__x000A_</S><S S=\"Error\">+ $a &lt;&gt; $b &amp; c_x005F_x_x000D__x000A_</S></Objs>";
  assert_eq!(clixml_to_text(clixml), "无法将类型为“System.Int32”的对象强制转换为类型“System.String”。
所在位置 行:20 字符: 36
+ $a <> $b & c_x");
  assert_eq!(clixml_to_text("普通的错误输出
"), "普通的错误输出
");
}

#[test]
fn refuses_scripts_outside_roots_or_of_unknown_types() {
  let dir = TempDir::new("refuse");
  let roots = dir.roots();
  let outside = dir.write("outside.py", "print(1)");
  let exe = dir.write("root/app.exe", "MZ");
  let script = dir.write("root/a.py", "print(1)");

  assert!(inspect(&roots, &request("r1", &outside, &[])).unwrap_err().contains("不在授权"));
  assert!(inspect(&roots, &request("r1", &exe, &[])).unwrap_err().contains("不能运行 .exe"));
  let outside_dir = RunRequest { working_dir: Some(dir.0.display().to_string()), ..request("r1", &script, &[]) };
  assert!(inspect(&roots, &outside_dir).unwrap_err().contains("不在授权"));
  let too_many: Vec<&str> = vec!["x"; 31];
  assert!(inspect(&roots, &request("r1", &script, &too_many)).unwrap_err().contains("参数太多"));
}

#[cfg(windows)]
#[test]
fn runs_batch_scripts_with_arguments_and_exit_codes() {
  let dir = TempDir::new("batch");
  let roots = dir.roots();
  // 中文 Windows 上 cmd 按 GBK 读取批处理文件，输出也是 GBK
  let content = "@echo off\r\necho hello %~1\r\necho 出错了 1>&2\r\ncd\r\nexit /b 3\r\n";
  let script = dir.0.join("root/hello.bat");
  fs::write(&script, encoding_rs::GB18030.encode(content).0).unwrap();
  let script = script.display().to_string();

  let info = inspect(&roots, &request("b1", &script, &["big world"])).unwrap();
  assert_eq!(info.kind, "批处理脚本");
  assert!(info.command.ends_with("hello.bat\" \"big world\"") || info.command.ends_with("hello.bat \"big world\""), "{}", info.command);
  assert!(info.preview.starts_with("@echo off\necho hello %~1"), "{}", info.preview);
  assert_eq!(info.lines, 5);

  // 参数中带空格也作为一个参数传入；工作目录默认为脚本所在的文件夹
  let result = run(&roots, &request("b1", &script, &["big world"])).unwrap();
  assert_eq!(result.exit_code, Some(3));
  let lines: Vec<&str> = result.stdout.lines().collect();
  assert_eq!(lines[0], "hello big world");
  assert_eq!(lines[1], dir.0.join("root").display().to_string());
  assert_eq!(result.stderr.trim(), "出错了");
  assert!(!result.timed_out && !result.cancelled);

  // 指定工作目录
  let custom = RunRequest { working_dir: Some(dir.0.join("root/sub").display().to_string()), ..request("b2", &script, &[]) };
  assert_eq!(run(&roots, &custom).unwrap().stdout.lines().nth(1), Some(dir.0.join("root").join("sub").display().to_string().as_str()));
}

#[cfg(windows)]
#[test]
fn stops_scripts_on_timeout_or_cancel() {
  let dir = TempDir::new("stop");
  let roots = dir.roots();
  let script = dir.write("root/slow.ps1", "Write-Output 'started'\nStart-Sleep -Seconds 30\nWrite-Output 'never'\n");

  let timeout = RunRequest { timeout_seconds: Some(3), ..request("s1", &script, &[]) };
  let result = run(&roots, &timeout).unwrap();
  assert!(result.timed_out && result.exit_code.is_none());
  assert!(result.duration_ms < 10_000, "{}", result.duration_ms);
  assert!(result.stdout.contains("started") && !result.stdout.contains("never"), "{}", result.stdout);

  let canceller = thread::spawn(|| {
    thread::sleep(Duration::from_millis(1500));
    cancel("s2")
  });
  let result = run(&roots, &request("s2", &script, &[])).unwrap();
  assert!(canceller.join().unwrap());
  assert!(result.cancelled && result.exit_code.is_none());
  assert!(result.duration_ms < 10_000, "{}", result.duration_ms);
  // 已经结束的脚本不能再取消
  assert!(!cancel("s2"));
}

#[test]
fn runs_python_scripts_when_available() {
  let python_available = runtimes().iter().any(|runtime| runtime.kind == "Python 脚本" && runtime.path.is_some());
  if !python_available {
    return;
  }
  let dir = TempDir::new("python");
  let roots = dir.roots();
  let script = dir.write("root/hi.py", "import sys\nprint('你好', sys.argv[1:])\nprint('x' * 100000)\n");
  let result = run(&roots, &request("p1", &script, &["a b", "--flag"])).unwrap();
  assert_eq!(result.exit_code, Some(0), "{}", result.stderr);
  assert!(result.stdout.starts_with("你好 ['a b', '--flag']"), "{}", &result.stdout[..100.min(result.stdout.len())]);
  // 输出过长时保留开头与结尾
  assert!(result.stdout_truncated && result.stdout.contains("中间省略"));
}

// ===== 直接运行一段代码 =====

fn code(run_id: &str, language: &str, source: &str, args: &[&str]) -> CodeRequest {
  CodeRequest {
    run_id: run_id.into(),
    language: language.into(),
    code: source.into(),
    args: args.iter().map(|a| a.to_string()).collect(),
    working_dir: None,
    timeout_seconds: None,
    cleanup_office: false,
  }
}

fn available(kind: &str) -> bool {
  runtimes().iter().any(|runtime| runtime.kind == kind && runtime.path.is_some())
}

#[test]
fn checks_code_before_running() {
  let dir = TempDir::new("code-check");
  let roots = dir.roots();

  // 授权卡片展示全部代码；工作目录默认为第一个授权文件夹
  let source = (1..=200).map(|n| format!("print({n})")).collect::<Vec<_>>().join("\n");
  let info = inspect_code(&roots, &code("c1", "python", &source, &[])).unwrap();
  assert_eq!((info.kind, info.lines, info.preview_truncated), ("Python 代码", 200, false));
  assert_eq!(info.preview, source);
  assert_eq!(info.working_dir, dir.0.join("root").display().to_string());

  let error = |request: CodeRequest| inspect_code(&roots, &request).unwrap_err();
  assert!(error(code("c1", "ruby", "puts 1", &[])).contains("不支持的语言"));
  assert!(error(code("c1", "python", "  \n", &[])).contains("不能为空"));
  assert!(error(code("c1", "python", &"x".repeat(20_001), &[])).contains("代码太长"));
  let outside = CodeRequest { working_dir: Some(dir.0.display().to_string()), ..code("c1", "python", "print(1)", &[]) };
  assert!(error(outside).contains("不在授权"));
}

#[test]
fn runs_python_and_javascript_code_from_stdin() {
  let dir = TempDir::new("code-stdin");
  let roots = dir.roots();
  if available("Python 脚本") {
    let source = "import os, sys\nprint('你好', sys.argv[1:])\nprint(os.getcwd())\n";
    let result = run_code(&roots, &code("py1", "python", source, &["a b", "--x"])).unwrap();
    assert_eq!(result.exit_code, Some(0), "{}", result.stderr);
    let lines: Vec<&str> = result.stdout.lines().collect();
    assert_eq!(lines, vec!["你好 ['a b', '--x']", dir.0.join("root").display().to_string().as_str()]);
  }
  if available("JavaScript 脚本") {
    let result = run_code(&roots, &code("js1", "javascript", "console.log('你好', process.argv.slice(2).join('|'))", &["a b", "c"])).unwrap();
    assert_eq!(result.exit_code, Some(0), "{}", result.stderr);
    assert_eq!(result.stdout.trim(), "你好 a b|c");
  }
  if available("Shell 脚本") {
    let result = run_code(&roots, &code("sh1", "shell", "echo \"你好 $1\"\r\necho \"$#\"", &["a b"])).unwrap();
    assert_eq!(result.exit_code, Some(0), "{}", result.stderr);
    assert_eq!(result.stdout.trim(), "你好 a b\n1");
  }
}

#[cfg(windows)]
#[test]
fn runs_powershell_and_batch_code_on_windows() {
  let dir = TempDir::new("code-windows");
  let roots = dir.roots();

  // 多行代码块、参数中的单引号、中文输出
  let source = "if ($args.Count -gt 0) {\n  Write-Output \"参数：$($args[0])\"\n}\nWrite-Output (Get-Location).Path\nexit 2";
  let result = run_code(&roots, &code("ps1", "powershell", source, &["it's 好"])).unwrap();
  assert_eq!(result.exit_code, Some(2), "{}", result.stderr);
  assert!(result.stderr.trim().is_empty(), "{}", result.stderr);
  let lines: Vec<&str> = result.stdout.lines().collect();
  assert_eq!(lines, vec!["参数：it's 好", dir.0.join("root").display().to_string().as_str()]);
  assert!(result.command.contains("-EncodedCommand （编码后的代码）"), "{}", result.command);

  // 批处理：跳转标签与中文；临时文件在运行结束后删除
  let source = "@echo off\ngoto :main\necho 不应该输出\n:main\necho 你好 %~1\nexit /b 0";
  let result = run_code(&roots, &code("bat-1", "batch", source, &["a b"])).unwrap();
  assert_eq!(result.exit_code, Some(0), "{}", result.stderr);
  assert_eq!(result.stdout.trim(), "你好 a b");
  assert!(!std::env::temp_dir().join("desktop-pet-scripts").join("bat-1.bat").exists());
}

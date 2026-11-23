use std::{
  fs,
  io::Write,
  path::{Path, PathBuf},
};

use super::ops::{apply_moves, create_folder, list, plan_organize, search, FileMove, OrganizeBy, SearchRequest};
use super::read::{decode, extract_xml_text, read_text};
use super::roots::{validate_root, Roots};
use super::write::{self, TextEdit, WriteRequest};

/// 测试用的临时目录，结束时自动删除
struct TempDir(PathBuf);

impl TempDir {
  fn new(name: &str) -> Self {
    let dir = std::env::temp_dir().join(format!("desktop-pet-files-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Self(dunce::canonicalize(&dir).unwrap())
  }

  fn path(&self, relative: &str) -> PathBuf {
    self.0.join(relative)
  }

  fn write(&self, relative: &str, bytes: &[u8]) -> PathBuf {
    let path = self.path(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, bytes).unwrap();
    path
  }

  fn roots(&self, relative: &str) -> Roots {
    Roots::new(&[self.path(relative).display().to_string()]).unwrap()
  }
}

impl Drop for TempDir {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.0);
  }
}

fn s(path: &Path) -> String {
  path.display().to_string()
}

fn names(entries: &[super::ops::FileEntry]) -> Vec<String> {
  let mut names: Vec<String> = entries.iter().map(|e| e.name.clone()).collect();
  names.sort();
  names
}

// ===== 授权文件夹 =====

#[test]
fn rejects_paths_outside_roots() {
  let dir = TempDir::new("roots");
  dir.write("allowed/a.txt", b"a");
  let secret = dir.write("other/secret.txt", b"secret");
  let roots = dir.roots("allowed");

  assert!(roots.resolve(&s(&dir.path("allowed/a.txt"))).is_ok());
  assert!(roots.resolve(&s(&secret)).is_err());
  // 规范化后会解析 ..，同样不允许跳出授权文件夹
  assert!(roots.resolve(&format!("{}/../other/secret.txt", s(&dir.path("allowed")))).is_err());
  assert!(roots.resolve("a.txt").is_err(), "必须使用完整路径");
  assert!(roots.resolve(&s(&dir.path("allowed/missing.txt"))).is_err());

  // 还不存在的目标路径
  assert!(roots.resolve_new(&s(&dir.path("allowed/new/sub/file.txt"))).is_ok());
  assert!(roots.resolve_new(&s(&dir.path("other/new.txt"))).is_err());
  assert!(roots.resolve_new(&format!("{}/x/../../other/y.txt", s(&dir.path("allowed")))).is_err());

  assert!(Roots::new(&[s(&dir.path("missing"))]).is_err(), "没有可用的授权文件夹");
}

#[test]
fn validates_roots() {
  let dir = TempDir::new("validate");
  dir.write("docs/a.txt", b"a");
  assert!(validate_root(&s(&dir.path("docs"))).is_ok());
  assert!(validate_root(&s(&dir.path("docs/a.txt"))).is_err(), "必须是文件夹");
  #[cfg(windows)]
  {
    assert!(validate_root("C:\\").is_err(), "不能授权整个磁盘");
    assert!(validate_root("C:\\Windows").is_err(), "不能授权系统目录");
  }
}

// ===== 查找与列出 =====

#[test]
fn searches_files() {
  let dir = TempDir::new("search");
  dir.write("docs/2026年度报告.docx", b"x");
  dir.write("docs/报告草稿.txt", "这里有合同编号 A-1024".as_bytes());
  dir.write("docs/notes.md", b"meeting notes");
  dir.write("docs/sub/deep/年度计划.txt", b"plan");
  dir.write("docs/.hidden/报告.txt", b"hidden");
  dir.write("docs/node_modules/报告.txt", b"dependency");
  let roots = dir.roots("docs");

  let by_keyword = search(&roots, &SearchRequest { keywords: vec!["报告".into()], limit: 50, ..Default::default() }).unwrap();
  assert_eq!(names(&by_keyword.entries), vec!["2026年度报告.docx", "报告草稿.txt"], "跳过隐藏目录与依赖目录");

  let by_keywords = search(&roots, &SearchRequest { keywords: vec!["年度".into(), "计划".into()], limit: 50, ..Default::default() }).unwrap();
  assert_eq!(names(&by_keywords.entries), vec!["年度计划.txt"], "会查找子文件夹");

  let by_extension = search(&roots, &SearchRequest { extensions: vec![".TXT".into()], limit: 50, ..Default::default() }).unwrap();
  assert_eq!(names(&by_extension.entries), vec!["年度计划.txt", "报告草稿.txt"]);

  let by_content = search(&roots, &SearchRequest { contains: Some("合同编号".into()), limit: 50, ..Default::default() }).unwrap();
  assert_eq!(names(&by_content.entries), vec!["报告草稿.txt"]);

  let limited = search(&roots, &SearchRequest { limit: 1, ..Default::default() }).unwrap();
  assert_eq!(limited.entries.len(), 1);
  assert!(limited.truncated);

  let with_dirs = search(&roots, &SearchRequest { keywords: vec!["sub".into()], include_dirs: true, limit: 50, ..Default::default() }).unwrap();
  assert!(with_dirs.entries.iter().any(|e| e.is_dir && e.name == "sub"));

  // 只能在授权文件夹内查找
  assert!(search(&roots, &SearchRequest { folders: vec![s(&dir.0)], limit: 50, ..Default::default() }).is_err());
}

#[test]
fn lists_folders_first() {
  let dir = TempDir::new("list");
  dir.write("root/b.txt", b"b");
  dir.write("root/A.txt", b"a");
  dir.write("root/sub/c.txt", b"c");
  dir.write("root/.hidden", b"h");
  let roots = dir.roots("root");
  let (entries, total) = list(&roots, &s(&dir.path("root")), 10).unwrap();
  assert_eq!(entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["sub", "A.txt", "b.txt"]);
  assert_eq!(total, 3);
}

// ===== 读取 =====

#[test]
fn decodes_text_in_common_encodings() {
  assert_eq!(decode("你好 hello".as_bytes()).unwrap(), ("你好 hello".to_string(), "UTF-8"));

  let (gbk, _, _) = encoding_rs::GBK.encode("你好世界");
  assert_eq!(decode(&gbk).unwrap(), ("你好世界".to_string(), "GB18030"));

  let mut utf16 = vec![0xFF, 0xFE];
  utf16.extend("你好".encode_utf16().flat_map(u16::to_le_bytes));
  assert_eq!(decode(&utf16).unwrap().0, "你好");

  assert!(decode(&[0x89, b'P', b'N', b'G', 0, 0, 0, 13]).is_none(), "二进制文件");
}

fn write_zip(path: &Path, entries: &[(&str, &str)]) {
  let file = fs::File::create(path).unwrap();
  let mut zip = zip::ZipWriter::new(file);
  let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
  for (name, content) in entries {
    zip.start_file(*name, options).unwrap();
    zip.write_all(content.as_bytes()).unwrap();
  }
  zip.finish().unwrap();
}

#[test]
fn reads_office_documents() {
  let dir = TempDir::new("office");
  let docx = dir.path("报告.docx");
  write_zip(&docx, &[(
    "word/document.xml",
    r#"<w:document><w:body><w:p><w:r><w:t>第一段</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve"> A &amp; B</w:t></w:r></w:p><w:p><w:pPr/><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>"#,
  )]);
  let text = read_text(&docx).unwrap();
  assert_eq!(text.format, "docx");
  assert_eq!(text.content, "第一段 A & B\n第二段");

  let pptx = dir.path("汇报.pptx");
  write_zip(&pptx, &[
    ("ppt/slides/slide2.xml", "<p:sld><a:p><a:r><a:t>总结</a:t></a:r></a:p></p:sld>"),
    ("ppt/slides/slide1.xml", "<p:sld><a:p><a:r><a:t>标题</a:t></a:r></a:p><a:p><a:r><a:t>副标题</a:t></a:r></a:p></p:sld>"),
  ]);
  assert_eq!(read_text(&pptx).unwrap().content, "【第 1 页】\n标题\n副标题\n\n【第 2 页】\n总结");

  let pdf = dir.write("扫描件.pdf", b"%PDF-1.7");
  assert!(read_text(&pdf).is_err());
  let binary = dir.write("data.bin", &[0, 1, 2, 3]);
  assert!(read_text(&binary).is_err());
}

#[test]
fn extracts_xml_text() {
  assert_eq!(extract_xml_text("<a:p><a:t>1 &lt; 2</a:t></a:p><a:p><a:t/></a:p>", "a:t", "a:p"), "1 < 2");
  // 不会把 <w:tbl>、<w:tab/> 当成 <w:t>
  assert_eq!(extract_xml_text("<w:tbl><w:p><w:t>格</w:t><w:tab/></w:p></w:tbl>", "w:t", "w:p"), "格");
}

// ===== 整理与移动 =====

#[test]
fn plans_organizing_by_type() {
  let dir = TempDir::new("organize");
  dir.write("downloads/照片.JPG", b"x");
  dir.write("downloads/合同.pdf", b"x");
  dir.write("downloads/数据.xlsx", b"x");
  dir.write("downloads/安装包.exe", b"x");
  dir.write("downloads/无扩展名", b"x");
  dir.write("downloads/快捷方式.lnk", b"x");
  dir.write("downloads/desktop.ini", b"x");
  dir.write("downloads/.hidden.txt", b"x");
  dir.write("downloads/旧文件夹/a.txt", b"x");
  let roots = dir.roots("downloads");
  let folder = dir.path("downloads");

  let plan = plan_organize(&roots, &s(&folder), OrganizeBy::Type, 0).unwrap();
  let mut targets: Vec<String> = plan
    .iter()
    .map(|m| Path::new(&m.to).strip_prefix(&folder).unwrap().display().to_string().replace('\\', "/"))
    .collect();
  targets.sort();
  // 快捷方式、系统文件、隐藏文件与子文件夹不会被移动
  assert_eq!(targets, vec!["其他/无扩展名", "图片/照片.JPG", "安装程序/安装包.exe", "文档/合同.pdf", "表格/数据.xlsx"]);

  let by_extension = plan_organize(&roots, &s(&folder), OrganizeBy::Extension, 0).unwrap();
  assert!(by_extension.iter().any(|m| m.to.ends_with(&format!("JPG{}照片.JPG", std::path::MAIN_SEPARATOR))));
  let by_month = plan_organize(&roots, &s(&folder), OrganizeBy::Month, 0).unwrap();
  assert_eq!(by_month.len(), 5);
}

#[test]
fn moves_files_and_can_move_them_back() {
  let dir = TempDir::new("move");
  let a = dir.write("root/a.txt", b"new");
  dir.write("root/archive/a.txt", b"old");
  dir.write("other/b.txt", b"b");
  let roots = dir.roots("root");

  // 目标已存在时加上编号
  let report = apply_moves(&roots, &[FileMove { from: s(&a), to: s(&dir.path("root/archive/a.txt")) }]);
  assert!(report.failed.is_empty(), "{:?}", report.failed);
  assert!(report.moved[0].to.ends_with("a (1).txt"));
  assert_eq!(fs::read(dir.path("root/archive/a.txt")).unwrap(), b"old");
  assert!(!a.exists());

  // 撤销：反向移动
  let back: Vec<FileMove> = report.moved.iter().map(|m| FileMove { from: m.to.clone(), to: m.from.clone() }).collect();
  assert!(apply_moves(&roots, &back).failed.is_empty());
  assert_eq!(fs::read(&a).unwrap(), b"new");

  // 不能移出授权文件夹，也不能把文件夹移到它自己里面；单个失败不影响其他
  let report = apply_moves(&roots, &[
    FileMove { from: s(&a), to: s(&dir.path("other/a.txt")) },
    FileMove { from: s(&dir.path("root/archive")), to: s(&dir.path("root/archive/inner/archive")) },
    FileMove { from: s(&a), to: s(&dir.path("root/docs/a.txt")) },
  ]);
  assert_eq!(report.failed.len(), 2);
  assert_eq!(report.moved.len(), 1);
  assert!(dir.path("root/docs/a.txt").exists());
}

#[test]
fn creates_folders_inside_roots() {
  let dir = TempDir::new("create");
  fs::create_dir_all(dir.path("root")).unwrap();
  let roots = dir.roots("root");
  let created = create_folder(&roots, &s(&dir.path("root/新建/子文件夹"))).unwrap();
  assert!(Path::new(&created).is_dir());
  assert!(create_folder(&roots, &s(&dir.path("outside"))).is_err());
}

// ===== 写入与修改 =====

fn create(path: &Path, content: &str) -> WriteRequest {
  WriteRequest { path: s(path), content: Some(content.into()), ..Default::default() }
}

fn edit(path: &Path, edits: &[(&str, &str)], append: Option<&str>) -> WriteRequest {
  WriteRequest {
    path: s(path),
    edits: edits.iter().map(|(old, new)| TextEdit { old_text: old.to_string(), new_text: new.to_string() }).collect(),
    append: append.map(str::to_string),
    ..Default::default()
  }
}

fn gbk(text: &str) -> Vec<u8> {
  encoding_rs::GB18030.encode(text).0.into_owned()
}

fn utf16le(text: &str) -> Vec<u8> {
  [0xFF, 0xFE].into_iter().chain(text.encode_utf16().flat_map(u16::to_le_bytes)).collect()
}

#[test]
fn creates_files_and_overwrites_only_when_asked() {
  let dir = TempDir::new("write-create");
  let backups = TempDir::new("write-create-backups");
  let roots = dir.roots("");
  let path = dir.path("笔记/todo.md");

  let preview = write::preview(&roots, &create(&path, "买牛奶\r\n交周报\n")).unwrap();
  assert!(preview.created && preview.before_hash.is_none());
  assert_eq!(preview.summary, "新建文件，共 2 行");
  assert_eq!(preview.preview, "+ 买牛奶\n+ 交周报");

  // 父文件夹自动创建，换行统一为 \n
  let result = write::apply(&roots, &create(&path, "买牛奶\r\n交周报\n"), None, &backups.0).unwrap();
  assert!(result.created && result.backup_id.is_none());
  assert_eq!(fs::read_to_string(&path).unwrap(), "买牛奶\n交周报\n");

  // 已存在时不覆盖，除非明确要求
  let error = write::preview(&roots, &create(&path, "别的内容")).unwrap_err();
  assert!(error.contains("已经存在"), "{error}");
  let overwrite = WriteRequest { overwrite: true, ..create(&path, "买牛奶\n写日报\n") };
  let preview = write::preview(&roots, &overwrite).unwrap();
  assert!(!preview.created);
  assert!(preview.summary.starts_with("覆盖整个文件"), "{}", preview.summary);
  assert_eq!(preview.preview, "第 2 行起：\n- 交周报\n+ 写日报");
}

#[test]
fn edits_keep_encoding_and_line_endings() {
  let dir = TempDir::new("write-encoding");
  let backups = TempDir::new("write-encoding-backups");
  let roots = dir.roots("");

  // GBK + CRLF
  let config = dir.write("配置.ini", &gbk("[服务]\r\n端口=8080\r\n名称=桌宠\r\n"));
  let request = edit(&config, &[("端口=8080", "端口=9090")], Some("日志=开启"));
  let preview = write::preview(&roots, &request).unwrap();
  assert_eq!(preview.encoding, "GBK");
  assert_eq!(preview.summary, "修改了 1 处，在末尾追加了 1 行");
  assert_eq!(preview.preview, "第 2 行：\n- 端口=8080\n+ 端口=9090\n\n末尾追加：\n+ 日志=开启");
  write::apply(&roots, &request, preview.before_hash.as_deref(), &backups.0).unwrap();
  assert_eq!(fs::read(&config).unwrap(), gbk("[服务]\r\n端口=9090\r\n名称=桌宠\r\n日志=开启"));

  // UTF-16 LE（带 BOM）
  let notes = dir.write("notes.txt", &utf16le("hello world"));
  let request = edit(&notes, &[("world", "世界")], None);
  let preview = write::preview(&roots, &request).unwrap();
  write::apply(&roots, &request, preview.before_hash.as_deref(), &backups.0).unwrap();
  assert_eq!(fs::read(&notes).unwrap(), utf16le("hello 世界"));

  // UTF-8 BOM
  let readme = dir.write("readme.md", b"\xEF\xBB\xBF# Title\n");
  let request = edit(&readme, &[("Title", "标题")], None);
  let preview = write::preview(&roots, &request).unwrap();
  write::apply(&roots, &request, preview.before_hash.as_deref(), &backups.0).unwrap();
  assert_eq!(fs::read(&readme).unwrap(), "\u{FEFF}# 标题\n".as_bytes());
}

#[test]
fn rejects_ambiguous_or_destructive_edits() {
  let dir = TempDir::new("write-errors");
  let roots = dir.roots("");
  let path = dir.write("a.txt", b"apple apple\nbanana\n");
  let error = |request: WriteRequest| write::preview(&roots, &request).unwrap_err();

  assert!(error(edit(&path, &[("cherry", "x")], None)).contains("没有在文件中找到"));
  assert!(error(edit(&path, &[("apple", "pear")], None)).contains("出现了 2 次"));
  assert!(error(edit(&path, &[("", "x")], None)).contains("不能为空"));
  assert!(error(edit(&path, &[("banana", "banana")], None)).contains("相同"));
  assert!(error(WriteRequest { overwrite: true, ..create(&path, " \n ") }).contains("不能清空"));
  assert!(error(edit(&path, &[("apple apple\nbanana\n", "")], None)).contains("不能清空"));
  assert!(error(WriteRequest { overwrite: true, ..create(&path, "apple apple\nbanana\n") }).contains("与原来相同"));
  assert!(error(edit(&dir.path("missing.txt"), &[("a", "b")], None)).contains("找不到"));
  let binary = dir.write("data.json", b"{\x00\x01}");
  assert!(error(edit(&binary, &[("{", "[")], None)).contains("不是文本文件"));

  // 多处修改依次执行
  let preview = write::preview(&roots, &edit(&path, &[("apple apple", "apple pie"), ("banana", "cherry")], None)).unwrap();
  assert_eq!(preview.summary, "修改了 2 处");
}

#[test]
fn refuses_unsafe_targets() {
  let dir = TempDir::new("write-unsafe");
  dir.write("inside/keep.txt", b"x");
  let roots = dir.roots("inside");
  let error = |relative: &str| write::preview(&roots, &create(&dir.path(relative), "内容")).unwrap_err();

  assert!(error("inside/run.bat").contains("脚本"));
  assert!(error("inside/run.ps1").contains("脚本"));
  assert!(error("inside/app.exe").contains("不能写入 .exe"));
  assert!(error("inside/报告.doc").contains("旧版"));
  assert!(error("inside/Makefile").contains("带扩展名"));
  assert!(error("inside/.git/hooks.txt").contains("隐藏"));
  assert!(error("inside/~$报告.txt").contains("隐藏"));
  assert!(error("outside.txt").contains("不在授权"));
  assert!(error("inside/../outside.txt").contains(".."));
}

#[test]
fn verifies_hashes_and_undoes_writes() {
  let dir = TempDir::new("write-undo");
  let backups = TempDir::new("write-undo-backups");
  let roots = dir.roots("");
  let path = dir.write("plan.md", b"v1\n");
  let request = edit(&path, &[("v1", "v2")], None);

  // 确认期间文件被改动：不写入
  let stale = write::preview(&roots, &request).unwrap();
  fs::write(&path, b"v1\nnew line\n").unwrap();
  let error = write::apply(&roots, &request, stale.before_hash.as_deref(), &backups.0).unwrap_err();
  assert!(error.contains("确认期间"), "{error}");
  assert_eq!(fs::read(&path).unwrap(), b"v1\nnew line\n");

  // 修改后撤销：恢复原内容并删除备份
  fs::write(&path, b"v1\n").unwrap();
  let preview = write::preview(&roots, &request).unwrap();
  let result = write::apply(&roots, &request, preview.before_hash.as_deref(), &backups.0).unwrap();
  assert_eq!(fs::read(&path).unwrap(), b"v2\n");
  write::undo(&roots, &result.path, result.backup_id.as_deref(), &result.after_hash, &backups.0).unwrap();
  assert_eq!(fs::read(&path).unwrap(), b"v1\n");
  assert_eq!(fs::read_dir(&backups.0).unwrap().count(), 0);

  // 之后又被改动过：不撤销
  let result = write::apply(&roots, &request, preview.before_hash.as_deref(), &backups.0).unwrap();
  fs::write(&path, b"v3\n").unwrap();
  let error = write::undo(&roots, &result.path, result.backup_id.as_deref(), &result.after_hash, &backups.0).unwrap_err();
  assert!(error.contains("又被修改过"), "{error}");
  assert_eq!(fs::read(&path).unwrap(), b"v3\n");

  // 撤销新建：删除这个文件
  let new_file = dir.path("new.txt");
  let result = write::apply(&roots, &create(&new_file, "hi"), None, &backups.0).unwrap();
  write::undo(&roots, &result.path, None, &result.after_hash, &backups.0).unwrap();
  assert!(!new_file.exists());

  // 备份 id 不能用来访问其他位置
  let result = write::apply(&roots, &create(&new_file, "hi"), None, &backups.0).unwrap();
  assert!(write::undo(&roots, &result.path, Some("../plan"), &result.after_hash, &backups.0).is_err());
  assert!(new_file.exists());
}

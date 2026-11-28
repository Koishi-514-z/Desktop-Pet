//! 由脚本修改的文件（运行前检查与备份、运行后记录改动与撤销）、Office 支持的检测，
//! 以及「Office 文档」技能中示例代码的测试。
//!
//! 示例代码与前端技能说明中展示给 LLM 的是同一份文件（src/agent/skills/office-examples）。
//! 需要 Microsoft Office 或 Python 库的测试默认跳过，手动运行：
//! `cargo test --lib office_tests -- --ignored --test-threads=1`

use std::{
  fs,
  io::Cursor,
  path::{Path, PathBuf},
};

use super::office_check::check_file;
use super::read::read_text;
use super::roots::Roots;
use super::script::{office_processes, office_support, run_code, CodeRequest, RunResult};
use super::write::{check_targets, settle_targets, snapshot_targets, undo};

struct TempDir(PathBuf);

impl TempDir {
  fn new(name: &str) -> Self {
    let dir = std::env::temp_dir().join(format!("desktop-pet-office-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Self(dunce::canonicalize(&dir).unwrap())
  }

  fn path(&self, name: &str) -> PathBuf {
    self.0.join(name)
  }

  fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
    let path = self.path(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, bytes).unwrap();
    path
  }

  fn roots(&self) -> Roots {
    Roots::new(&[self.0.display().to_string()]).unwrap()
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

// ===== 运行前检查与备份，运行后记录改动 =====

#[test]
fn backs_up_targets_and_records_changes_for_undo() {
  let dir = TempDir::new("targets");
  let backups = TempDir::new("targets-backups");
  let roots = dir.roots();
  let modified = dir.write("a.txt", b"v1");
  let unchanged = dir.write("b.txt", b"same");
  let removed = dir.write("c.txt", b"bye");
  let created = dir.path("sub").join("d.txt");
  // 重复的路径只算一次
  let paths: Vec<String> = [&modified, &unchanged, &removed, &created, &modified].iter().map(|p| s(p)).collect();

  let infos = check_targets(&roots, &paths).unwrap();
  assert_eq!(infos.iter().map(|info| info.exists).collect::<Vec<_>>(), [true, true, true, false]);

  let snapshots = snapshot_targets(&roots, &paths, &backups.0).unwrap();
  assert_eq!(fs::read_dir(&backups.0).unwrap().count(), 3);

  // 模拟脚本的改动
  fs::write(&modified, b"v2").unwrap();
  fs::remove_file(&removed).unwrap();
  fs::create_dir_all(created.parent().unwrap()).unwrap();
  fs::write(&created, b"new").unwrap();

  let changes = settle_targets(&roots, &snapshots, &backups.0);
  let change = |path: &Path| changes.iter().find(|change| change.path == s(path)).unwrap();
  let flags = |path: &Path| {
    let c = change(path);
    (c.changed, c.created, c.deleted, c.backup_id.is_some(), c.after_hash.is_some(), c.error.is_none())
  };
  assert_eq!(flags(&modified), (true, false, false, true, true, true));
  assert_eq!(flags(&unchanged), (false, false, false, false, true, true));
  assert_eq!(flags(&removed), (true, false, true, true, false, true));
  assert_eq!(flags(&created), (true, true, false, false, true, true));
  // 没有变化的文件，备份已删除
  assert_eq!(fs::read_dir(&backups.0).unwrap().count(), 2);

  // 撤销：恢复修改前的内容、恢复被删除的文件、删除新建的文件
  for path in [&modified, &removed, &created] {
    let c = change(path);
    undo(&roots, &c.path, c.backup_id.as_deref(), c.after_hash.as_deref(), &backups.0).unwrap();
  }
  assert_eq!(fs::read(&modified).unwrap(), b"v1");
  assert_eq!(fs::read(&removed).unwrap(), b"bye");
  assert!(!created.exists());
}

#[test]
fn refuses_targets_that_cannot_be_safely_modified() {
  let dir = TempDir::new("targets-refuse");
  fs::create_dir_all(dir.path("inside")).unwrap();
  let roots = Roots::new(&[s(&dir.path("inside"))]).unwrap();
  let error = |paths: &[PathBuf]| check_targets(&roots, &paths.iter().map(|p| s(p)).collect::<Vec<_>>()).unwrap_err();

  assert!(error(&[]).contains("需要列出"));
  assert!(error(&[dir.path("outside.docx")]).contains("不在授权"));
  assert!(error(&[dir.path("inside/.git/a.docx")]).contains("隐藏"));
  assert!(error(&[dir.path("inside/~$报告.docx")]).contains("隐藏"));
  assert!(error(&[dir.path("inside/宏.xlsm")]).contains("带宏"));
  assert!(error(&[dir.path("inside")]).contains("是文件夹"));
  let many: Vec<PathBuf> = (0..21).map(|n| dir.path(&format!("inside/{n}.docx"))).collect();
  assert!(error(&many).contains("最多"));

  // 文件正被其他程序打开着（如在 Word 中打开）时，提示先关闭
  #[cfg(windows)]
  {
    let file = dir.write("inside/报告.docx", b"x");
    let handle = fs::File::open(&file).unwrap();
    assert!(error(std::slice::from_ref(&file)).contains("正在被其他程序使用"));
    drop(handle);
    assert!(check_targets(&roots, &[s(&file)]).is_ok());
  }
}

#[test]
fn detects_office_support() {
  let support = office_support();
  for library in &support.python_libraries {
    assert!(["python-docx", "openpyxl", "python-pptx"].contains(library), "{library}");
  }
}

// ===== 需要 Microsoft Office 或 Python 库的测试 =====

const WORD_EXAMPLE: &str = include_str!("../../../src/agent/skills/office-examples/word.ps1");
const EXCEL_EXAMPLE: &str = include_str!("../../../src/agent/skills/office-examples/excel.ps1");
const POWERPOINT_EXAMPLE: &str = include_str!("../../../src/agent/skills/office-examples/powerpoint.ps1");
const PYTHON_EXAMPLE: &str = include_str!("../../../src/agent/skills/office-examples/python.py");

/// 把示例中的 C:\Users\me\Desktop 换成测试目录后运行
fn run_example(roots: &Roots, dir: &Path, run_id: &str, language: &str, source: &str) -> RunResult {
  let code = source.replace(r"C:\Users\me\Desktop", &s(dir));
  let request = CodeRequest {
    run_id: run_id.into(),
    language: language.into(),
    code,
    args: Vec::new(),
    working_dir: None,
    timeout_seconds: Some(180),
    cleanup_office: language == "powershell",
  };
  let result = run_code(roots, &request).unwrap();
  assert_eq!(result.exit_code, Some(0), "{run_id}：\n{}\n{}", result.stdout, result.stderr);
  assert!(result.stderr.trim().is_empty(), "{run_id}：{}", result.stderr);
  result
}

fn has_chart(path: &Path) -> bool {
  let archive = zip::ZipArchive::new(Cursor::new(fs::read(path).unwrap())).unwrap();
  archive.file_names().any(|name| name.is_ok_and(|name| name.starts_with("xl/charts/chart")))
}

#[test]
#[ignore]
fn office_examples_work_with_microsoft_office() {
  let dir = TempDir::new("office-examples");
  let roots = dir.roots();

  let result = run_example(&roots, &dir.0, "word", "powershell", WORD_EXAMPLE);
  assert_eq!(result.note, None, "Word 应当正常退出");
  let text = read_text(&dir.path("会议纪要.docx")).unwrap().content;
  // 文档标题与一级标题、副标题、提示框、编号列表、表格、页眉（页脚中只有页码，不列出）
  assert_eq!(
    text,
    "# 产品发布会议纪要\n2026年11月24日 · 产品部 · 记录人：小李\n\n# 会议结论\n确定12月15日正式发布，发布前完成全部测试与文档。\n\n# 讨论事项\n1. 确定发布日期\n2. 分配测试任务\n\n# 任务分工\n\n| 任务 | 负责人 | 截止日期 |\n| --- | --- | --- |\n| 测试 | 小王 | 12月10日 |\n| 文档 | 小李 | 12月12日 |\n| 发布 | 小张 | 12月15日 |\n\n【页眉】\n产品发布会议纪要"
  );
  // 设计确实生效了：一级标题与表头是主题色（深蓝 1F4E79），提示框样式有浅色底与左侧竖线
  let mut archive = zip::ZipArchive::new(Cursor::new(fs::read(dir.path("会议纪要.docx")).unwrap())).unwrap();
  let mut read_entry = |name: &str| {
    let mut xml = String::new();
    std::io::Read::read_to_string(&mut archive.by_name(name).unwrap(), &mut xml).unwrap();
    xml
  };
  let styles = read_entry("word/styles.xml");
  assert!(styles.contains(r#"<w:color w:val="1F4E79"/>"#), "{styles}");
  let note = &styles[styles.find("提示框").expect("提示框样式")..];
  let note = &note[..note.find("</w:style>").unwrap()];
  assert!(note.contains(r#"w:fill="EAF1F8""#) && note.contains("<w:left "), "{note}");
  let document = read_entry("word/document.xml");
  assert!(document.contains(r#"w:fill="1F4E79""#), "表头没有深色底");
  assert!(read_text(&dir.path("会议纪要.pdf")).unwrap().content.contains("会议纪要"));
  // 示例是 LLM 照着写的样板，生成的文档要能通过自动检查
  assert_eq!(check_file(&dir.path("会议纪要.docx")).unwrap(), vec![]);

  // 第一次新建，第二次打开已有的工作簿修改
  for run in ["excel-new", "excel-open"] {
    let result = run_example(&roots, &dir.0, run, "powershell", EXCEL_EXAMPLE);
    assert_eq!(result.note, None, "Excel 应当正常退出");
  }
  let text = read_text(&dir.path("销售.xlsx")).unwrap().content;
  // 标题、说明、表头、数据（完成率由公式计算）、合计行
  assert!(text.contains("1 | 2026 年第一季度销售 |  |  | \n2 | 单位：元 |  |  | \n3 | 月份 | 销售额 | 目标 | 完成率\n4 | 一月 | 1200 | 1000 | 1.2\n"), "{text}");
  assert!(text.contains("7 | 合计 | 3680.5 | 3800 | 0.9685526316"), "{text}");
  assert!(has_chart(&dir.path("销售.xlsx")));
  assert_eq!(check_file(&dir.path("销售.xlsx")).unwrap(), vec![]);
  // 英文写法的数字格式在中文版 Excel 中也设置成功了（直接赋值会报「不能设置类 Range 的 NumberFormat 属性」）
  let mut archive = zip::ZipArchive::new(Cursor::new(fs::read(dir.path("销售.xlsx")).unwrap())).unwrap();
  let mut styles = String::new();
  std::io::Read::read_to_string(&mut archive.by_name("xl/styles.xml").unwrap(), &mut styles).unwrap();
  assert!(styles.contains("#,##0.00;[Red]"), "{styles}");
  // 通过方法调用 SeriesCollection(1)、Axes(2) 设置的数据标签与坐标轴标题
  let mut chart = String::new();
  std::io::Read::read_to_string(&mut archive.by_name("xl/charts/chart1.xml").unwrap(), &mut chart).unwrap();
  assert!(chart.contains(r#"<c:showVal val="1"/>"#) && chart.contains("金额（元）"), "{chart}");
  // 设计确实生效了：表头深色底（1F4E79），百分比格式，数据条，冻结表头、隐藏网格线；再次运行后只有一个图表
  assert!(styles.contains("1F4E79") && styles.contains("0.0%"), "{styles}");
  let mut sheet = String::new();
  std::io::Read::read_to_string(&mut archive.by_name("xl/worksheets/sheet1.xml").unwrap(), &mut sheet).unwrap();
  // 冻结窗格记为 frozen 或 frozenSplit
  assert!(sheet.contains(r#"state="frozen"#) && sheet.contains(r#"showGridLines="0""#) && sheet.contains(r#"<cfRule type="dataBar""#), "{sheet}");
  assert_eq!(archive.file_names().filter(|name| name.as_ref().is_ok_and(|name| name.starts_with("xl/charts/chart") && name.ends_with(".xml"))).count(), 1);

  let result = run_example(&roots, &dir.0, "powerpoint", "powershell", POWERPOINT_EXAMPLE);
  assert_eq!(result.note, None, "PowerPoint 应当正常退出");
  let text = read_text(&dir.path("年度总结.pptx")).unwrap().content;
  // 封面的标题与副标题用占位符（装饰的圆放到了最底层，没有文字）
  assert!(text.contains("【第 1 页】\n2026 年度总结\n市场部"), "{text}");
  // 每页按内容选择不同的版式：卡片、大数字、表格
  assert!(text.contains("【第 2 页】\n主要成果\n01\n销售额增长 20%\n02\n新增客户 120 家\n03\n推出 3 款新产品"), "{text}");
  assert!(text.contains("【第 3 页】\n关键数据\n270 万\n上半年销售额\n+25%\n二季度同比增长\n98%\n客户满意度"), "{text}");
  assert!(
    text.contains("【第 4 页】\n季度数据\n\n| 季度 | 销售额 | 同比 |\n| --- | --- | --- |\n| 一季度 | 120 万 | +12% |\n| 二季度 | 150 万 | +25% |"),
    "{text}"
  );
  // 空白页上添加的文本框
  assert!(text.contains("【第 5 页】\n谢谢观看\n欢迎提问与交流"), "{text}");
  assert!(result.stdout.contains("共 5 页"), "{}", result.stdout);

  // 设计确实生效了
  let mut archive = zip::ZipArchive::new(Cursor::new(fs::read(dir.path("年度总结.pptx")).unwrap())).unwrap();
  let mut read_entry = |name: &str| {
    let mut xml = String::new();
    std::io::Read::read_to_string(&mut archive.by_name(name).unwrap(), &mut xml).unwrap();
    xml
  };
  let slides: Vec<String> = (1..=5).map(|n| read_entry(&format!("ppt/slides/slide{n}.xml"))).collect();
  for (index, slide) in slides.iter().enumerate() {
    // 每页都有进入动画与切换效果
    assert!(slide.contains("<p:timing>") && slide.contains(r#"presetClass="entr""#), "第 {} 页没有进入动画：{slide}", index + 1);
    assert!(slide.contains("<p:transition"), "第 {} 页没有切换效果：{slide}", index + 1);
  }
  // 封面与结束页是渐变背景；内容页跟随母版的浅色背景，不是纯白
  for index in [0, 4] {
    assert!(slides[index].contains("<p:bg>") && slides[index].contains("<a:gradFill"), "第 {} 页：{}", index + 1, slides[index]);
  }
  let master = read_entry("ppt/slideMasters/slideMaster1.xml");
  assert!(master.contains(r#"<a:srgbClr val="F6F7FB"/>"#), "{master}");
  // 标题的格式：加粗、54 磅、白色，数字与中文都是微软雅黑（PowerPoint 的加粗要用 -1，用 $true 会报错）
  assert!(slides[0].contains(r#"sz="5400""#) && slides[0].contains(r#"b="1""#), "{}", slides[0]);
  assert!(slides[0].contains(r#"<a:latin typeface="微软雅黑""#) && slides[0].contains(r#"<a:ea typeface="微软雅黑""#), "{}", slides[0]);
  // 卡片中第一段（编号）的格式单独设置为强调色
  assert!(slides[1].contains(r#"<a:srgbClr val="FF6B57"/>"#), "{}", slides[1]);
  // 示例是 LLM 照着写的样板，生成的文稿要能通过自动检查
  assert_eq!(check_file(&dir.path("年度总结.pptx")).unwrap(), vec![]);
}

#[test]
#[ignore]
fn python_example_works_with_python_libraries() {
  let dir = TempDir::new("python-example");
  let roots = dir.roots();
  run_example(&roots, &dir.0, "python", "python", PYTHON_EXAMPLE);

  let text = read_text(&dir.path("会议纪要.docx")).unwrap().content;
  assert_eq!(
    text,
    "# 产品发布会议纪要\n2026年11月24日 · 产品部 · 记录人：小李\n\n# 讨论事项\n1. 确定发布日期\n2. 分配测试任务\n\n# 任务分工\n\n| 任务 | 负责人 | 截止日期 |\n| --- | --- | --- |\n| 测试 | 小王 | 12月10日 |\n| 文档 | 小李 | 12月12日 |\n\n【页眉】\n产品发布会议纪要"
  );
  let text = read_text(&dir.path("销售.xlsx")).unwrap().content;
  // openpyxl 不计算公式，完成率与合计没有计算结果
  assert!(text.contains("3 | 月份 | 销售额 | 目标 | 完成率\n4 | 一月 | 1200 | 1000 | \n5 | 二月 | 1500.5 | 1600 | \n6 | 三月 | 980 | 1200 | \n7 | 合计 |"), "{text}");
  assert!(has_chart(&dir.path("销售.xlsx")));
  // 示例生成的文档与表格要能通过自动检查
  assert_eq!(check_file(&dir.path("会议纪要.docx")).unwrap(), vec![]);
  assert_eq!(check_file(&dir.path("销售.xlsx")).unwrap(), vec![]);
  let text = read_text(&dir.path("年度总结.pptx")).unwrap().content;
  assert!(text.contains("【第 2 页】\n主要成果\n销售额增长 20%\n新增客户 120 家\n推出 3 款新产品"), "{text}");
}

#[test]
#[ignore]
fn cleans_up_office_left_running_by_a_timed_out_script() {
  let dir = TempDir::new("office-cleanup");
  let roots = dir.roots();
  let before = office_processes();

  // 脚本启动 Word 后一直等待，超时被结束；通过 COM 启动的 Word 不是脚本的子进程，会残留在后台
  let request = CodeRequest {
    run_id: "cleanup".into(),
    language: "powershell".into(),
    code: "$word = New-Object -ComObject Word.Application\n$word.Visible = $false\nWrite-Output 'started'\nStart-Sleep -Seconds 60".into(),
    args: Vec::new(),
    working_dir: None,
    timeout_seconds: Some(15),
    cleanup_office: true,
  };
  let result = run_code(&roots, &request).unwrap();
  assert!(result.timed_out, "{}", result.stderr);
  assert!(result.stdout.contains("started"));
  let note = result.note.unwrap_or_default();
  assert!(note.contains("winword.exe"), "{note}");

  let leftovers: Vec<u32> = office_processes().into_keys().filter(|pid| !before.contains_key(pid)).collect();
  assert!(leftovers.is_empty(), "仍有残留的 Office 进程：{leftovers:?}");
}

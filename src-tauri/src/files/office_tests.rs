//! Office 文件、PDF 的读取与写入测试

use std::{
  collections::HashMap,
  fs,
  io::{Cursor, Read, Write},
  path::PathBuf,
};

use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

use super::office::{create_docx, create_xlsx, edit_docx, edit_pptx, edit_xlsx, parse_rows, CellEdit};
use super::read::read_text;
use super::roots::Roots;
use super::write::{self, TextEdit, WriteRequest};

/// 测试用的临时目录，结束时自动删除
struct TempDir(PathBuf);

impl TempDir {
  fn new(name: &str) -> Self {
    let dir = std::env::temp_dir().join(format!("desktop-pet-office-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Self(dunce::canonicalize(&dir).unwrap())
  }

  fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
    let path = self.0.join(name);
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

fn edits(pairs: &[(&str, &str)]) -> Vec<TextEdit> {
  pairs.iter().map(|(old, new)| TextEdit { old_text: old.to_string(), new_text: new.to_string() }).collect()
}

fn zip_entries(entries: &[(&str, &[u8])]) -> Vec<u8> {
  let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
  for (name, content) in entries {
    writer.start_file(*name, SimpleFileOptions::default()).unwrap();
    writer.write_all(content).unwrap();
  }
  writer.finish().unwrap().into_inner()
}

fn unzip(bytes: &[u8]) -> HashMap<String, Vec<u8>> {
  let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
  (0..archive.len())
    .map(|index| {
      let mut entry = archive.by_index(index).unwrap();
      let mut content = Vec::new();
      entry.read_to_end(&mut content).unwrap();
      (entry.name().unwrap().to_string(), content)
    })
    .collect()
}

/// 压缩包中所有 XML 都必须是合法的 XML
fn assert_well_formed(bytes: &[u8]) {
  for (name, content) in unzip(bytes) {
    if !(name.ends_with(".xml") || name.ends_with(".rels")) {
      continue;
    }
    let mut reader = quick_xml::Reader::from_reader(content.as_slice());
    reader.config_mut().check_end_names = true;
    let mut buffer = Vec::new();
    loop {
      match reader.read_event_into(&mut buffer) {
        Ok(quick_xml::events::Event::Eof) => break,
        Ok(_) => buffer.clear(),
        Err(error) => panic!("{name} 不是合法的 XML：{error}"),
      }
    }
  }
}

const W: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main""#;

fn docx_with_body(body: &str) -> Vec<u8> {
  let document = format!(r#"<?xml version="1.0" encoding="UTF-8"?><w:document {W}><w:body>{body}</w:body></w:document>"#);
  zip_entries(&[("word/document.xml", document.as_bytes())])
}

fn document_xml(bytes: &[u8]) -> String {
  String::from_utf8(unzip(bytes)["word/document.xml"].clone()).unwrap()
}

#[test]
fn replaces_only_the_changed_part_to_keep_formatting() {
  let bold = |text: &str| format!(r#"<w:r><w:rPr><w:b/></w:rPr><w:t>{text}</w:t></w:r>"#);
  let plain = |text: &str| format!(r#"<w:r><w:t>{text}</w:t></w:r>"#);
  let original = docx_with_body(&format!("<w:p>{}{}</w:p>", bold("项目周报"), plain("：本周完成了开发")));

  // 「周报」加粗、「：本周」不加粗：只替换不同的「本」，加粗的部分不变
  let change = edit_docx(&original, &edits(&[("周报：本周", "周报：这周")]), None).unwrap();
  let xml = document_xml(&change.bytes);
  assert!(xml.contains(&bold("项目周报")), "{xml}");
  assert!(xml.contains(r#"<w:r><w:t xml:space="preserve">：这周完成了开发</w:t></w:r>"#), "{xml}");

  // 纯插入与纯删除
  let inserted = document_xml(&edit_docx(&original, &edits(&[("完成了开发", "完成了全部开发")]), None).unwrap().bytes);
  assert!(inserted.contains("：本周完成了全部开发"), "{inserted}");
  let removed = document_xml(&edit_docx(&original, &edits(&[("本周完成了开发", "本周完成")]), None).unwrap().bytes);
  assert!(removed.contains("：本周完成</w:t>"), "{removed}");
  assert!(removed.contains(&bold("项目周报")), "{removed}");
}

/// 一个最小的 docx：正文中「World」被拆成两段，其中一段加粗；附带一张图片
fn sample_docx() -> Vec<u8> {
  let document = format!(
    r#"<?xml version="1.0" encoding="UTF-8"?><w:document {W}><w:body><w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>Wor</w:t></w:r><w:r><w:t>ld!</w:t></w:r></w:p><w:p><w:r><w:t>重复 &amp; 重复</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>单元格</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>"#
  );
  zip_entries(&[
    ("[Content_Types].xml", br#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>"#),
    ("word/document.xml", document.as_bytes()),
    ("word/media/image1.png", &[0x89, b'P', b'N', b'G', 0, 1, 2, 3]),
  ])
}

#[test]
fn creates_word_documents_from_markdown() {
  let dir = TempDir::new("docx-create");
  let markdown = "# 周报\n\n本周完成了 **登录** 功能 & 优化。\n- 修复 Bug\n1. 第一步\n> 引用的话\n\n| 项目 | 进度 |\n|---|:---:|\n| 登录 | 100% |";
  let bytes = create_docx(markdown).unwrap();
  assert_well_formed(&bytes);

  let entries = unzip(&bytes);
  for name in ["[Content_Types].xml", "_rels/.rels", "word/_rels/document.xml.rels", "word/document.xml", "word/styles.xml"] {
    assert!(entries.contains_key(name), "缺少 {name}");
  }
  let document = String::from_utf8(entries["word/document.xml"].clone()).unwrap();
  assert!(document.contains(r#"<w:pStyle w:val="Heading1"/>"#));
  // 表格是正文最后的内容时，后面要补一个段落
  assert!(document.contains("</w:tbl><w:p/><w:sectPr>"));

  let text = read_text(&dir.write("周报.docx", &bytes)).unwrap().content;
  assert_eq!(text, "周报\n本周完成了 登录 功能 & 优化。\n• 修复 Bug\n1. 第一步\n引用的话\n项目\n进度\n登录\n100%");
}

#[test]
fn edits_word_text_across_runs_and_keeps_other_parts() {
  let dir = TempDir::new("docx-edit");
  let original = sample_docx();
  let change = edit_docx(&original, &edits(&[("World", "地球"), ("单元格", "表格里的字")]), Some("## 新的一节\n- 新增的要点")).unwrap();
  assert_well_formed(&change.bytes);
  assert_eq!(change.summary, "修改了 2 处，在末尾追加了 2 段");
  assert!(change.preview.starts_with("第 1 段：\n- Hello World!\n+ Hello 地球!"), "{}", change.preview);

  let entries = unzip(&change.bytes);
  // 其他内容原样保留
  assert_eq!(entries["word/media/image1.png"], unzip(&original)["word/media/image1.png"]);
  let document = String::from_utf8(entries["word/document.xml"].clone()).unwrap();
  // 新文字放进第一段被涉及的文字中，沿用它的加粗格式
  assert!(document.contains(r#"<w:b/></w:rPr><w:t xml:space="preserve">地球</w:t>"#), "{document}");
  // 追加的段落在页面设置之前
  assert!(document.find("新的一节").unwrap() < document.find("<w:sectPr").unwrap());

  let text = read_text(&dir.write("a.docx", &change.bytes)).unwrap().content;
  assert_eq!(text, "Hello 地球!\n重复 & 重复\n表格里的字\n新的一节\n• 新增的要点");

  // 找不到、出现多次、跨段落
  let error = |pairs: &[(&str, &str)]| edit_docx(&original, &edits(pairs), None).err().unwrap();
  assert!(error(&[("Hello World?", "x")]).contains("没有在文档中找到"));
  assert!(error(&[("重复", "x")]).contains("出现了 2 次"));
  assert!(error(&[("Hello World!\n重复", "x")]).contains("不能包含换行"));
  assert!(error(&[("Hello", "第一行\n第二行")]).contains("不能包含换行"));
}

fn sample_pptx() -> Vec<u8> {
  let slide = |text: &str| {
    format!(
      r#"<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:pPr/><a:r><a:rPr lang="zh-CN"/><a:t>{text}</a:t></a:r></a:p><a:p><a:r><a:t>谢谢</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#
    )
  };
  zip_entries(&[
    ("ppt/slides/slide1.xml", slide("年度总结").as_bytes()),
    ("ppt/slides/slide2.xml", slide("Q3 目标：增长 10%").as_bytes()),
  ])
}

#[test]
fn edits_powerpoint_text() {
  let dir = TempDir::new("pptx-edit");
  let original = sample_pptx();
  let change = edit_pptx(&original, &edits(&[("增长 10%", "增长 20%")])).unwrap();
  assert_well_formed(&change.bytes);
  assert_eq!(change.preview.trim(), "第 2 页：\n- Q3 目标：增长 10%\n+ Q3 目标：增长 20%");
  // 没有改动的幻灯片原样保留
  assert_eq!(unzip(&change.bytes)["ppt/slides/slide1.xml"], unzip(&original)["ppt/slides/slide1.xml"]);

  let text = read_text(&dir.write("a.pptx", &change.bytes)).unwrap().content;
  assert!(text.contains("【第 2 页】\nQ3 目标：增长 20%"), "{text}");

  // 每一页都有「谢谢」
  let error = edit_pptx(&original, &edits(&[("谢谢", "感谢")])).err().unwrap();
  assert!(error.contains("出现了 2 次"), "{error}");
}

#[test]
fn creates_and_edits_excel() {
  let dir = TempDir::new("xlsx");
  let (bytes, rows) = create_xlsx("姓名,工号,分数\n张三,001,90\n李四,002,85.5\n\"王, 五\",003,=SUM(C2:C3)").unwrap();
  assert_eq!(rows, 4);
  let path = dir.write("成绩.xlsx", &bytes);
  let text = read_text(&path).unwrap().content;
  assert!(text.starts_with("【工作表：Sheet1】共 4 行 × 3 列\n行 | A | B | C\n1 | 姓名 | 工号 | 分数\n2 | 张三 | 001 | 90\n3 | 李四 | 002 | 85.5\n4 | 王, 五 | 003"), "{text}");

  let cells = vec![
    CellEdit { sheet: None, cell: "c3".into(), value: "95".into() },
    CellEdit { sheet: Some("sheet1".into()), cell: "D1".into(), value: "备注".into() },
  ];
  let change = edit_xlsx(&bytes, &cells, Some("赵六\t004\t88"), None).unwrap();
  assert_eq!(change.summary, "修改了 2 个单元格，在「Sheet1」追加了 1 行");
  assert!(change.preview.starts_with("Sheet1!C3：85.5 → 95\nSheet1!D1：（空） → 备注\n\n在「Sheet1」第 5 行起追加：\n+ 赵六 | 004 | 88"), "{}", change.preview);

  let text = read_text(&dir.write("成绩2.xlsx", &change.bytes)).unwrap().content;
  assert!(text.contains("1 | 姓名 | 工号 | 分数 | 备注"), "{text}");
  assert!(text.contains("3 | 李四 | 002 | 95 | "), "{text}");
  assert!(text.contains("5 | 赵六 | 004 | 88 | "), "{text}");

  let error = |cell: &str, sheet: Option<&str>| {
    edit_xlsx(&bytes, &[CellEdit { sheet: sheet.map(str::to_string), cell: cell.into(), value: "1".into() }], None, None).err().unwrap()
  };
  assert!(error("3B", None).contains("无效的单元格位置"));
  assert!(error("A0", None).contains("无效的单元格位置"));
  assert!(error("A1", Some("汇总")).contains("没有名为「汇总」的工作表"));
}

#[test]
fn parses_csv_and_markdown_tables() {
  assert_eq!(parse_rows("a,\"b,\"\"c\"\"\"\r\n1,2"), vec![vec!["a", "b,\"c\""], vec!["1", "2"]]);
  assert_eq!(parse_rows("| 名称 | 数量 |\n|---|---|\n| 苹果 | 3 |"), vec![vec!["名称", "数量"], vec!["苹果", "3"]]);
  assert_eq!(parse_rows("x\ty\n多行\t\"第一行\n第二行\""), vec![vec!["x", "y"], vec!["多行", "第一行\n第二行"]]);
}

/// 一个最小的 PDF：一页，用 Helvetica 写一行字
fn minimal_pdf(content: &str) -> Vec<u8> {
  let objects = [
    "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_string(),
    format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
  ];
  let mut pdf = b"%PDF-1.4\n".to_vec();
  let mut offsets = Vec::new();
  for (index, object) in objects.iter().enumerate() {
    offsets.push(pdf.len());
    pdf.extend(format!("{} 0 obj\n{object}\nendobj\n", index + 1).as_bytes());
  }
  let xref = pdf.len();
  pdf.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
  for offset in offsets {
    pdf.extend(format!("{offset:010} 00000 n \n").as_bytes());
  }
  pdf.extend(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).as_bytes());
  pdf
}

#[test]
fn reads_pdf_text() {
  let dir = TempDir::new("pdf");
  let text = read_text(&dir.write("a.pdf", &minimal_pdf("BT /F1 24 Tf 72 700 Td (Hello PDF) Tj ET"))).unwrap().content;
  assert!(text.starts_with("【第 1 页】\n"), "{text}");
  assert!(text.contains("Hello PDF"), "{text}");

  // 没有文字（如扫描件）、损坏的文件：给出提示而不是崩溃
  let error = read_text(&dir.write("scan.pdf", &minimal_pdf(""))).err().unwrap();
  assert!(error.contains("扫描件"), "{error}");
  assert!(read_text(&dir.write("broken.pdf", b"%PDF-1.4\nnot really a pdf")).is_err());
}

/// 生成用于在 Office 中人工检查的文件：
/// 在 OFFICE_CHECK_DIR 中放入由 Office 保存的 base.docx / base.xlsx / base.pptx，
/// 运行 `cargo test --lib exports_files_for_office_check -- --ignored`
#[test]
#[ignore]
fn exports_files_for_office_check() {
  let dir = PathBuf::from(std::env::var("OFFICE_CHECK_DIR").expect("需要设置 OFFICE_CHECK_DIR"));
  let read = |name: &str| fs::read(dir.join(name)).unwrap();
  let mut report = Vec::new();
  for name in ["base.docx", "base.xlsx", "base.pptx"] {
    report.push(format!("== {name}（LLM 读到的内容）\n{}", read_text(&dir.join(name)).unwrap().content));
  }

  let markdown = "# 会议纪要\n\n时间：**周五下午**，地点：3 楼会议室\n## 结论\n- 下周发布 2.0 版本\n- 文档由小李负责\n1. 先修复 Bug\n> 注意：发布前需要回归测试\n\n| 任务 | 负责人 | 截止 |\n|---|---|---|\n| 测试 | 小王 | 周三 |\n| 文档 | 小李 | 周四 |";
  fs::write(dir.join("created.docx"), create_docx(markdown).unwrap()).unwrap();

  let change = edit_docx(
    &read("base.docx"),
    &edits(&[("周报：本周", "周报：这周"), ("80%", "100%")]),
    Some("## 下周计划\n- 上线注册功能\n\n| 任务 | 负责人 |\n|---|---|\n| 测试 | 小王 |"),
  )
  .unwrap();
  report.push(format!("== edited.docx 预览\n{}", change.preview));
  fs::write(dir.join("edited.docx"), change.bytes).unwrap();

  let (bytes, _) = create_xlsx("产品,单价,数量,小计\n苹果,5.5,10,=B2*C2\n香蕉,3,20,=B3*C3\n编号,001,,").unwrap();
  fs::write(dir.join("created.xlsx"), bytes).unwrap();

  let cells = [("B3", "250"), ("C1", "备注"), ("C2", "新年促销")]
    .map(|(cell, value)| CellEdit { sheet: Some("销售".into()), cell: cell.into(), value: value.into() });
  let change = edit_xlsx(&read("base.xlsx"), &cells, Some("三月,300"), Some("销售")).unwrap();
  report.push(format!("== edited.xlsx 预览\n{}", change.preview));
  fs::write(dir.join("edited.xlsx"), change.bytes).unwrap();

  let change = edit_pptx(&read("base.pptx"), &edits(&[("增长 10%", "增长 20%"), ("市场部", "市场部 · 张三")])).unwrap();
  report.push(format!("== edited.pptx 预览\n{}", change.preview));
  fs::write(dir.join("edited.pptx"), change.bytes).unwrap();

  fs::write(dir.join("report.txt"), report.join("\n\n")).unwrap();
}

/// 读取 OFFICE_CHECK_DIR 中的 PDF（如由 Word 导出的中文 PDF），结果写入 pdf-report.txt
#[test]
#[ignore]
fn reads_pdfs_for_office_check() {
  let dir = PathBuf::from(std::env::var("OFFICE_CHECK_DIR").expect("需要设置 OFFICE_CHECK_DIR"));
  let mut report = Vec::new();
  for entry in fs::read_dir(&dir).unwrap() {
    let path = entry.unwrap().path();
    if path.extension().is_some_and(|e| e == "pdf") {
      let result = read_text(&path).map(|text| text.content).unwrap_or_else(|error| format!("失败：{error}"));
      report.push(format!("== {}\n{result}", path.display()));
    }
  }
  fs::write(dir.join("pdf-report.txt"), report.join("\n\n")).unwrap();
}

#[test]
fn writes_office_files_through_preview_and_undo() {
  let dir = TempDir::new("office-write");
  let backups = TempDir::new("office-write-backups");
  let roots = dir.roots();
  let request = |name: &str| WriteRequest { path: dir.0.join(name).display().to_string(), ..Default::default() };

  // 新建 Word 文档，再修改
  let create = WriteRequest { content: Some("# 会议纪要\n- 下周发布".into()), ..request("纪要.docx") };
  let preview = write::preview(&roots, &create).unwrap();
  assert_eq!((preview.summary.as_str(), preview.encoding), ("新建 Word 文档，共 2 段", "Word 文档"));
  write::apply(&roots, &create, None, &backups.0).unwrap();

  let edit = WriteRequest { edits: edits(&[("下周", "周五")]), ..request("纪要.docx") };
  let preview = write::preview(&roots, &edit).unwrap();
  let result = write::apply(&roots, &edit, preview.before_hash.as_deref(), &backups.0).unwrap();
  assert_eq!(read_text(&dir.0.join("纪要.docx")).unwrap().content, "会议纪要\n• 周五发布");
  // 撤销后恢复原文件
  write::undo(&roots, &result.path, result.backup_id.as_deref(), &result.after_hash, &backups.0).unwrap();
  assert_eq!(read_text(&dir.0.join("纪要.docx")).unwrap().content, "会议纪要\n• 下周发布");

  // Excel 只能用 cells 修改，并提示整体重新保存
  dir.write("表.xlsx", &create_xlsx("a,b\n1,2").unwrap().0);
  let cells = WriteRequest { cells: vec![CellEdit { sheet: None, cell: "B2".into(), value: "3".into() }], ..request("表.xlsx") };
  assert!(write::preview(&roots, &cells).unwrap().warning.is_some());
  let error = write::preview(&roots, &WriteRequest { edits: edits(&[("1", "2")]), ..request("表.xlsx") }).err().unwrap();
  assert!(error.contains("cells"), "{error}");

  // 不支持的情况
  dir.write("a.pptx", &sample_pptx());
  let error = |request: WriteRequest| write::preview(&roots, &request).err().unwrap();
  assert!(error(WriteRequest { content: Some("x".into()), ..request("新.pptx") }).contains("暂不支持新建 PowerPoint"));
  assert!(error(WriteRequest { append: Some("x".into()), ..request("a.pptx") }).contains("不支持追加"));
  assert!(error(WriteRequest { cells: cells.cells, ..request("纪要.docx") }).contains("只能用于 Excel"));
  assert!(error(WriteRequest { content: Some("x".into()), ..request("旧.doc") }).contains("旧版"));
  assert!(error(WriteRequest { content: Some("x".into()), ..request("宏.xlsm") }).contains("宏"));
  assert!(error(WriteRequest { content: Some("x".into()), ..request("a.pdf") }).contains("PDF"));
  assert!(error(WriteRequest { content: Some("覆盖".into()), ..request("纪要.docx") }).contains("已经存在"));
}

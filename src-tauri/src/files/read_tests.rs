//! 读取 PDF 与表格的测试

use std::{
  fs,
  io::{Cursor, Write},
  path::PathBuf,
};

use zip::{write::SimpleFileOptions, ZipWriter};

use super::read::read_text;

/// 测试用的临时目录，结束时自动删除
struct TempDir(PathBuf);

impl TempDir {
  fn new(name: &str) -> Self {
    let dir = std::env::temp_dir().join(format!("desktop-pet-read-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Self(dunce::canonicalize(&dir).unwrap())
  }

  fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
    let path = self.0.join(name);
    fs::write(&path, bytes).unwrap();
    path
  }
}

impl Drop for TempDir {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.0);
  }
}

fn zip_entries(entries: &[(&str, &str)]) -> Vec<u8> {
  let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
  for (name, content) in entries {
    writer.start_file(*name, SimpleFileOptions::default()).unwrap();
    writer.write_all(content.as_bytes()).unwrap();
  }
  writer.finish().unwrap().into_inner()
}

/// 一个最小的 xlsx：一个工作表，文字以内联字符串保存，带一个公式（含计算结果）
fn minimal_xlsx() -> Vec<u8> {
  const MAIN: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const RELS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
  let text = |cell: &str, value: &str| format!(r#"<c r="{cell}" t="inlineStr"><is><t>{value}</t></is></c>"#);
  let rows = [
    format!(r#"<row r="1">{}{}</row>"#, text("A1", "月份"), text("B1", "金额")),
    format!(r#"<row r="2">{}<c r="B2"><v>100.5</v></c></row>"#, text("A2", "一月")),
    format!(r#"<row r="3">{}<c r="B3"><v>0.30000000000000004</v></c></row>"#, text("A3", "二月")),
    format!(r#"<row r="5">{}<c r="B5"><f>SUM(B2:B3)</f><v>100.8</v></c></row>"#, text("A5", "合计")),
  ];
  zip_entries(&[
    (
      "[Content_Types].xml",
      r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
    ),
    ("_rels/.rels", &format!(r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="{RELS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#)),
    ("xl/workbook.xml", &format!(r#"<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="{MAIN}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="销售" sheetId="1" r:id="rId1"/></sheets></workbook>"#)),
    ("xl/_rels/workbook.xml.rels", &format!(r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="{RELS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#)),
    ("xl/worksheets/sheet1.xml", &format!(r#"<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="{MAIN}"><sheetData>{}</sheetData></worksheet>"#, rows.join(""))),
  ])
}

#[test]
fn reads_spreadsheets_with_row_and_column_labels() {
  let dir = TempDir::new("xlsx");
  let text = read_text(&dir.write("销售.xlsx", &minimal_xlsx())).unwrap().content;
  // 第一行是列字母，每行开头是行号；空行跳过；公式显示计算结果；去掉浮点误差
  assert_eq!(text, "【工作表：销售】共 5 行 × 2 列\n行 | A | B\n1 | 月份 | 金额\n2 | 一月 | 100.5\n3 | 二月 | 0.3\n5 | 合计 | 100.8");
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

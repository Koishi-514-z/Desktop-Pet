//! 自动检查 Word 文档与 Excel 工作簿：粗糙的文件能查出各种问题，规范的文件没有问题，常见的写法不会误报

use std::io::{Cursor, Write};

use super::office_check::QualityIssue;
use super::office_check_docx::check_docx;
use super::office_check_xlsx::check_xlsx;

fn zip_bytes(entries: &[(&str, String)]) -> Vec<u8> {
  let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
  for (name, content) in entries {
    zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
    zip.write_all(content.as_bytes()).unwrap();
  }
  zip.finish().unwrap().into_inner()
}

fn codes(issues: &[QualityIssue]) -> Vec<&'static str> {
  issues.iter().map(|issue| issue.code).collect()
}

fn message<'a>(issues: &'a [QualityIssue], code: &str) -> &'a str {
  &issues.iter().find(|issue| issue.code == code).unwrap_or_else(|| panic!("没有 {code}：{issues:?}")).message
}

// ===== Word =====

const W: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main""#;

/// 段落：properties 为段落属性，run_properties 为文字的属性
fn p(properties: &str, run_properties: &str, text: &str) -> String {
  format!(r#"<w:p><w:pPr>{properties}</w:pPr><w:r><w:rPr>{run_properties}</w:rPr><w:t xml:space="preserve">{text}</w:t></w:r></w:p>"#)
}

fn body_text(text: &str) -> String {
  p("", "", text)
}

/// 表格：style 为表格样式，borders 为直接设置的边框，widths 为各列宽度（缇）
fn table(style: &str, borders: &str, widths: &[i64], rows: usize) -> String {
  let style = if style.is_empty() { String::new() } else { format!(r#"<w:tblStyle w:val="{style}"/>"#) };
  let grid: String = widths.iter().map(|width| format!(r#"<w:gridCol w:w="{width}"/>"#)).collect();
  let row = format!("<w:tr>{}</w:tr>", widths.iter().map(|_| format!("<w:tc>{}</w:tc>", body_text("格"))).collect::<String>());
  format!("<w:tbl><w:tblPr>{style}{borders}</w:tblPr><w:tblGrid>{grid}</w:tblGrid>{}</w:tbl>", row.repeat(rows))
}

/// A4 纸、左右页边距各 3.17 厘米：版心约 14.6 厘米（8306 缇）
const SECTION: &str = r#"<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800"/></w:sectPr>"#;

fn styles() -> String {
  format!(
    r#"<w:styles {W}>
      <w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style>
      <w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
      <w:style w:type="table" w:styleId="TableNormal"><w:name w:val="Normal Table"/></w:style>
      <w:style w:type="table" w:styleId="BaseGrid"><w:name w:val="base"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/></w:tblBorders></w:tblPr></w:style>
      <w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="BaseGrid"/></w:style>
    </w:styles>"#
  )
}

fn docx(body: &str, footer: Option<&str>) -> Vec<QualityIssue> {
  let mut entries = vec![
    ("word/document.xml", format!("<w:document {W}><w:body>{body}{SECTION}</w:body></w:document>")),
    ("word/styles.xml", styles()),
  ];
  if let Some(footer) = footer {
    entries.push(("word/footer1.xml", format!("<w:ftr {W}>{footer}</w:ftr>")));
  }
  check_docx(&mut zip::ZipArchive::new(Cursor::new(zip_bytes(&entries))).unwrap())
}

#[test]
fn finds_problems_in_a_sloppy_word_document() {
  let long = "这是正文的内容，说明具体的情况与安排。".repeat(150);
  let body = [
    // 只是加粗、没有用标题样式的「标题」
    p("", "<w:b/>", "项目背景"),
    body_text(&long),
    p("", r#"<w:b/><w:sz w:val="32"/>"#, "实施计划"),
    body_text("计划分三个阶段进行。"),
    // 连续的空段落
    body_text(""),
    body_text(""),
    body_text(""),
    // 手动输入的项目符号
    body_text("• 第一点"),
    body_text("• 第二点"),
    body_text("- 第三点"),
    // 没有填写的占位内容、小字
    body_text("甲方：XX 公司，签订日期 20XX 年"),
    p("", r#"<w:sz w:val="14"/>"#, "最终解释权归甲方所有"),
    body_text("请填写联系人"),
    // 没有边框的表格、比版心宽的表格
    table("TableNormal", "", &[3000, 3000], 2),
    body_text(""),
    table("TableGrid", "", &[2000; 6], 2),
    body_text("结束"),
  ]
  .concat();
  let issues = docx(&body, None);
  assert_eq!(
    codes(&issues),
    vec!["fake-heading", "empty-paragraphs", "manual-bullets", "table-borders", "table-width", "small-font", "placeholder", "no-page-number"]
  );
  assert!(message(&issues, "fake-heading").starts_with("「项目背景」「实施计划」等 2 段"), "{issues:?}");
  assert!(message(&issues, "empty-paragraphs").starts_with("有 1 处用连续的空段落"), "{issues:?}");
  assert!(message(&issues, "manual-bullets").contains("等 3 段"), "{issues:?}");
  assert!(message(&issues, "table-borders").starts_with("第 1 个表格没有边框"), "{issues:?}");
  assert!(message(&issues, "table-width").starts_with("第 2 个表格比版心宽（约 21.2 厘米，版心 14.6 厘米）"), "{issues:?}");
  // 占位内容引用所在的短语（到标点为止）
  assert!(message(&issues, "placeholder").contains("「XX 公司」「签订日期 20XX 年」「请填写联系人」"), "{issues:?}");
}

#[test]
fn well_formatted_word_document_has_no_problems() {
  let long = "这是正文的内容，说明具体的情况与安排。".repeat(150);
  let body = [
    p(r#"<w:pStyle w:val="1"/>"#, "<w:b/>", "项目背景"),
    body_text(&long),
    p(r#"<w:pStyle w:val="1"/>"#, "", "实施计划"),
    // 用列表样式的要点；加粗的「时间：」只是一段的开头
    p(r#"<w:pStyle w:val="ListBullet"/>"#, "", "第一阶段"),
    p(r#"<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>"#, "", "第二阶段"),
    r#"<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>时间：</w:t></w:r><w:r><w:t>11 月</w:t></w:r></w:p>"#.to_string(),
    // 尺码 XXL 不是占位内容；文档末尾的空段落、表格后必需的空段落不算
    body_text("规格：XXL"),
    table("TableGrid", "", &[4000, 4000], 3),
    body_text(""),
    table("", r#"<w:tblBorders><w:top w:val="nil"/></w:tblBorders>"#, &[8000], 1),
    body_text(""),
    body_text(""),
  ]
  .concat();
  let footer = r#"<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>"#;
  assert_eq!(docx(&body, Some(footer)), vec![]);
}

#[test]
fn long_word_document_without_sections() {
  let body = (0..16).map(|index| body_text(&format!("第 {index} 段，{}", "正文内容。".repeat(20)))).collect::<String>();
  let footer = r#"<w:p><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>"#;
  let issues = docx(&body, Some(footer));
  assert_eq!(codes(&issues), vec!["no-heading"], "{issues:?}");
}

// ===== Excel =====

const S: &str = r#"xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships""#;

/// 单元格格式：0 默认，1 加粗加底色（表头），2 #,##0.00，3 自动换行
const XLSX_STYLES: &str = r#"<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/></font><font><b/><sz val="11"/></font></fonts>
  <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/></patternFill></fill></fills>
  <cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0"/><xf numFmtId="0" fontId="1" fillId="2"/><xf numFmtId="4" fontId="0" fillId="0"/><xf numFmtId="0" fontId="0" fillId="0" applyAlignment="1"><alignment wrapText="1"/></xf></cellXfs>
</styleSheet>"#;

/// 单元格：文字用共享字符串（strings 中的序号）
enum C<'a> {
  S(usize),
  N(&'a str),
  E(&'a str),
}

/// 一个单元格：位置、值、格式
fn cell(reference: impl Into<String>, value: C<'static>, style: usize) -> (String, C<'static>, usize) {
  (reference.into(), value, style)
}

/// 一行：行号与其中的单元格
type Row<'a> = (u32, Vec<(String, C<'a>, usize)>);

fn sheet_xml(head: &str, rows: &[Row], tail: &str) -> String {
  let rows: String = rows
    .iter()
    .map(|(number, cells)| {
      let cells: String = cells
        .iter()
        .map(|(reference, value, style)| match value {
          C::S(index) => format!(r#"<c r="{reference}" s="{style}" t="s"><v>{index}</v></c>"#),
          C::N(number) => format!(r#"<c r="{reference}" s="{style}"><v>{number}</v></c>"#),
          C::E(error) => format!(r#"<c r="{reference}" s="{style}" t="e"><f>1/0</f><v>{error}</v></c>"#),
        })
        .collect();
      format!(r#"<row r="{number}">{cells}</row>"#)
    })
    .collect();
  format!("<worksheet {S}>{head}<sheetData>{rows}</sheetData>{tail}</worksheet>")
}

fn xlsx(strings: &[&str], sheets: &[(&str, String)]) -> Vec<QualityIssue> {
  let sheet_list: String = sheets.iter().enumerate().map(|(index, (name, _))| format!(r#"<sheet name="{name}" sheetId="{}" r:id="rId{}"/>"#, index + 1, index + 1)).collect();
  let mut relations: String = (1..=sheets.len())
    .map(|n| format!(r#"<Relationship Id="rId{n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{n}.xml"/>"#))
    .collect();
  relations.push_str(r#"<Relationship Id="rS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>"#);
  relations.push_str(r#"<Relationship Id="rT" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>"#);
  let shared: String = strings.iter().map(|text| format!("<si><t>{text}</t></si>")).collect();
  let mut entries: Vec<(String, String)> = vec![
    ("xl/workbook.xml".into(), format!("<workbook {S}><sheets>{sheet_list}</sheets></workbook>")),
    ("xl/_rels/workbook.xml.rels".into(), format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{relations}</Relationships>"#)),
    ("xl/sharedStrings.xml".into(), format!("<sst {S}>{shared}</sst>")),
    ("xl/styles.xml".into(), XLSX_STYLES.to_string()),
  ];
  for (index, (_, xml)) in sheets.iter().enumerate() {
    entries.push((format!("xl/worksheets/sheet{}.xml", index + 1), xml.clone()));
  }
  let entries: Vec<(&str, String)> = entries.iter().map(|(name, content)| (name.as_str(), content.clone())).collect();
  check_xlsx(&mut zip::ZipArchive::new(Cursor::new(zip_bytes(&entries))).unwrap())
}

#[test]
fn finds_problems_in_a_sloppy_workbook() {
  let strings = ["产品名称", "销售额", "占比", "备注", "高端定制款智能手表（限量版）", "正常", "1,200", "980", "15%"];
  let mut rows = vec![(1, vec![cell("A1", C::S(0), 0), cell("B1", C::S(1), 0), cell("C1", C::S(2), 0), cell("D1", C::S(3), 0)])];
  for row in 2..=40u32 {
    rows.push((row, vec![cell(format!("A{row}"), C::S(4), 0), cell(format!("B{row}"), C::N("1000"), 0), cell(format!("D{row}"), C::S(5), 0)]));
  }
  // 存成文本的数字、常规格式下的长小数、公式出错、装不下的数字（#,##0.00）
  rows[1].1[1] = cell("B2", C::S(6), 0);
  rows[2].1[1] = cell("B3", C::S(7), 0);
  rows[3].1[1] = cell("B4", C::S(8), 0);
  rows[1].1.push(cell("C2", C::N("0.33333333333333331"), 0));
  rows[2].1.push(cell("C3", C::E("#DIV/0!"), 0));
  rows[3].1.push(cell("E4", C::N("123456789012"), 2));
  let issues = xlsx(&strings, &[("销售", sheet_xml("", &rows, "")), ("Sheet2", sheet_xml("", &[], ""))]);
  assert_eq!(
    codes(&issues),
    vec!["formula-error", "plain-header", "no-freeze", "number-as-text", "long-decimals", "narrow-column", "empty-sheet"],
    "{issues:?}"
  );
  assert_eq!(message(&issues, "formula-error"), "工作表「销售」的 C3（#DIV/0!）公式出错：检查公式引用的单元格、除数是否为 0");
  assert!(message(&issues, "plain-header").contains("表头（第 1 行）"), "{issues:?}");
  assert!(message(&issues, "no-freeze").contains("有 39 行数据"), "{issues:?}");
  assert!(message(&issues, "number-as-text").starts_with("工作表「销售」的 B2、B3、B4 把数字存成了文本"), "{issues:?}");
  assert!(message(&issues, "long-decimals").contains("C2 小数位太多（如 0.33333333）"), "{issues:?}");
  // A 列的长文字右边有内容，被截断；E 列的数字设置了格式，会显示成 ####；C 列是常规格式，不算
  assert!(message(&issues, "narrow-column").starts_with("工作表「销售」的 A、E 列宽度不够"), "{issues:?}");
  assert_eq!(message(&issues, "empty-sheet"), "工作表「Sheet2」是空的：删除不用的工作表");
}

#[test]
fn well_formatted_workbook_has_no_problems() {
  let strings = ["月份", "金额", "一月", "二月", "三月", "很长很长很长很长的一段备注说明文字", "0012", "2026 年销售汇总（标题合并居中）", "自动换行的很长很长很长的一段文字"];
  let rows = vec![
    // 合并居中的标题
    (1, vec![cell("A1", C::S(7), 1)]),
    (2, vec![cell("A2", C::S(0), 1), cell("B2", C::S(1), 1), cell("C2", C::S(1), 1)]),
    (3, vec![cell("A3", C::S(2), 0), cell("B3", C::N("1200"), 2), cell("C3", C::S(5), 0)]),
    // 以 0 开头的编号不算数字；右边没有内容的长文字可以显示完整
    (4, vec![cell("A4", C::S(3), 0), cell("B4", C::N("1500.5"), 2), cell("C4", C::S(6), 0)]),
    // 自动换行的长文字右边有内容，也不算显示不全
    (5, vec![cell("A5", C::S(4), 0), cell("B5", C::N("980"), 2), cell("C5", C::S(8), 3), cell("D5", C::S(2), 0)]),
  ];
  let head = r#"<sheetViews><sheetView workbookViewId="0"/></sheetViews><cols><col min="2" max="2" width="14" customWidth="1"/></cols>"#;
  let tail = r#"<mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells>"#;
  // 只放了图表的工作表不算空
  let chart_sheet = format!(r#"<worksheet {S}><sheetData/><drawing r:id="rId1"/></worksheet>"#);
  assert_eq!(xlsx(&strings, &[("销售", sheet_xml(head, &rows, tail)), ("图表", chart_sheet)]), vec![]);
}

#[test]
fn frozen_header_and_numeric_looking_text() {
  let strings = ["名称", "数量", "物品"];
  let mut rows = vec![(1, vec![cell("A1", C::S(0), 1), cell("B1", C::S(1), 1)])];
  for row in 2..=40u32 {
    rows.push((row, vec![cell(format!("A{row}"), C::S(2), 0), cell(format!("B{row}"), C::N("3"), 0)]));
  }
  let frozen = r#"<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews>"#;
  assert_eq!(xlsx(&strings, &[("清单", sheet_xml(frozen, &rows, ""))]), vec![]);
  // 没有冻结时提示
  assert_eq!(codes(&xlsx(&strings, &[("清单", sheet_xml("", &rows, ""))])), vec!["no-freeze"]);
}

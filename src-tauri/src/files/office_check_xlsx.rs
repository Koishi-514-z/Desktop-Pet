//! 自动检查 Excel 工作簿（xlsx）：
//! 公式出错（如 #DIV/0!）、数字存成了文本、列宽不够（内容显示不全或显示成 ####）、表头没有加粗也没有底色、
//! 小数位太多、长表格没有冻结表头、空的工作表。

use std::{
  collections::{HashMap, HashSet},
  io::{Read, Seek},
};

use super::office_check::QualityIssue;
use super::office_text::{read_xml, relationships, resolve_target, Element};
use super::read::column_name;

/// 每个工作表最多检查多少行
const MAX_ROWS: usize = 5000;
/// 多少行数据时应该冻结表头
const FREEZE_ROWS: usize = 30;
/// 默认列宽（字符）
const DEFAULT_COLUMN_WIDTH: f64 = 8.43;
/// 常规格式的数字最多几位小数
const MAX_DECIMALS: usize = 4;
/// 报告中最多列出几个单元格
const MAX_EXAMPLES: usize = 3;

/// 单元格格式（styles.xml 中的 cellXfs）
#[derive(Default, Clone)]
struct CellFormat {
  number_format: u32,
  bold: bool,
  filled: bool,
  wrap: bool,
}

struct Styles {
  formats: Vec<CellFormat>,
  /// 自定义的数字格式：编号 → 格式代码
  codes: HashMap<u32, String>,
}

impl Styles {
  fn parse(root: Option<&Element>) -> Self {
    let Some(root) = root else { return Self { formats: Vec::new(), codes: HashMap::new() } };
    let off = |element: Option<&Element>| element.is_some_and(|element| !matches!(element.attr("val"), Some("0" | "false")));
    let fonts: Vec<bool> = root.child("fonts").map_or_else(Vec::new, |fonts| fonts.elements().map(|font| off(font.child("b"))).collect());
    let fills: Vec<bool> = root.child("fills").map_or_else(Vec::new, |fills| {
      fills
        .elements()
        .map(|fill| fill.child("gradientFill").is_some() || fill.child("patternFill").is_some_and(|pattern| !matches!(pattern.attr("patternType"), None | Some("none" | "gray125"))))
        .collect()
    });
    let index = |element: &Element, name: &str| element.attr(name).and_then(|value| value.parse::<usize>().ok()).unwrap_or(0);
    let formats = root.child("cellXfs").map_or_else(Vec::new, |xfs| {
      xfs
        .elements()
        .map(|xf| CellFormat {
          number_format: index(xf, "numFmtId") as u32,
          bold: fonts.get(index(xf, "fontId")).copied().unwrap_or(false),
          filled: fills.get(index(xf, "fillId")).copied().unwrap_or(false),
          wrap: xf.child("alignment").is_some_and(|alignment| matches!(alignment.attr("wrapText"), Some("1" | "true"))),
        })
        .collect()
    });
    let codes = root.child("numFmts").map_or_else(HashMap::new, |formats| {
      formats.elements().filter_map(|format| Some((format.attr("numFmtId")?.parse().ok()?, format.attr("formatCode")?.to_string()))).collect()
    });
    Self { formats, codes }
  }

  fn format(&self, style: usize) -> CellFormat {
    self.formats.get(style).cloned().unwrap_or_default()
  }

  /// 数字格式的格式代码（内置格式只列出常用的）
  fn code(&self, id: u32) -> Option<String> {
    let builtin = match id {
      0 => "General",
      1 => "0",
      2 => "0.00",
      3 => "#,##0",
      4 => "#,##0.00",
      9 => "0%",
      10 => "0.00%",
      11 => "0.00E+00",
      14..=22 | 45..=47 => "date",
      49 => "@",
      _ => "",
    };
    if !builtin.is_empty() {
      return Some(builtin.to_string());
    }
    self.codes.get(&id).cloned()
  }
}

#[derive(Debug)]
enum Value {
  Number(String),
  Text(String),
  Error(String),
  Other,
}

struct Cell {
  column: u32,
  row: u32,
  value: Value,
  style: usize,
}

impl Cell {
  fn reference(&self) -> String {
    format!("{}{}", column_name(self.column - 1), self.row)
  }

  fn is_empty(&self) -> bool {
    match &self.value {
      Value::Text(text) => text.trim().is_empty(),
      Value::Number(_) | Value::Error(_) => false,
      Value::Other => true,
    }
  }
}

/// 单元格引用（如 B12）→ (列号, 行号)，都从 1 开始
fn parse_reference(reference: &str) -> Option<(u32, u32)> {
  let letters: String = reference.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
  let row = reference[letters.len()..].parse().ok()?;
  let column = letters.to_ascii_uppercase().bytes().fold(0u32, |sum, byte| sum * 26 + u32::from(byte - b'A' + 1));
  (column > 0).then_some((column, row))
}

fn shared_strings<R: Read + Seek>(archive: &mut zip::ZipArchive<R>, path: Option<&str>) -> Vec<String> {
  let Some(root) = path.and_then(|path| read_xml(archive, path)) else { return Vec::new() };
  root
    .elements()
    .filter(|item| item.name == "si")
    .map(|item| {
      if let Some(text) = item.child("t") {
        return text.text();
      }
      item.elements().filter(|run| run.name == "r").filter_map(|run| run.child("t").map(Element::text)).collect()
    })
    .collect()
}

/// 文字显示的宽度（按字符计，中文等全角字符算两个）
fn display_width(text: &str) -> f64 {
  text
    .chars()
    .map(|c| if (c as u32) >= 0x2E80 && !matches!(c as u32, 0xFF61..=0xFF9F) { 2.0 } else { 1.0 })
    .sum()
}

/// 数字按格式显示的大致宽度
fn number_width(raw: &str, code: &str) -> f64 {
  let value: f64 = raw.parse().unwrap_or(0.0);
  let integer_digits = format!("{:.0}", value.abs().trunc()).len() as f64;
  let sign = if value < 0.0 { 1.0 } else { 0.0 };
  if code == "General" {
    // 常规格式最多显示 11 位
    return (raw.trim_start_matches('-').len() as f64).min(11.0) + sign;
  }
  let percent = code.contains('%');
  let digits = if percent { format!("{:.0}", (value * 100.0).abs().trunc()).len() as f64 } else { integer_digits };
  let separators = if code.contains(",") { ((digits - 1.0) / 3.0).floor().max(0.0) } else { 0.0 };
  let decimals = code.split(['.', ';']).nth(1).map_or(0, |part| part.chars().take_while(|c| *c == '0').count()) as f64;
  digits + separators + if decimals > 0.0 { decimals + 1.0 } else { 0.0 } + if percent { 1.0 } else { 0.0 } + sign
}

/// 看起来是数字的文字，如 1200、1,500.5、12%、-3.2（以 0 开头的编号、很长的号码不算）
fn looks_numeric(text: &str) -> bool {
  let text = text.trim();
  let body = text.strip_suffix('%').unwrap_or(text);
  let body = body.strip_prefix(['-', '+']).unwrap_or(body);
  if body.is_empty() || body.len() > 15 || !body.chars().next().is_some_and(|c| c.is_ascii_digit()) {
    return false;
  }
  if body.len() > 1 && body.starts_with('0') && !body.starts_with("0.") {
    return false;
  }
  let plain = body.replace(',', "");
  if body.contains(',') && !body.split('.').next().unwrap_or_default().split(',').skip(1).all(|group| group.len() == 3) {
    return false;
  }
  plain.parse::<f64>().is_ok()
}

fn decimals(raw: &str) -> usize {
  if raw.contains(['e', 'E']) {
    return 0;
  }
  raw.split('.').nth(1).map_or(0, |fraction| fraction.trim_end_matches('0').len())
}

struct Sheet {
  name: String,
  cells: Vec<Cell>,
  widths: Vec<(u32, u32, f64)>,
  default_width: f64,
  frozen: bool,
  /// 合并单元格覆盖的所有单元格
  merged: HashSet<(u32, u32)>,
}

impl Sheet {
  fn width(&self, column: u32) -> f64 {
    self.widths.iter().find(|(min, max, _)| (*min..=*max).contains(&column)).map_or(self.default_width, |(_, _, width)| *width)
  }
}

fn parse_sheet(root: &Element, name: String, strings: &[String]) -> Sheet {
  let mut sheet = Sheet { name, cells: Vec::new(), widths: Vec::new(), default_width: DEFAULT_COLUMN_WIDTH, frozen: false, merged: HashSet::new() };
  if let Some(format) = root.child("sheetFormatPr") {
    if let Some(width) = format.attr("defaultColWidth").and_then(|value| value.parse().ok()) {
      sheet.default_width = width;
    }
    else if let Some(base) = format.attr("baseColWidth").and_then(|value| value.parse::<f64>().ok()) {
      sheet.default_width = base + 0.71;
    }
  }
  sheet.frozen = root
    .child("sheetViews")
    .is_some_and(|views| views.elements().any(|view| view.child("pane").is_some_and(|pane| matches!(pane.attr("state"), Some("frozen" | "frozenSplit")))));
  if let Some(columns) = root.child("cols") {
    for column in columns.elements() {
      let number = |name: &str| column.attr(name).and_then(|value| value.parse::<u32>().ok());
      if let (Some(min), Some(max), Some(width)) = (number("min"), number("max"), column.attr("width").and_then(|value| value.parse::<f64>().ok())) {
        sheet.widths.push((min, max, width));
      }
    }
  }
  if let Some(merges) = root.child("mergeCells") {
    for merge in merges.elements() {
      let Some((start, end)) = merge.attr("ref").and_then(|range| range.split_once(':')) else { continue };
      let (Some((c1, r1)), Some((c2, r2))) = (parse_reference(start), parse_reference(end)) else { continue };
      for row in r1..=r2.min(r1 + 200) {
        for column in c1..=c2.min(c1 + 50) {
          sheet.merged.insert((column, row));
        }
      }
    }
  }
  let Some(data) = root.child("sheetData") else { return sheet };
  for row in data.elements().filter(|row| row.name == "row").take(MAX_ROWS) {
    for cell in row.elements().filter(|cell| cell.name == "c") {
      let Some((column, row_number)) = cell.attr("r").and_then(parse_reference) else { continue };
      let raw = cell.child("v").map(Element::text);
      let value = match (cell.attr("t"), raw) {
        (Some("s"), Some(index)) => index.trim().parse::<usize>().ok().and_then(|index| strings.get(index)).map_or(Value::Other, |text| Value::Text(text.clone())),
        (Some("inlineStr"), _) => cell.child("is").map_or(Value::Other, |inline| {
          let text = inline.child("t").map(Element::text).unwrap_or_else(|| inline.elements().filter_map(|run| run.child("t").map(Element::text)).collect());
          Value::Text(text)
        }),
        (Some("str"), Some(text)) => Value::Text(text),
        (Some("e"), Some(error)) => Value::Error(error),
        (Some("n") | None, Some(number)) if !number.trim().is_empty() => Value::Number(number.trim().to_string()),
        _ => Value::Other,
      };
      let style = cell.attr("s").and_then(|value| value.parse().ok()).unwrap_or(0);
      sheet.cells.push(Cell { column, row: row_number, value, style });
    }
  }
  sheet
}

/// 工作簿中的工作表（按顺序，不含图表工作表与隐藏的工作表）
fn worksheets<R: Read + Seek>(archive: &mut zip::ZipArchive<R>) -> Vec<(String, String)> {
  let Some(workbook) = read_xml(archive, "xl/workbook.xml") else { return Vec::new() };
  let relations = relationships(archive, "xl/_rels/workbook.xml.rels");
  let Some(sheets) = workbook.child("sheets") else { return Vec::new() };
  sheets
    .elements()
    .filter(|sheet| !matches!(sheet.attr("state"), Some("hidden" | "veryHidden")))
    .filter_map(|sheet| {
      let (kind, target) = relations.get(sheet.attr("r:id")?)?;
      kind.ends_with("/worksheet").then(|| (sheet.attr("name").unwrap_or_default().to_string(), resolve_target("xl", target)))
    })
    .collect()
}

/// 列出几个单元格，如「B2、B3、B4 等 12 个单元格」；describe 为每个单元格的写法。
/// 以英文或数字结尾时（如 B4）后面加一个空格，再接中文
fn cell_list(cells: &[&Cell], describe: impl Fn(&Cell) -> String) -> String {
  let list = cells.iter().take(MAX_EXAMPLES).map(|cell| describe(cell)).collect::<Vec<_>>().join("、");
  let list = if cells.len() > MAX_EXAMPLES { format!("{list} 等 {} 个单元格", cells.len()) } else { list };
  if list.ends_with(|c: char| c.is_ascii_alphanumeric()) { format!("{list} ") } else { list }
}

/// 检查一个工作表
fn check_sheet(sheet: &Sheet, styles: &Styles, push: &mut impl FnMut(&'static str, String)) {
  let name = &sheet.name;
  let filled: Vec<&Cell> = sheet.cells.iter().filter(|cell| !cell.is_empty()).collect();
  let by_position: HashMap<(u32, u32), &Cell> = filled.iter().map(|cell| ((cell.column, cell.row), *cell)).collect();

  // 公式出错
  let errors: Vec<&Cell> = filled.iter().copied().filter(|cell| matches!(cell.value, Value::Error(_))).collect();
  if !errors.is_empty() {
    let list = cell_list(&errors, |cell| format!("{}（{}）", cell.reference(), if let Value::Error(error) = &cell.value { error.as_str() } else { "" }));
    push("formula-error", format!("工作表「{name}」的 {list}公式出错：检查公式引用的单元格、除数是否为 0"));
  }

  // 表头：前 10 行中第一行有两个以上（不在合并单元格中的）内容的行，后面至少还有两行数据
  let mut rows: Vec<u32> = filled.iter().map(|cell| cell.row).collect();
  rows.sort_unstable();
  rows.dedup();
  let header_row = rows.iter().take(10).copied().find(|row| {
    filled.iter().filter(|cell| cell.row == *row && !sheet.merged.contains(&(cell.column, cell.row))).count() >= 2
  });
  let data_rows = header_row.map_or(0, |header| rows.iter().filter(|row| **row > header).count());
  if let Some(header) = header_row
    && data_rows >= 2
  {
    let header_cells: Vec<&Cell> = filled.iter().copied().filter(|cell| cell.row == header).collect();
    if header_cells.iter().all(|cell| {
      let format = styles.format(cell.style);
      !format.bold && !format.filled
    }) {
      push("plain-header", format!("工作表「{name}」的表头（第 {header} 行）没有加粗，也没有底色：加粗并加上底色，和数据区分开"));
    }
    if data_rows > FREEZE_ROWS && !sheet.frozen {
      push("no-freeze", format!("工作表「{name}」有 {data_rows} 行数据，没有冻结表头：冻结表头所在的行，滚动时表头一直可见"));
    }
  }

  // 数字存成了文本（表头所在的行与之前的行不算）
  let first_data_row = header_row.map_or(2, |header| header + 1);
  let text_numbers: Vec<&Cell> = filled
    .iter()
    .copied()
    .filter(|cell| cell.row >= first_data_row && matches!(&cell.value, Value::Text(text) if looks_numeric(text)))
    .collect();
  if text_numbers.len() >= 3 {
    push(
      "number-as-text",
      format!("工作表「{name}」的 {}把数字存成了文本，不能计算和排序：写入数字而不是文字，显示方式用数字格式设置", cell_list(&text_numbers, Cell::reference)),
    );
  }

  // 常规格式下小数位太多（如公式算出的 0.333333333）
  let long_decimals: Vec<&Cell> = filled
    .iter()
    .copied()
    .filter(|cell| matches!(&cell.value, Value::Number(raw) if styles.format(cell.style).number_format == 0 && decimals(raw) > MAX_DECIMALS))
    .collect();
  if let Some(first) = long_decimals.first() {
    let sample = if let Value::Number(raw) = &first.value { raw.chars().take(10).collect::<String>() } else { String::new() };
    push(
      "long-decimals",
      format!("工作表「{name}」的 {}小数位太多（如 {sample}）：设置数字格式，如 0.00、#,##0.00 或 0.0%", cell_list(&long_decimals, Cell::reference)),
    );
  }

  // 列宽不够：设置了数字格式的数字超出列宽会显示成 ####（常规格式会自动减少小数位或改用科学计数法，不算）；
  // 文字超出列宽、右边又有内容时会被截断（自动换行、合并单元格不算）
  let mut narrow: Vec<u32> = Vec::new();
  for cell in &filled {
    if narrow.contains(&cell.column) || sheet.merged.contains(&(cell.column, cell.row)) {
      continue;
    }
    let format = styles.format(cell.style);
    let width = sheet.width(cell.column);
    let too_narrow = match &cell.value {
      Value::Number(raw) => {
        let code = styles.code(format.number_format).unwrap_or_else(|| "General".into());
        !matches!(code.as_str(), "General" | "date") && number_width(raw, &code) > width + 0.5
      }
      Value::Text(text) => {
        let needed = display_width(text.lines().max_by_key(|line| line.len()).unwrap_or_default()) * if format.bold { 1.1 } else { 1.0 };
        !format.wrap && needed > width + 1.0 && by_position.contains_key(&(cell.column + 1, cell.row))
      }
      _ => false,
    };
    if too_narrow {
      narrow.push(cell.column);
    }
  }
  if !narrow.is_empty() {
    narrow.sort_unstable();
    let columns = narrow.iter().map(|column| column_name(column - 1)).collect::<Vec<_>>().join("、");
    push("narrow-column", format!("工作表「{name}」的 {columns} 列宽度不够，内容显示不全（数字会显示成 ####）：调整列宽，如自动调整列宽（AutoFit）"));
  }
}

/// 检查 Excel 工作簿
pub fn check_xlsx<R: Read + Seek>(archive: &mut zip::ZipArchive<R>) -> Vec<QualityIssue> {
  let sheets = worksheets(archive);
  let relations = relationships(archive, "xl/_rels/workbook.xml.rels");
  let strings_path = relations.values().find(|(kind, _)| kind.ends_with("/sharedStrings")).map(|(_, target)| resolve_target("xl", target));
  let strings = shared_strings(archive, strings_path.as_deref());
  let styles_path = relations.values().find(|(kind, _)| kind.ends_with("/styles")).map(|(_, target)| resolve_target("xl", target));
  let styles = Styles::parse(styles_path.and_then(|path| read_xml(archive, &path)).as_ref());

  let mut issues = Vec::new();
  let mut push = |code: &'static str, message: String| issues.push(QualityIssue { code, message });
  let mut empty = Vec::new();
  let mut non_empty = 0;
  for (name, path) in sheets {
    let Some(root) = read_xml(archive, &path) else { continue };
    let sheet = parse_sheet(&root, name, &strings);
    // 只放了图表、图片的工作表不算空
    if sheet.cells.iter().all(Cell::is_empty) && root.child("drawing").is_none() {
      empty.push(sheet.name);
      continue;
    }
    non_empty += 1;
    check_sheet(&sheet, &styles, &mut push);
  }
  if non_empty > 0 && !empty.is_empty() {
    let names = empty.iter().map(|name| format!("「{name}」")).collect::<String>();
    push("empty-sheet", format!("工作表{names}是空的：删除不用的工作表"));
  }
  issues
}

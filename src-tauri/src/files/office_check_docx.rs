//! 自动检查 Word 文档（docx）：
//! 看起来像标题却没有用标题样式（加粗或放大的短段落）、长文档没有分节标题、用连续的空段落调整间距、
//! 手动输入的项目符号、表格没有边框或比版心宽、字号太小、没有填写的占位内容（如「20XX 年」「XX 公司」）、长文档没有页码。

use std::{
  collections::HashMap,
  io::{Read, Seek},
};

use super::office_check::{walk, QualityIssue};
use super::office_text::{numbered_entries, parse_styles, read_xml, Element, StyleInfo};

/// 像标题的段落最多多少字
const MAX_HEADING_CHARS: usize = 30;
/// 标题的最小字号（半磅）：14 磅
const HEADING_SIZE: i64 = 28;
/// 正文的最小字号（半磅）：9 磅
const MIN_TEXT_SIZE: i64 = 18;
/// 多长的文档应该分节、加页码（字数）
const LONG_DOCUMENT_CHARS: usize = 1500;
const PAGE_NUMBER_CHARS: usize = 2500;
/// 手动输入的项目符号
const BULLET_SYMBOLS: &[char] = &['•', '●', '○', '■', '□', '◆', '◇', '▪', '▫', '·', '*', '-', '–', '—', '√', '✓', '➢', '►', '▶'];
/// 没有填写的占位内容
const PLACEHOLDER_PHRASES: &[&str] = &["待填写", "待补充", "此处填写", "请填写", "请输入", "在此输入", "在此处输入", "TODO", "lorem ipsum"];

/// 一个段落的信息
struct Paragraph {
  text: String,
  heading: bool,
  list: bool,
  /// 有文字的部分全部加粗
  bold: bool,
  /// 直接设置的最大字号（半磅）
  size: Option<i64>,
  /// 含有图片、图形、分页符或分节符：不是空段落
  object: bool,
}

fn chars(text: &str) -> usize {
  text.chars().filter(|c| !c.is_whitespace()).count()
}

/// 开关属性（如 <w:b/>、<w:b w:val="0"/>）是否打开
fn toggle(element: Option<&Element>) -> bool {
  element.is_some_and(|element| !matches!(element.attr("w:val"), Some("0" | "false" | "off")))
}

/// 段落中的文字，跳过修订中删除的内容
fn paragraph_text(element: &Element, output: &mut String) {
  for child in element.elements() {
    match child.name.as_str() {
      "w:del" | "w:moveFrom" | "w:pPr" | "w:rPr" => {}
      "w:t" => output.push_str(&child.text()),
      _ => paragraph_text(child, output),
    }
  }
}

fn inspect_paragraph(paragraph: &Element, styles: &HashMap<String, StyleInfo>) -> Paragraph {
  let properties = paragraph.child("w:pPr");
  let style = properties.and_then(|p| p.child_attr("w:pStyle", "w:val")).and_then(|id| styles.get(id));
  let outline = properties.and_then(|p| p.child_attr("w:outlineLvl", "w:val")).and_then(|level| level.parse::<usize>().ok()).is_some_and(|level| level < 9);
  let numbered = properties.and_then(|p| p.child("w:numPr")).and_then(|numbering| numbering.child_attr("w:numId", "w:val")).is_some_and(|id| id != "0");

  let mut text = String::new();
  paragraph_text(paragraph, &mut text);
  let mut bold = true;
  let mut any_run = false;
  let mut size: Option<i64> = None;
  let mut object = properties.is_some_and(|p| p.child("w:sectPr").is_some());
  walk(paragraph, &mut |item| match item.name.as_str() {
    "w:r" => {
      let mut run_text = String::new();
      paragraph_text(item, &mut run_text);
      if run_text.trim().is_empty() {
        return;
      }
      any_run = true;
      let run_properties = item.child("w:rPr");
      bold &= toggle(run_properties.and_then(|p| p.child("w:b")));
      if let Some(value) = run_properties.and_then(|p| p.child_attr("w:sz", "w:val")).and_then(|value| value.parse::<i64>().ok()) {
        size = Some(size.map_or(value, |current| current.max(value)));
      }
    }
    "w:drawing" | "w:pict" | "w:object" | "mc:AlternateContent" => object = true,
    "w:br" if item.attr("w:type") == Some("page") => object = true,
    _ => {}
  });
  Paragraph {
    text,
    heading: outline || style.is_some_and(|style| style.heading.is_some()),
    list: numbered || style.is_some_and(|style| style.numbering.is_some()),
    bold: any_run && bold,
    size,
    object,
  }
}

/// 正文中的块：段落与表格（内容控件中的也算），按顺序
enum Block<'a> {
  Paragraph(&'a Element),
  Table(&'a Element),
}

fn blocks<'a>(container: &'a Element, output: &mut Vec<Block<'a>>) {
  for element in container.elements() {
    match element.name.as_str() {
      "w:p" => output.push(Block::Paragraph(element)),
      "w:tbl" => output.push(Block::Table(element)),
      "w:sdt" => {
        if let Some(content) = element.child("w:sdtContent") {
          blocks(content, output);
        }
      }
      "w:customXml" => blocks(element, output),
      _ => {}
    }
  }
}

/// 边框是否可见（不是 nil / none）
fn visible_borders(borders: Option<&Element>) -> bool {
  borders.is_some_and(|borders| borders.elements().any(|border| !matches!(border.attr("w:val"), Some("nil" | "none") | None)))
}

/// 表格样式（沿着 basedOn）是否带有边框
fn style_has_borders(style_id: &str, table_styles: &HashMap<String, &Element>) -> bool {
  let mut current = Some(style_id.to_string());
  for _ in 0..8 {
    let Some(style) = current.as_deref().and_then(|id| table_styles.get(id)) else { return false };
    if visible_borders(style.child("w:tblPr").and_then(|p| p.child("w:tblBorders"))) {
      return true;
    }
    current = style.child_attr("w:basedOn", "w:val").map(str::to_string);
  }
  false
}

fn table_has_borders(table: &Element, table_styles: &HashMap<String, &Element>) -> bool {
  let properties = table.child("w:tblPr");
  if visible_borders(properties.and_then(|p| p.child("w:tblBorders"))) {
    return true;
  }
  if properties.and_then(|p| p.child_attr("w:tblStyle", "w:val")).is_some_and(|style| style_has_borders(style, table_styles)) {
    return true;
  }
  let mut cell_borders = false;
  walk(table, &mut |item| {
    if item.name == "w:tcBorders" && visible_borders(Some(item)) {
      cell_borders = true;
    }
  });
  cell_borders
}

fn table_size(table: &Element) -> (usize, usize) {
  let rows = table.elements().filter(|element| element.name == "w:tr").count();
  let columns = table.child("w:tblGrid").map_or(0, |grid| grid.elements().filter(|element| element.name == "w:gridCol").count());
  (rows, columns)
}

/// 表格各列宽度之和（缇，1 厘米 ≈ 567 缇）
fn table_width(table: &Element) -> i64 {
  table.child("w:tblGrid").map_or(0, |grid| {
    grid
      .elements()
      .filter(|element| element.name == "w:gridCol")
      .filter_map(|column| column.attr("w:w").and_then(|width| width.parse::<i64>().ok()))
      .sum()
  })
}

/// 版心宽度（缇）：纸张宽度减去左右页边距
fn text_width(body: &Element) -> Option<i64> {
  let section = body.elements().filter(|element| element.name == "w:sectPr").last()?;
  let number = |element: &Element, name: &str| element.attr(name).and_then(|value| value.parse::<i64>().ok());
  let page = number(section.child("w:pgSz")?, "w:w")?;
  let margins = section.child("w:pgMar");
  let left = margins.and_then(|m| number(m, "w:left")).unwrap_or(1800);
  let right = margins.and_then(|m| number(m, "w:right")).unwrap_or(1800);
  Some(page - left - right)
}

fn cm(twips: i64) -> String {
  format!("{:.1}", twips as f64 / 567.0)
}

/// 文字中没有填写的占位内容（带前后几个字），如「20XX 年」「XX 公司」「请填写」
fn find_placeholders(text: &str, found: &mut Vec<String>) {
  let characters: Vec<char> = text.chars().collect();
  // 引用占位内容所在的短语：向前后各扩展到标点为止（最多 8 个字）
  let boundary = |c: char| "，。；：、,.;:!?！？（）()「」\n\t".contains(c);
  let snippet = |start: usize, end: usize| -> String {
    let mut left = start;
    while left > 0 && start - left < 8 && !boundary(characters[left - 1]) {
      left -= 1;
    }
    let mut right = end;
    while right < characters.len() && right - end < 8 && !boundary(characters[right]) {
      right += 1;
    }
    characters[left..right].iter().collect::<String>().trim().to_string()
  };
  // 连续的 X / ×，前后不能是英文字母（如 XXL）
  let mut index = 0;
  while index < characters.len() {
    if matches!(characters[index], 'X' | '×' | 'Ｘ') {
      let start = index;
      while index < characters.len() && matches!(characters[index], 'X' | '×' | 'Ｘ') {
        index += 1;
      }
      let letter = |position: Option<&char>| position.is_some_and(|c| c.is_ascii_alphabetic());
      if index - start >= 2 && !letter(start.checked_sub(1).and_then(|i| characters.get(i))) && !letter(characters.get(index)) {
        found.push(snippet(start, index));
      }
    }
    else {
      index += 1;
    }
  }
  let lowered = text.to_lowercase();
  for phrase in PLACEHOLDER_PHRASES {
    if let Some(position) = lowered.find(&phrase.to_lowercase()) {
      let start = lowered[..position].chars().count();
      found.push(snippet(start, start + phrase.chars().count()));
    }
  }
}

fn quote_list(items: &[String], limit: usize) -> String {
  items.iter().take(limit).map(|item| format!("「{item}」")).collect::<String>()
}

fn ordinal_list(numbers: &[usize]) -> String {
  format!("第 {} 个表格", numbers.iter().map(usize::to_string).collect::<Vec<_>>().join("、"))
}

/// 检查 Word 文档
pub fn check_docx<R: Read + Seek>(archive: &mut zip::ZipArchive<R>) -> Vec<QualityIssue> {
  let Some(document) = read_xml(archive, "word/document.xml") else { return Vec::new() };
  let Some(body) = document.child("w:body") else { return Vec::new() };
  let styles_root = read_xml(archive, "word/styles.xml");
  let styles = parse_styles(styles_root.as_ref());
  let table_styles: HashMap<String, &Element> = styles_root
    .as_ref()
    .map(|root| {
      root
        .elements()
        .filter(|style| style.name == "w:style" && style.attr("w:type") == Some("table"))
        .filter_map(|style| Some((style.attr("w:styleId")?.to_string(), style)))
        .collect()
    })
    .unwrap_or_default();

  let mut order = Vec::new();
  blocks(body, &mut order);
  let mut paragraphs: Vec<Paragraph> = Vec::new();
  // 正文中的段落按顺序编号，表格处断开（用于查找连续的空段落）
  let mut sequence: Vec<Option<usize>> = Vec::new();
  let mut tables = Vec::new();
  for block in &order {
    match block {
      Block::Paragraph(element) => {
        sequence.push(Some(paragraphs.len()));
        paragraphs.push(inspect_paragraph(element, &styles));
      }
      Block::Table(element) => {
        sequence.push(None);
        tables.push(*element);
      }
    }
  }

  let mut issues = Vec::new();
  let mut push = |code: &'static str, message: String| issues.push(QualityIssue { code, message });
  let filled: Vec<&Paragraph> = paragraphs.iter().filter(|paragraph| chars(&paragraph.text) > 0).collect();
  let total_chars: usize = filled.iter().map(|paragraph| chars(&paragraph.text)).sum();

  // 看起来像标题却没有用标题样式：不长、没有句末标点、加粗或放大，并且后面还有内容
  let fake_headings: Vec<String> = filled
    .iter()
    .enumerate()
    .filter(|(index, paragraph)| {
      let text = paragraph.text.trim();
      !paragraph.heading
        && !paragraph.list
        && *index + 1 < filled.len()
        && chars(text) <= MAX_HEADING_CHARS
        && !text.ends_with(['。', '；', '，', '、', '：', ':', ';', ',', '.', '!', '?', '！', '？'])
        && (paragraph.bold || paragraph.size.is_some_and(|size| size >= HEADING_SIZE))
    })
    .map(|(_, paragraph)| paragraph.text.trim().to_string())
    .collect();
  if fake_headings.len() >= 2 {
    push(
      "fake-heading",
      format!(
        "{}等 {} 段看起来是标题，但只是加粗或放大了文字，没有使用标题样式：改用内置的标题样式（标题 1、标题 2……），导航窗格和自动目录才能识别",
        quote_list(&fake_headings, 3),
        fake_headings.len()
      ),
    );
  }
  else if !paragraphs.iter().any(|paragraph| paragraph.heading) && filled.len() >= 15 && total_chars >= LONG_DOCUMENT_CHARS {
    push("no-heading", format!("全文约 {total_chars} 字，没有分节标题：按内容分成几节，用标题样式写小标题"));
  }

  // 连续的空段落：文档末尾的不算，表格处断开
  let mut runs = Vec::new();
  let mut current = 0;
  let mut empty_total = 0;
  for item in &sequence {
    match item.map(|index| &paragraphs[index]) {
      Some(paragraph) if chars(&paragraph.text) == 0 && !paragraph.object => {
        current += 1;
        empty_total += 1;
      }
      _ => {
        if current > 0 {
          runs.push(current);
        }
        current = 0;
      }
    }
  }
  empty_total -= current;
  let long_runs = runs.iter().filter(|run| **run >= 3).count();
  if long_runs > 0 || (empty_total >= 5 && empty_total * 5 >= paragraphs.len()) {
    let places = if long_runs > 0 { long_runs } else { runs.iter().filter(|run| **run >= 2).count().max(1) };
    push("empty-paragraphs", format!("有 {places} 处用连续的空段落调整间距（共 {empty_total} 个空段落）：改用段前、段后间距，需要换页时插入分页符"));
  }

  // 手动输入的项目符号
  let manual_bullets: Vec<String> = filled
    .iter()
    .filter(|paragraph| !paragraph.list)
    .filter_map(|paragraph| {
      let text = paragraph.text.trim();
      let mut characters = text.chars();
      let first = characters.next()?;
      let second = characters.next();
      let is_bullet = BULLET_SYMBOLS.contains(&first) && !(first == '-' && second.is_some_and(|c| c.is_ascii_digit()));
      is_bullet.then(|| text.chars().take(12).collect())
    })
    .collect();
  if manual_bullets.len() >= 3 {
    push(
      "manual-bullets",
      format!("{}等 {} 段用手动输入的符号当项目符号：改用 Word 的项目符号列表，缩进与对齐才会整齐", quote_list(&manual_bullets, 2), manual_bullets.len()),
    );
  }

  // 表格：没有边框（只有一行或一列的常用来排版，不算）、比版心宽
  let page_width = text_width(body);
  let mut borderless = Vec::new();
  let mut too_wide = Vec::new();
  for (index, table) in tables.iter().enumerate() {
    let (rows, columns) = table_size(table);
    if rows >= 2 && columns >= 2 && !table_has_borders(table, &table_styles) {
      borderless.push(index + 1);
    }
    if let Some(page) = page_width {
      let width = table_width(table);
      if width > page + page / 20 {
        too_wide.push((index + 1, width, page));
      }
    }
  }
  if !borderless.is_empty() {
    push("table-borders", format!("{}没有边框，表格线看不见：给表格加上边框（如 Borders.Enable，或使用「网格型」表格样式）", ordinal_list(&borderless)));
  }
  if !too_wide.is_empty() {
    let numbers: Vec<usize> = too_wide.iter().map(|(number, _, _)| *number).collect();
    let (_, width, page) = too_wide[0];
    push(
      "table-width",
      format!("{}比版心宽（约 {} 厘米，版心 {} 厘米），右边会超出页面：调整列宽（如 AutoFitBehavior 根据窗口调整），或改为横向页面", ordinal_list(&numbers), cm(width), cm(page)),
    );
  }

  // 字号太小（正文与表格中直接设置的字号）
  let mut small = false;
  walk(body, &mut |item| {
    if item.name == "w:r" {
      let mut text = String::new();
      paragraph_text(item, &mut text);
      if !text.trim().is_empty()
        && item.child("w:rPr").and_then(|p| p.child_attr("w:sz", "w:val")).and_then(|value| value.parse::<i64>().ok()).is_some_and(|size| size < MIN_TEXT_SIZE)
      {
        small = true;
      }
    }
  });
  if small {
    push("small-font", "有小于 9 磅的文字，打印后看不清：正文一般用五号（10.5 磅）或小四（12 磅）".into());
  }

  // 没有填写的占位内容：正文、表格、页眉页脚
  let mut placeholders = Vec::new();
  let mut all_text = String::new();
  paragraph_text(body, &mut all_text);
  for paragraph_text_value in body_texts(body) {
    find_placeholders(&paragraph_text_value, &mut placeholders);
  }
  let parts: Vec<String> = numbered_entries(archive, "word/header", ".xml").into_iter().chain(numbered_entries(archive, "word/footer", ".xml")).collect();
  let mut page_number = false;
  for part in &parts {
    let Some(root) = read_xml(archive, part) else { continue };
    for text in body_texts(&root) {
      find_placeholders(&text, &mut placeholders);
    }
    walk(&root, &mut |item| {
      let instruction = match item.name.as_str() {
        "w:instrText" => item.text(),
        "w:fldSimple" => item.attr("w:instr").unwrap_or_default().to_string(),
        _ => return,
      };
      if instruction.to_uppercase().contains("PAGE") {
        page_number = true;
      }
    });
  }
  let mut seen = std::collections::HashSet::new();
  placeholders.retain(|item| seen.insert(item.clone()));
  if !placeholders.is_empty() {
    push("placeholder", format!("有没有填写的占位内容（{}）：换成实际的内容，不知道时问用户", quote_list(&placeholders, 3)));
  }
  if !page_number && chars(&all_text) >= PAGE_NUMBER_CHARS {
    push("no-page-number", format!("全文约 {} 字，没有页码：在页脚加上页码", chars(&all_text)));
  }
  issues
}

/// 每个段落的文字（包括表格中的）
fn body_texts(root: &Element) -> Vec<String> {
  let mut texts = Vec::new();
  walk(root, &mut |item| {
    if item.name == "w:p" {
      let mut text = String::new();
      paragraph_text(item, &mut text);
      if !text.trim().is_empty() {
        texts.push(text);
      }
    }
  });
  texts
}

//! 提取 Word（docx）与 PowerPoint（pptx）的文字，尽量保留结构：
//! - Word：标题写成 `# 标题`，列表加上项目符号或编号（如 `1.`、`（一）`），表格写成 Markdown 表格，
//!   文本框中的文字跟在所在的段落后面；正文之后附上页眉、页脚、脚注、尾注与批注（批注注明对应的原文）。
//!   修订中删除的文字、域代码不会出现。
//! - PowerPoint：按演示文稿中的顺序列出每页的文字与表格，以及演讲者备注；隐藏的幻灯片会注明。

use std::{
  collections::{HashMap, HashSet},
  io::{Read, Seek},
};

use quick_xml::{events::Event, Reader};

/// 压缩包内单个 XML 的最大大小
const MAX_XML_BYTES: u64 = 16 * 1024 * 1024;
/// 批注对应的原文最多保留的字数
const MAX_ANCHOR_CHARS: usize = 200;

// ===== XML 树 =====

#[derive(Debug, Default)]
pub struct Element {
  pub name: String,
  attrs: Vec<(String, String)>,
  children: Vec<Node>,
}

#[derive(Debug)]
enum Node {
  Element(Element),
  Text(String),
}

impl Element {
  fn attr(&self, name: &str) -> Option<&str> {
    self.attrs.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
  }

  fn elements(&self) -> impl Iterator<Item = &Element> {
    self.children.iter().filter_map(|child| match child {
      Node::Element(element) => Some(element),
      Node::Text(_) => None,
    })
  }

  fn child(&self, name: &str) -> Option<&Element> {
    self.elements().find(|element| element.name == name)
  }

  /// 子元素 name 的属性 attr，如 <w:pStyle w:val="1"/> 的 w:val
  fn child_attr(&self, name: &str, attr: &str) -> Option<&str> {
    self.child(name)?.attr(attr)
  }

  /// 深度优先查找第一个名为 name 的元素
  fn find(&self, name: &str) -> Option<&Element> {
    self.elements().find_map(|element| if element.name == name { Some(element) } else { element.find(name) })
  }

  /// 直接包含的文字
  fn text(&self) -> String {
    self.children.iter().filter_map(|child| if let Node::Text(text) = child { Some(text.as_str()) } else { None }).collect()
  }

  fn push_text(&mut self, text: &str) {
    if text.is_empty() {
      return;
    }
    if let Some(Node::Text(last)) = self.children.last_mut() {
      last.push_str(text);
    }
    else {
      self.children.push(Node::Text(text.to_string()));
    }
  }
}

fn element_of(start: &quick_xml::events::BytesStart) -> Element {
  let attrs = start
    .attributes()
    .flatten()
    .map(|attr| {
      let value = quick_xml::escape::unescape(&attr.value).map(|value| value.into_owned()).unwrap_or_else(|_| attr.value.to_string());
      (attr.key.as_ref().to_string(), value)
    })
    .collect();
  Element { name: start.name().as_ref().to_string(), attrs, children: Vec::new() }
}

/// 预定义的实体与字符引用（&amp;、&#x4E2D;）
fn resolve_reference(reference: quick_xml::events::BytesRef) -> String {
  if let Ok(Some(ch)) = reference.resolve_char_ref() {
    return ch.to_string();
  }
  match reference.into_inner().as_ref() {
    "lt" => "<",
    "gt" => ">",
    "amp" => "&",
    "apos" => "'",
    "quot" => "\"",
    _ => "",
  }
  .to_string()
}

/// 解析 XML，返回根元素
pub fn parse_xml(xml: &str) -> Result<Element, String> {
  let mut reader = Reader::from_str(xml);
  reader.config_mut().check_end_names = false;
  reader.config_mut().allow_unmatched_ends = true;
  let mut stack = vec![Element::default()];
  loop {
    let event = reader.read_event().map_err(|e| format!("文档格式有误：{e}"))?;
    match event {
      Event::Start(start) => stack.push(element_of(&start)),
      Event::Empty(start) => {
        let element = element_of(&start);
        stack.last_mut().expect("栈中至少有根节点").children.push(Node::Element(element));
      }
      Event::End(_) => {
        if stack.len() > 1 {
          let element = stack.pop().expect("栈中至少有两个元素");
          stack.last_mut().expect("栈中至少有根节点").children.push(Node::Element(element));
        }
      }
      Event::Text(text) => stack.last_mut().expect("栈中至少有根节点").push_text(&text.into_inner()),
      Event::CData(data) => stack.last_mut().expect("栈中至少有根节点").push_text(&data.into_inner()),
      Event::GeneralRef(reference) => {
        let text = resolve_reference(reference);
        stack.last_mut().expect("栈中至少有根节点").push_text(&text);
      }
      Event::Eof => break,
      _ => {}
    }
  }
  // 没有闭合的元素
  while stack.len() > 1 {
    let element = stack.pop().expect("栈中至少有两个元素");
    stack.last_mut().expect("栈中至少有根节点").children.push(Node::Element(element));
  }
  let mut document = stack.pop().expect("栈中至少有根节点");
  document
    .children
    .drain(..)
    .find_map(|child| if let Node::Element(element) = child { Some(element) } else { None })
    .ok_or_else(|| "文档是空的".to_string())
}

// ===== 压缩包 =====

pub fn read_entry<R: Read + Seek>(archive: &mut zip::ZipArchive<R>, name: &str) -> Result<String, String> {
  let entry = archive.by_name(name).map_err(|_| format!("文档中缺少 {name}"))?;
  if entry.size() > MAX_XML_BYTES {
    return Err("文档太大，无法读取".into());
  }
  let mut xml = String::new();
  entry.take(MAX_XML_BYTES).read_to_string(&mut xml).map_err(|e| format!("读取文档失败：{e}"))?;
  Ok(xml)
}

/// 读取并解析压缩包中的 XML；不存在或无法解析时为 None
fn read_xml<R: Read + Seek>(archive: &mut zip::ZipArchive<R>, name: &str) -> Option<Element> {
  parse_xml(&read_entry(archive, name).ok()?).ok()
}

/// 压缩包中「前缀 + 编号 + 后缀」的文件，按编号排序，如 word/header1.xml、ppt/slides/slide2.xml
fn numbered_entries<R: Read + Seek>(archive: &zip::ZipArchive<R>, prefix: &str, suffix: &str) -> Vec<String> {
  let mut entries: Vec<(usize, String)> = archive
    .file_names()
    .filter_map(|name| {
      let name = name.ok()?;
      let number = name.strip_prefix(prefix)?.strip_suffix(suffix)?.parse().ok()?;
      Some((number, name.to_string()))
    })
    .collect();
  entries.sort();
  entries.into_iter().map(|(_, name)| name).collect()
}

/// 关系文件（.rels）中的关系：Id → (Type, Target)，外部链接除外
fn relationships<R: Read + Seek>(archive: &mut zip::ZipArchive<R>, name: &str) -> HashMap<String, (String, String)> {
  let Some(root) = read_xml(archive, name) else { return HashMap::new() };
  root
    .elements()
    .filter(|element| element.name == "Relationship" && element.attr("TargetMode") != Some("External"))
    .filter_map(|element| {
      Some((element.attr("Id")?.to_string(), (element.attr("Type").unwrap_or_default().to_string(), element.attr("Target")?.to_string())))
    })
    .collect()
}

/// 关系中的 Target 相对于所在文件夹（如 ppt/slides）的完整路径
fn resolve_target(base_dir: &str, target: &str) -> String {
  let mut parts: Vec<&str> = if let Some(absolute) = target.strip_prefix('/') {
    return absolute.to_string();
  }
  else {
    base_dir.split('/').filter(|part| !part.is_empty()).collect()
  };
  for part in target.split('/') {
    match part {
      "" | "." => {}
      ".." => {
        parts.pop();
      }
      part => parts.push(part),
    }
  }
  parts.join("/")
}

/// 整理文字：去掉行尾空白，最多保留一个空行
pub fn tidy(text: &str) -> String {
  let mut output = String::new();
  let mut blank = false;
  for line in text.lines().map(str::trim_end) {
    if line.trim().is_empty() {
      if !blank && !output.is_empty() {
        output.push('\n');
      }
      blank = true;
    }
    else {
      output.push_str(line);
      output.push('\n');
      blank = false;
    }
  }
  output.trim().to_string()
}

/// Markdown 表格：第一行作为表头；单元格中的换行换成空格，| 转义
fn markdown_table(rows: &[Vec<String>]) -> String {
  let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
  if columns == 0 {
    return String::new();
  }
  let mut lines = Vec::new();
  for (index, row) in rows.iter().enumerate() {
    let cells: Vec<String> = (0..columns)
      .map(|column| {
        let text = row.get(column).map(String::as_str).unwrap_or_default();
        text.split_whitespace().collect::<Vec<_>>().join(" ").replace('|', "\\|")
      })
      .collect();
    lines.push(format!("| {} |", cells.join(" | ")));
    if index == 0 {
      lines.push(format!("|{}", " --- |".repeat(columns)));
    }
  }
  lines.join("\n")
}

// ===== Word：编号 =====

#[derive(Debug, Clone)]
struct Level {
  format: String,
  text: String,
  start: u32,
}

impl Default for Level {
  fn default() -> Self {
    Self { format: "decimal".into(), text: String::new(), start: 1 }
  }
}

/// 列表的编号（word/numbering.xml）
#[derive(Default)]
struct Numbering {
  /// 抽象编号 id → 每一级的格式
  abstracts: HashMap<String, Vec<Level>>,
  /// 编号 id → 抽象编号 id，以及重新设置的起始值
  nums: HashMap<String, (String, HashMap<usize, u32>)>,
  /// 每个编号当前每一级的值
  counters: HashMap<String, [Option<u32>; 9]>,
}

impl Numbering {
  fn parse(root: Option<&Element>) -> Self {
    let mut numbering = Self::default();
    let Some(root) = root else { return numbering };
    for abstract_num in root.elements().filter(|element| element.name == "w:abstractNum") {
      let Some(id) = abstract_num.attr("w:abstractNumId") else { continue };
      let mut levels = vec![Level::default(); 9];
      for level in abstract_num.elements().filter(|element| element.name == "w:lvl") {
        let Some(index) = level.attr("w:ilvl").and_then(|value| value.parse::<usize>().ok()).filter(|index| *index < 9) else { continue };
        levels[index] = Level {
          format: level.child_attr("w:numFmt", "w:val").unwrap_or("decimal").to_string(),
          text: level.child_attr("w:lvlText", "w:val").unwrap_or_default().to_string(),
          start: level.child_attr("w:start", "w:val").and_then(|value| value.parse().ok()).unwrap_or(1),
        };
      }
      numbering.abstracts.insert(id.to_string(), levels);
    }
    for num in root.elements().filter(|element| element.name == "w:num") {
      let (Some(id), Some(abstract_id)) = (num.attr("w:numId"), num.child_attr("w:abstractNumId", "w:val")) else { continue };
      let overrides = num
        .elements()
        .filter(|element| element.name == "w:lvlOverride")
        .filter_map(|element| {
          let level = element.attr("w:ilvl")?.parse().ok()?;
          let start = element.child_attr("w:startOverride", "w:val")?.parse().ok()?;
          Some((level, start))
        })
        .collect();
      numbering.nums.insert(id.to_string(), (abstract_id.to_string(), overrides));
    }
    numbering
  }

  /// 列表项的编号，如「-」「1.」「（一）」「2.3」；没有编号时为 None
  fn label(&mut self, num_id: &str, level: usize) -> Option<String> {
    let (abstract_id, overrides) = self.nums.get(num_id)?;
    let levels = self.abstracts.get(abstract_id)?;
    let current = levels.get(level)?;
    if current.format == "bullet" {
      return Some("-".into());
    }
    if current.format == "none" {
      return None;
    }
    let start = |index: usize| overrides.get(&index).copied().unwrap_or(levels[index].start);
    let counters = self.counters.entry(num_id.to_string()).or_insert([None; 9]);
    counters[level] = Some(counters[level].map_or(start(level), |value| value + 1));
    for deeper in counters.iter_mut().skip(level + 1) {
      *deeper = None;
    }
    let mut label = if current.text.is_empty() { format!("%{}.", level + 1) } else { current.text.clone() };
    for index in (0..9).rev() {
      let placeholder = format!("%{}", index + 1);
      if label.contains(&placeholder) {
        let value = counters[index].unwrap_or_else(|| start(index));
        label = label.replace(&placeholder, &format_number(value, &levels[index].format));
      }
    }
    let label = label.trim().to_string();
    (!label.is_empty()).then_some(label)
  }
}

fn roman(mut value: u32) -> String {
  const NUMERALS: [(u32, &str); 13] =
    [(1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"), (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")];
  let mut output = String::new();
  for (number, numeral) in NUMERALS {
    while value >= number {
      output.push_str(numeral);
      value -= number;
    }
  }
  output
}

/// 中文数字（一百以内）：一、十一、二十三
fn chinese(value: u32) -> String {
  const DIGITS: [&str; 10] = ["〇", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  match value {
    0..=9 => DIGITS[value as usize].to_string(),
    10..=19 => format!("十{}", if value == 10 { "" } else { DIGITS[(value - 10) as usize] }),
    20..=99 => format!("{}十{}", DIGITS[(value / 10) as usize], if value.is_multiple_of(10) { "" } else { DIGITS[(value % 10) as usize] }),
    _ => value.to_string(),
  }
}

/// 按编号格式写出数字
fn format_number(value: u32, format: &str) -> String {
  match format {
    "decimalZero" => format!("{value:02}"),
    "lowerLetter" | "upperLetter" => {
      let letter = (b'a' + ((value.max(1) - 1) % 26) as u8) as char;
      let text = letter.to_string().repeat(((value.max(1) - 1) / 26 + 1) as usize);
      if format == "upperLetter" { text.to_uppercase() } else { text }
    }
    "lowerRoman" => roman(value).to_lowercase(),
    "upperRoman" => roman(value),
    "chineseCounting" | "chineseCountingThousand" | "japaneseCounting" | "taiwaneseCounting" | "ideographDigital" | "chineseLegalSimplified" => chinese(value),
    "ideographTraditional" => ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"][((value.max(1) - 1) % 10) as usize].to_string(),
    "decimalEnclosedCircle" | "decimalEnclosedCircleChinese" if (1..=20).contains(&value) => char::from_u32(0x2460 + value - 1).map(String::from).unwrap_or_default(),
    "decimalFullWidth" => value.to_string().chars().map(|c| char::from_u32(c as u32 - '0' as u32 + 0xFF10).unwrap_or(c)).collect(),
    _ => value.to_string(),
  }
}

// ===== Word =====

/// 样式的标题级别与编号（word/styles.xml）
#[derive(Default, Clone)]
struct StyleInfo {
  heading: Option<usize>,
  numbering: Option<(String, usize)>,
}

fn parse_styles(root: Option<&Element>) -> HashMap<String, StyleInfo> {
  let mut styles = HashMap::new();
  let Some(root) = root else { return styles };
  for style in root.elements().filter(|element| element.name == "w:style") {
    let Some(id) = style.attr("w:styleId") else { continue };
    // 内置样式的 w:name 总是英文（如 heading 1），中文版 Word 的样式 id 可能是「1」「2」
    let name = style.child_attr("w:name", "w:val").unwrap_or_default().to_lowercase();
    let properties = style.child("w:pPr");
    let heading = if name == "title" {
      Some(1)
    }
    else if let Some(level) = name.strip_prefix("heading ").and_then(|level| level.trim().parse::<usize>().ok()) {
      Some(level)
    }
    else {
      properties.and_then(|p| p.child_attr("w:outlineLvl", "w:val")).and_then(|level| level.parse::<usize>().ok()).filter(|level| *level < 9).map(|level| level + 1)
    };
    let numbering = properties.and_then(|p| p.child("w:numPr")).and_then(|numbering| {
      let id = numbering.child_attr("w:numId", "w:val")?.to_string();
      Some((id, numbering.child_attr("w:ilvl", "w:val").and_then(|level| level.parse().ok()).unwrap_or(0)))
    });
    styles.insert(id.to_string(), StyleInfo { heading, numbering });
  }
  styles
}

/// 脚注、尾注与批注在正文中出现的顺序（标签从 1 开始）
#[derive(Default)]
struct Labels {
  order: Vec<String>,
}

impl Labels {
  fn label(&mut self, id: &str) -> usize {
    match self.order.iter().position(|item| item == id) {
      Some(index) => index + 1,
      None => {
        self.order.push(id.to_string());
        self.order.len()
      }
    }
  }
}

struct Docx {
  styles: HashMap<String, StyleInfo>,
  numbering: Numbering,
  footnotes: Labels,
  endnotes: Labels,
  comments: Labels,
  /// 正在标记原文的批注，以及每个批注对应的原文
  active_comments: Vec<String>,
  anchors: HashMap<String, String>,
  marked_comments: HashSet<String>,
}

impl Docx {
  /// 段落、表格等块级内容，每个元素一行（表格为多行）
  fn blocks(&mut self, container: &Element) -> Vec<String> {
    let mut output = Vec::new();
    for element in container.elements() {
      match element.name.as_str() {
        "w:p" => {
          let (line, extra, heading) = self.paragraph(element);
          if heading {
            output.push(String::new());
          }
          output.push(line);
          output.extend(extra);
        }
        "w:tbl" => {
          output.push(String::new());
          output.push(self.table(element));
          output.push(String::new());
        }
        "w:sdt" => {
          if let Some(content) = element.child("w:sdtContent") {
            output.extend(self.blocks(content));
          }
        }
        "w:customXml" | "w:ins" | "w:moveTo" | "w:smartTag" => output.extend(self.blocks(element)),
        "mc:AlternateContent" => {
          if let Some(choice) = element.child("mc:Choice") {
            output.extend(self.blocks(choice));
          }
        }
        _ => {}
      }
    }
    output
  }

  /// 一个段落：返回这一行、跟在后面的内容（如文本框中的段落），以及是不是标题
  fn paragraph(&mut self, paragraph: &Element) -> (String, Vec<String>, bool) {
    let properties = paragraph.child("w:pPr");
    let style = properties.and_then(|p| p.child_attr("w:pStyle", "w:val")).and_then(|id| self.styles.get(id)).cloned().unwrap_or_default();
    let outline = properties
      .and_then(|p| p.child_attr("w:outlineLvl", "w:val"))
      .and_then(|level| level.parse::<usize>().ok())
      .filter(|level| *level < 9)
      .map(|level| level + 1);
    let heading = outline.or(style.heading);
    let numbering = match properties.and_then(|p| p.child("w:numPr")) {
      Some(numbering) => numbering.child_attr("w:numId", "w:val").map(|id| {
        let level = numbering.child_attr("w:ilvl", "w:val").and_then(|level| level.parse().ok()).unwrap_or(style.numbering.as_ref().map_or(0, |(_, level)| *level));
        (id.to_string(), level)
      }),
      None => style.numbering.clone(),
    };

    let mut text = String::new();
    let mut extra = Vec::new();
    self.inline(paragraph, &mut text, &mut extra);
    let text = text.trim();
    if text.is_empty() {
      return (String::new(), extra, false);
    }

    let label = numbering.as_ref().filter(|(id, _)| id != "0").and_then(|(id, level)| self.numbering.label(id, (*level).min(8)));
    let mut line = String::new();
    if let Some(level) = heading {
      line.push_str(&"#".repeat(level.clamp(1, 6)));
      line.push(' ');
    }
    else if let (Some((_, level)), Some(_)) = (&numbering, &label) {
      line.push_str(&"  ".repeat((*level).min(8)));
    }
    if let Some(label) = label {
      line.push_str(&label);
      line.push(' ');
    }
    if heading.is_some() {
      line.push_str(&text.split_whitespace().collect::<Vec<_>>().join(" "));
    }
    else {
      line.push_str(text);
    }
    (line, extra, heading.is_some())
  }

  /// 段落中的文字
  fn inline(&mut self, element: &Element, output: &mut String, extra: &mut Vec<String>) {
    for child in element.elements() {
      match child.name.as_str() {
        // 段落与文字的格式、修订中删除的文字、域代码、脚注与批注自己的编号标记
        "w:pPr" | "w:rPr" | "w:del" | "w:moveFrom" | "w:delText" | "w:instrText" | "w:footnoteRef" | "w:endnoteRef"
        | "w:annotationRef" | "w:fldData" | "mc:Fallback" => {}
        "w:t" => {
          let text = child.text();
          self.anchor(&text);
          output.push_str(&text);
        }
        "w:tab" | "w:ptab" => output.push('\t'),
        "w:br" | "w:cr" => output.push('\n'),
        "w:noBreakHyphen" => output.push('-'),
        "w:footnoteReference" => {
          if let Some(id) = child.attr("w:id") {
            output.push_str(&format!("[^{}]", self.footnotes.label(id)));
          }
        }
        "w:endnoteReference" => {
          if let Some(id) = child.attr("w:id") {
            output.push_str(&format!("[^尾注{}]", self.endnotes.label(id)));
          }
        }
        "w:commentRangeStart" => {
          if let Some(id) = child.attr("w:id") {
            self.active_comments.push(id.to_string());
          }
        }
        "w:commentRangeEnd" | "w:commentReference" => {
          if let Some(id) = child.attr("w:id") {
            self.active_comments.retain(|active| active != id);
            if self.marked_comments.insert(id.to_string()) {
              output.push_str(&format!("[批注{}]", self.comments.label(id)));
            }
          }
        }
        // 文本框：其中的段落跟在所在的段落后面
        "w:txbxContent" => {
          let blocks = self.blocks(child);
          extra.extend(blocks);
        }
        "mc:AlternateContent" => {
          if let Some(choice) = child.child("mc:Choice") {
            self.inline(choice, output, extra);
          }
        }
        "w:p" => {
          let (line, more, _) = self.paragraph(child);
          extra.push(line);
          extra.extend(more);
        }
        "w:tbl" => extra.push(self.table(child)),
        _ => self.inline(child, output, extra),
      }
    }
  }

  /// 记下批注对应的原文
  fn anchor(&mut self, text: &str) {
    for id in &self.active_comments {
      let anchor = self.anchors.entry(id.clone()).or_default();
      if anchor.chars().count() < MAX_ANCHOR_CHARS {
        anchor.push_str(text);
      }
    }
  }

  /// 表格中的行（包括内容控件中的行）
  fn rows(table: &Element) -> Vec<&Element> {
    let mut rows = Vec::new();
    for element in table.elements() {
      match element.name.as_str() {
        "w:tr" => rows.push(element),
        "w:sdt" | "w:customXml" => {
          if let Some(content) = element.child("w:sdtContent").or(Some(element)) {
            rows.extend(content.elements().filter(|row| row.name == "w:tr"));
          }
        }
        _ => {}
      }
    }
    rows
  }

  fn cells(row: &Element) -> Vec<&Element> {
    let mut cells = Vec::new();
    for element in row.elements() {
      match element.name.as_str() {
        "w:tc" => cells.push(element),
        "w:sdt" | "w:customXml" => {
          if let Some(content) = element.child("w:sdtContent").or(Some(element)) {
            cells.extend(content.elements().filter(|cell| cell.name == "w:tc"));
          }
        }
        _ => {}
      }
    }
    cells
  }

  /// 表格：写成 Markdown 表格。合并的单元格只在第一格写内容；只有一格的表格（常用来排版）按普通内容输出
  fn table(&mut self, table: &Element) -> String {
    let rows = Self::rows(table);
    if let [row] = rows.as_slice()
      && let [cell] = Self::cells(row).as_slice()
    {
      return tidy(&self.blocks(cell).join("\n"));
    }
    let mut output: Vec<Vec<String>> = Vec::new();
    for row in rows {
      let mut cells = Vec::new();
      for cell in Self::cells(row) {
        let properties = cell.child("w:tcPr");
        let span = properties.and_then(|p| p.child_attr("w:gridSpan", "w:val")).and_then(|span| span.parse::<usize>().ok()).unwrap_or(1).clamp(1, 64);
        // 纵向合并：restart 开始，没有 w:val 或为 continue 的是被合并的格子
        let merged = properties.and_then(|p| p.child("w:vMerge")).is_some_and(|merge| merge.attr("w:val") != Some("restart"));
        cells.push(if merged { String::new() } else { self.cell_text(cell) });
        cells.extend(std::iter::repeat_n(String::new(), span - 1));
      }
      output.push(cells);
    }
    markdown_table(&output)
  }

  /// 单元格中的文字写成一行；单元格中的表格每行用「；」分隔
  fn cell_text(&mut self, cell: &Element) -> String {
    let mut parts = Vec::new();
    for element in cell.elements() {
      match element.name.as_str() {
        "w:tbl" => {
          let rows: Vec<String> = Self::rows(element)
            .into_iter()
            .map(|row| Self::cells(row).into_iter().map(|cell| self.cell_text(cell)).filter(|text| !text.is_empty()).collect::<Vec<_>>().join(" / "))
            .filter(|row| !row.is_empty())
            .collect();
          parts.push(rows.join("；"));
        }
        "w:tcPr" => {}
        _ => parts.extend(self.blocks_of(element)),
      }
    }
    parts.into_iter().map(|part| part.trim().to_string()).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ")
  }

  /// 单个块级元素的内容
  fn blocks_of(&mut self, element: &Element) -> Vec<String> {
    match element.name.as_str() {
      "w:p" => {
        let (line, extra, _) = self.paragraph(element);
        std::iter::once(line).chain(extra).collect()
      }
      "w:sdt" => element.child("w:sdtContent").map(|content| self.blocks(content)).unwrap_or_default(),
      "w:customXml" | "w:ins" | "w:moveTo" | "w:smartTag" => self.blocks(element),
      _ => Vec::new(),
    }
  }

  /// 页眉、页脚、脚注等独立部分的文字
  fn part_text(&mut self, element: &Element) -> String {
    tidy(&self.blocks(element).join("\n"))
  }
}

/// 读取 Word 文档的文字
pub fn read_docx<R: Read + Seek>(archive: &mut zip::ZipArchive<R>) -> Result<String, String> {
  let document = parse_xml(&read_entry(archive, "word/document.xml")?)?;
  let body = document.child("w:body").ok_or("文档中没有正文")?;
  let styles_root = read_xml(archive, "word/styles.xml");
  let numbering_root = read_xml(archive, "word/numbering.xml");
  let mut docx = Docx {
    styles: parse_styles(styles_root.as_ref()),
    numbering: Numbering::parse(numbering_root.as_ref()),
    footnotes: Labels::default(),
    endnotes: Labels::default(),
    comments: Labels::default(),
    active_comments: Vec::new(),
    anchors: HashMap::new(),
    marked_comments: HashSet::new(),
  };

  let mut sections = vec![docx.part_text(body)];

  // 页眉与页脚：各节通常相同，去掉重复的。只有页码（文件中保存的是页码域上次的值，如「1」「0」）的不列出
  for (prefix, title) in [("word/header", "页眉"), ("word/footer", "页脚")] {
    let mut texts: Vec<String> = Vec::new();
    for name in numbered_entries(archive, prefix, ".xml") {
      if let Some(root) = read_xml(archive, &name) {
        let text = docx.part_text(&root);
        let page_number_only = text.chars().all(|c| c.is_ascii_digit() || c.is_whitespace());
        if !page_number_only && !texts.contains(&text) {
          texts.push(text);
        }
      }
    }
    if !texts.is_empty() {
      sections.push(format!("【{title}】\n{}", texts.join("\n\n")));
    }
  }

  // 脚注与尾注：按在正文中出现的顺序
  for (name, tag, title, prefix, is_footnote) in [
    ("word/footnotes.xml", "w:footnote", "脚注", "", true),
    ("word/endnotes.xml", "w:endnote", "尾注", "尾注", false),
  ] {
    let Some(root) = read_xml(archive, name) else { continue };
    let notes: HashMap<&str, &Element> = root
      .elements()
      .filter(|element| element.name == tag && !matches!(element.attr("w:type"), Some("separator" | "continuationSeparator" | "continuationNotice")))
      .filter_map(|element| Some((element.attr("w:id")?, element)))
      .collect();
    let mut lines = Vec::new();
    let mut index = 0;
    // 脚注中也可能引用其他脚注，因此每次都重新读取顺序
    loop {
      let labels = if is_footnote { &docx.footnotes } else { &docx.endnotes };
      let Some(id) = labels.order.get(index).cloned() else { break };
      index += 1;
      if let Some(note) = notes.get(id.as_str()) {
        let text = docx.part_text(note).replace('\n', " ");
        lines.push(format!("[^{prefix}{index}] {text}"));
      }
    }
    if !lines.is_empty() {
      sections.push(format!("【{title}】\n{}", lines.join("\n")));
    }
  }

  // 批注：按在正文中出现的顺序，注明作者、日期与对应的原文
  if let Some(root) = read_xml(archive, "word/comments.xml") {
    let comments: Vec<&Element> = root.elements().filter(|element| element.name == "w:comment").collect();
    for comment in &comments {
      if let Some(id) = comment.attr("w:id") {
        docx.comments.label(id);
      }
    }
    let mut lines = Vec::new();
    for (index, id) in docx.comments.order.clone().iter().enumerate() {
      let Some(comment) = comments.iter().find(|comment| comment.attr("w:id") == Some(id.as_str())) else { continue };
      let author = comment.attr("w:author").filter(|author| !author.is_empty());
      let date = comment.attr("w:date").map(|date| date.chars().take(10).collect::<String>());
      let who = match (author, date) {
        (Some(author), Some(date)) => format!("{author}（{date}）"),
        (Some(author), None) => author.to_string(),
        (None, Some(date)) => format!("（{date}）"),
        (None, None) => String::new(),
      };
      let text = docx.part_text(comment).replace('\n', " ");
      let mut line = format!("[批注{}] {}{}", index + 1, if who.is_empty() { String::new() } else { format!("{who}：") }, text);
      if let Some(anchor) = docx.anchors.get(id).map(|anchor| anchor.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|anchor| !anchor.is_empty()) {
        let anchor: String = anchor.chars().take(MAX_ANCHOR_CHARS).collect();
        line.push_str(&format!("\n  对应的原文：「{anchor}」"));
      }
      lines.push(line);
    }
    if !lines.is_empty() {
      sections.push(format!("【批注】\n{}", lines.join("\n")));
    }
  }

  Ok(sections.into_iter().filter(|section| !section.is_empty()).collect::<Vec<_>>().join("\n\n"))
}

// ===== PowerPoint =====

/// 文本框中的段落，每段一行；按段落的级别缩进
fn text_body_lines(body: &Element) -> Vec<String> {
  fn collect(element: &Element, output: &mut String) {
    for child in element.elements() {
      match child.name.as_str() {
        "a:pPr" | "a:rPr" | "a:endParaRPr" => {}
        "a:t" => output.push_str(&child.text()),
        "a:br" => output.push('\n'),
        _ => collect(child, output),
      }
    }
  }
  body
    .elements()
    .filter(|element| element.name == "a:p")
    .filter_map(|paragraph| {
      let mut text = String::new();
      collect(paragraph, &mut text);
      let text = text.trim();
      if text.is_empty() {
        return None;
      }
      let level = paragraph.child("a:pPr").and_then(|p| p.attr("lvl")).and_then(|level| level.parse::<usize>().ok()).unwrap_or(0).min(8);
      Some(format!("{}{text}", "  ".repeat(level)))
    })
    .collect()
}

/// 幻灯片中的表格：写成 Markdown 表格，合并的单元格只在第一格写内容
fn slide_table(table: &Element) -> String {
  let rows: Vec<Vec<String>> = table
    .elements()
    .filter(|element| element.name == "a:tr")
    .map(|row| {
      row
        .elements()
        .filter(|element| element.name == "a:tc")
        .map(|cell| {
          if cell.attr("hMerge") == Some("1") || cell.attr("vMerge") == Some("1") {
            return String::new();
          }
          cell.child("a:txBody").map(|body| text_body_lines(body).iter().map(|line| line.trim()).collect::<Vec<_>>().join(" ")).unwrap_or_default()
        })
        .collect()
    })
    .collect();
  markdown_table(&rows)
}

/// 形状的占位符类型（如 title、body、sldNum）；不是占位符时为 None
fn placeholder_type(shape: &Element) -> Option<&str> {
  let properties = shape.elements().find(|element| element.name.starts_with("p:nv"))?;
  let placeholder = properties.child("p:nvPr")?.child("p:ph")?;
  Some(placeholder.attr("type").unwrap_or("obj"))
}

/// 幻灯片（或备注页）中的文字。include 决定是否包含某个形状（参数为占位符类型）
fn shapes_text(tree: &Element, include: &dyn Fn(Option<&str>) -> bool, output: &mut Vec<String>) {
  for element in tree.elements() {
    match element.name.as_str() {
      "p:sp" => {
        if include(placeholder_type(element))
          && let Some(body) = element.child("p:txBody")
        {
          output.extend(text_body_lines(body));
        }
      }
      "p:grpSp" => shapes_text(element, include, output),
      "p:graphicFrame" => {
        if let Some(table) = element.find("a:tbl") {
          output.push(String::new());
          output.push(slide_table(table));
          output.push(String::new());
        }
      }
      "mc:AlternateContent" => {
        if let Some(choice) = element.child("mc:Choice") {
          shapes_text(choice, include, output);
        }
      }
      _ => {}
    }
  }
}

/// 幻灯片按演示文稿中的顺序排列（ppt/presentation.xml）；读取不到时按文件编号排序
fn slide_order<R: Read + Seek>(archive: &mut zip::ZipArchive<R>) -> Vec<String> {
  let ordered = (|| {
    let presentation = read_xml(archive, "ppt/presentation.xml")?;
    let relationships = relationships(archive, "ppt/_rels/presentation.xml.rels");
    let list = presentation.child("p:sldIdLst")?;
    let slides: Vec<String> = list
      .elements()
      .filter(|element| element.name == "p:sldId")
      .filter_map(|element| relationships.get(element.attr("r:id")?).map(|(_, target)| resolve_target("ppt", target)))
      .collect();
    (!slides.is_empty()).then_some(slides)
  })();
  ordered.unwrap_or_else(|| numbered_entries(archive, "ppt/slides/slide", ".xml"))
}

/// 读取 PowerPoint 演示文稿的文字：每页的文字、表格与演讲者备注
pub fn read_pptx<R: Read + Seek>(archive: &mut zip::ZipArchive<R>) -> Result<String, String> {
  let mut output = Vec::new();
  for (index, path) in slide_order(archive).into_iter().enumerate() {
    let Ok(xml) = read_entry(archive, &path) else { continue };
    let slide = parse_xml(&xml)?;
    let mut lines = Vec::new();
    if let Some(tree) = slide.find("p:spTree") {
      shapes_text(tree, &|_| true, &mut lines);
    }
    let text = tidy(&lines.join("\n"));

    // 演讲者备注：幻灯片的关系中类型为 notesSlide 的文件，只取正文占位符中的文字
    let (dir, file) = path.rsplit_once('/').unwrap_or(("", path.as_str()));
    let notes_path = relationships(archive, &format!("{dir}/_rels/{file}.rels"))
      .into_values()
      .find(|(kind, _)| kind.ends_with("/notesSlide"))
      .map(|(_, target)| resolve_target(dir, &target));
    let notes = notes_path
      .and_then(|notes_path| read_xml(archive, &notes_path))
      .and_then(|notes| {
        let tree = notes.find("p:spTree")?;
        let mut lines = Vec::new();
        shapes_text(tree, &|kind| matches!(kind, None | Some("body")), &mut lines);
        Some(tidy(&lines.join("\n")))
      })
      .unwrap_or_default();

    if text.is_empty() && notes.is_empty() {
      continue;
    }
    let hidden = if slide.attr("show") == Some("0") { "（隐藏）" } else { "" };
    let mut block = format!("【第 {} 页{hidden}】", index + 1);
    if !text.is_empty() {
      block.push('\n');
      block.push_str(&text);
    }
    if !notes.is_empty() {
      block.push_str("\n【备注】\n");
      block.push_str(&notes);
    }
    output.push(block);
  }
  Ok(output.join("\n\n"))
}

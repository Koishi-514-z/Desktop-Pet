//! 新建与修改 Office 文件：
//! - Word（docx）：用简单的 Markdown 写法新建文档；在段落内替换文字，在末尾追加段落
//! - PowerPoint（pptx）：在幻灯片内替换文字（不支持新建）
//! - Excel（xlsx）：新建表格，修改单元格，追加行
//!
//! 修改 docx 与 pptx 时只改动正文的 XML，压缩包中的其他内容（图片、样式等）原样复制；
//! xlsx 由 umya-spreadsheet 读入后整体重新保存。

use std::{
  collections::HashMap,
  io::{Cursor, Read, Write},
};

use serde::Deserialize;
use umya_spreadsheet::{Cell, Workbook, Worksheet};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use super::read::column_name;
use super::write::{push_lines, TextEdit};

/// 压缩包内单个 XML 的最大大小
const MAX_XML_BYTES: u64 = 16 * 1024 * 1024;
/// 预览中段落最多显示的字数
const PARAGRAPH_PREVIEW_CHARS: usize = 200;

/// 修改 Excel 时提示用户的注意事项
pub const XLSX_WARNING: &str =
  "Excel 文件会被整体重新保存：公式的结果要在 Excel 中打开后才会更新，少数高级内容（如数据透视表、切片器）可能丢失";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellEdit {
  /// 工作表名称，省略时为第一个工作表
  pub sheet: Option<String>,
  /// 单元格位置，如 B3
  pub cell: String,
  /// 新的值：以 = 开头为公式，数字会存为数值，其余为文字
  pub value: String,
}

/// 一次修改的结果
pub struct OfficeChange {
  pub bytes: Vec<u8>,
  pub summary: String,
  pub preview: String,
}

// ===== XML 与压缩包 =====

pub fn escape_xml(text: &str) -> String {
  text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn unescape_xml(text: &str) -> String {
  let mut output = String::with_capacity(text.len());
  let mut rest = text;
  while let Some(position) = rest.find('&') {
    output.push_str(&rest[..position]);
    let tail = &rest[position..];
    let Some(end) = tail.find(';').filter(|&end| end <= 10) else {
      output.push('&');
      rest = &tail[1..];
      continue;
    };
    let entity = &tail[1..end];
    let decoded = match entity {
      "lt" => Some('<'),
      "gt" => Some('>'),
      "amp" => Some('&'),
      "quot" => Some('"'),
      "apos" => Some('\''),
      _ => entity
        .strip_prefix("#x")
        .or_else(|| entity.strip_prefix("#X"))
        .and_then(|hex| u32::from_str_radix(hex, 16).ok())
        .or_else(|| entity.strip_prefix('#').and_then(|dec| dec.parse().ok()))
        .and_then(char::from_u32),
    };
    match decoded {
      Some(c) => {
        output.push(c);
        rest = &tail[end + 1..];
      }
      None => {
        output.push('&');
        rest = &tail[1..];
      }
    }
  }
  output.push_str(rest);
  output
}

fn open_archive(bytes: &[u8]) -> Result<ZipArchive<Cursor<&[u8]>>, String> {
  ZipArchive::new(Cursor::new(bytes)).map_err(|_| "文件已损坏，或不是有效的 Office 文档".to_string())
}

fn read_xml(archive: &mut ZipArchive<Cursor<&[u8]>>, name: &str) -> Result<String, String> {
  let entry = archive.by_name(name).map_err(|_| format!("文档中缺少 {name}"))?;
  if entry.size() > MAX_XML_BYTES {
    return Err("文档太大，无法修改".into());
  }
  let mut xml = String::new();
  entry.take(MAX_XML_BYTES).read_to_string(&mut xml).map_err(|e| format!("读取文档失败：{e}"))?;
  Ok(xml)
}

fn zip_options() -> SimpleFileOptions {
  SimpleFileOptions::default().compression_method(CompressionMethod::Deflated)
}

/// 重新打包：替换指定的条目，其余条目原样复制（不重新压缩）
fn rewrite_archive(bytes: &[u8], replaced: &HashMap<String, String>) -> Result<Vec<u8>, String> {
  let error = |e: zip::result::ZipError| format!("保存文档失败：{e}");
  let mut archive = open_archive(bytes)?;
  let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
  for index in 0..archive.len() {
    let entry = archive.by_index_raw(index).map_err(error)?;
    let name = entry.name().map_err(error)?.to_string();
    match replaced.get(&name) {
      Some(content) => {
        drop(entry);
        writer.start_file(name, zip_options()).map_err(error)?;
        writer.write_all(content.as_bytes()).map_err(|e| format!("保存文档失败：{e}"))?;
      }
      None => writer.raw_copy_file(entry).map_err(error)?,
    }
  }
  Ok(writer.finish().map_err(error)?.into_inner())
}

fn create_archive(entries: &[(&str, &str)]) -> Result<Vec<u8>, String> {
  let error = |e: zip::result::ZipError| format!("生成文档失败：{e}");
  let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
  for (name, content) in entries {
    writer.start_file(*name, zip_options()).map_err(error)?;
    writer.write_all(content.as_bytes()).map_err(|e| format!("生成文档失败：{e}"))?;
  }
  Ok(writer.finish().map_err(error)?.into_inner())
}

// ===== 在段落内替换文字（docx 与 pptx 共用） =====

/// 一段文字（<w:t> 或 <a:t>）在 XML 中的位置
struct TextNode {
  /// 开始标签的位置
  start: usize,
  /// 文字内容的范围
  content_start: usize,
  content_end: usize,
  text: String,
  /// 所在段落的编号；不在段落中时为 None
  paragraph: Option<usize>,
}

/// 一个段落：由若干段文字拼成，每段文字记录它在段落文字中的起始位置
struct Paragraph {
  text: String,
  nodes: Vec<(usize, usize)>,
}

struct TextLayout {
  nodes: Vec<TextNode>,
  /// 按文档顺序排列的段落（只包含有文字的段落）
  paragraphs: Vec<Paragraph>,
}

/// 找出 XML 中的所有文字节点及其所在的段落。段落可能嵌套（如文本框中的段落），
/// 文字属于最内层的段落
fn layout(xml: &str, text_tag: &str, paragraph_tag: &str) -> TextLayout {
  let text_open = format!("<{text_tag}");
  let text_close = format!("</{text_tag}>");
  let paragraph_open = format!("<{paragraph_tag}");
  let paragraph_close = format!("</{paragraph_tag}>");
  // 标签名后必须是 >、空白或 /，避免把 <w:tbl>、<w:pPr> 当成 <w:t>、<w:p>
  let is_tag = |tail: &str, prefix: &str| tail.starts_with(prefix) && tail[prefix.len()..].starts_with(['>', ' ', '/', '\n', '\r', '\t']);

  let mut nodes = Vec::new();
  let mut stack: Vec<usize> = Vec::new();
  let mut next_paragraph = 0;
  let mut position = 0;
  while let Some(offset) = xml[position..].find('<') {
    let start = position + offset;
    let tail = &xml[start..];
    let Some(tag_length) = tail.find('>') else { break };
    let tag_end = start + tag_length + 1;
    let self_closing = xml[..tag_end].ends_with("/>");

    if tail.starts_with(&paragraph_close) {
      stack.pop();
    }
    else if is_tag(tail, &paragraph_open) {
      if !self_closing {
        stack.push(next_paragraph);
        next_paragraph += 1;
      }
    }
    else if is_tag(tail, &text_open) && !self_closing {
      let Some(length) = xml[tag_end..].find(&text_close) else { break };
      let content_end = tag_end + length;
      nodes.push(TextNode {
        start,
        content_start: tag_end,
        content_end,
        text: unescape_xml(&xml[tag_end..content_end]),
        paragraph: stack.last().copied(),
      });
      position = content_end + text_close.len();
      continue;
    }
    position = tag_end;
  }

  let mut by_id: Vec<Option<Paragraph>> = (0..next_paragraph).map(|_| None).collect();
  for (index, node) in nodes.iter().enumerate() {
    let Some(id) = node.paragraph else { continue };
    let paragraph = by_id[id].get_or_insert_with(|| Paragraph { text: String::new(), nodes: Vec::new() });
    paragraph.nodes.push((index, paragraph.text.len()));
    paragraph.text.push_str(&node.text);
  }
  let paragraphs = by_id.into_iter().flatten().filter(|p| !p.text.trim().is_empty()).collect();
  TextLayout { nodes, paragraphs }
}

/// 把段落中 [start, end) 范围内的文字替换为 replacement：新文字放进第一段被涉及的文字中（沿用它的格式），
/// 其余被涉及的文字删去相应部分
fn replace_range(xml: &str, layout: &TextLayout, paragraph: &Paragraph, start: usize, end: usize, replacement: &str, text_tag: &str) -> String {
  let mut changes: Vec<(usize, usize, String)> = Vec::new();
  let mut inserted = false;
  for &(index, offset) in &paragraph.nodes {
    let node = &layout.nodes[index];
    let node_end = offset + node.text.len();
    if node_end <= start || offset >= end {
      continue;
    }
    let mut text = String::new();
    if !inserted {
      text.push_str(&node.text[..start - offset]);
      text.push_str(replacement);
      inserted = true;
    }
    if end < node_end {
      text.push_str(&node.text[end - offset..]);
    }
    // Word 默认会去掉文字首尾的空格，需要声明保留
    let open = if text_tag == "w:t" { "<w:t xml:space=\"preserve\">".to_string() } else { xml[node.start..node.content_start].to_string() };
    changes.push((node.start, node.content_end, format!("{open}{}", escape_xml(&text))));
  }

  let mut output = xml.to_string();
  for (from, to, content) in changes.into_iter().rev() {
    output.replace_range(from..to, &content);
  }
  output
}

/// 原文与新内容相同的开头与结尾（字节数）。只替换中间不同的部分，相同的文字保持原来的格式，
/// 例如「周报：本周」→「周报：这周」只替换「本」，不会因为「周报」加粗而把「：这周」也变成加粗。
/// 不同的部分在原文中至少保留一个字，让新文字沿用那个位置的格式
fn common_affixes(old: &str, new: &str) -> (usize, usize) {
  let mut prefix: usize = old.chars().zip(new.chars()).take_while(|(a, b)| a == b).map(|(a, _)| a.len_utf8()).sum();
  let limit = old.len().min(new.len()) - prefix;
  let mut suffix: usize = old
    .chars()
    .rev()
    .zip(new.chars().rev())
    .take_while(|(a, b)| a == b)
    .map(|(a, _)| a.len_utf8())
    .scan(0, |total, length| {
      *total += length;
      (*total <= limit).then_some(length)
    })
    .sum();
  if old.len() == prefix + suffix {
    // 纯插入：把插入点前（或后）的一个字也算作被替换的部分
    if let Some(c) = old[..prefix].chars().next_back() {
      prefix -= c.len_utf8();
    }
    else if let Some(c) = old[prefix..].chars().next() {
      suffix -= c.len_utf8();
    }
  }
  (prefix, suffix)
}

fn shorten(text: &str) -> String {
  if text.chars().count() <= PARAGRAPH_PREVIEW_CHARS {
    return text.to_string();
  }
  let shown: String = text.chars().take(PARAGRAPH_PREVIEW_CHARS).collect();
  format!("{shown}…")
}

/// 一个可以替换文字的 XML 部件（docx 的正文、pptx 的一页幻灯片）
struct Part {
  name: String,
  /// 在预览中的称呼，如「第 3 页」；为空时按段落称呼
  label: Option<String>,
  xml: String,
}

/// 在若干部件中依次执行替换。每处原文必须在一个段落之内，并且在所有部件中只出现一次
fn replace_in_parts(parts: &mut [Part], edits: &[TextEdit], text_tag: &str, paragraph_tag: &str, preview: &mut String) -> Result<(), String> {
  for (number, edit) in edits.iter().enumerate() {
    let label = if edits.len() > 1 { format!("第 {} 处修改", number + 1) } else { "修改".to_string() };
    let (old, new) = (edit.old_text.as_str(), edit.new_text.as_str());
    if old.is_empty() {
      return Err(format!("{label}的原文不能为空"));
    }
    if old == new {
      return Err(format!("{label}的原文与新内容相同"));
    }
    if old.contains('\n') || new.contains('\n') {
      return Err(format!("{label}的原文与新内容都不能包含换行：每处修改只能在一个段落之内；需要添加新段落时请用 append"));
    }

    // 统计所有部件中出现的次数，记录第一次出现的位置
    let mut found: Option<(usize, usize, usize)> = None;
    let mut count = 0;
    for (part_index, part) in parts.iter().enumerate() {
      let layout = layout(&part.xml, text_tag, paragraph_tag);
      for (paragraph_index, paragraph) in layout.paragraphs.iter().enumerate() {
        for (position, _) in paragraph.text.match_indices(old) {
          count += 1;
          found.get_or_insert((part_index, paragraph_index, position));
        }
      }
    }
    let Some((part_index, paragraph_index, position)) = found else {
      let excerpt: String = old.chars().take(60).collect();
      return Err(format!(
        "{label}的原文没有在文档中找到：「{excerpt}」。请先用 read_file 读取文档，原文需要与某一段的文字完全一致（包括空格与标点），并且不能跨越段落"
      ));
    };
    if count > 1 {
      return Err(format!("{label}的原文在文档中出现了 {count} 次，请包含更多上下文，使它只出现一次"));
    }

    let part = &mut parts[part_index];
    let layout = layout(&part.xml, text_tag, paragraph_tag);
    let paragraph = &layout.paragraphs[paragraph_index];
    let before = paragraph.text.clone();
    let after = format!("{}{new}{}", &before[..position], &before[position + old.len()..]);
    let location = match &part.label {
      Some(label) => label.clone(),
      None => format!("第 {} 段", paragraph_index + 1),
    };
    preview.push_str(&format!("{location}：\n- {}\n+ {}\n\n", shorten(&before), shorten(&after)));
    let (prefix, suffix) = common_affixes(old, new);
    let (start, end) = (position + prefix, position + old.len() - suffix);
    part.xml = replace_range(&part.xml, &layout, paragraph, start, end, &new[prefix..new.len() - suffix], text_tag);
  }
  Ok(())
}

// ===== Word =====

const DOCX_CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>"#;

const DOCX_PACKAGE_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#;

const DOCX_DOCUMENT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#;

const DOCX_STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="等线" w:cs="Calibri"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>"#;

/// 正文结尾的页面设置：A4，常规页边距
const DOCX_SECTION: &str = r#"<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>"#;

/// 正文的可用宽度（A4 宽度减去左右页边距），单位为 1/20 磅
const DOCX_TEXT_WIDTH: usize = 8306;

#[derive(Clone, Copy)]
enum Block {
  Normal,
  Heading(usize),
  List,
  Quote,
}

/// 把一行文字转为 run：**加粗** 的部分单独加粗
fn runs_xml(text: &str, bold: bool, size: Option<u32>) -> String {
  let mut output = String::new();
  for (index, segment) in text.split("**").enumerate() {
    if segment.is_empty() {
      continue;
    }
    let mut properties = String::new();
    if bold || index % 2 == 1 {
      properties.push_str("<w:b/>");
    }
    if let Some(size) = size {
      properties.push_str(&format!("<w:sz w:val=\"{size}\"/><w:szCs w:val=\"{size}\"/>"));
    }
    let properties = if properties.is_empty() { String::new() } else { format!("<w:rPr>{properties}</w:rPr>") };
    output.push_str(&format!("<w:r>{properties}<w:t xml:space=\"preserve\">{}</w:t></w:r>", escape_xml(segment)));
  }
  output
}

/// 生成一个段落。标题同时使用样式与直接格式，追加到没有定义标题样式的文档中时也能正确显示
fn paragraph_xml(text: &str, block: Block) -> String {
  let (properties, bold, size) = match block {
    Block::Heading(level) => {
      let size = [32, 28, 24][level.clamp(1, 3) - 1];
      let properties = format!(
        "<w:pPr><w:pStyle w:val=\"Heading{}\"/><w:keepNext/><w:spacing w:before=\"240\" w:after=\"120\"/><w:outlineLvl w:val=\"{}\"/></w:pPr>",
        level.clamp(1, 3),
        level.clamp(1, 3) - 1
      );
      (properties, true, Some(size))
    }
    Block::List => ("<w:pPr><w:ind w:left=\"420\" w:hanging=\"210\"/></w:pPr>".to_string(), false, None),
    Block::Quote => ("<w:pPr><w:ind w:left=\"420\"/></w:pPr>".to_string(), false, None),
    Block::Normal => (String::new(), false, None),
  };
  format!("<w:p>{properties}{}</w:p>", runs_xml(text, bold, size))
}

fn table_xml(rows: &[Vec<String>]) -> String {
  let columns = rows.iter().map(Vec::len).max().unwrap_or(1).max(1);
  let width = DOCX_TEXT_WIDTH / columns;
  let border = |side: &str| format!("<w:{side} w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>");
  let borders: String = ["top", "left", "bottom", "right", "insideH", "insideV"].iter().map(|side| border(side)).collect();
  let grid: String = (0..columns).map(|_| format!("<w:gridCol w:w=\"{width}\"/>")).collect();

  let mut xml = format!("<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/><w:tblBorders>{borders}</w:tblBorders></w:tblPr><w:tblGrid>{grid}</w:tblGrid>");
  for (row_index, row) in rows.iter().enumerate() {
    xml.push_str("<w:tr>");
    for column in 0..columns {
      let text = row.get(column).map(String::as_str).unwrap_or("");
      // 每个单元格至少要有一个段落；第一行作为表头加粗
      xml.push_str(&format!(
        "<w:tc><w:tcPr><w:tcW w:w=\"{width}\" w:type=\"dxa\"/></w:tcPr><w:p>{}</w:p></w:tc>",
        runs_xml(text, row_index == 0, None)
      ));
    }
    xml.push_str("</w:tr>");
  }
  xml.push_str("</w:tbl>");
  xml
}

/// 解析 Markdown 表格的一行：| a | b | → ["a", "b"]
fn table_row(line: &str) -> Vec<String> {
  let line = line.trim();
  let line = line.strip_prefix('|').unwrap_or(line);
  let line = line.strip_suffix('|').unwrap_or(line);
  line.split('|').map(|cell| cell.trim().to_string()).collect()
}

/// Markdown 表格的分隔行，如 |---|:---:|
fn is_table_separator(line: &str) -> bool {
  let cells = table_row(line);
  !cells.is_empty() && cells.iter().all(|cell| !cell.is_empty() && cell.chars().all(|c| matches!(c, '-' | ':' | ' ')))
}

/// 把简单的 Markdown 转为 Word 正文：标题（#）、列表（- 或 1.）、引用（>）、表格（|）、加粗（**）、普通段落
fn markdown_to_docx(markdown: &str) -> String {
  let lines: Vec<&str> = markdown.lines().collect();
  let mut xml = String::new();
  let mut index = 0;
  while index < lines.len() {
    let line = lines[index].trim();
    if line.starts_with('|') {
      let mut rows = Vec::new();
      while index < lines.len() && lines[index].trim().starts_with('|') {
        if !is_table_separator(lines[index]) {
          rows.push(table_row(lines[index]));
        }
        index += 1;
      }
      xml.push_str(&table_xml(&rows));
      continue;
    }
    index += 1;
    if line.is_empty() {
      continue;
    }

    let hashes = line.chars().take_while(|&c| c == '#').count();
    if hashes > 0 && line[hashes..].starts_with(' ') {
      xml.push_str(&paragraph_xml(line[hashes..].trim(), Block::Heading(hashes)));
    }
    else if let Some(rest) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")).or_else(|| line.strip_prefix("+ ")) {
      xml.push_str(&paragraph_xml(&format!("• {}", rest.trim()), Block::List));
    }
    else if line.split_once(". ").is_some_and(|(number, _)| !number.is_empty() && number.chars().all(|c| c.is_ascii_digit())) {
      xml.push_str(&paragraph_xml(line, Block::List));
    }
    else if let Some(rest) = line.strip_prefix('>') {
      xml.push_str(&paragraph_xml(rest.trim(), Block::Quote));
    }
    else {
      xml.push_str(&paragraph_xml(line, Block::Normal));
    }
  }
  // Word 要求正文以段落结尾，表格之后补一个空段落
  if xml.ends_with("</w:tbl>") {
    xml.push_str("<w:p/>");
  }
  xml
}

/// 用简单的 Markdown 新建 Word 文档
pub fn create_docx(markdown: &str) -> Result<Vec<u8>, String> {
  let body = markdown_to_docx(markdown);
  if body.is_empty() {
    return Err("文档内容不能为空".into());
  }
  let document = format!(
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><w:body>{body}{DOCX_SECTION}</w:body></w:document>"
  );
  create_archive(&[
    ("[Content_Types].xml", DOCX_CONTENT_TYPES),
    ("_rels/.rels", DOCX_PACKAGE_RELS),
    ("word/_rels/document.xml.rels", DOCX_DOCUMENT_RELS),
    ("word/document.xml", &document),
    ("word/styles.xml", DOCX_STYLES),
  ])
}

/// 修改 Word 文档：在段落内替换文字，在末尾追加段落
pub fn edit_docx(bytes: &[u8], edits: &[TextEdit], append: Option<&str>) -> Result<OfficeChange, String> {
  const DOCUMENT: &str = "word/document.xml";
  let xml = read_xml(&mut open_archive(bytes)?, DOCUMENT)?;
  let mut parts = [Part { name: DOCUMENT.into(), label: None, xml }];
  let mut preview = String::new();
  replace_in_parts(&mut parts, edits, "w:t", "w:p", &mut preview)?;
  let [Part { mut xml, .. }] = parts;

  let mut summary = Vec::new();
  if !edits.is_empty() {
    summary.push(format!("修改了 {} 处", edits.len()));
  }
  if let Some(append) = append {
    let paragraphs = markdown_to_docx(append);
    if paragraphs.is_empty() {
      return Err("追加的内容不能为空".into());
    }
    // 插入到正文末尾：正文最后的 <w:sectPr>（页面设置）之前，没有时插入到 </w:body> 之前
    let body_end = xml.rfind("</w:body>").ok_or("文档格式不正确：找不到正文")?;
    let last_block = xml[..body_end].rfind("</w:p>").max(xml[..body_end].rfind("</w:tbl>"));
    let insert_at = match xml[..body_end].rfind("<w:sectPr") {
      Some(section) if last_block.is_none_or(|block| section > block) => section,
      _ => body_end,
    };
    xml.insert_str(insert_at, &paragraphs);
    preview.push_str("末尾追加：\n");
    push_lines(&mut preview, "+ ", append.trim());
    summary.push(format!("在末尾追加了 {} 段", append.lines().filter(|line| !line.trim().is_empty()).count()));
  }

  let bytes = rewrite_archive(bytes, &HashMap::from([(DOCUMENT.to_string(), xml)]))?;
  Ok(OfficeChange { bytes, summary: summary.join("，"), preview })
}

// ===== PowerPoint =====

/// 修改 PowerPoint 文稿：在幻灯片内替换文字
pub fn edit_pptx(bytes: &[u8], edits: &[TextEdit]) -> Result<OfficeChange, String> {
  let mut archive = open_archive(bytes)?;
  let mut slides: Vec<(usize, String)> = archive
    .file_names()
    .filter_map(|name| {
      let name = name.ok()?;
      let number = name.strip_prefix("ppt/slides/slide")?.strip_suffix(".xml")?.parse().ok()?;
      Some((number, name.to_string()))
    })
    .collect();
  slides.sort();

  let mut parts = Vec::new();
  for (number, name) in slides {
    let xml = read_xml(&mut archive, &name)?;
    parts.push(Part { name, label: Some(format!("第 {number} 页")), xml });
  }
  let originals: Vec<String> = parts.iter().map(|part| part.xml.clone()).collect();
  let mut preview = String::new();
  replace_in_parts(&mut parts, edits, "a:t", "a:p", &mut preview)?;

  let replaced: HashMap<String, String> = parts
    .into_iter()
    .zip(originals)
    .filter(|(part, original)| &part.xml != original)
    .map(|(part, _)| (part.name, part.xml))
    .collect();
  let bytes = rewrite_archive(bytes, &replaced)?;
  Ok(OfficeChange { bytes, summary: format!("修改了 {} 处", edits.len()), preview })
}

// ===== Excel =====

/// 解析表格内容：Markdown 表格（| a | b |），或 CSV（逗号或制表符分隔，双引号包裹的字段可以包含逗号、引号与换行）
pub fn parse_rows(text: &str) -> Vec<Vec<String>> {
  let text = text.trim_matches(['\n', '\r']);
  if text.trim_start().starts_with('|') {
    return text.lines().filter(|line| line.trim().starts_with('|') && !is_table_separator(line)).map(table_row).collect();
  }

  let delimiter = if text.lines().next().unwrap_or("").contains('\t') { '\t' } else { ',' };
  let mut rows = Vec::new();
  let mut row = Vec::new();
  let mut field = String::new();
  let mut quoted = false;
  let mut chars = text.chars().peekable();
  while let Some(c) = chars.next() {
    match c {
      '"' if quoted && chars.peek() == Some(&'"') => {
        field.push('"');
        chars.next();
      }
      '"' if quoted => quoted = false,
      '"' if field.is_empty() => quoted = true,
      '\r' if !quoted => {}
      '\n' if !quoted => {
        row.push(std::mem::take(&mut field));
        rows.push(std::mem::take(&mut row));
      }
      c if c == delimiter && !quoted => row.push(std::mem::take(&mut field)),
      c => field.push(c),
    }
  }
  row.push(field);
  rows.push(row);
  rows.into_iter().map(|row| row.into_iter().map(|cell| cell.trim().to_string()).collect()).collect()
}

/// 解析单元格位置，如 B3 → (2, 3)
fn parse_cell(cell: &str) -> Result<(u32, u32), String> {
  let cell = cell.trim().to_uppercase();
  let letters = cell.chars().take_while(char::is_ascii_uppercase).count();
  let (column, row) = cell.split_at(letters);
  let invalid = || format!("无效的单元格位置：{cell}，应为列字母加行号，如 B3");
  if letters == 0 || letters > 3 || row.is_empty() || !row.chars().all(|c| c.is_ascii_digit()) {
    return Err(invalid());
  }
  let column = column.bytes().fold(0u32, |sum, b| sum * 26 + u32::from(b - b'A' + 1));
  let row: u32 = row.parse().map_err(|_| invalid())?;
  if column > 16_384 || row == 0 || row > 1_048_576 {
    return Err(invalid());
  }
  Ok((column, row))
}

/// 写入单元格：以 = 开头为公式，数字存为数值（保留 001 这类以 0 开头的编号为文字），其余为文字
fn set_cell(cell: &mut Cell, value: &str) {
  let value = value.trim();
  if let Some(formula) = value.strip_prefix('=') {
    cell.set_formula(formula);
    return;
  }
  let numeric = !value.is_empty()
    && value.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | '-' | 'e' | 'E'))
    && !(value.starts_with('0') && value.len() > 1 && !value.starts_with("0."))
    && value.parse::<f64>().is_ok_and(f64::is_finite);
  if numeric {
    cell.set_value_number(value.parse::<f64>().unwrap_or_default());
  }
  else {
    cell.set_value_string(value);
  }
}

fn cell_text(sheet: &Worksheet, position: (u32, u32)) -> String {
  sheet
    .cell(position)
    .map(|cell| if cell.formula().is_empty() { cell.value().to_string() } else { format!("={}", cell.formula()) })
    .unwrap_or_default()
}

fn write_rows(sheet: &mut Worksheet, rows: &[Vec<String>], first_row: u32) {
  for (row_offset, row) in rows.iter().enumerate() {
    for (column, value) in row.iter().enumerate() {
      if !value.is_empty() {
        set_cell(sheet.cell_mut((column as u32 + 1, first_row + row_offset as u32)), value);
      }
    }
  }
}

fn workbook_bytes(book: &Workbook) -> Result<Vec<u8>, String> {
  let mut cursor = Cursor::new(Vec::new());
  umya_spreadsheet::writer::xlsx::write_writer(book, &mut cursor).map_err(|e| format!("保存表格失败：{e}"))?;
  Ok(cursor.into_inner())
}

/// 预览中显示的一行表格
fn row_preview(row: &[String]) -> String {
  row.join(" | ")
}

/// 新建 Excel 表格（一个工作表）
pub fn create_xlsx(content: &str) -> Result<(Vec<u8>, usize), String> {
  let rows = parse_rows(content);
  if rows.iter().all(|row| row.iter().all(String::is_empty)) {
    return Err("表格内容不能为空".into());
  }
  let mut book = umya_spreadsheet::new_file();
  let sheet = book.sheet_mut(0).map_err(|e| format!("生成表格失败：{e}"))?;
  write_rows(sheet, &rows, 1);
  Ok((workbook_bytes(&book)?, rows.len()))
}

/// 修改 Excel 表格：修改单元格，在工作表末尾追加行
pub fn edit_xlsx(bytes: &[u8], cells: &[CellEdit], append: Option<&str>, append_sheet: Option<&str>) -> Result<OfficeChange, String> {
  let mut book = umya_spreadsheet::reader::xlsx::read_reader(Cursor::new(bytes), true)
    .map_err(|e| format!("无法读取这个 Excel 文件（可能已加密或损坏）：{e}"))?;
  let names: Vec<String> = book.sheet_collection().iter().map(|sheet| sheet.name().to_string()).collect();
  let resolve = |name: Option<&str>| -> Result<String, String> {
    match name.map(str::trim).filter(|name| !name.is_empty()) {
      None => names.first().cloned().ok_or_else(|| "这个文件里没有工作表".to_string()),
      Some(name) => names
        .iter()
        .find(|existing| existing.as_str() == name || existing.to_lowercase() == name.to_lowercase())
        .cloned()
        .ok_or_else(|| format!("没有名为「{name}」的工作表，现有的工作表：{}", names.join("、"))),
    }
  };

  let mut preview = String::new();
  let mut summary = Vec::new();
  for edit in cells {
    let name = resolve(edit.sheet.as_deref())?;
    let position = parse_cell(&edit.cell)?;
    let sheet = book.sheet_by_name_mut(&name).map_err(|e| format!("找不到工作表 {name}：{e}"))?;
    let before = cell_text(sheet, position);
    set_cell(sheet.cell_mut(position), &edit.value);
    let after = cell_text(sheet, position);
    let label = format!("{}{}", column_name(position.0 - 1), position.1);
    let shown = |text: &str| if text.is_empty() { "（空）".to_string() } else { shorten(text) };
    preview.push_str(&format!("{name}!{label}：{} → {}\n", shown(&before), shown(&after)));
  }
  if !cells.is_empty() {
    summary.push(format!("修改了 {} 个单元格", cells.len()));
  }

  if let Some(append) = append {
    let rows = parse_rows(append);
    if rows.iter().all(|row| row.iter().all(String::is_empty)) {
      return Err("追加的内容不能为空".into());
    }
    let name = resolve(append_sheet)?;
    let sheet = book.sheet_by_name_mut(&name).map_err(|e| format!("找不到工作表 {name}：{e}"))?;
    let first_row = sheet.highest_row() + 1;
    write_rows(sheet, &rows, first_row);
    if !preview.is_empty() {
      preview.push('\n');
    }
    preview.push_str(&format!("在「{name}」第 {first_row} 行起追加：\n"));
    let lines: Vec<String> = rows.iter().map(|row| row_preview(row)).collect();
    push_lines(&mut preview, "+ ", &lines.join("\n"));
    summary.push(format!("在「{name}」追加了 {} 行", rows.len()));
  }

  Ok(OfficeChange { bytes: workbook_bytes(&book)?, summary: summary.join("，"), preview })
}

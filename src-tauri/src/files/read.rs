//! 读取文件内容：纯文本（自动识别编码）、Word（docx）、PowerPoint（pptx）、PDF、表格（xlsx / xls / xlsb / ods）

use std::{
  fs::{self, File},
  io::{Read, Seek},
  path::Path,
};

use calamine::{open_workbook_auto, Data, DataType, Range, Reader};

/// 读取纯文本文件时最多读取的字节数
const MAX_TEXT_BYTES: u64 = 4 * 1024 * 1024;
/// 读取 docx / pptx 时，压缩包内单个 XML 的最大大小
const MAX_XML_BYTES: u64 = 16 * 1024 * 1024;
/// PDF 文件的最大大小
const MAX_PDF_BYTES: u64 = 50 * 1024 * 1024;
/// 表格的每个工作表最多读取的行数与列数
const MAX_SHEET_ROWS: usize = 1000;
const MAX_SHEET_COLUMNS: usize = 50;

/// 内容检索时会读取的文本文件类型
pub const TEXT_EXTENSIONS: &[&str] = &[
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonc", "xml", "yml", "yaml", "toml", "ini", "cfg", "conf", "log",
  "html", "htm", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "vue", "py", "java", "c", "h", "cpp", "hpp", "cs",
  "go", "rs", "rb", "php", "sh", "bat", "cmd", "ps1", "sql", "r", "swift", "kt", "dart", "lua", "tex", "srt", "ass", "vtt",
];

pub struct FileText {
  pub content: String,
  /// 内容的格式：text、docx、pptx
  pub format: &'static str,
  /// 文本使用的编码（仅纯文本）
  pub encoding: Option<&'static str>,
}

/// 读取文件的文字内容
pub fn read_text(path: &Path) -> Result<FileText, String> {
  let extension = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
  match extension.as_str() {
    "docx" => Ok(FileText { content: read_docx(path)?, format: "docx", encoding: None }),
    "pptx" => Ok(FileText { content: read_pptx(path)?, format: "pptx", encoding: None }),
    "pdf" => Ok(FileText { content: read_pdf(path)?, format: "pdf", encoding: None }),
    "xlsx" | "xlsm" | "xls" | "xlsb" | "ods" => Ok(FileText { content: read_spreadsheet(path)?, format: "spreadsheet", encoding: None }),
    "doc" | "ppt" => Err(format!("暂不支持读取旧版的 .{extension} 文件，可以先用 Office 另存为 .{extension}x")),
    _ => {
      let mut bytes = Vec::new();
      File::open(path)
        .and_then(|file| file.take(MAX_TEXT_BYTES).read_to_end(&mut bytes))
        .map_err(|e| format!("读取文件失败：{e}"))?;
      let (content, encoding) = decode(&bytes).ok_or("这不是文本文件，无法读取内容")?;
      Ok(FileText { content, format: "text", encoding: Some(encoding) })
    }
  }
}

/// 识别编码并解码文本：BOM → UTF-8 → GB18030；看起来是二进制数据时返回 None
pub fn decode(bytes: &[u8]) -> Option<(String, &'static str)> {
  if let Some((encoding, bom_length)) = encoding_rs::Encoding::for_bom(bytes) {
    let (text, _) = encoding.decode_without_bom_handling(&bytes[bom_length..]);
    return Some((text.into_owned(), encoding.name()));
  }
  // 含有 NUL 字节的通常是二进制文件
  if bytes.iter().take(8192).any(|&b| b == 0) {
    return None;
  }
  match std::str::from_utf8(bytes) {
    Ok(text) => Some((text.to_string(), "UTF-8")),
    // 读取上限可能截断在多字节字符中间
    Err(error) if error.error_len().is_none() => Some((String::from_utf8_lossy(bytes).into_owned(), "UTF-8")),
    Err(_) => {
      let (text, _, had_errors) = encoding_rs::GB18030.decode(bytes);
      (!had_errors).then(|| (text.into_owned(), "GB18030"))
    }
  }
}

fn open_zip(path: &Path) -> Result<zip::ZipArchive<File>, String> {
  let file = File::open(path).map_err(|e| format!("读取文件失败：{e}"))?;
  zip::ZipArchive::new(file).map_err(|_| "文件已损坏，或不是有效的 Office 文档".to_string())
}

fn read_entry<R: Read + Seek>(archive: &mut zip::ZipArchive<R>, name: &str) -> Result<String, String> {
  let entry = archive.by_name(name).map_err(|_| format!("文档中缺少 {name}"))?;
  if entry.size() > MAX_XML_BYTES {
    return Err("文档太大，无法读取".into());
  }
  let mut xml = String::new();
  entry.take(MAX_XML_BYTES).read_to_string(&mut xml).map_err(|e| format!("读取文档失败：{e}"))?;
  Ok(xml)
}

/// 从 Office XML 中提取指定标签（如 w:t、a:t）中的文字，段落标签（如 w:p、a:p）结束时换行
pub fn extract_xml_text(xml: &str, text_tag: &str, paragraph_tag: &str) -> String {
  let open = format!("<{text_tag}");
  let close = format!("</{text_tag}>");
  let paragraph_end = format!("</{paragraph_tag}>");
  let mut output = String::new();
  let mut rest = xml;

  while let Some(position) = rest.find('<') {
    let tail = &rest[position..];
    if tail.starts_with(&paragraph_end) {
      if !output.ends_with('\n') && !output.is_empty() {
        output.push('\n');
      }
      rest = &tail[paragraph_end.len()..];
    }
    else if tail.starts_with(&open) && tail[open.len()..].starts_with(['>', ' ']) {
      // 跳过开始标签，读取到结束标签为止
      let Some(start) = tail.find('>') else { break };
      if tail[..start].ends_with('/') {
        rest = &tail[start + 1..];
        continue;
      }
      let content = &tail[start + 1..];
      let end = content.find(&close).unwrap_or(content.len());
      output.push_str(&unescape_xml(&content[..end]));
      rest = &content[(end + close.len()).min(content.len())..];
    }
    else {
      rest = &tail[1..];
    }
  }
  output.trim().to_string()
}

fn unescape_xml(text: &str) -> String {
  text
    .replace("&lt;", "<")
    .replace("&gt;", ">")
    .replace("&quot;", "\"")
    .replace("&apos;", "'")
    .replace("&amp;", "&")
}

fn read_docx(path: &Path) -> Result<String, String> {
  let mut archive = open_zip(path)?;
  let xml = read_entry(&mut archive, "word/document.xml")?;
  Ok(extract_xml_text(&xml, "w:t", "w:p"))
}

fn read_pptx(path: &Path) -> Result<String, String> {
  let mut archive = open_zip(path)?;
  // 幻灯片按编号排序：ppt/slides/slide1.xml、slide2.xml……
  let mut slides: Vec<(usize, String)> = archive
    .file_names()
    .filter_map(|name| {
      let name = name.ok()?;
      let number = name.strip_prefix("ppt/slides/slide")?.strip_suffix(".xml")?.parse().ok()?;
      Some((number, name.to_string()))
    })
    .collect();
  slides.sort();

  let mut output = Vec::new();
  for (number, name) in slides {
    let xml = read_entry(&mut archive, &name)?;
    let text = extract_xml_text(&xml, "a:t", "a:p");
    if !text.is_empty() {
      output.push(format!("【第 {number} 页】\n{text}"));
    }
  }
  Ok(output.join("\n\n"))
}

//// 整理提取出的文字：去掉行尾空白，最多保留一个空行
fn tidy(text: &str) -> String {
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

fn read_pdf(path: &Path) -> Result<String, String> {
  let size = fs::metadata(path).map_err(|e| format!("读取文件失败：{e}"))?.len();
  if size > MAX_PDF_BYTES {
    return Err("PDF 太大（超过 50 MB），无法读取".into());
  }
  let bytes = fs::read(path).map_err(|e| format!("读取文件失败：{e}"))?;
  // 解析库遇到不规范的 PDF 时可能 panic，不能让它影响整个应用
  let pages = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem_by_pages(&bytes))
    .map_err(|_| "无法解析这个 PDF（文件可能已损坏，或使用了不支持的格式）".to_string())?
    .map_err(|e| format!("无法读取这个 PDF（可能已加密或损坏）：{e}"))?;

  let output: Vec<String> = pages
    .iter()
    .enumerate()
    .filter_map(|(index, page)| {
      let text = tidy(page);
      (!text.is_empty()).then(|| format!("【第 {} 页】\n{text}", index + 1))
    })
    .collect();
  if output.is_empty() {
    return Err("这个 PDF 中没有可以提取的文字（可能是扫描件或图片），可以截图后让我识别图中的文字".into());
  }
  // 没有文字的页面不显示，先写明总页数，便于按页码处理
  Ok(format!("（共 {} 页）\n\n{}", pages.len(), output.join("\n\n")))
}

/// 列号转为字母：0 → A，25 → Z，26 → AA
pub fn column_name(mut index: u32) -> String {
  let mut name = Vec::new();
  loop {
    name.push(b'A' + (index % 26) as u8);
    if index < 26 {
      break;
    }
    index = index / 26 - 1;
  }
  name.reverse();
  String::from_utf8(name).unwrap_or_default()
}

fn format_cell(cell: &Data) -> String {
  let text = match cell {
    Data::Empty => return String::new(),
    Data::DateTime(value) => match cell.as_datetime() {
      Some(datetime) => {
        let text = datetime.format("%Y-%m-%d %H:%M").to_string();
        text.strip_suffix(" 00:00").map(str::to_string).unwrap_or(text)
      }
      None => value.to_string(),
    },
    // 去掉浮点误差（如 0.30000000000000004）
    Data::Float(value) => {
      let text = format!("{value:.10}");
      text.trim_end_matches('0').trim_end_matches('.').to_string()
    }
    other => other.to_string(),
  };
  text.replace(['\r', '\n'], " ").trim().to_string()
}

/// 把工作表转为文字：第一行为列号，每行开头为行号，便于按「B3」这样的位置引用单元格
fn format_sheet(name: &str, range: &Range<Data>) -> String {
  let Some((start_row, start_column)) = range.start() else {
    return format!("【工作表：{name}】（空）");
  };
  let (height, width) = range.get_size();
  let columns = width.min(MAX_SHEET_COLUMNS);
  let header: Vec<String> = (0..columns as u32).map(|offset| column_name(start_column + offset)).collect();
  let mut lines = vec![
    format!("【工作表：{name}】共 {height} 行 × {width} 列"),
    format!("行 | {}", header.join(" | ")),
  ];

  let mut shown = 0;
  for (offset, row) in range.rows().enumerate() {
    if row.iter().all(|cell| matches!(cell, Data::Empty)) {
      continue;
    }
    if shown == MAX_SHEET_ROWS {
      lines.push(format!("……只显示了前 {MAX_SHEET_ROWS} 行"));
      break;
    }
    let cells: Vec<String> = row.iter().take(columns).map(format_cell).collect();
    lines.push(format!("{} | {}", start_row as usize + offset + 1, cells.join(" | ")));
    shown += 1;
  }
  if width > columns {
    lines.push(format!("……只显示了前 {columns} 列"));
  }
  lines.join("\n")
}

fn read_spreadsheet(path: &Path) -> Result<String, String> {
  let mut workbook = open_workbook_auto(path).map_err(|e| format!("无法读取这个表格文件（可能已加密或损坏）：{e}"))?;
  let names = workbook.sheet_names().to_vec();
  let sheets: Vec<String> = names
    .iter()
    .map(|name| match workbook.worksheet_range(name) {
      Ok(range) => format_sheet(name, &range),
      Err(error) => format!("【工作表：{name}】无法读取：{error}"),
    })
    .collect();
  Ok(sheets.join("\n\n"))
}

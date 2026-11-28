//! 读取文件内容：纯文本（自动识别编码）、Word（docx）、PowerPoint（pptx，见 office_text.rs）、PDF、表格（xlsx / xls / xlsb / ods）

use std::{
  fs::{self, File},
  io::{Cursor, Read, Seek},
  path::Path,
};

use calamine::{open_workbook_auto, open_workbook_auto_from_rs, Data, DataType, Range, Reader, Sheets};

use super::office_text::{read_docx, read_pptx, tidy};

/// 读取纯文本文件时最多读取的字节数
const MAX_TEXT_BYTES: u64 = 4 * 1024 * 1024;
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

#[derive(Debug)]
pub struct FileText {
  pub content: String,
  /// 内容的格式：text、docx、pptx、pdf、spreadsheet
  pub format: &'static str,
  /// 文本使用的编码（仅纯文本）
  pub encoding: Option<&'static str>,
}

fn extension_of(name: &str) -> String {
  Path::new(name).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

fn old_format_error(extension: &str) -> String {
  format!("暂不支持读取旧版的 .{extension} 文件，可以先用 Office 另存为 .{extension}x")
}

/// 读取文件的文字内容
pub fn read_text(path: &Path) -> Result<FileText, String> {
  let extension = extension_of(&path.to_string_lossy());
  match extension.as_str() {
    "docx" | "pptx" => read_zip_document(File::open(path).map_err(|e| format!("读取文件失败：{e}"))?, &extension),
    "pdf" => {
      let size = fs::metadata(path).map_err(|e| format!("读取文件失败：{e}"))?.len();
      if size > MAX_PDF_BYTES {
        return Err("PDF 太大（超过 50 MB），无法读取".into());
      }
      let bytes = fs::read(path).map_err(|e| format!("读取文件失败：{e}"))?;
      Ok(FileText { content: read_pdf(&bytes)?, format: "pdf", encoding: None })
    }
    "xlsx" | "xlsm" | "xls" | "xlsb" | "ods" => {
      let workbook = open_workbook_auto(path).map_err(|e| format!("无法读取这个表格文件（可能已加密或损坏）：{e}"))?;
      Ok(FileText { content: read_workbook(workbook), format: "spreadsheet", encoding: None })
    }
    "doc" | "ppt" => Err(old_format_error(&extension)),
    _ => {
      let mut bytes = Vec::new();
      File::open(path)
        .and_then(|file| file.take(MAX_TEXT_BYTES).read_to_end(&mut bytes))
        .map_err(|e| format!("读取文件失败：{e}"))?;
      read_plain_text(&bytes)
    }
  }
}

/// 从文件内容的字节读取文字（如拖进对话框的文件，不知道它在电脑上的位置），name 为文件名，用来判断类型
pub fn read_bytes(name: &str, bytes: &[u8]) -> Result<FileText, String> {
  let extension = extension_of(name);
  match extension.as_str() {
    "docx" | "pptx" => read_zip_document(Cursor::new(bytes), &extension),
    "pdf" => {
      if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err("PDF 太大（超过 50 MB），无法读取".into());
      }
      Ok(FileText { content: read_pdf(bytes)?, format: "pdf", encoding: None })
    }
    "xlsx" | "xlsm" | "xls" | "xlsb" | "ods" => {
      let workbook = open_workbook_auto_from_rs(Cursor::new(bytes)).map_err(|e| format!("无法读取这个表格文件（可能已加密或损坏）：{e}"))?;
      Ok(FileText { content: read_workbook(workbook), format: "spreadsheet", encoding: None })
    }
    "doc" | "ppt" => Err(old_format_error(&extension)),
    _ => read_plain_text(&bytes[..bytes.len().min(MAX_TEXT_BYTES as usize)]),
  }
}

fn read_plain_text(bytes: &[u8]) -> Result<FileText, String> {
  let (content, encoding) = decode(bytes).ok_or("这不是文本文件，无法读取内容")?;
  Ok(FileText { content, format: "text", encoding: Some(encoding) })
}

/// Word 与 PowerPoint 文件是 zip 压缩包
fn read_zip_document<R: Read + Seek>(reader: R, extension: &str) -> Result<FileText, String> {
  let mut archive = zip::ZipArchive::new(reader).map_err(|_| "文件已损坏，或不是有效的 Office 文档".to_string())?;
  if extension == "docx" {
    Ok(FileText { content: read_docx(&mut archive)?, format: "docx", encoding: None })
  }
  else {
    Ok(FileText { content: read_pptx(&mut archive)?, format: "pptx", encoding: None })
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

fn read_pdf(bytes: &[u8]) -> Result<String, String> {
  // 解析库遇到不规范的 PDF 时可能 panic，不能让它影响整个应用
  let pages = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem_by_pages(bytes))
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

fn read_workbook<RS: Read + Seek>(mut workbook: Sheets<RS>) -> String {
  let names = workbook.sheet_names().to_vec();
  let sheets: Vec<String> = names
    .iter()
    .map(|name| match workbook.worksheet_range(name) {
      Ok(range) => format_sheet(name, &range),
      Err(error) => format!("【工作表：{name}】无法读取：{error}"),
    })
    .collect();
  sheets.join("\n\n")
}

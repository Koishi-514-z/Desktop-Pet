//! 自动检查生成的 Office 文件，找出常见的问题，交给 LLM 在回复用户之前自己修正。
//!
//! 只读取文件本身（XML），不需要 Office：
//! - 演示文稿（pptx，在这个文件中）：没有进入动画或切换效果、纯白背景（默认模板）、每页都是「标题 + 要点」的默认版式、
//!   文字超出页面、字号太小、一页的文字太多、空的占位符；
//! - Word 文档（docx，见 office_check_docx.rs）；
//! - Excel 工作簿（xlsx，见 office_check_xlsx.rs）。

use std::{
  collections::HashMap,
  fs::File,
  io::{Read, Seek},
  path::Path,
};

use serde::Serialize;

use super::office_check_docx::check_docx;
use super::office_check_xlsx::check_xlsx;
use super::office_text::{placeholder_type, read_xml, relationships, resolve_target, slide_order, Element};

/// 默认的幻灯片大小（16:9，单位为 EMU）
const DEFAULT_SLIDE_SIZE: (i64, i64) = (12_192_000, 6_858_000);
/// 正文与表格的最小字号（百分之一磅）
const MIN_TEXT_SIZE: i64 = 1200;
const MIN_TABLE_TEXT_SIZE: i64 = 1000;
/// 一页最多多少字（不算空白）
const MAX_SLIDE_CHARS: usize = 300;
/// 多少页是默认的「标题 + 要点」时算作版式单一
const MIN_PLAIN_SLIDES: usize = 3;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QualityIssue {
  /// 问题的类别，如 no-animation
  pub code: &'static str,
  pub message: String,
}

/// 检查一个文件；不支持检查的类型返回空列表
pub fn check_file(path: &Path) -> Result<Vec<QualityIssue>, String> {
  let extension = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
  match extension.as_str() {
    "pptx" | "docx" | "xlsx" | "xlsm" => {
      let file = File::open(path).map_err(|e| format!("读取文件失败：{e}"))?;
      let mut archive = zip::ZipArchive::new(file).map_err(|_| "文件已损坏，或不是有效的 Office 文件".to_string())?;
      Ok(match extension.as_str() {
        "pptx" => check_pptx(&mut archive),
        "docx" => check_docx(&mut archive),
        _ => check_xlsx(&mut archive),
      })
    }
    _ => Ok(Vec::new()),
  }
}

/// 依次访问元素及其所有后代
pub(super) fn walk<'a>(element: &'a Element, visit: &mut impl FnMut(&'a Element)) {
  visit(element);
  for child in element.elements() {
    walk(child, visit);
  }
}

/// 元素中所有文字（a:t）
fn all_text(element: &Element) -> String {
  let mut text = String::new();
  walk(element, &mut |item| {
    if item.name == "a:t" {
      text.push_str(&item.text());
    }
  });
  text
}

fn visible_chars(text: &str) -> usize {
  text.chars().filter(|c| !c.is_whitespace()).count()
}

/// 页码的简短写法：第 2–4、6 页
pub fn format_pages(pages: &[usize]) -> String {
  let mut ranges: Vec<String> = Vec::new();
  let mut index = 0;
  while index < pages.len() {
    let start = pages[index];
    let mut end = start;
    while index + 1 < pages.len() && pages[index + 1] == end + 1 {
      index += 1;
      end = pages[index];
    }
    ranges.push(if end > start { format!("{start}–{end}") } else { start.to_string() });
    index += 1;
  }
  format!("第 {} 页", ranges.join("、"))
}

// ===== 背景 =====

/// 颜色是不是白色。主题色 bg1 / lt1 对应主题中的浅色 1；带有调整（如变暗）的不算
fn is_white_color(parent: &Element, theme_light_white: bool) -> bool {
  parent.elements().any(|color| {
    if color.elements().next().is_some() {
      return false;
    }
    match color.name.as_str() {
      "a:srgbClr" => color.attr("val").is_some_and(|value| value.eq_ignore_ascii_case("FFFFFF")),
      "a:schemeClr" => matches!(color.attr("val"), Some("bg1" | "lt1")) && theme_light_white,
      "a:sysClr" => color.attr("val") == Some("window") || color.attr("lastClr").is_some_and(|value| value.eq_ignore_ascii_case("FFFFFF")),
      "a:prstClr" => color.attr("val") == Some("white"),
      _ => false,
    }
  })
}

/// 背景是不是纯白：纯色填充为白色，或引用的主题背景为白色；渐变、图片、图案都不算
fn is_white_background(background: &Element, theme_light_white: bool) -> bool {
  if let Some(properties) = background.child("p:bgPr") {
    return properties.child("a:solidFill").is_some_and(|fill| is_white_color(fill, theme_light_white));
  }
  background.child("p:bgRef").is_some_and(|reference| is_white_color(reference, theme_light_white))
}

fn background_of(element: &Element) -> Option<&Element> {
  element.child("p:cSld")?.child("p:bg")
}

/// 关系中某种类型（如 slideLayout）的文件的完整路径
fn related_part<R: Read + Seek>(archive: &mut zip::ZipArchive<R>, part: &str, kind: &str) -> Option<String> {
  let (dir, file) = part.rsplit_once('/')?;
  relationships(archive, &format!("{dir}/_rels/{file}.rels"))
    .into_values()
    .find(|(relation, _)| relation.ends_with(&format!("/{kind}")))
    .map(|(_, target)| resolve_target(dir, &target))
}

/// 母版与版式的背景：路径 → 是否为纯白（没有设置背景时为 None）
struct Backgrounds<'a, R: Read + Seek> {
  archive: &'a mut zip::ZipArchive<R>,
  parts: HashMap<String, Option<bool>>,
  themes: HashMap<String, bool>,
}

impl<R: Read + Seek> Backgrounds<'_, R> {
  /// 母版使用的主题中，浅色 1（背景 1）是不是白色；读取不到时按默认主题（白色）处理
  fn theme_light_white(&mut self, master: &str) -> bool {
    if let Some(white) = self.themes.get(master) {
      return *white;
    }
    let white = related_part(self.archive, master, "theme")
      .and_then(|theme| read_xml(self.archive, &theme))
      .and_then(|theme| theme.find("a:clrScheme").and_then(|scheme| scheme.child("a:lt1")).map(|light| is_white_color(light, true)))
      .unwrap_or(true);
    self.themes.insert(master.to_string(), white);
    white
  }

  /// 版式或母版自己设置的背景是不是纯白；没有设置时为 None
  fn own(&mut self, part: &str, master: &str) -> Option<bool> {
    if let Some(value) = self.parts.get(part) {
      return *value;
    }
    let theme_white = self.theme_light_white(master);
    let value = read_xml(self.archive, part).and_then(|root| background_of(&root).map(|background| is_white_background(background, theme_white)));
    self.parts.insert(part.to_string(), value);
    value
  }

  /// 幻灯片实际显示的背景是不是纯白：幻灯片 → 版式 → 母版，都没有设置时为主题的背景色
  fn is_white(&mut self, slide_path: &str, slide: &Element) -> bool {
    let layout = related_part(self.archive, slide_path, "slideLayout");
    let master = layout.as_deref().and_then(|layout| related_part(self.archive, layout, "slideMaster")).unwrap_or_default();
    let theme_white = self.theme_light_white(&master);
    if let Some(background) = background_of(slide) {
      return is_white_background(background, theme_white);
    }
    if let Some(white) = layout.as_deref().and_then(|layout| self.own(layout, &master)) {
      return white;
    }
    if !master.is_empty()
      && let Some(white) = self.own(&master, &master)
    {
      return white;
    }
    theme_white
  }
}

// ===== 每一页 =====

#[derive(Debug, Default)]
struct SlideReport {
  number: usize,
  entrance: bool,
  transition: bool,
  white: bool,
  chars: usize,
  overflow: bool,
  small_font: bool,
  empty_placeholders: usize,
  /// 只有标题与正文占位符中的文字，没有图片、表格、图表或其他图形
  plain: bool,
}

/// 形状的位置与大小（EMU）；从版式继承位置的占位符没有
fn bounds(shape: &Element) -> Option<(i64, i64, i64, i64)> {
  let transform = shape.child("p:spPr")?.child("a:xfrm")?;
  let offset = transform.child("a:off")?;
  let extent = transform.child("a:ext")?;
  let number = |element: &Element, name: &str| element.attr(name).and_then(|value| value.parse::<i64>().ok());
  Some((number(offset, "x")?, number(offset, "y")?, number(extent, "cx")?, number(extent, "cy")?))
}

/// 有文字的段落中最小的字号（百分之一磅）
fn smallest_font(element: &Element) -> Option<i64> {
  let mut smallest: Option<i64> = None;
  walk(element, &mut |item| {
    if item.name == "a:r"
      && item.child("a:t").is_some_and(|text| !text.text().trim().is_empty())
      && let Some(size) = item.child("a:rPr").and_then(|properties| properties.attr("sz")).and_then(|size| size.parse::<i64>().ok())
    {
      smallest = Some(smallest.map_or(size, |current| current.min(size)));
    }
  });
  smallest
}

/// 一页中有哪些元素：标题占位符、正文占位符（有文字的），以及其他元素（文本框、图形、图片、表格、图表）的数量
#[derive(Default)]
struct Elements {
  title: bool,
  body: bool,
  other: usize,
}

/// 访问一页中的形状。组合中的形状的位置相对于组合，不检查是否超出页面
fn visit_shapes(tree: &Element, in_group: bool, size: (i64, i64), report: &mut SlideReport, elements: &mut Elements) {
  let tolerance = size.0 / 50;
  for shape in tree.elements() {
    match shape.name.as_str() {
      "p:sp" => {
        let chars = visible_chars(&all_text(shape));
        report.chars += chars;
        match placeholder_type(shape) {
          Some("sldNum" | "dt" | "ftr" | "hdr" | "sldImg") => {}
          Some(_) if chars == 0 => report.empty_placeholders += 1,
          Some("title") => elements.title = true,
          // 封面的主标题与副标题不算「标题 + 要点」
          Some("ctrTitle" | "subTitle") => elements.other += 1,
          Some(_) => elements.body = true,
          None => elements.other += 1,
        }
        if chars == 0 {
          continue;
        }
        if smallest_font(shape).is_some_and(|font| font < MIN_TEXT_SIZE) {
          report.small_font = true;
        }
        if !in_group
          && let Some((x, y, width, height)) = bounds(shape)
          && (x < -tolerance || y < -tolerance || x + width > size.0 + tolerance || y + height > size.1 + tolerance)
        {
          report.overflow = true;
        }
      }
      "p:graphicFrame" => {
        elements.other += 1;
        report.chars += visible_chars(&all_text(shape));
        if shape.find("a:tbl").is_some() && smallest_font(shape).is_some_and(|font| font < MIN_TABLE_TEXT_SIZE) {
          report.small_font = true;
        }
      }
      "p:pic" | "p:cxnSp" => elements.other += 1,
      "p:grpSp" => {
        elements.other += 1;
        visit_shapes(shape, true, size, report, elements);
      }
      "mc:AlternateContent" => {
        if let Some(choice) = shape.child("mc:Choice") {
          visit_shapes(choice, in_group, size, report, elements);
        }
      }
      _ => {}
    }
  }
}

fn inspect_slide(slide: &Element, number: usize, size: (i64, i64)) -> SlideReport {
  let mut report = SlideReport { number, ..SlideReport::default() };
  walk(slide, &mut |item| {
    if item.name == "p:cTn" && item.attr("presetClass") == Some("entr") {
      report.entrance = true;
    }
    if item.name == "p:transition" {
      report.transition = true;
    }
  });
  if let Some(tree) = slide.find("p:spTree") {
    let mut elements = Elements::default();
    visit_shapes(tree, false, size, &mut report, &mut elements);
    report.plain = elements.title && elements.body && elements.other == 0;
  }
  report
}

fn slide_size<R: Read + Seek>(archive: &mut zip::ZipArchive<R>) -> (i64, i64) {
  read_xml(archive, "ppt/presentation.xml")
    .and_then(|presentation| {
      let size = presentation.child("p:sldSz")?;
      Some((size.attr("cx")?.parse().ok()?, size.attr("cy")?.parse().ok()?))
    })
    .unwrap_or(DEFAULT_SLIDE_SIZE)
}

/// 检查演示文稿
pub fn check_pptx<R: Read + Seek>(archive: &mut zip::ZipArchive<R>) -> Vec<QualityIssue> {
  let size = slide_size(archive);
  let mut slides = Vec::new();
  let paths = slide_order(archive);
  let mut backgrounds = Backgrounds { archive, parts: HashMap::new(), themes: HashMap::new() };
  for (index, path) in paths.iter().enumerate() {
    let Some(slide) = read_xml(backgrounds.archive, path) else { continue };
    let mut report = inspect_slide(&slide, index + 1, size);
    report.white = backgrounds.is_white(path, &slide);
    slides.push(report);
  }
  if slides.is_empty() {
    return Vec::new();
  }

  let pages = |filter: &dyn Fn(&SlideReport) -> bool| -> Vec<usize> { slides.iter().filter(|slide| filter(slide)).map(|slide| slide.number).collect() };
  let all = slides.len();
  let mut issues = Vec::new();
  let mut push = |code: &'static str, message: String| issues.push(QualityIssue { code, message });
  let which = |list: &[usize]| if list.len() == all && all > 1 { "所有页面".to_string() } else { format_pages(list) };

  let list = pages(&|slide| !slide.entrance);
  if !list.is_empty() {
    push("no-animation", format!("{}没有进入动画：给标题、要点、图片等元素加上进入动画（如淡入、飞入、擦除），按阅读顺序依次出现", which(&list)));
  }
  let list = pages(&|slide| !slide.transition);
  if !list.is_empty() {
    push("no-transition", format!("{}没有切换效果：给每页加上切换效果（如平滑淡出）", which(&list)));
  }
  let list = pages(&|slide| slide.white);
  if !list.is_empty() {
    push("white-background", format!("{}是纯白背景（默认模板）：设置统一的主题配色，如给母版设置浅色背景，封面与结束页用深色或渐变背景", which(&list)));
  }
  let list = pages(&|slide| slide.plain);
  if list.len() >= MIN_PLAIN_SLIDES && list.len() * 5 >= all * 3 {
    push(
      "monotonous-layout",
      format!("{}都是「标题 + 要点」的默认版式，每页看起来都一样：按内容换用不同的版式，如卡片、大数字、图文、左右对比、时间线、表格", format_pages(&list)),
    );
  }
  let list = pages(&|slide| slide.overflow);
  if !list.is_empty() {
    push("overflow", format!("{}有文字超出了页面：调整位置与大小，或减少文字", format_pages(&list)));
  }
  let list = pages(&|slide| slide.small_font);
  if !list.is_empty() {
    push("small-font", format!("{}有字号小于 12 磅的文字（表格小于 10 磅），放映时看不清", format_pages(&list)));
  }
  for slide in slides.iter().filter(|slide| slide.chars > MAX_SLIDE_CHARS) {
    push("too-much-text", format!("第 {} 页文字太多（约 {} 字）：精简成要点，或拆成几页", slide.number, slide.chars));
  }
  let list = pages(&|slide| slide.empty_placeholders > 0);
  if !list.is_empty() {
    push("empty-placeholder", format!("{}有空的占位符（编辑时显示「单击此处添加文本」）：填上内容或删除", format_pages(&list)));
  }
  issues
}

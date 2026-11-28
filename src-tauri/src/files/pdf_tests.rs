//! PDF：HTML 转 PDF 前的检查与处理、按页重新组合 PDF。
//! 打印 PDF 的测试需要本机安装 Edge 或 Chrome，没有时跳过。

use std::{
  fs,
  path::{Path, PathBuf},
};

use lopdf::{content::{Content, Operation}, dictionary, Document, Object, Stream};

use super::pdf::{browser_name, compose, parse_pages, plan_compose, prepare_html, print_html, PdfOutput, PdfPart, PrintRequest};
use super::read::read_text;
use super::roots::Roots;

struct TempDir(PathBuf);

impl TempDir {
  fn new(name: &str) -> Self {
    let dir = std::env::temp_dir().join(format!("desktop-pet-pdf-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Self(dunce::canonicalize(&dir).unwrap())
  }

  fn path(&self, name: &str) -> PathBuf {
    self.0.join(name)
  }

  fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
    let path = self.path(name);
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

fn s(path: &Path) -> String {
  path.display().to_string()
}

/// 生成一个每页只有一行文字的 PDF：页面写着「前缀 + 页码」。
/// nested 为 true 时页面放在第二层的页面树节点中，并从中继承页面大小与旋转角度
fn sample_pdf(prefix: &str, pages: usize, nested: bool) -> Vec<u8> {
  let mut doc = Document::with_version("1.5");
  let root_pages = doc.new_object_id();
  let parent = if nested { doc.new_object_id() } else { root_pages };
  let font = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Courier" });
  let resources = doc.add_object(dictionary! { "Font" => dictionary! { "F1" => font } });
  let mut kids: Vec<Object> = Vec::new();
  for index in 1..=pages {
    let content = Content {
      operations: vec![
        Operation::new("BT", vec![]),
        Operation::new("Tf", vec!["F1".into(), 24.into()]),
        Operation::new("Td", vec![72.into(), 700.into()]),
        Operation::new("Tj", vec![Object::string_literal(format!("{prefix}{index}"))]),
        Operation::new("ET", vec![]),
      ],
    };
    let content = doc.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
    let mut page = dictionary! { "Type" => "Page", "Parent" => parent, "Contents" => content, "Resources" => resources };
    if !nested {
      page.set("MediaBox", vec![0.into(), 0.into(), 595.into(), 842.into()]);
    }
    kids.push(doc.add_object(page).into());
  }
  if nested {
    let count = kids.len() as i64;
    doc.objects.insert(parent, Object::Dictionary(dictionary! {
      "Type" => "Pages", "Parent" => root_pages, "Kids" => kids, "Count" => count,
      "MediaBox" => vec![0.into(), 0.into(), 300.into(), 400.into()], "Rotate" => 90,
    }));
    doc.objects.insert(root_pages, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![parent.into()], "Count" => pages as i64 }));
  }
  else {
    doc.objects.insert(root_pages, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => pages as i64 }));
  }
  let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => root_pages });
  doc.trailer.set("Root", catalog);
  let mut bytes = Vec::new();
  doc.save_to(&mut bytes).unwrap();
  bytes
}

/// 每一页的文字（去掉空白）
fn page_texts(path: &Path) -> Vec<String> {
  let bytes = fs::read(path).unwrap();
  pdf_extract::extract_text_from_mem_by_pages(&bytes)
    .unwrap()
    .into_iter()
    .map(|text| text.split_whitespace().collect::<String>())
    .collect()
}

/// 每一页的属性
fn page_attribute(path: &Path, key: &[u8]) -> Vec<Option<Object>> {
  let doc = Document::load(path).unwrap();
  doc.get_pages().values().map(|id| doc.get_dictionary(*id).unwrap().get(key).ok().cloned()).collect()
}

fn part(path: &Path, pages: Option<&str>, rotate: Option<i64>) -> PdfPart {
  PdfPart { path: s(path), pages: pages.map(str::to_string), rotate }
}

fn output(path: &Path, parts: Vec<PdfPart>) -> PdfOutput {
  PdfOutput { path: s(path), parts }
}

// ===== 页码 =====

#[test]
fn parses_page_ranges() {
  assert_eq!(parse_pages(None, 3, "a.pdf").unwrap(), vec![1, 2, 3]);
  assert_eq!(parse_pages(Some("全部"), 2, "a.pdf").unwrap(), vec![1, 2]);
  assert_eq!(parse_pages(Some("1-3, 5，8-"), 9, "a.pdf").unwrap(), vec![1, 2, 3, 5, 8, 9]);
  assert_eq!(parse_pages(Some("-2,last"), 6, "a.pdf").unwrap(), vec![1, 2, 6]);
  assert_eq!(parse_pages(Some("3~1"), 5, "a.pdf").unwrap(), vec![3, 2, 1]);
  assert_eq!(parse_pages(Some("2到end"), 4, "a.pdf").unwrap(), vec![2, 3, 4]);
  assert_eq!(parse_pages(Some("2,2"), 4, "a.pdf").unwrap(), vec![2, 2]);

  assert_eq!(parse_pages(Some("1-12"), 10, "a.pdf").unwrap_err(), "「a.pdf」只有 10 页，没有第 12 页");
  assert!(parse_pages(Some("0"), 10, "a.pdf").unwrap_err().contains("从 1 开始"));
  assert!(parse_pages(Some("第一页"), 10, "a.pdf").unwrap_err().contains("无法识别"));
  assert!(parse_pages(Some(",，"), 10, "a.pdf").unwrap_err().contains("没有选中"));
}

// ===== HTML =====

#[test]
fn prepares_html_with_security_policy_and_defaults() {
  let dir = TempDir::new("html");
  let html = prepare_html(&dir.roots(), "<!doctype html>\n<html lang=\"zh\"><body><h1>标题</h1></body></html>").unwrap();
  // 内容安全策略在最前面，只出现一次 doctype；默认样式在前，HTML 自己的样式可以覆盖
  assert!(html.starts_with("<!DOCTYPE html>\n<meta charset=\"utf-8\">\n<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none';"), "{html}");
  assert!(html.contains("@page{size:A4;"));
  assert_eq!(html.to_lowercase().matches("<!doctype").count(), 1);
  assert!(html.ends_with("<html lang=\"zh\"><body><h1>标题</h1></body></html>"));

  // 不能自己设置 http-equiv（如跳转到其他网址、改写内容安全策略）
  let error = prepare_html(&dir.roots(), "<meta http-equiv=\"refresh\" content=\"0;url=https://example.com\">").unwrap_err();
  assert!(error.contains("http-equiv"), "{error}");
  assert!(prepare_html(&dir.roots(), "  ").is_err());
}

#[test]
fn inlines_local_images_inside_roots() {
  let dir = TempDir::new("images");
  let outside = TempDir::new("images-outside");
  let image = dir.write("图 1.png", b"\x89PNG fake");
  dir.write("notes.txt", b"secret");
  let secret = outside.write("x.png", b"\x89PNG");

  let url = format!("file:///{}", s(&image).replace('\\', "/").replace(' ', "%20"));
  let html = prepare_html(&dir.roots(), &format!("<img src=\"{url}\"><div style=\"background:url('{url}')\"></div>")).unwrap();
  let data = "data:image/png;base64,iVBORyBmYWtl";
  assert_eq!(html.matches(data).count(), 2, "{html}");
  assert!(!html.contains("file:///"));

  // 授权文件夹以外的图片、不是图片的文件都不能引用
  let outside_url = format!("file:///{}", s(&secret).replace('\\', "/"));
  assert!(prepare_html(&dir.roots(), &format!("<img src=\"{outside_url}\">")).unwrap_err().contains("不在授权访问的文件夹内"));
  let text_url = format!("file:///{}", s(&dir.path("notes.txt")).replace('\\', "/"));
  assert!(prepare_html(&dir.roots(), &format!("<img src='{text_url}'>")).unwrap_err().contains("只能引用图片"));
}

// ===== 按页重新组合 =====

#[test]
fn merges_selected_pages_with_rotation() {
  let dir = TempDir::new("merge");
  let a = dir.write("a.pdf", &sample_pdf("A", 5, false));
  let b = dir.write("b.pdf", &sample_pdf("B", 3, false));
  let merged = dir.path("合并/merged.pdf");

  let outputs = vec![output(&merged, vec![part(&a, Some("4-5,1"), None), part(&b, None, Some(90)), part(&a, Some("1"), Some(-90))])];
  let plans = plan_compose(&dir.roots(), &outputs).unwrap();
  assert_eq!(plans[0].pages, 7);
  assert!(!plans[0].exists);
  assert_eq!(plans[0].parts[0].pages, vec![4, 5, 1]);
  assert_eq!(plans[0].parts[0].total_pages, 5);
  assert_eq!(plans[0].parts[2].rotate, 270);
  assert!(!merged.exists(), "检查计划时不生成文件");

  let results = compose(&dir.roots(), &outputs).unwrap();
  assert_eq!(results[0].pages, 7);
  assert_eq!(page_texts(&merged), vec!["A4", "A5", "A1", "B1", "B2", "B3", "A1"]);
  assert_eq!(
    page_attribute(&merged, b"Rotate"),
    vec![None, None, None, Some(Object::Integer(90)), Some(Object::Integer(90)), Some(Object::Integer(90)), Some(Object::Integer(270))]
  );
  // 读取文件时写明总页数
  assert!(read_text(&merged).unwrap().content.starts_with("（共 7 页）"));
}

#[test]
fn splits_into_several_files_and_keeps_inherited_attributes() {
  let dir = TempDir::new("split");
  let source = dir.write("source.pdf", &sample_pdf("P", 4, true));
  let first = dir.path("part1.pdf");
  let second = dir.path("part2.pdf");

  compose(&dir.roots(), &[output(&first, vec![part(&source, Some("1-2"), None)]), output(&second, vec![part(&source, Some("3-"), Some(180))])]).unwrap();
  assert_eq!(page_texts(&first), vec!["P1", "P2"]);
  assert_eq!(page_texts(&second), vec!["P3", "P4"]);
  // 从页面树继承的大小与旋转写到了每一页上，旋转在原来的基础上叠加
  let media_box = Object::Array(vec![0.into(), 0.into(), 300.into(), 400.into()]);
  assert_eq!(page_attribute(&first, b"MediaBox"), vec![Some(media_box.clone()), Some(media_box)]);
  assert_eq!(page_attribute(&first, b"Rotate"), vec![Some(Object::Integer(90)); 2]);
  assert_eq!(page_attribute(&second, b"Rotate"), vec![Some(Object::Integer(270)); 2]);
  // 只保留用到的页面：拆出的文件比原文件小
  assert!(fs::metadata(&first).unwrap().len() < fs::metadata(&source).unwrap().len());
}

#[test]
fn overwrites_source_to_delete_or_reorder_pages() {
  let dir = TempDir::new("overwrite");
  let source = dir.write("report.pdf", &sample_pdf("R", 4, false));
  // 删除第 2 页、重复最后一页：输出覆盖输入的文件
  compose(&dir.roots(), &[output(&source, vec![part(&source, Some("1,3-4,4"), None)])]).unwrap();
  assert_eq!(page_texts(&source), vec!["R1", "R3", "R4", "R4"]);
  let plan = plan_compose(&dir.roots(), &[output(&source, vec![part(&source, None, None)])]).unwrap();
  assert!(plan[0].exists);
}

#[test]
fn rejects_invalid_compose_requests_without_writing() {
  let dir = TempDir::new("invalid");
  let outside = TempDir::new("invalid-outside");
  let a = dir.write("a.pdf", &sample_pdf("A", 2, false));
  let fake = dir.write("fake.pdf", b"%PDF-1.4 not really");
  let docx = dir.write("a.docx", b"PK");
  let out = dir.path("out.pdf");
  let roots = dir.roots();

  let error = |outputs: Vec<PdfOutput>| compose(&roots, &outputs).unwrap_err();
  assert_eq!(error(vec![output(&out, vec![part(&a, Some("3"), None)])]), "「a.pdf」只有 2 页，没有第 3 页");
  assert!(error(vec![output(&out, vec![part(&a, None, Some(45))])]).contains("90 的倍数"));
  assert!(error(vec![output(&out, vec![part(&fake, None, None)])]).contains("fake.pdf"));
  assert!(error(vec![output(&out, vec![part(&docx, None, None)])]).contains("只能组合 PDF"));
  assert!(error(vec![output(&dir.path("out.docx"), vec![part(&a, None, None)])]).contains("必须是 .pdf"));
  assert!(error(vec![output(&outside.path("out.pdf"), vec![part(&a, None, None)])]).contains("不在授权访问的文件夹内"));
  assert!(error(vec![output(&out, vec![part(&outside.write("x.pdf", &sample_pdf("X", 1, false)), None, None)])]).contains("不在授权访问的文件夹内"));
  assert!(error(vec![output(&out, vec![])]).contains("没有指定"));
  assert!(error(vec![output(&out, vec![part(&a, None, None)]), output(&out, vec![part(&a, None, None)])]).contains("重复"));

  // 第二个文件出错时，第一个也不生成
  let first = dir.path("first.pdf");
  error(vec![output(&first, vec![part(&a, None, None)]), output(&out, vec![part(&a, Some("9"), None)])]);
  assert!(!first.exists());
  assert!(!out.exists());
}

// ===== 打印 PDF（需要 Edge 或 Chrome） =====

#[test]
fn prints_html_to_pdf_with_browser() {
  let Some(browser) = browser_name() else {
    eprintln!("没有找到 Edge 或 Chrome，跳过");
    return;
  };
  let dir = TempDir::new("print");
  let target = dir.path("输出/会议纪要.pdf");
  let html = r#"<html><head><style>@page{@bottom-center{content:"Page " counter(page) " of " counter(pages)}}</style></head>
<body><h1>会议纪要</h1><table><tr><td>议题</td><td>结论</td></tr></table>
<img src="https://example.com/track.png"><script>document.write("SCRIPT-RAN")</script><div style="break-before:page">第二页内容</div></body></html>"#;
  let result = print_html(&dir.roots(), &PrintRequest { run_id: "pdf-test".into(), path: s(&target), html: html.into(), timeout_seconds: None }).unwrap();
  assert_eq!(result.browser, browser);
  assert_eq!(result.pages, 2);
  assert!(!result.cancelled && !result.timed_out);

  let text = read_text(&target).unwrap().content;
  assert!(text.starts_with("（共 2 页）"), "{text}");
  assert!(text.contains("会议纪要") && text.contains("第二页内容"), "{text}");
  // CSS 的页边距区域可以加页码；没有加上浏览器默认的日期与网址
  assert!(text.contains("Page 1 of 2") && text.contains("Page 2 of 2"), "{text}");
  assert!(!text.contains("file:"), "{text}");
  // 内容安全策略禁止运行脚本
  assert!(!text.contains("SCRIPT-RAN"), "{text}");
}

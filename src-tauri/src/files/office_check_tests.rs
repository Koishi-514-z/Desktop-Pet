//! 自动检查演示文稿：默认样式的文稿能查出各种问题，设计过的文稿没有问题

use std::io::{Cursor, Write};

use super::office_check::{check_pptx, format_pages, QualityIssue};

const P: &str = r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships""#;

fn relationship(id: &str, kind: &str, target: &str) -> String {
  format!(r#"<Relationship Id="{id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}" Target="{target}"/>"#)
}

fn rels(items: &[String]) -> String {
  format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{}</Relationships>"#, items.concat())
}

/// 文本形状：placeholder 为占位符类型（空字符串表示普通文本框），position 为位置与大小（EMU）
fn shape(placeholder: &str, texts: &[&str], size: Option<u32>, position: Option<(i64, i64, i64, i64)>) -> String {
  let ph = if placeholder.is_empty() { String::new() } else { format!(r#"<p:ph type="{placeholder}"/>"#) };
  let xfrm = position.map_or(String::new(), |(x, y, cx, cy)| format!(r#"<a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>"#));
  let rpr = size.map_or(r#"<a:rPr lang="zh-CN"/>"#.to_string(), |size| format!(r#"<a:rPr lang="zh-CN" sz="{size}"/>"#));
  let paragraphs: String = texts.iter().map(|text| format!("<a:p><a:r>{rpr}<a:t>{text}</a:t></a:r></a:p>")).collect();
  format!(r#"<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"/><p:cNvSpPr/><p:nvPr>{ph}</p:nvPr></p:nvSpPr><p:spPr>{xfrm}</p:spPr><p:txBody><a:bodyPr/>{paragraphs}</p:txBody></p:sp>"#)
}

/// 一页：background 为幻灯片自己的背景，animated 时带进入动画与切换效果
fn slide(shapes: &str, background: &str, animated: bool) -> String {
  let (timing, transition) = if animated {
    (
      r#"<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" nodeType="tmRoot"><p:childTnLst><p:seq><p:cTn id="2" nodeType="mainSeq"><p:childTnLst><p:par><p:cTn id="3" presetID="10" presetClass="entr" nodeType="afterEffect"/></p:par></p:childTnLst></p:cTn></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>"#,
      r#"<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="p14"><p:transition spd="slow"><p:fade/></p:transition></mc:Choice></mc:AlternateContent>"#,
    )
  }
  else {
    ("", "")
  };
  format!("<p:sld {P}><p:cSld>{background}<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>{shapes}</p:spTree></p:cSld>{transition}{timing}</p:sld>")
}

/// 演示文稿：母版背景为 master_background，主题的浅色 1 为 theme_light
fn pptx(slides: &[String], master_background: &str, theme_light: &str) -> Vec<u8> {
  let mut entries: Vec<(String, String)> = vec![
    (
      "ppt/presentation.xml".into(),
      format!(
        r#"<p:presentation {P}><p:sldIdLst>{}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>"#,
        (1..=slides.len()).map(|n| format!(r#"<p:sldId id="{}" r:id="rId{n}"/>"#, 255 + n)).collect::<String>()
      ),
    ),
    (
      "ppt/_rels/presentation.xml.rels".into(),
      rels(&(1..=slides.len()).map(|n| relationship(&format!("rId{n}"), "slide", &format!("slides/slide{n}.xml"))).collect::<Vec<_>>()),
    ),
    ("ppt/slideLayouts/slideLayout1.xml".into(), format!("<p:sldLayout {P}><p:cSld><p:spTree/></p:cSld></p:sldLayout>")),
    ("ppt/slideLayouts/_rels/slideLayout1.xml.rels".into(), rels(&[relationship("rId1", "slideMaster", "../slideMasters/slideMaster1.xml")])),
    ("ppt/slideMasters/slideMaster1.xml".into(), format!("<p:sldMaster {P}><p:cSld>{master_background}<p:spTree/></p:cSld></p:sldMaster>")),
    ("ppt/slideMasters/_rels/slideMaster1.xml.rels".into(), rels(&[relationship("rId1", "theme", "../theme/theme1.xml")])),
    (
      "ppt/theme/theme1.xml".into(),
      format!(r#"<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="x"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1>{theme_light}</a:lt1></a:clrScheme></a:themeElements></a:theme>"#),
    ),
  ];
  for (index, content) in slides.iter().enumerate() {
    let n = index + 1;
    entries.push((format!("ppt/slides/slide{n}.xml"), content.clone()));
    entries.push((format!("ppt/slides/_rels/slide{n}.xml.rels"), rels(&[relationship("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml")])));
  }
  let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
  for (name, content) in entries {
    zip.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
    zip.write_all(content.as_bytes()).unwrap();
  }
  zip.finish().unwrap().into_inner()
}

fn check(bytes: Vec<u8>) -> Vec<QualityIssue> {
  check_pptx(&mut zip::ZipArchive::new(Cursor::new(bytes)).unwrap())
}

fn codes(issues: &[QualityIssue]) -> Vec<&'static str> {
  issues.iter().map(|issue| issue.code).collect()
}

/// 默认模板的背景：引用主题的背景 1，主题的浅色 1 为白色
const DEFAULT_BACKGROUND: &str = r#"<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>"#;
const WHITE_THEME: &str = r#"<a:sysClr val="window" lastClr="FFFFFF"/>"#;

#[test]
fn finds_problems_in_a_default_looking_deck() {
  let bullets = |title: &str| slide(&format!("{}{}", shape("title", &[title], None, None), shape("body", &["要点一", "要点二"], None, None)), "", false);
  let slides = vec![
    bullets("背景"),
    bullets("目标"),
    bullets("计划"),
    // 文字超出页面、字号太小
    slide(&shape("", &["很长的说明"], Some(1000), Some((10_000_000, 6_000_000, 4_000_000, 2_000_000))), "", false),
    // 一页的文字太多，还有空的占位符（页码占位符不算）
    slide(&format!("{}{}{}", shape("title", &[&"字".repeat(320)], None, None), shape("body", &[], None, None), shape("sldNum", &[], None, None)), "", false),
  ];
  let issues = check(pptx(&slides, DEFAULT_BACKGROUND, WHITE_THEME));
  assert_eq!(codes(&issues), vec!["no-animation", "no-transition", "white-background", "monotonous-layout", "overflow", "small-font", "too-much-text", "empty-placeholder"]);
  let message = |code: &str| issues.iter().find(|issue| issue.code == code).unwrap().message.clone();
  assert!(message("no-animation").starts_with("所有页面没有进入动画"), "{issues:?}");
  assert!(message("white-background").starts_with("所有页面是纯白背景"), "{issues:?}");
  assert!(message("monotonous-layout").starts_with("第 1–3 页都是「标题 + 要点」"), "{issues:?}");
  assert!(message("overflow").starts_with("第 4 页有文字超出了页面"), "{issues:?}");
  assert!(message("small-font").starts_with("第 4 页"), "{issues:?}");
  assert!(message("too-much-text").starts_with("第 5 页文字太多（约 320 字）"), "{issues:?}");
  assert!(message("empty-placeholder").starts_with("第 5 页有空的占位符"), "{issues:?}");
}

#[test]
fn designed_deck_has_no_problems() {
  let gradient = r#"<p:bg><p:bgPr><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="1B2442"/></a:gs><a:gs pos="100000"><a:srgbClr val="384887"/></a:gs></a:gsLst></a:gradFill></p:bgPr></p:bg>"#;
  let cards: String = (1..=3).map(|n| shape("", &[&format!("0{n}"), "要点"], Some(2200), Some((n * 3_000_000, 2_000_000, 2_800_000, 2_600_000)))).collect();
  let slides = vec![
    slide(&format!("{}{}", shape("ctrTitle", &["年度总结"], Some(5400), None), shape("subTitle", &["市场部"], None, None)), gradient, true),
    slide(&format!("{}{cards}", shape("title", &["主要成果"], None, None)), "", true),
    // 「标题 + 要点」只有一页，不算版式单一
    slide(&format!("{}{}", shape("title", &["计划"], None, None), shape("body", &["要点"], None, None)), "", true),
    slide(&shape("", &["谢谢观看"], Some(5400), Some((0, 2_400_000, 12_192_000, 1_200_000))), gradient, true),
  ];
  // 母版是浅灰色，不是纯白
  let master = r#"<p:bg><p:bgPr><a:solidFill><a:srgbClr val="F6F7FB"/></a:solidFill></p:bgPr></p:bg>"#;
  assert_eq!(check(pptx(&slides, master, WHITE_THEME)), vec![]);
}

#[test]
fn resolves_background_through_layout_master_and_theme() {
  let page = || slide(&shape("title", &["标题"], None, None), "", true);
  // 母版引用主题的背景 1，但主题的浅色 1 不是白色
  let tinted_theme = r#"<a:srgbClr val="FFF4E5"/>"#;
  assert!(!codes(&check(pptx(&[page()], DEFAULT_BACKGROUND, tinted_theme))).contains(&"white-background"));
  // 母版没有设置背景时，用主题的背景色
  assert!(codes(&check(pptx(&[page()], "", WHITE_THEME))).contains(&"white-background"));
  // 幻灯片自己的背景优先；调暗过的主题色不算纯白
  let darker = r#"<p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"><a:lumMod val="85000"/></a:schemeClr></a:solidFill></p:bgPr></p:bg>"#;
  let slides = vec![slide(&shape("title", &["标题"], None, None), darker, true), page()];
  let issues = check(pptx(&slides, DEFAULT_BACKGROUND, WHITE_THEME));
  assert_eq!(issues.iter().find(|issue| issue.code == "white-background").unwrap().message.split('是').next().unwrap(), "第 2 页");
}

#[test]
fn cover_is_not_counted_as_a_bullet_slide() {
  let cover = slide(&format!("{}{}", shape("ctrTitle", &["年度总结"], None, None), shape("subTitle", &["市场部"], None, None)), "", true);
  let bullets = |title: &str| slide(&format!("{}{}", shape("title", &[title], None, None), shape("body", &["要点"], None, None)), "", true);
  let master = r#"<p:bg><p:bgPr><a:solidFill><a:srgbClr val="F6F7FB"/></a:solidFill></p:bgPr></p:bg>"#;
  assert_eq!(check(pptx(&[cover.clone(), bullets("一"), bullets("二")], master, WHITE_THEME)), vec![]);
  let issues = check(pptx(&[cover, bullets("一"), bullets("二"), bullets("三")], master, WHITE_THEME));
  assert_eq!(issues[0].message.split('都').next().unwrap(), "第 2–4 页");
}

#[test]
fn formats_page_ranges() {
  assert_eq!(format_pages(&[1]), "第 1 页");
  assert_eq!(format_pages(&[2, 3, 4, 6, 8, 9]), "第 2–4、6、8–9 页");
}

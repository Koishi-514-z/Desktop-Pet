//! 提取 Word 与 PowerPoint 的文字：保留标题、列表、表格结构，页眉页脚、脚注尾注、批注与演讲者备注

use std::io::{Cursor, Write};

use super::read::read_bytes;

fn zip_bytes(entries: &[(&str, String)]) -> Vec<u8> {
  let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
  let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
  for (name, content) in entries {
    zip.start_file(*name, options).unwrap();
    zip.write_all(content.as_bytes()).unwrap();
  }
  zip.finish().unwrap().into_inner()
}

const W: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006""#;

fn run(text: &str) -> String {
  format!(r#"<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">{text}</w:t></w:r>"#)
}

fn paragraph(properties: &str, content: &str) -> String {
  format!("<w:p><w:pPr>{properties}</w:pPr>{content}</w:p>")
}

fn cell(properties: &str, text: &str) -> String {
  format!("<w:tc><w:tcPr>{properties}</w:tcPr>{}</w:tc>", paragraph("", &run(text)))
}

fn docx(body: &str, extra: &[(&str, String)]) -> Vec<u8> {
  let mut entries = vec![("word/document.xml", format!("<?xml version=\"1.0\"?><w:document {W}><w:body>{body}<w:sectPr/></w:body></w:document>"))];
  entries.extend(extra.iter().cloned());
  zip_bytes(&entries)
}

fn styles() -> String {
  format!(
    r#"<w:styles {W}>
      <w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
      <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
      <w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr></w:style>
    </w:styles>"#
  )
}

fn numbering() -> String {
  format!(
    r#"<w:numbering {W}>
      <w:abstractNum w:abstractNumId="0">
        <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
        <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl>
      </w:abstractNum>
      <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val=""/></w:lvl></w:abstractNum>
      <w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="（%1）"/></w:lvl></w:abstractNum>
      <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
      <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
      <w:num w:numId="3"><w:abstractNumId w:val="2"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="3"/></w:lvlOverride></w:num>
    </w:numbering>"#
  )
}

#[test]
fn reads_word_structure() {
  let list = |level: usize, text: &str| paragraph(&format!(r#"<w:numPr><w:ilvl w:val="{level}"/><w:numId w:val="1"/></w:numPr>"#), &run(text));
  let body = [
    paragraph(r#"<w:pStyle w:val="1"/>"#, &run("年度   报告")),
    paragraph("", &format!("{}{}", run("正文 A "), run("&amp; B"))),
    paragraph(r#"<w:pStyle w:val="Heading2"/>"#, &run("目标")),
    list(0, "增长"),
    list(1, "收入"),
    list(1, "利润"),
    list(0, "风险"),
    list(1, "成本"),
    paragraph(r#"<w:pStyle w:val="ListBullet"/>"#, &run("要点")),
    // 中文编号，从 3 开始
    paragraph(r#"<w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>"#, &run("丙")),
    paragraph(r#"<w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>"#, &run("丁")),
    // 空段落不占编号，多个空段落只保留一个空行
    paragraph("", ""),
    paragraph("", ""),
    // 修订中删除的文字、域代码不出现，域的结果保留；换行与制表符
    paragraph(
      "",
      r#"<w:ins><w:r><w:t>新增</w:t></w:r></w:ins><w:del><w:r><w:delText>删掉</w:delText></w:r></w:del><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:br/><w:t>下一行</w:t><w:tab/><w:t>右</w:t></w:r>"#,
    ),
  ]
  .concat();
  let bytes = docx(&body, &[("word/styles.xml", styles()), ("word/numbering.xml", numbering())]);
  let text = read_bytes("报告.docx", &bytes).unwrap();
  assert_eq!(text.format, "docx");
  assert_eq!(
    text.content,
    "# 年度 报告\n正文 A & B\n\n## 目标\n1. 增长\n  1.1 收入\n  1.2 利润\n2. 风险\n  2.1 成本\n- 要点\n（三） 丙\n（四） 丁\n\n新增3\n下一行\t右"
  );
}

#[test]
fn reads_word_tables_and_text_boxes() {
  let row = |cells: &[String]| format!("<w:tr>{}</w:tr>", cells.concat());
  let table = format!(
    "<w:tbl><w:tblPr/>{}{}{}</w:tbl>",
    row(&[cell("", "项目"), cell("", "Q1"), cell("", "Q2")]),
    // 横向合并两格；内容中的 | 需要转义
    row(&[cell(r#"<w:vMerge w:val="restart"/>"#, "收入"), cell(r#"<w:gridSpan w:val="2"/>"#, "100 | 120")]),
    // 纵向合并：被合并的格子为空；一格中的多个段落写成一行
    row(&[
      cell("<w:vMerge/>", "（被合并）"),
      format!("<w:tc>{}{}</w:tc>", paragraph("", &run("第一段")), paragraph("", &run("第二段"))),
      cell("", "x"),
    ]),
  );
  // 只有一格的表格常用来排版，按普通内容输出
  let frame = format!("<w:tbl><w:tr><w:tc>{}{}</w:tc></w:tr></w:tbl>", paragraph("", &run("框内一")), paragraph("", &run("框内二")));
  // 文本框在新旧两种写法中各有一份，只取一份
  let text_box = paragraph(
    "",
    &format!(
      "{}<w:r><mc:AlternateContent><mc:Choice Requires=\"wps\"><w:drawing><wps:txbx><w:txbxContent>{}</w:txbxContent></wps:txbx></w:drawing></mc:Choice><mc:Fallback><w:pict><v:textbox><w:txbxContent>{}</w:txbxContent></v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r>",
      run("图注"),
      paragraph("", &run("文本框")),
      paragraph("", &run("文本框")),
    ),
  );
  let body = [paragraph("", &run("前文")), table, frame, text_box].concat();
  let text = read_bytes("表格.docx", &docx(&body, &[])).unwrap().content;
  assert_eq!(
    text,
    "前文\n\n| 项目 | Q1 | Q2 |\n| --- | --- | --- |\n| 收入 | 100 \\| 120 |  |\n|  | 第一段 第二段 | x |\n\n框内一\n框内二\n\n图注\n文本框"
  );
}

#[test]
fn reads_word_headers_footnotes_and_comments() {
  let body = [
    paragraph(
      "",
      &format!(
        r#"{}<w:commentRangeStart w:id="7"/>{}<w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r>{}<w:r><w:footnoteReference w:id="2"/></w:r>"#,
        run("今年营收"),
        run("增长 20%"),
        run("，详见附录"),
      ),
    ),
    paragraph("", &format!(r#"{}<w:r><w:endnoteReference w:id="1"/></w:r>"#, run("参考资料"))),
    // 没有标记原文的批注
    paragraph("", &format!(r#"{}<w:r><w:commentReference w:id="9"/></w:r>"#, run("结论"))),
  ]
  .concat();
  let header = |text: &str| format!("<w:hdr {W}>{}</w:hdr>", paragraph("", &run(text)));
  let footer = format!("<w:ftr {W}>{}</w:ftr>", paragraph("", &format!("{}<w:r><w:instrText>PAGE</w:instrText></w:r>{}", run("第 "), run("1 页"))));
  let footnotes = format!(
    r#"<w:footnotes {W}><w:footnote w:type="separator" w:id="-1">{}</w:footnote><w:footnote w:id="2">{}</w:footnote></w:footnotes>"#,
    paragraph("", "<w:r><w:separator/></w:r>"),
    paragraph("", &format!("<w:r><w:footnoteRef/></w:r>{}", run(" 按审计后的数字"))),
  );
  let endnotes = format!(r#"<w:endnotes {W}><w:endnote w:id="1">{}</w:endnote></w:endnotes>"#, paragraph("", &run("《年度报告》")));
  let comments = format!(
    r#"<w:comments {W}><w:comment w:id="9" w:author="李四">{}</w:comment><w:comment w:id="7" w:author="张三" w:date="2026-03-01T10:00:00Z">{}</w:comment></w:comments>"#,
    paragraph("", &run("写得太简单")),
    paragraph("", &format!("<w:r><w:annotationRef/></w:r>{}", run("请核实"))),
  );
  let bytes = docx(
    &body,
    &[
      // 各节的页眉通常相同，只保留一份
      ("word/header1.xml", header("公司机密")),
      ("word/header2.xml", header("公司机密")),
      ("word/header3.xml", header("首页页眉")),
      ("word/footer1.xml", footer),
      ("word/footnotes.xml", footnotes),
      ("word/endnotes.xml", endnotes),
      ("word/comments.xml", comments),
    ],
  );
  let text = read_bytes("报告.docx", &bytes).unwrap().content;
  assert_eq!(
    text,
    [
      "今年营收增长 20%[批注1]，详见附录[^1]\n参考资料[^尾注1]\n结论[批注2]",
      "【页眉】\n公司机密\n\n首页页眉",
      "【页脚】\n第 1 页",
      "【脚注】\n[^1] 按审计后的数字",
      "【尾注】\n[^尾注1] 《年度报告》",
      "【批注】\n[批注1] 张三（2026-03-01）：请核实\n  对应的原文：「增长 20%」\n[批注2] 李四：写得太简单",
    ]
    .join("\n\n")
  );
}

const P: &str = r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships""#;

fn shape(placeholder: &str, paragraphs: &[&str]) -> String {
  let ph = if placeholder.is_empty() { String::new() } else { format!(r#"<p:ph type="{placeholder}"/>"#) };
  let body: String = paragraphs.iter().map(|text| format!(r#"<a:p><a:r><a:rPr lang="zh-CN"/><a:t>{text}</a:t></a:r></a:p>"#)).collect();
  format!(r#"<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"/><p:cNvSpPr/><p:nvPr>{ph}</p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/>{body}</p:txBody></p:sp>"#)
}

fn slide(attributes: &str, shapes: &str) -> String {
  format!("<p:sld {P}{attributes}><p:cSld><p:spTree><p:nvGrpSpPr/>{shapes}</p:spTree></p:cSld></p:sld>")
}

fn relationship(id: &str, kind: &str, target: &str) -> String {
  format!(r#"<Relationship Id="{id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}" Target="{target}"/>"#)
}

fn rels(items: &[String]) -> String {
  format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{}</Relationships>"#, items.concat())
}

#[test]
fn reads_slides_in_presentation_order_with_notes_and_tables() {
  let cell = |text: &str, attributes: &str| format!(r#"<a:tc{attributes}><a:txBody><a:bodyPr/><a:p><a:r><a:t>{text}</a:t></a:r></a:p></a:txBody></a:tc>"#);
  let table = format!(
    r#"<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tblGrid/><a:tr>{}{}</a:tr><a:tr>{}{}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>"#,
    cell("指标", ""),
    cell("数值", ""),
    cell("用户", r#" gridSpan="2""#),
    cell("（合并）", r#" hMerge="1""#),
  );
  let group = format!("<p:grpSp><p:nvGrpSpPr/>{}</p:grpSp>", shape("", &["组合中的文字"]));
  let level = r#"<p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:pPr lvl="1"/><a:r><a:t>二级要点</a:t></a:r><a:br/><a:r><a:t>换行</a:t></a:r></a:p><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>"#;

  let notes = format!(
    "<p:notes {P}><p:cSld><p:spTree>{}{}{}</p:spTree></p:cSld></p:notes>",
    shape("sldImg", &[]),
    shape("body", &["开场先讲背景", "控制在 3 分钟"]),
    shape("sldNum", &["1"]),
  );
  let bytes = zip_bytes(&[
    // 文件编号与播放顺序不同：presentation.xml 中 slide3 在最前面
    (
      "ppt/presentation.xml",
      format!(r#"<p:presentation {P}><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId1"/><p:sldId id="258" r:id="rId2"/></p:sldIdLst></p:presentation>"#),
    ),
    (
      "ppt/_rels/presentation.xml.rels",
      rels(&[relationship("rId1", "slide", "slides/slide1.xml"), relationship("rId2", "slide", "slides/slide2.xml"), relationship("rId3", "slide", "slides/slide3.xml"), relationship("rId9", "theme", "theme/theme1.xml")]),
    ),
    ("ppt/slides/slide3.xml", slide("", &format!("{}{}", shape("ctrTitle", &["封面"]), shape("subTitle", &["副标题"])))),
    ("ppt/slides/_rels/slide3.xml.rels", rels(&[relationship("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"), relationship("rId2", "notesSlide", "../notesSlides/notesSlide1.xml")])),
    ("ppt/notesSlides/notesSlide1.xml", notes),
    ("ppt/slides/slide1.xml", slide("", &format!("{}{table}{group}{level}", shape("title", &["数据"])))),
    ("ppt/slides/slide2.xml", slide(r#" show="0""#, &shape("", &["备用页"]))),
  ]);
  let text = read_bytes("汇报.pptx", &bytes).unwrap();
  assert_eq!(text.format, "pptx");
  assert_eq!(
    text.content,
    [
      "【第 1 页】\n封面\n副标题\n【备注】\n开场先讲背景\n控制在 3 分钟",
      "【第 2 页】\n数据\n\n| 指标 | 数值 |\n| --- | --- |\n| 用户 |  |\n\n组合中的文字\n  二级要点\n换行",
      "【第 3 页（隐藏）】\n备用页",
    ]
    .join("\n\n")
  );
}

#[test]
fn reads_bytes_of_other_formats() {
  assert_eq!(read_bytes("笔记.txt", "你好".as_bytes()).unwrap().content, "你好");
  assert!(read_bytes("旧版.doc", b"\xD0\xCF\x11\xE0").unwrap_err().contains("另存为 .docx"));
  assert!(read_bytes("坏的.docx", b"not a zip").unwrap_err().contains("不是有效的 Office 文档"));
  assert!(read_bytes("坏的.xlsx", b"not a zip").unwrap_err().contains("无法读取这个表格文件"));
  assert!(read_bytes("扫描件.pdf", b"%PDF-1.7").is_err());
}

#[test]
fn extracts_dropped_file_bytes_with_encoded_name() {
  let bytes = docx(&paragraph("", &run("合同正文")), &[]);
  // 前端用 encodeURIComponent 编码文件名「合同.docx」，可以限制返回的字数
  let result = super::extract_bytes(Some("%E5%90%88%E5%90%8C.docx"), Some("2"), &bytes).unwrap();
  assert_eq!((result.name.as_str(), result.path.as_str(), result.format), ("合同.docx", "", "docx"));
  assert_eq!((result.content.as_str(), result.truncated, result.total_chars), ("合同", true, 4));
  // 文件名中的路径会被去掉；不限制字数时返回全部
  let result = super::extract_bytes(Some("..%5C..%2F%E5%90%88%E5%90%8C.docx"), None, &bytes).unwrap();
  assert_eq!((result.name.as_str(), result.content.as_str()), ("合同.docx", "合同正文"));
  assert!(super::extract_bytes(None, None, &bytes).unwrap_err().contains("缺少文件名"));
}

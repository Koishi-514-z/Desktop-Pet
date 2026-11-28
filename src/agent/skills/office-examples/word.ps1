# Word：新建一份排版规范、美观的文档——统一的字体与配色，标题用内置的标题样式（导航窗格与目录依赖它），
# 间距在样式中设置（不要用空段落调整间距），要点用 Word 的列表，表格有深色表头、隔行底色与浅色边框，
# 页眉写文档标题、页脚有页码。保存后导出 PDF。
# 修改已有文档：$doc = $word.Documents.Open($path)，改完后 $doc.Save()
$dir = 'C:\Users\me\Desktop'
# 传给 Office 的路径必须是普通字符串。不要直接传 Join-Path 等命令的结果（先用 [string] 转换），否则 Office 会卡住
$path = "$dir\会议纪要.docx"
function Rgb([int]$r, [int]$g, [int]$b) { $r + 256 * $g + 65536 * $b }   # Office 的颜色值：红 + 绿×256 + 蓝×65536

# 配色：一份文档只用这几种颜色
$accent = Rgb 31 78 121       # 深蓝：标题、表头、强调
$light = Rgb 234 241 248      # 浅蓝：提示框、隔行底色
$lineColor = Rgb 191 204 219  # 边框与分隔线
$text = Rgb 38 38 38
$muted = Rgb 118 118 118

# 内置样式用编号（中文版的样式名是中文）：-1 正文，-2 标题 1，-3 标题 2，-63 标题（文档标题），-75 副标题
$styleNormal = -1
$styleHeading1 = -2
$styleTitle = -63
$styleSubtitle = -75

# 辅助函数的参数必须写明类型：PowerShell 调用 Office 时，同一行代码会沿用第一次收到的值的类型
function Set-StyleFont([object]$style, [string]$font, [double]$size, [bool]$bold, [int]$color) {
  $style.Font.Name = $font          # 数字与英文的字体
  $style.Font.NameFarEast = $font   # 中文的字体
  $style.Font.Size = $size
  $style.Font.Bold = $bold
  $style.Font.Color = $color
}

# 写一段：先设置样式再输入文字
function Write-Paragraph([object]$sel, [int]$style, [string]$value) {
  $sel.Style = $style
  $sel.TypeText($value)
  $sel.TypeParagraph()
}

# 表格：第一行是表头（深色底、白色粗体，跨页时重复），正文隔行浅色底；宽度随页面，不会超出版心
function Add-Table([object]$doc, [object]$sel, [object[]]$rows) {
  $table = $doc.Tables.Add($sel.Range, $rows.Count, $rows[0].Count)
  $table.Borders.InsideLineStyle = 1
  $table.Borders.OutsideLineStyle = 1
  $table.Borders.InsideColor = $lineColor
  $table.Borders.OutsideColor = $lineColor
  for ($r = 0; $r -lt $rows.Count; $r++) {
    for ($c = 0; $c -lt $rows[0].Count; $c++) { $table.Cell($r + 1, $c + 1).Range.Text = $rows[$r][$c] }
    if ($r -gt 0 -and $r % 2 -eq 0) { $table.Rows.Item($r + 1).Shading.BackgroundPatternColor = $light }
  }
  $header = $table.Rows.Item(1)
  $header.Shading.BackgroundPatternColor = $accent
  $header.Range.Font.Color = Rgb 255 255 255
  $header.Range.Font.Bold = $true
  $header.HeadingFormat = $true              # 跨页时重复表头
  $table.Range.ParagraphFormat.SpaceAfter = 0       # 表格中不用正文的段后间距与 1.5 倍行距
  $table.Range.ParagraphFormat.LineSpacingRule = 0  # 0：单倍行距
  $table.Rows.Height = 26                    # 最小行高（磅）
  $table.Range.Cells.VerticalAlignment = 1   # 1：垂直居中
  $table.AutoFitBehavior(2)                  # 2：根据页面宽度调整
  $sel.EndKey(6) | Out-Null                  # 光标移到文档末尾，接着往下写
}

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0          # 不弹出任何对话框，否则脚本会卡住
$word.AutomationSecurity = 3     # 禁止运行文档中的宏
try {
  $doc = $word.Documents.Add()
  $sel = $word.Selection

  # 页面：A4，页边距 2.5 厘米
  $doc.PageSetup.PaperSize = 7
  $margin = $word.CentimetersToPoints(2.5)
  $doc.PageSetup.TopMargin = $margin
  $doc.PageSetup.BottomMargin = $margin
  $doc.PageSetup.LeftMargin = $margin
  $doc.PageSetup.RightMargin = $margin

  # 样式：正文五号（10.5 磅）、1.5 倍行距、段后 6 磅；标题用微软雅黑与主题色，一级标题下方有分隔线
  $normal = $doc.Styles.Item($styleNormal)
  Set-StyleFont $normal '等线' 10.5 $false $text
  $normal.ParagraphFormat.LineSpacingRule = 1       # 1：1.5 倍行距
  $normal.ParagraphFormat.SpaceAfter = 6
  $title = $doc.Styles.Item($styleTitle)
  Set-StyleFont $title '微软雅黑' 22 $true $accent
  $title.ParagraphFormat.Alignment = 1              # 1：居中
  $title.ParagraphFormat.SpaceAfter = 4
  $subtitle = $doc.Styles.Item($styleSubtitle)
  Set-StyleFont $subtitle '等线' 10.5 $false $muted
  $subtitle.Font.Spacing = 0                        # 内置的副标题样式加宽了字间距
  $subtitle.ParagraphFormat.Alignment = 1
  $subtitle.ParagraphFormat.SpaceAfter = 18
  $heading = $doc.Styles.Item($styleHeading1)
  Set-StyleFont $heading '微软雅黑' 14 $true $accent
  $heading.ParagraphFormat.SpaceBefore = 18
  $heading.ParagraphFormat.SpaceAfter = 8
  $heading.Borders.Item(-3).LineStyle = 1           # 边框：-1 上，-2 左，-3 下，-4 右
  $heading.Borders.Item(-3).Color = $lineColor
  # 提示框：自定义的段落样式（浅色底、左侧强调色竖线），用于结论、注意事项
  $note = $doc.Styles.Add('提示框', 1)              # 1：段落样式
  Set-StyleFont $note '等线' 10.5 $false $text
  $note.ParagraphFormat.Shading.BackgroundPatternColor = $light
  $note.ParagraphFormat.LineSpacingRule = 0
  $note.ParagraphFormat.SpaceBefore = 10
  $note.ParagraphFormat.SpaceAfter = 16
  # 上、右、下用与底色同色的边框：看不出来，但文字与底色边缘之间能留出距离
  foreach ($side in @(-1, -3, -4)) {
    $note.Borders.Item($side).LineStyle = 1
    $note.Borders.Item($side).Color = $light
  }
  $note.Borders.DistanceFromTop = 6                 # 文字与边缘的距离（磅）
  $note.Borders.DistanceFromBottom = 6
  $note.Borders.DistanceFromLeft = 10
  $note.Borders.DistanceFromRight = 10
  $note.ParagraphFormat.LeftIndent = 10             # 缩进与上面的距离相同，底色才和正文对齐
  $note.ParagraphFormat.RightIndent = 10
  $note.Borders.Item(-2).LineStyle = 1
  $note.Borders.Item(-2).LineWidth = 24             # 24：3 磅
  $note.Borders.Item(-2).Color = $accent
  $note.NextParagraphStyle = $normal

  Write-Paragraph $sel $styleTitle '产品发布会议纪要'
  Write-Paragraph $sel $styleSubtitle '2026年11月24日 · 产品部 · 记录人：小李'

  Write-Paragraph $sel $styleHeading1 '会议结论'
  # 自定义样式按名称设置，写在单独的一行（同一行代码不能交替收到数字与文字）
  $sel.Style = '提示框'
  $sel.TypeText('确定12月15日正式发布，发布前完成全部测试与文档。')
  $sel.TypeParagraph()

  Write-Paragraph $sel $styleHeading1 '讨论事项'
  $sel.Range.ListFormat.ApplyNumberDefault()       # 编号列表；项目符号列表用 ApplyBulletDefault()
  $sel.TypeText('确定发布日期')
  $sel.TypeParagraph()
  $sel.TypeText('分配测试任务')
  $sel.TypeParagraph()
  $sel.Range.ListFormat.RemoveNumbers()

  Write-Paragraph $sel $styleHeading1 '任务分工'
  Add-Table $doc $sel @(@('任务', '负责人', '截止日期'), @('测试', '小王', '12月10日'), @('文档', '小李', '12月12日'), @('发布', '小张', '12月15日'))

  # 页眉：文档标题（右对齐、灰色小字）；页脚：居中的页码
  $section = $doc.Sections.Item(1)
  $headerRange = $section.Headers.Item(1).Range
  $headerRange.Text = '产品发布会议纪要'
  $headerRange.Font.Size = 9
  $headerRange.Font.Color = $muted
  $headerRange.ParagraphFormat.Alignment = 2        # 2：右对齐
  $section.Footers.Item(1).PageNumbers.Add(1) | Out-Null
  $footerRange = $section.Footers.Item(1).Range
  $footerRange.Font.Size = 9
  $footerRange.Font.Color = $muted

  $doc.SaveAs2($path, 16)                                          # 16：docx
  $doc.ExportAsFixedFormat("$dir\会议纪要.pdf", 17)                # 17：PDF
  Write-Output "已保存 $path"
}
finally {
  if ($doc) { try { $doc.Close(0) } catch {} }          # 关闭文档（出错时不保存）
  # 丢掉脚本中引用的 Office 对象并回收，否则 Word 退出后后台进程要等很久才结束
  $footerRange = $headerRange = $section = $note = $heading = $subtitle = $title = $normal = $sel = $doc = $null
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  [GC]::Collect()                  # 第二轮：回收上一轮释放出来的对象
  [GC]::WaitForPendingFinalizers()
  if ($word.Documents.Count -eq 0) {                    # 只在没有其他文档打开时退出
    $word.NormalTemplate.Saved = $true                   # 不保存公共模板 Normal.dotm（被用户的 Word 占用时会卡在退出）
    $word.Quit()
  }
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}

# PowerPoint：新建演示文稿，添加标题页、要点页、表格页与结束页。
# 把每一页的内容写成数组再循环生成：页数再多，代码也不会变长
# 修改已有文稿：$pres = $ppt.Presentations.Open($path, 0, 0, 0)（不只读、不是无标题、不显示窗口），改完后 $pres.Save()
$path = 'C:\Users\me\Desktop\年度总结.pptx'
function Rgb([int]$r, [int]$g, [int]$b) { $r + 256 * $g + 65536 * $b }   # Office 的颜色值：红 + 绿×256 + 蓝×65536

# Bold、Italic、Underline 是三态值：-1 是，0 否（用 $true / $false 会报「指定的转换无效」）
$msoTrue = -1
$msoFalse = 0

# 新建幻灯片用 $pres.Slides.Add(位置, 版式常量)：PowerPoint 会在当前母版中找到对应的版式，与模板、语言无关。
# 不要用 $pres.SlideMaster.CustomLayouts.Item(编号)：版式的数量与顺序因模板而异（默认只有 11 个），两套编号不能混用
$ppLayoutTitle = 1        # 标题幻灯片
$ppLayoutText = 2         # 标题和内容
$ppLayoutTitleOnly = 11   # 仅标题
$ppLayoutBlank = 12       # 空白

# 辅助函数的参数必须写明类型。PowerShell 调用 Office 时，同一行代码会沿用第一次收到的值的类型，
# 之后收到其他类型的值就会报「无法将 Int32 强制转换为 String」；而调用函数时直接写 -1 会被当成文字 "-1"
function Set-Font([object]$range, [int]$size, [int]$bold, [int]$color) {
  $range.Font.Size = $size
  $range.Font.Bold = $bold
  $range.Font.Color.RGB = $color
  $range.Font.NameFarEast = '微软雅黑'     # 中文字体用 NameFarEast，Name 只影响英文
}

# 要点页：每页的标题与要点
$pages = @(
  @{ Title = '主要成果'; Points = @('销售额增长 20%', '新增客户 120 家', '推出 3 款新产品') },
  @{ Title = '明年计划'; Points = @('开拓海外市场', '上线会员体系') }
)
# 表格页：第一行是表头
$rows = @(@('季度', '销售额'), @('一季度', '120 万'), @('二季度', '150 万'))

$ppt = New-Object -ComObject PowerPoint.Application
$ppt.DisplayAlerts = 1           # 1：不弹出对话框（PowerPoint 不能隐藏程序窗口，打开文稿时不显示窗口即可）
$ppt.AutomationSecurity = 3      # 禁止运行文档中的宏
try {
  $pres = $ppt.Presentations.Add(0)               # 0：不显示窗口

  $slide = $pres.Slides.Add(1, $ppLayoutTitle)
  $title = $slide.Shapes.Item(1).TextFrame.TextRange
  $title.Text = '2026 年度总结'
  Set-Font $title 44 $msoTrue (Rgb 47 85 151)
  $subtitle = $slide.Shapes.Item(2).TextFrame.TextRange
  $subtitle.Text = '市场部'
  Set-Font $subtitle 24 $msoFalse (Rgb 89 89 89)

  foreach ($page in $pages) {
    $slide = $pres.Slides.Add($pres.Slides.Count + 1, $ppLayoutText)
    $slide.Shapes.Item(1).TextFrame.TextRange.Text = $page.Title
    $slide.Shapes.Item(2).TextFrame.TextRange.Text = $page.Points -join "`r"   # `r 分隔要点
  }

  # 表格：行数、列数、左、上、宽、高（单位为磅，16:9 的幻灯片为 960×540）
  $slide = $pres.Slides.Add($pres.Slides.Count + 1, $ppLayoutTitleOnly)
  $slide.Shapes.Item(1).TextFrame.TextRange.Text = '季度数据'
  $table = $slide.Shapes.AddTable($rows.Count, 2, 80, 140, 800, 150).Table
  for ($r = 0; $r -lt $rows.Count; $r++) {
    for ($c = 0; $c -lt 2; $c++) { $table.Cell($r + 1, $c + 1).Shape.TextFrame.TextRange.Text = $rows[$r][$c] }
  }

  # 空白页：自己添加文本框，参数依次为方向（1 横排）、左、上、宽、高
  $slide = $pres.Slides.Add($pres.Slides.Count + 1, $ppLayoutBlank)
  $closing = $slide.Shapes.AddTextbox(1, 80, 200, 800, 100).TextFrame.TextRange
  $closing.Text = '谢谢观看'
  Set-Font $closing 40 $msoTrue (Rgb 47 85 151)

  $pres.SaveAs($path)              # 默认保存为 pptx；导出 PDF：$pres.SaveAs($pdfPath, 32)
  Write-Output "已保存 $path，共 $($pres.Slides.Count) 页"
}
finally {
  if ($pres) { try { $pres.Close() } catch {} }
  # PowerPoint 只有一个实例，可能是用户正在使用的：只在它没有打开其他文稿、也没有显示窗口时退出
  if ($ppt.Presentations.Count -eq 0 -and -not $ppt.Visible) { $ppt.Quit() }
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt)
}

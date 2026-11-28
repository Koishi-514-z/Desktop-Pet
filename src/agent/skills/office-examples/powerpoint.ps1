# PowerPoint：新建一份有设计感的演示文稿——统一的配色与字体，封面与结束页用深色渐变背景、内容页用浅色背景，
# 每页按内容选择不同的版式（卡片、大数字、表格……），每个元素都有进入动画，每页都有切换效果。
# 把每一页写成「版式 + 内容」放进数组，再循环按版式生成：页数再多，代码也不会变长
# 修改已有文稿：$pres = $ppt.Presentations.Open($path, 0, 0, 0)（不只读、不是无标题、不显示窗口），改完后 $pres.Save()
$path = 'C:\Users\me\Desktop\年度总结.pptx'
function Rgb([int]$r, [int]$g, [int]$b) { $r + 256 * $g + 65536 * $b }   # Office 的颜色值：红 + 绿×256 + 蓝×65536

# Bold、Visible 等是三态值：-1 是，0 否（用 $true / $false 会报「指定的转换无效」）
$msoTrue = -1
$msoFalse = 0

# 配色：一份文稿只用这几种颜色。深色用于封面、结束页与表头，强调色用于编号、数字与装饰
$dark = Rgb 27 36 66
$dark2 = Rgb 56 72 135
$light = Rgb 246 247 251
$white = Rgb 255 255 255
$accent = Rgb 255 107 87
$accent2 = Rgb 72 134 255
$text = Rgb 38 45 66
$muted = Rgb 118 126 148

# 版式常量：PowerPoint 会在当前母版中找到对应的版式，与模板、语言无关。
# 不要用 $pres.SlideMaster.CustomLayouts.Item(编号)：版式的数量与顺序因模板而异（默认只有 11 个），两套编号不能混用
$ppLayoutTitle = 1        # 标题幻灯片（封面）
$ppLayoutTitleOnly = 11   # 仅标题（内容页：标题用占位符，其余自己排版）

# 辅助函数的参数必须写明类型。PowerShell 调用 Office 时，同一行代码会沿用第一次收到的值的类型，
# 之后收到其他类型的值就会报「无法将 Int32 强制转换为 String」；而调用函数时直接写 -1 会被当成文字 "-1"，负数要加括号
function Set-Font([object]$range, [int]$size, [int]$bold, [int]$color) {
  $range.Font.Size = $size
  $range.Font.Bold = $bold
  $range.Font.Color.RGB = $color
  # Name 是数字与英文的字体，NameFarEast 是中文的字体：两个都要设置，否则数字、英文会是另一种字体
  $range.Font.Name = '微软雅黑'
  $range.Font.NameFarEast = '微软雅黑'
}

# 文本框（返回形状，便于加动画）；align：1 左对齐，2 居中
function Add-Text([object]$slide, [string]$value, [double]$left, [double]$top, [double]$width, [double]$height, [int]$size, [int]$bold, [int]$color, [int]$align) {
  $shape = $slide.Shapes.AddTextbox(1, $left, $top, $width, $height)   # 1：横排
  $range = $shape.TextFrame.TextRange
  $range.Text = $value
  Set-Font $range $size $bold $color
  $range.ParagraphFormat.Alignment = $align
  $shape
}

# 色块：type 为 1 矩形、5 圆角矩形、9 椭圆；transparency 为 0~1 的透明度
function Add-Box([object]$slide, [int]$type, [double]$left, [double]$top, [double]$width, [double]$height, [int]$color, [double]$transparency) {
  $shape = $slide.Shapes.AddShape($type, $left, $top, $width, $height)
  $shape.Fill.ForeColor.RGB = $color
  $shape.Fill.Transparency = $transparency
  $shape.Line.Visible = $msoFalse
  $shape
}

# 进入动画：effect 为 10 淡入、2 飞入、22 擦除、23 缩放；3 表示在上一个动画之后自动播放，delay 为等待的秒数
function Add-Entrance([object]$slide, [object]$shape, [int]$effect, [double]$delay) {
  $animation = $slide.TimeLine.MainSequence.AddEffect($shape, $effect, 0, 3)
  $animation.Timing.Duration = 0.5
  $animation.Timing.TriggerDelayTime = $delay
}

# 渐变背景（封面、结束页）；内容页跟随母版的浅色背景
function Set-Gradient([object]$slide, [int]$from, [int]$to) {
  $slide.FollowMasterBackground = $msoFalse
  $fill = $slide.Background.Fill
  $fill.TwoColorGradient(1, 1)    # 1：水平渐变
  $fill.ForeColor.RGB = $from
  $fill.BackColor.RGB = $to
}

# 内容页的标题：用版式自带的标题占位符（大纲视图、导航与无障碍检查都依赖它），左边加一条强调色竖条
function Set-Title([object]$slide, [string]$value) {
  $title = $slide.Shapes.Placeholders.Item(1)
  $title.Left = 84
  $title.Top = 36
  $title.Width = 800
  $title.Height = 64
  $range = $title.TextFrame.TextRange
  $range.Text = $value
  Set-Font $range 32 $msoTrue $text
  $range.ParagraphFormat.Alignment = 1
  $bar = Add-Box $slide 1 60 50 8 36 $accent 0
  Add-Entrance $slide $bar 22 0
  Add-Entrance $slide $title 10 0
}

# 每一页：Type 为版式，其余为内容
$pages = @(
  @{ Type = 'cover'; Title = '2026 年度总结'; Subtitle = '市场部' },
  @{ Type = 'cards'; Title = '主要成果'; Items = @('销售额增长 20%', '新增客户 120 家', '推出 3 款新产品') },
  @{ Type = 'numbers'; Title = '关键数据'; Items = @(@('270 万', '上半年销售额'), @('+25%', '二季度同比增长'), @('98%', '客户满意度')) },
  @{ Type = 'table'; Title = '季度数据'; Rows = @(@('季度', '销售额', '同比'), @('一季度', '120 万', '+12%'), @('二季度', '150 万', '+25%')) },
  @{ Type = 'end'; Title = '谢谢观看'; Subtitle = '欢迎提问与交流' }
)

# 按版式生成一页。放在函数里：函数结束后，这一页用到的对象（幻灯片、形状、动画）就不再被引用，
# 最后才能释放干净，让 PowerPoint 及时退出（对象很多时，留在变量里的引用会让后台进程迟迟不退出）
function Add-Page([object]$pres, [hashtable]$page) {
  $index = $pres.Slides.Count + 1
  $W = [int]$pres.PageSetup.SlideWidth            # 16:9 为 960×540（单位为磅）
  $H = [int]$pres.PageSetup.SlideHeight
  switch ($page.Type) {
    'cover' {
      $slide = $pres.Slides.Add($index, $ppLayoutTitle)
      Set-Gradient $slide $dark $dark2
      # 装饰的半透明圆放到最底层，不挡住文字
      (Add-Box $slide 9 ($W - 330) (-150) 480 480 $accent 0.8).ZOrder(1)
      (Add-Box $slide 9 ($W - 210) ($H - 170) 260 260 $accent2 0.75).ZOrder(1)
      # 占位符用 Placeholders 取：Shapes.Item(编号) 是按层叠顺序排的，加了图形或调整了层叠顺序后会变
      $title = $slide.Shapes.Placeholders.Item(1)
      $title.Left = 80; $title.Top = 170; $title.Width = 640; $title.Height = 110
      $title.TextFrame.TextRange.Text = $page.Title
      Set-Font $title.TextFrame.TextRange 54 $msoTrue $white
      $title.TextFrame.TextRange.ParagraphFormat.Alignment = 1
      $subtitle = $slide.Shapes.Placeholders.Item(2)
      $subtitle.Left = 80; $subtitle.Top = 300; $subtitle.Width = 640; $subtitle.Height = 50
      $subtitle.TextFrame.TextRange.Text = $page.Subtitle
      Set-Font $subtitle.TextFrame.TextRange 22 $msoFalse (Rgb 200 207 230)
      $subtitle.TextFrame.TextRange.ParagraphFormat.Alignment = 1
      $line = Add-Box $slide 1 84 286 72 5 $accent 0
      Add-Entrance $slide $title 2 0
      Add-Entrance $slide $line 22 0.1
      Add-Entrance $slide $subtitle 10 0.1
    }
    'cards' {
      # 卡片：每个要点一张，编号用强调色，依次飞入
      $slide = $pres.Slides.Add($index, $ppLayoutTitleOnly)
      Set-Title $slide $page.Title
      $count = $page.Items.Count
      $gap = 24
      $width = ($W - 120 - $gap * ($count - 1)) / $count
      for ($i = 0; $i -lt $count; $i++) {
        $card = Add-Box $slide 5 (60 + $i * ($width + $gap)) 170 $width 210 $white 0
        $card.TextFrame.TextRange.Text = ('{0:D2}' -f ($i + 1)) + "`r" + $page.Items[$i]   # `r 分段
        Set-Font $card.TextFrame.TextRange 22 $msoTrue $text
        Set-Font $card.TextFrame.TextRange.Paragraphs(1) 44 $msoTrue $accent
        $card.TextFrame.TextRange.Paragraphs(2).ParagraphFormat.SpaceBefore = 18
        $card.TextFrame.TextRange.ParagraphFormat.Alignment = 1
        $card.TextFrame.VerticalAnchor = 1          # 1：顶端对齐
        $card.TextFrame.MarginLeft = 24
        $card.TextFrame.MarginTop = 32
        $card.Shadow.Visible = $msoTrue
        $card.Shadow.Transparency = 0.85
        Add-Entrance $slide $card 2 0.15
      }
    }
    'numbers' {
      # 大数字：适合展示关键数据，数字大、说明小
      $slide = $pres.Slides.Add($index, $ppLayoutTitleOnly)
      Set-Title $slide $page.Title
      $count = $page.Items.Count
      $width = ($W - 120) / $count
      for ($i = 0; $i -lt $count; $i++) {
        $left = 60 + $i * $width
        $color = if ($i % 2 -eq 0) { $accent } else { $accent2 }
        $number = Add-Text $slide $page.Items[$i][0] $left 210 $width 90 60 $msoTrue $color 2
        $label = Add-Text $slide $page.Items[$i][1] $left 310 $width 40 18 $msoFalse $muted 2
        Add-Entrance $slide $number 23 0.15
        Add-Entrance $slide $label 10 0
      }
    }
    'table' {
      # 表格：表头深色，正文隔行变色
      $slide = $pres.Slides.Add($index, $ppLayoutTitleOnly)
      Set-Title $slide $page.Title
      $rows = $page.Rows
      $columns = $rows[0].Count
      $shape = $slide.Shapes.AddTable($rows.Count, $columns, 60, 140, $W - 120, 48 * $rows.Count)
      $table = $shape.Table
      for ($r = 0; $r -lt $rows.Count; $r++) {
        $fill = if ($r -eq 0) { $dark } elseif ($r % 2 -eq 1) { $white } else { Rgb 236 239 247 }
        $color = if ($r -eq 0) { $white } else { $text }
        $bold = if ($r -eq 0) { $msoTrue } else { $msoFalse }
        for ($c = 0; $c -lt $columns; $c++) {
          $cell = $table.Cell($r + 1, $c + 1).Shape
          $cell.Fill.ForeColor.RGB = $fill
          $cell.TextFrame.VerticalAnchor = 3        # 3：垂直居中
          $cell.TextFrame.MarginLeft = 16
          $cell.TextFrame.TextRange.Text = $rows[$r][$c]
          Set-Font $cell.TextFrame.TextRange 18 $bold $color
        }
      }
      Add-Entrance $slide $shape 22 0.1
    }
    'end' {
      $slide = $pres.Slides.Add($index, 12)       # 12：空白
      Set-Gradient $slide $dark2 $dark
      (Add-Box $slide 9 (-120) (-120) 360 360 $accent2 0.8).ZOrder(1)
      $title = Add-Text $slide $page.Title 0 190 $W 90 54 $msoTrue $white 2
      $subtitle = Add-Text $slide $page.Subtitle 0 290 $W 40 20 $msoFalse (Rgb 200 207 230) 2
      Add-Entrance $slide $title 23 0
      Add-Entrance $slide $subtitle 10 0.1
    }
  }
  # 切换效果：3849 为平滑淡出
  $slide.SlideShowTransition.EntryEffect = 3849
}

$ppt = New-Object -ComObject PowerPoint.Application
$ppt.DisplayAlerts = 1           # 1：不弹出对话框（PowerPoint 不能隐藏程序窗口，打开文稿时不显示窗口即可）
$ppt.AutomationSecurity = 3      # 禁止运行文档中的宏
try {
  $pres = $ppt.Presentations.Add(0)               # 0：不显示窗口
  # 母版背景：所有内容页统一用浅色，不要用默认的纯白
  $pres.SlideMaster.Background.Fill.Solid()
  $pres.SlideMaster.Background.Fill.ForeColor.RGB = $light

  foreach ($page in $pages) { Add-Page $pres $page }

  $pres.SaveAs($path)              # 默认保存为 pptx；导出 PDF：$pres.SaveAs($pdfPath, 32)
  Write-Output "已保存 $path，共 $($pres.Slides.Count) 页"
}
finally {
  if ($pres) { try { $pres.Close() } catch {} }
  $pres = $null
  # 回收不再使用的 Office 对象，否则 PowerPoint 要等很久才会退出
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  [GC]::Collect()                  # 第二轮：回收上一轮释放出来的对象
  [GC]::WaitForPendingFinalizers()
  # PowerPoint 只有一个实例，可能是用户正在使用的：只在它没有打开其他文稿、也没有显示窗口时退出
  if ($ppt.Presentations.Count -eq 0 -and -not $ppt.Visible) { $ppt.Quit() }
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt)
}

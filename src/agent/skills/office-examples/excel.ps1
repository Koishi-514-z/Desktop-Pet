# Excel：打开工作簿（不存在时新建），写入一张排版美观的表格——标题与说明、深色表头、隔行底色、浅色细边框、
# 数字格式、合计行、数据条，冻结表头、隐藏网格线，并添加统一配色的图表。
# 再次运行时更新同一个文件：先删除旧的图表与条件格式，不会越加越多
$path = 'C:\Users\me\Desktop\销售.xlsx'
function Rgb([int]$r, [int]$g, [int]$b) { $r + 256 * $g + 65536 * $b }   # Office 的颜色值：红 + 绿×256 + 蓝×65536

# 数字格式一律用这个函数设置，格式代码按英文写（如 [Red]、General）。
# PowerShell 调用 Office 时使用系统语言，直接给 NumberFormat 赋值时，中文版 Excel 只认中文写法（[红色]、G/通用格式），
# 写英文会报「不能设置类 Range 的 NumberFormat 属性」；这个函数指定按英文解释，与 Office 的语言无关
function Set-NumberFormat([object]$range, [string]$format) {
  [void][System.__ComObject].InvokeMember('NumberFormat', [System.Reflection.BindingFlags]::SetProperty, $null, $range, @($format), [System.Globalization.CultureInfo]::GetCultureInfo('en-US'))
}

# 配色：一张表只用这几种颜色
$accent = Rgb 31 78 121       # 深蓝：标题、表头、图表
$light = Rgb 234 241 248      # 浅蓝：隔行底色
$lineColor = Rgb 191 204 219  # 边框
$muted = Rgb 118 118 118

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false    # 不弹出任何对话框，否则脚本会卡住
$excel.AutomationSecurity = 3    # 禁止运行文档中的宏
try {
  $exists = Test-Path $path
  $book = if ($exists) { $excel.Workbooks.Open($path) } else { $excel.Workbooks.Add() }
  # 新建的工作簿只保留一个工作表（多余的空工作表会被当成问题）
  if (-not $exists) { while ($book.Worksheets.Count -gt 1) { $book.Worksheets.Item($book.Worksheets.Count).Delete() | Out-Null } }
  $sheet = $book.Worksheets.Item(1)     # 按名称：$book.Worksheets.Item('销售')
  $sheet.Name = '销售'
  $sheet.Cells.Font.Name = '微软雅黑'   # 整张表统一字体
  $sheet.Cells.Font.Size = 10

  # 标题与说明：合并单元格，靠左
  $sheet.Range('A1').Value2 = '2026 年第一季度销售'
  $title = $sheet.Range('A1:D1')
  $title.Merge()
  $title.Font.Size = 16
  $title.Font.Bold = $true
  $title.Font.Color = $accent
  $sheet.Rows.Item(1).RowHeight = 30
  $sheet.Range('A2').Value2 = '单位：元'
  $sheet.Range('A2:D2').Merge()
  $sheet.Range('A2').Font.Color = $muted

  # 用二维数组一次写入一块区域：比逐个单元格写入快得多；
  # 并且在循环里给同一个属性交替赋文字和数字会出错（无法将 Int32 转换为 String）
  $rows = @(@('月份', '销售额', '目标', '完成率'), @('一月', 1200, 1000), @('二月', 1500.5, 1600), @('三月', 980, 1200))
  $data = New-Object 'object[,]' $rows.Count, 4
  for ($r = 0; $r -lt $rows.Count; $r++) {
    for ($c = 0; $c -lt $rows[$r].Count; $c++) { $data[$r, $c] = $rows[$r][$c] }
  }
  $sheet.Range('A3:D6').Value2 = $data
  $sheet.Range('D4:D6').Formula = '=B4/C4'           # 公式按相对位置自动填到每一行
  $sheet.Range('A7').Value2 = '合计'
  $sheet.Range('B7').Formula = '=SUM(B4:B6)'
  $sheet.Range('C7').Formula = '=SUM(C4:C6)'
  $sheet.Range('D7').Formula = '=B7/C7'

  # 表头：深色底、白色粗体、居中
  $header = $sheet.Range('A3:D3')
  $header.Interior.Color = $accent
  $header.Font.Color = Rgb 255 255 255
  $header.Font.Bold = $true
  $header.HorizontalAlignment = -4108               # -4108：居中
  $sheet.Rows.Item(3).RowHeight = 24
  # 正文：隔行浅色底；整张表浅色细边框
  $sheet.Range('A5:D5').Interior.Color = $light
  $table = $sheet.Range('A3:D7')
  $table.Borders.LineStyle = 1
  $table.Borders.Color = $lineColor
  $table.VerticalAlignment = -4108
  $sheet.Range('A4:A7').HorizontalAlignment = -4108
  $sheet.Range('A4:A7').RowHeight = 20
  # 合计行：粗体，上方一条强调色的线（边框：8 上，9 下，7 左，10 右）
  $total = $sheet.Range('A7:D7')
  $total.Font.Bold = $true
  $total.Borders.Item(8).Color = $accent
  $total.Borders.Item(8).Weight = -4138             # -4138：中等粗细

  Set-NumberFormat $sheet.Range('B4:C7') '#,##0.00;[Red]-#,##0.00'   # 千分位、两位小数，负数显示为红色
  Set-NumberFormat $sheet.Range('D4:D7') '0.0%'

  # 数据条：一眼看出大小（先删除旧的条件格式）
  $sheet.Cells.FormatConditions.Delete() | Out-Null
  $bars = $sheet.Range('B4:B6').FormatConditions.AddDatabar()
  $bars.BarColor.Color = Rgb 155 194 230

  # 列宽：按内容自动调整后再留一些空白
  for ($c = 1; $c -le 4; $c++) {
    $column = $sheet.Columns.Item($c)
    $column.AutoFit() | Out-Null
    $column.ColumnWidth = [double]$column.ColumnWidth + 4
  }

  # 冻结表头（第 3 行以上），隐藏网格线：都在工作簿的窗口上设置
  $sheet.Activate() | Out-Null
  $window = $book.Windows.Item(1)
  $window.FreezePanes = $false
  $window.SplitColumn = 0
  $window.SplitRow = 3
  $window.FreezePanes = $true
  $window.DisplayGridlines = $false

  # 簇状柱形图（51）：先删除旧的图表；参数依次为样式、图表类型、左、上、宽、高（单位为磅）
  if ($sheet.ChartObjects().Count -gt 0) { $sheet.ChartObjects().Delete() | Out-Null }
  $left = [double]$sheet.Range('F3').Left
  $top = [double]$sheet.Range('F3').Top
  $chart = $sheet.Shapes.AddChart2(201, 51, $left, $top, 380, 220).Chart
  $chart.SetSourceData($sheet.Range('A3:B6'))
  $chart.HasTitle = $true
  $chart.ChartTitle.Text = '月度销售额'
  # SeriesCollection、Axes、ChartObjects 是方法，必须带括号（VBA 可以省略，PowerShell 不行，否则报「不包含名为 NewSeries 的方法」）。
  # 添加系列：$s = $chart.SeriesCollection().NewSeries()，再设置 $s.Name、$s.Values = $sheet.Range(...)、$s.XValues
  $series = $chart.SeriesCollection(1)
  $series.Format.Fill.ForeColor.RGB = $accent        # 柱子用主题色
  $series.HasDataLabels = $true                      # 显示数据标签
  Set-NumberFormat $series.DataLabels() '#,##0'
  $chart.HasLegend = $false                          # 只有一个系列，不需要图例
  $axis = $chart.Axes(2)                             # 1：分类轴，2：数值轴
  $axis.HasTitle = $true
  $axis.AxisTitle.Text = '金额（元）'
  Set-NumberFormat $axis.TickLabels '#,##0'

  if ($exists) { $book.Save() } else { $book.SaveAs($path, 51) }   # 51：xlsx；导出 PDF：$book.ExportAsFixedFormat(0, $pdfPath)
  Write-Output "已保存 $path"
}
finally {
  if ($book) { try { $book.Close($false) } catch {} }      # 关闭工作簿（出错时不保存）
  # 丢掉脚本中引用的 Office 对象并回收，否则 Excel 退出后后台进程要等很久才结束
  $axis = $series = $chart = $window = $column = $bars = $total = $table = $header = $title = $sheet = $book = $null
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  [GC]::Collect()                  # 第二轮：回收上一轮释放出来的对象
  [GC]::WaitForPendingFinalizers()
  if ($excel.Workbooks.Count -eq 0) { $excel.Quit() }      # 只在没有其他工作簿打开时退出
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
}

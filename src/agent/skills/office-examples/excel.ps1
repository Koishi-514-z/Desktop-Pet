# Excel：打开工作簿（不存在时新建），写入数据与公式，设置格式，添加图表。
$path = 'C:\Users\me\Desktop\销售.xlsx'
function Rgb([int]$r, [int]$g, [int]$b) { $r + 256 * $g + 65536 * $b }   # Office 的颜色值：红 + 绿×256 + 蓝×65536

# 数字格式一律用这个函数设置，格式代码按英文写（如 [Red]、General）。
# PowerShell 调用 Office 时使用系统语言，直接给 NumberFormat 赋值时，中文版 Excel 只认中文写法（[红色]、G/通用格式），
# 写英文会报「不能设置类 Range 的 NumberFormat 属性」；这个函数指定按英文解释，与 Office 的语言无关
function Set-NumberFormat([object]$range, [string]$format) {
  [void][System.__ComObject].InvokeMember('NumberFormat', [System.Reflection.BindingFlags]::SetProperty, $null, $range, @($format), [System.Globalization.CultureInfo]::GetCultureInfo('en-US'))
}

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false    # 不弹出任何对话框，否则脚本会卡住
$excel.AutomationSecurity = 3    # 禁止运行文档中的宏
try {
  $exists = Test-Path $path
  $book = if ($exists) { $excel.Workbooks.Open($path) } else { $excel.Workbooks.Add() }
  $sheet = $book.Worksheets.Item(1)     # 按名称：$book.Worksheets.Item('销售')
  $sheet.Name = '销售'

  # 用二维数组一次写入一块区域：比逐个单元格写入快得多；
  # 并且在循环里给同一个属性交替赋文字和数字会出错（无法将 Int32 转换为 String）
  $rows = @(@('月份', '金额'), @('一月', 1200), @('二月', 1500.5), @('三月', 980))
  $data = New-Object 'object[,]' $rows.Count, 2
  for ($r = 0; $r -lt $rows.Count; $r++) {
    for ($c = 0; $c -lt 2; $c++) { $data[$r, $c] = $rows[$r][$c] }
  }
  $sheet.Range('A1:B4').Value2 = $data
  $sheet.Range('A5').Value2 = '合计'
  $sheet.Range('B5').Formula = '=SUM(B2:B4)'

  $header = $sheet.Range('A1:B1')
  $header.Font.Bold = $true
  $header.Interior.Color = Rgb 221 235 247
  Set-NumberFormat $sheet.Range('B2:B5') '#,##0.00;[Red]-#,##0.00'   # 千分位、两位小数，负数显示为红色；百分比如 '0.0%'
  $sheet.Range('A:B').EntireColumn.AutoFit() | Out-Null

  # 簇状柱形图（51）；参数依次为样式、图表类型、左、上、宽、高（单位为磅）
  $chart = $sheet.Shapes.AddChart2(201, 51, 150, 10, 360, 220).Chart
  $chart.SetSourceData($sheet.Range('A1:B4'))
  $chart.HasTitle = $true
  $chart.ChartTitle.Text = '季度销售'
  # SeriesCollection、Axes、ChartObjects 是方法，必须带括号（VBA 可以省略，PowerShell 不行，否则报「不包含名为 NewSeries 的方法」）。
  # 添加系列：$s = $chart.SeriesCollection().NewSeries()，再设置 $s.Name、$s.Values = $sheet.Range(...)、$s.XValues
  $chart.SeriesCollection(1).HasDataLabels = $true   # 第 1 个系列显示数据标签
  $axis = $chart.Axes(2)                             # 1：分类轴，2：数值轴
  $axis.HasTitle = $true
  $axis.AxisTitle.Text = '金额（元）'

  if ($exists) { $book.Save() } else { $book.SaveAs($path, 51) }   # 51：xlsx；导出 PDF：$book.ExportAsFixedFormat(0, $pdfPath)
  Write-Output "已保存 $path"
}
finally {
  if ($book) { try { $book.Close($false) } catch {} }      # 关闭工作簿（出错时不保存）
  if ($excel.Workbooks.Count -eq 0) { $excel.Quit() }      # 只在没有其他工作簿打开时退出
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
}

# Word：新建文档，写入标题、段落、列表、表格与页码，保存后导出 PDF。
# 修改已有文档：$doc = $word.Documents.Open($path)，改完后 $doc.Save()
$dir = 'C:\Users\me\Desktop'
# 传给 Office 的路径必须是普通字符串。不要直接传 Join-Path 等命令的结果（先用 [string] 转换），否则 Office 会卡住
$path = "$dir\会议纪要.docx"

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0          # 不弹出任何对话框，否则脚本会卡住
$word.AutomationSecurity = 3     # 禁止运行文档中的宏
try {
  $doc = $word.Documents.Add()
  $sel = $word.Selection

  $sel.Style = -2                # 内置样式用编号（中文版的样式名是中文）：-2 标题 1，-3 标题 2，-1 正文
  $sel.TypeText('会议纪要')
  $sel.TypeParagraph()
  $sel.Style = -1
  $sel.Font.Bold = $true
  $sel.TypeText('时间：')
  $sel.Font.Bold = $false
  $sel.TypeText('2026 年 11 月 24 日')
  $sel.TypeParagraph()

  $sel.Range.ListFormat.ApplyBulletDefault()     # 项目符号列表；编号列表用 ApplyNumberDefault()
  $sel.TypeText('确定发布日期')
  $sel.TypeParagraph()
  $sel.TypeText('分配测试任务')
  $sel.TypeParagraph()
  $sel.Range.ListFormat.RemoveNumbers()

  $rows = @(@('任务', '负责人'), @('测试', '小王'), @('文档', '小李'))
  $table = $doc.Tables.Add($sel.Range, $rows.Count, 2)
  $table.Borders.Enable = $true
  for ($r = 0; $r -lt $rows.Count; $r++) {
    for ($c = 0; $c -lt 2; $c++) { $table.Cell($r + 1, $c + 1).Range.Text = $rows[$r][$c] }
  }
  $table.Rows.Item(1).Range.Font.Bold = $true

  $doc.Sections.Item(1).Footers.Item(1).PageNumbers.Add(1) | Out-Null   # 页脚居中显示页码

  $doc.SaveAs2($path, 16)                                          # 16：docx
  $doc.ExportAsFixedFormat("$dir\会议纪要.pdf", 17)                # 17：PDF
  Write-Output "已保存 $path"
}
finally {
  if ($doc) { try { $doc.Close(0) } catch {} }          # 关闭文档（出错时不保存）
  if ($word.Documents.Count -eq 0) { $word.Quit() }     # 只在没有其他文档打开时退出
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}

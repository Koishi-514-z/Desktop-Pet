# Python：python-docx、openpyxl、python-pptx（对应的 Office 程序没有安装时使用）
from pathlib import Path

from docx import Document
from docx.oxml.ns import qn
from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.styles import Font, PatternFill
from pptx import Presentation

folder = Path(r'C:\Users\me\Desktop')

# Word：修改已有文档用 Document(路径)。中文需要另外设置东亚字体（先设置 font.name）
doc = Document()
normal = doc.styles['Normal']
normal.font.name = 'Calibri'
normal.element.rPr.rFonts.set(qn('w:eastAsia'), '等线')
doc.add_heading('会议纪要', level=1)
paragraph = doc.add_paragraph()
paragraph.add_run('时间：').bold = True
paragraph.add_run('2026 年 11 月 24 日')
doc.add_paragraph('确定发布日期', style='List Bullet')
table = doc.add_table(rows=3, cols=2)
table.style = 'Table Grid'
for r, row in enumerate([('任务', '负责人'), ('测试', '小王'), ('文档', '小李')]):
    for c, text in enumerate(row):
        table.cell(r, c).text = text
doc.save(folder / '会议纪要.docx')

# Excel：修改已有文件用 load_workbook(路径)。openpyxl 不会计算公式；
# 打开已有文件再保存可能丢失其中的图片与图表
book = Workbook()
sheet = book.active
sheet.title = '销售'
for row in [('月份', '金额'), ('一月', 1200), ('二月', 1500.5), ('三月', 980)]:
    sheet.append(row)
sheet['A5'] = '合计'
sheet['B5'] = '=SUM(B2:B4)'
for cell in sheet[1]:
    cell.font = Font(bold=True)
    cell.fill = PatternFill('solid', fgColor='DDEBF7')
for cell in sheet['B'][1:]:
    cell.number_format = '#,##0.00'
chart = BarChart()
chart.title = '季度销售'
chart.add_data(Reference(sheet, min_col=2, min_row=1, max_row=4), titles_from_data=True)
chart.set_categories(Reference(sheet, min_col=1, min_row=2, max_row=4))
sheet.add_chart(chart, 'D2')
book.save(folder / '销售.xlsx')

# PowerPoint：修改已有文稿用 Presentation(路径)。默认版式：0 标题幻灯片，1 标题和内容，5 仅标题，6 空白
deck = Presentation()
slide = deck.slides.add_slide(deck.slide_layouts[0])
slide.shapes.title.text = '2026 年度总结'
slide.placeholders[1].text = '市场部'
slide = deck.slides.add_slide(deck.slide_layouts[1])
slide.shapes.title.text = '主要成果'
body = slide.placeholders[1].text_frame
body.text = '销售额增长 20%'
for line in ['新增客户 120 家', '推出 3 款新产品']:
    body.add_paragraph().text = line
deck.save(folder / '年度总结.pptx')

print('已保存', folder)

# Python：python-docx、openpyxl、python-pptx（对应的 Office 程序没有安装时使用）
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor
from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.formatting.rule import DataBarRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from pptx import Presentation

folder = Path(r'C:\Users\me\Desktop')

# 配色：一份文件只用这几种颜色
ACCENT, LIGHT, LINE, MUTED = '1F4E79', 'EAF1F8', 'BFCCDB', '767676'


def set_font(style, name, size, bold=False, color='262626'):
    """设置样式的字体：中文还要另外设置东亚字体"""
    style.font.name = name
    style.element.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'), name)
    style.font.size = Pt(size)
    style.font.bold = bold
    style.font.color.rgb = RGBColor.from_string(color)


# Word：修改已有文档用 Document(路径)。间距在样式中设置（不要用空段落），标题用标题样式，要点用列表样式
doc = Document()
normal = doc.styles['Normal']
set_font(normal, '等线', 10.5)
normal.paragraph_format.line_spacing = 1.5
normal.paragraph_format.space_after = Pt(6)
set_font(doc.styles['Title'], '微软雅黑', 22, True, ACCENT)
doc.styles['Title'].paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
set_font(doc.styles['Heading 1'], '微软雅黑', 14, True, ACCENT)
doc.styles['Heading 1'].paragraph_format.space_before = Pt(18)

doc.add_heading('产品发布会议纪要', level=0)
subtitle = doc.add_paragraph('2026年11月24日 · 产品部 · 记录人：小李')
subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
subtitle.runs[0].font.color.rgb = RGBColor.from_string(MUTED)
doc.add_heading('讨论事项', level=1)
for item in ['确定发布日期', '分配测试任务']:
    doc.add_paragraph(item, style='List Number')
doc.add_heading('任务分工', level=1)
rows = [('任务', '负责人', '截止日期'), ('测试', '小王', '12月10日'), ('文档', '小李', '12月12日')]
table = doc.add_table(rows=len(rows), cols=3)
table.style = 'Medium Shading 1 Accent 1'   # 内置表格样式：深色表头、隔行底色、边框
for r, row in enumerate(rows):
    for c, text in enumerate(row):
        paragraph = table.cell(r, c).paragraphs[0]
        run = paragraph.add_run(text)
        paragraph.paragraph_format.space_after = Pt(0)     # 表格中不用正文的段后间距与 1.5 倍行距
        paragraph.paragraph_format.line_spacing = 1
        if r == 0:
            run.font.color.rgb = RGBColor.from_string('FFFFFF')
doc.sections[0].header.paragraphs[0].text = '产品发布会议纪要'
doc.save(folder / '会议纪要.docx')

# Excel：修改已有文件用 load_workbook(路径)。openpyxl 不会计算公式（在 Excel 中打开后才有结果）；
# 打开已有文件再保存可能丢失其中的图片与图表
book = Workbook()
sheet = book.active
sheet.title = '销售'
sheet['A1'] = '2026 年第一季度销售'
sheet['A1'].font = Font(name='微软雅黑', size=16, bold=True, color=ACCENT)
sheet.merge_cells('A1:D1')
sheet['A2'] = '单位：元'
sheet['A2'].font = Font(name='微软雅黑', size=10, color=MUTED)
for row in [('月份', '销售额', '目标', '完成率'), ('一月', 1200, 1000), ('二月', 1500.5, 1600), ('三月', 980, 1200)]:
    sheet.append(row)
for r in range(4, 7):
    sheet[f'D{r}'] = f'=B{r}/C{r}'
sheet.append(('合计', '=SUM(B4:B6)', '=SUM(C4:C6)', '=B7/C7'))

thin = Side(style='thin', color=LINE)
for r, cells in enumerate(sheet['A3:D7'], start=3):
    for cell in cells:
        cell.font = Font(name='微软雅黑', size=10, bold=r in (3, 7), color='FFFFFF' if r == 3 else '262626')
        cell.border = Border(left=thin, right=thin, top=Side(style='medium', color=ACCENT) if r == 7 else thin, bottom=thin)
        cell.alignment = Alignment(horizontal='center' if r == 3 or cell.column == 1 else None, vertical='center')
        if r == 3:
            cell.fill = PatternFill('solid', fgColor=ACCENT)    # 表头：深色底、白色粗体
        elif r == 5:
            cell.fill = PatternFill('solid', fgColor=LIGHT)     # 隔行底色
        if cell.column in (2, 3) and r > 3:
            cell.number_format = '#,##0.00'
        elif cell.column == 4 and r > 3:
            cell.number_format = '0.0%'
for column, width in zip('ABCD', (10, 14, 14, 10)):
    sheet.column_dimensions[column].width = width
sheet.row_dimensions[1].height = 30
sheet.row_dimensions[3].height = 24
sheet.conditional_formatting.add('B4:B6', DataBarRule(start_type='min', end_type='max', color='9BC2E6'))
sheet.freeze_panes = 'A4'                  # 冻结表头
sheet.sheet_view.showGridLines = False     # 隐藏网格线

chart = BarChart()
chart.title = '月度销售额'
chart.y_axis.title = '金额（元）'
chart.legend = None                        # 只有一个系列，不需要图例
chart.x_axis.delete = chart.y_axis.delete = False   # 新版 openpyxl 默认隐藏坐标轴，要显式显示
chart.y_axis.number_format = '#,##0'
chart.add_data(Reference(sheet, min_col=2, min_row=3, max_row=6), titles_from_data=True)
chart.set_categories(Reference(sheet, min_col=1, min_row=4, max_row=6))
chart.series[0].graphicalProperties.solidFill = ACCENT
sheet.add_chart(chart, 'F3')
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

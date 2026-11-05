import ExcelJS from 'exceljs';
import type { ExamReport, QuestionKind } from '../shared/types.ts';

const KIND_LABEL: Record<QuestionKind, string> = {
  choice: '单选题',
  multi: '多选题',
  fill: '填空题',
  equation: '方程式/公式',
  calc: '计算题',
  short: '简答题',
};

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF2F4F7' },
};

const THIN: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFD9DEE7' } },
  left: { style: 'thin', color: { argb: 'FFD9DEE7' } },
  bottom: { style: 'thin', color: { argb: 'FFD9DEE7' } },
  right: { style: 'thin', color: { argb: 'FFD9DEE7' } },
};

/** 学号自然序（1001 < 1002 < 1010），没有学号的排最后 */
function byStudentNo(a: { studentNo: string; studentName: string }, b: { studentNo: string; studentName: string }) {
  const x = a.studentNo || 'zzzz';
  const y = b.studentNo || 'zzzz';
  const c = x.localeCompare(y, 'zh-CN', { numeric: true });
  return c !== 0 ? c : a.studentName.localeCompare(b.studentName, 'zh-CN');
}

function styleHeader(row: ExcelJS.Row) {
  row.height = 22;
  row.eachCell((cell) => {
    cell.font = { bold: true, size: 10, color: { argb: 'FF3D434E' } };
    cell.fill = HEADER_FILL;
    cell.border = THIN;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
}

export async function buildReportWorkbook(report: ExamReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'paper-ai';
  wb.created = new Date();

  const rows = [...report.rows].sort(byStudentNo);
  const questions = report.questions;

  /* ------------------------------ 成绩单 ------------------------------ */
  const sheet = wb.addWorksheet('成绩单', {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { defaultRowHeight: 18 },
  });

  const header = ['名次', '学号', '姓名', ...questions.map((q) => `第${q.no}题\n(${q.maxScore}分)`), '总分', '得分率%', '等级', '待复核'];
  sheet.addRow(header);
  styleHeader(sheet.getRow(1));

  for (const r of rows) {
    const values: (string | number)[] = [
      r.rank,
      r.studentNo,
      r.studentName,
      ...questions.map((q) => r.scores[q.id] ?? ''),
      Number(r.total.toFixed(1)),
      Number((r.rate * 100).toFixed(1)),
      r.grade,
      r.needsReview,
    ];
    const row = sheet.addRow(values);
    row.eachCell((cell) => {
      cell.border = THIN;
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    // 0 分标红
    questions.forEach((q, i) => {
      const cell = row.getCell(4 + i);
      if (r.scores[q.id] === 0) cell.font = { color: { argb: 'FFC0392B' } };
    });
    const reviewCell = row.getCell(header.length);
    if (r.needsReview > 0) reviewCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDF3E2' } };
    if (r.grade === '优秀') row.getCell(header.length - 1).font = { color: { argb: 'FF0F7B4F' }, bold: true };
  }

  sheet.columns = [
    { width: 6 },
    { width: 13 },
    { width: 12 },
    ...questions.map(() => ({ width: 8 })),
    { width: 9 },
    { width: 10 },
    { width: 8 },
    { width: 9 },
  ];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: header.length } };

  /* ----------------------------- 分题明细 ----------------------------- */
  const detail = wb.addWorksheet('分题明细', {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { defaultRowHeight: 18 },
  });
  detail.addRow(['学号', '姓名', '题号', '题型', '满分', '得分', '评语', '待复核']);
  styleHeader(detail.getRow(1));

  for (const r of rows) {
    for (const q of questions) {
      const g = r.scores[q.id];
      const reviewCell = (g ?? 0) === 0 && (r.comments[q.id] ?? '').includes('复核');
      detail.addRow([
        r.studentNo,
        r.studentName,
        q.no,
        KIND_LABEL[q.kind] ?? q.kind,
        q.maxScore,
        g ?? '',
        r.comments[q.id] ?? '',
        reviewCell ? '是' : '',
      ]);
    }
  }
  detail.eachRow((row, idx) => {
    if (idx === 1) return;
    row.eachCell((cell) => {
      cell.border = THIN;
      cell.alignment = { vertical: 'middle' };
    });
    row.getCell(6).alignment = { horizontal: 'center', vertical: 'middle' };
  });
  detail.getColumn(7).alignment = { vertical: 'middle', wrapText: true };
  detail.columns = [
    { width: 13 },
    { width: 12 },
    { width: 8 },
    { width: 12 },
    { width: 7 },
    { width: 7 },
    { width: 46 },
    { width: 8 },
  ];

  /* ------------------------------- 统计 ------------------------------- */
  const stats = wb.addWorksheet('统计', { properties: { defaultRowHeight: 18 } });
  const s = report.stats;
  stats.addRow(['指标', '数值']);
  styleHeader(stats.getRow(1));
  const statRows: [string, string | number][] = [
    ['考试', report.exam.name],
    ['班级', report.exam.grade || '—'],
    ['参考人数', s.count],
    ['满分', report.fullScore],
    ['平均分', Number(s.avg.toFixed(1))],
    ['中位数', s.median],
    ['最高分', s.max],
    ['最低分', s.min],
    ['标准差', Number(s.stddev.toFixed(1))],
    [`及格率（≥${s.passLine}%）`, `${s.passRate.toFixed(0)}%`],
    [`优秀率（≥${s.excellentLine}%）`, `${s.excellentRate.toFixed(0)}%`],
    ['导出时间', new Date().toLocaleString('zh-CN')],
  ];
  for (const [k, v] of statRows) {
    const row = stats.addRow([k, v]);
    row.getCell(1).font = { color: { argb: 'FF6B7280' } };
    row.eachCell((cell) => {
      cell.border = THIN;
    });
  }

  stats.addRow([]);
  stats.addRow(['各题得分率', '平均得分', '满分', '待复核']);
  styleHeader(stats.getRow(stats.rowCount));
  for (const q of report.questionStats) {
    const row = stats.addRow([`第${q.no}题`, Number(q.avgScore.toFixed(1)), q.maxScore, q.needsReviewCount]);
    row.eachCell((cell) => {
      cell.border = THIN;
      cell.alignment = { horizontal: 'center' };
    });
    row.getCell(1).alignment = { horizontal: 'left' };
    const rate = q.rate;
    row.getCell(1).value = `第${q.no}题（${rate.toFixed(0)}%）`;
  }
  stats.columns = [{ width: 26 }, { width: 14 }, { width: 10 }, { width: 10 }];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

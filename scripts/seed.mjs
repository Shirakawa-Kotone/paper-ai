#!/usr/bin/env node
/**
 * 造一套演示数据：一场考试 + 12 份答题卡 + 识别 + 批改。
 * 需要先启动 mock 模型服务（不需要真 API Key）：
 *
 *   终端 1:  node scripts/mock-provider.mjs --port 8799
 *   终端 2:  npm start
 *   终端 3:  node scripts/seed.mjs --exam demo
 *
 * 注意：演示数据写进当前 data 目录，正式使用前请删掉 data/ 或换 PAPER_AI_DATA。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const args = process.argv.slice(2);
const getArg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const BASE = getArg('api', 'http://127.0.0.1:8787') + '/api';
const MOCK = getArg('mock', 'http://127.0.0.1:8799/v1');
const PDF = path.resolve(getArg('pdf', 'data/demo-sheet.pdf'));

const H = { 'Content-Type': 'application/json' };
const call = async (p, init) => {
  const res = await fetch(BASE + p, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${p} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
};

const waitJob = async (id) => {
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const st = await call(`/jobs/${id}`);
    if (st.status !== 'running') return st;
  }
  throw new Error('任务超时');
};

const NAMES = ['陈思远', '林悦', '王浩', '李梦琪', '赵一鸣', '周雨桐', '吴嘉诚', '郑可欣'];

/* 1. 生成一份"已作答"的答题卡 PDF（模拟扫描件）；variant 用来制造分数差异 */
async function makeFilledPdf(examId, studentName, studentNo, variant) {
  const layout = await call(`/exams/${examId}/template`);
  const { renderSheet, imagesToPdf } = await import('../server/renderSheet.ts');
  const { buildLayout } = await import('../server/template.ts');
  const detail = await call(`/exams/${examId}`);
  const layout2 = buildLayout({
    id: detail.id,
    name: detail.name,
    grade: detail.grade,
    questions: detail.questions,
  });
  const pages = renderSheet(layout2);
  const px = 200 / 25.4;
  const samples = {
    choice: 'B',
    fill: 'BaCl2',
    equation: 'MnO2 + 4HCl(浓) = MnCl2 + Cl2↑ + 2H2O',
    calc: 'pH = -lg(0.1) = 1',
    short: '先加稀盐酸酸化，再加 BaCl2 溶液，产生白色沉淀则含 SO4²⁻',
  };

  const out = [];
  for (const [i, page] of pages.entries()) {
    const canvas = createCanvas(page.width, page.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(await loadImage(page.jpeg), 0, 0);
    ctx.fillStyle = '#17307a';
    ctx.font = '34px "Songti SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(studentName, 36 * px, 47 * px);
    ctx.fillText(studentNo, 126 * px, 47 * px);

    for (const box of layout2.pages[i].boxes) {
      const qi = layout2.pages[i].boxes.indexOf(box);
      // 用 variant + 题序制造差异：有的题不做、有的题做错
      const skip = (variant + qi) % 4 === 0;
      if (skip) continue;

      if (box.qkind === 'choice') {
        const correct = detail.questions.find((q) => q.id === box.qid)?.answer || 'B';
        const wrong = (variant + qi) % 5 === 0;
        const letter = wrong ? (correct === 'A' ? 'B' : 'A') : correct;
        ctx.fillStyle = '#17307a';
        ctx.font = '600 30px "Songti SC", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(letter, (box.x + box.w / 2) * px, (box.y + box.h / 2 + 0.6) * px);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
      } else {
        const text = samples[box.qkind] ?? '';
        if (!text) continue;
        ctx.fillStyle = '#17307a';
        ctx.font = '26px "Songti SC", "Microsoft YaHei", sans-serif';
        let line = '';
        let ty = box.y + 5.5;
        for (const ch of text) {
          if (ctx.measureText(line + ch).width > (box.w - 6) * px) {
            ctx.fillText(line, (box.x + 3) * px, ty * px);
            ty += 7;
            line = ch;
          } else line += ch;
        }
        if (line) ctx.fillText(line, (box.x + 3) * px, ty * px);
      }
    }
    out.push({ jpeg: canvas.toBuffer('image/jpeg', 90), widthPt: page.widthPt, heightPt: page.heightPt });
  }
  void layout;
  const pdf = imagesToPdf(out);
  await fs.mkdir(path.dirname(PDF), { recursive: true });
  await fs.writeFile(PDF, pdf);
  return pdf;
}

async function main() {
  console.log('→ 配置模型为本地 mock');
  await call('/settings/ai', {
    method: 'PUT',
    headers: H,
    body: JSON.stringify({
      provider: 'custom',
      baseURL: MOCK,
      apiKey: 'mock',
      textModel: 'mock-text',
      visionModel: 'mock-vision',
      concurrency: 3,
    }),
  });

  console.log('→ 创建考试');
  const exam = await call('/exams', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ name: '高二化学 · 物质结构与性质单元测', grade: '高二(3)班' }),
  });

  const questions = [
    { no: '1', kind: 'choice', maxScore: 4, answer: 'B', rubric: '选对得 4 分' },
    { no: '2', kind: 'choice', maxScore: 4, answer: 'B', rubric: '选对得 4 分' },
    { no: '3', kind: 'fill', maxScore: 5, answer: 'BaCl2', rubric: '试剂正确 5 分' },
    { no: '4', kind: 'equation', maxScore: 6, answer: 'MnO2 + 4HCl(浓) = MnCl2 + Cl2↑ + 2H2O', rubric: '化学式 3 分，配平 2 分，条件 1 分' },
    { no: '5', kind: 'short', maxScore: 8, answer: '取少量溶液，加稀盐酸酸化，再加 BaCl2 溶液，产生白色沉淀则含 SO4²⁻', rubric: '酸化 2 分，试剂 3 分，现象 3 分' },
    { no: '6', kind: 'calc', maxScore: 6, answer: 'pH=-lg(0.1)=1', rubric: '公式 3 分，结果 3 分' },
  ];
  await call(`/exams/${exam.id}/questions`, {
    method: 'PUT',
    headers: H,
    body: JSON.stringify({ questions }),
  });
  console.log(`   ${exam.id}`);

  console.log('→ 生成 8 份不同学生、不同作答的答题卡');
  const fd = new FormData();
  for (let i = 0; i < NAMES.length; i++) {
    const pdf = await makeFilledPdf(exam.id, NAMES[i], `2026${String(310 + i).padStart(4, '0')}`, i);
    fd.append('files', new Blob([pdf], { type: 'application/pdf' }), `${String(i + 1).padStart(2, '0')}-${NAMES[i]}.pdf`);
  }
  const up = await call(`/exams/${exam.id}/sheets`, { method: 'POST', body: fd });

  console.log('→ 识别');
  const rjob = await call(`/exams/${exam.id}/recognize`, { method: 'POST', headers: H, body: '{}' });
  const rst = await waitJob(rjob.job.id);
  console.log(`   ${rst.status}，${rst.done}/${rst.total}`);

  // mock 模型读不出图上的姓名，这里按文件名回填，让演示数据看起来像真的
  // （真实环境里姓名由视觉模型从表头裁切图识别）
  const detail = await call(`/exams/${exam.id}`);
  for (const [i, sheet] of detail.sheets.entries()) {
    const m = String(sheet.fileName).match(/^\d+-(.+)\.pdf$/);
    await call(`/sheets/${sheet.id}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({
        studentName: m ? m[1] : sheet.studentName,
        studentNo: `2026${String(310 + i).padStart(4, '0')}`,
      }),
    });
  }

  // mock 模型读不出手写字母，按"打印时填的答案"回填选择题，模拟识别结果
  for (const [si, sheet] of detail.sheets.entries()) {
    for (const [qi, q] of detail.questions.entries()) {
      if (q.kind !== 'choice') continue;
      const skip = (si + qi) % 4 === 0;
      const wrong = (si + qi) % 5 === 0;
      const correct = q.answer || 'B';
      const letter = skip ? '' : wrong ? (correct === 'A' ? 'B' : 'A') : correct;
      await call(`/sheets/${sheet.id}/answers/${q.id}`, {
        method: 'PATCH',
        headers: H,
        body: JSON.stringify({ content: letter }),
      });
    }
  }

  console.log('→ 批改');
  const gjob = await call(`/exams/${exam.id}/grade`, { method: 'POST', headers: H, body: '{}' });
  const gst = await waitJob(gjob.job.id);
  console.log(`   ${gst.status}，${gst.done}/${gst.total}`);

  const report = await call(`/exams/${exam.id}/report`);
  console.log(`\n完成：${report.rows.length} 人，平均 ${report.stats.avg.toFixed(1)} 分，待复核 ${report.reviewQueue.length} 处`);
  console.log(`打开： http://127.0.0.1:${new URL(BASE).port}/#/exam/${exam.id}/questions`);
  void up;
}

main().catch((err) => {
  console.error('\n失败：', err.message);
  console.error('请确认 npm start 与 node scripts/mock-provider.mjs 都在运行。');
  process.exit(1);
});

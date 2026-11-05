#!/usr/bin/env node
/**
 * 答题卡裁切自检：拿一张真实的扫描件跑一遍定位，看看四角定位块能不能找到。
 *
 *   node scripts/diagnose.mjs 扫描件.pdf
 *   node scripts/diagnose.mjs 扫描件.jpg
 *
 * 输出：控制台报告 + data/diagnose/overlay.png（红圈=识别到的定位块，绿框=裁切区域）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { detectMarkers, homography, loadRaster, mapPt } from '../server/crop.ts';
import { buildLayout } from '../server/template.ts';
import { renderPages } from '../server/pdf.ts';
import { initDB, listExams, listQuestions, getExamRow } from '../server/db.ts';

const file = process.argv[2];
if (!file) {
  console.error('用法：node scripts/diagnose.mjs <扫描件.pdf|图片.jpg>');
  process.exit(1);
}

const ROOT = path.resolve(import.meta.dirname, '..');
const dataDir = path.resolve(process.env.PAPER_AI_DATA ?? path.join(ROOT, 'data'));
const outDir = path.join(dataDir, 'diagnose');
fs.mkdirSync(outDir, { recursive: true });

const buffer = fs.readFileSync(file);
const isPdf = /\.pdf$/i.test(file);
const images = isPdf
  ? await renderPages(buffer, { maxPages: 1, maxSide: 2400, quality: 90 })
  : [{ jpeg: buffer, index: 1, width: 0, height: 0, base64: '' }];

if (!images.length) {
  console.error('无法读取文件');
  process.exit(1);
}

const raster = await loadRaster(images[0].jpeg, 2400);
const started = Date.now();
const markers = detectMarkers(raster);
const ms = Date.now() - started;

console.log('');
console.log(`文件      ${path.basename(file)}`);
console.log(`页面尺寸  ${raster.width} × ${raster.height} px`);
console.log(`检测耗时  ${ms} ms`);
console.log('');

if (!markers) {
  console.log('✗ 没有检测到四个角标。\n');
  console.log('可能原因：');
  console.log('  · 打印时裁掉了边框（角标在边框内侧 8mm 处，不能贴边裁）');
  console.log('  · 墨太淡 / 扫描曝光过度，角标没成实心块');
  console.log('  · 只扫了答题卡的一部分，四个角不在画面里');
  console.log('  · 分辨率过低（建议 ≥ 150dpi）');
  console.log('\n系统会回退成"整页交给视觉模型"，仍能识别，但更慢也更贵。');
  process.exit(2);
}

console.log('✓ 找到 4 个定位块：');
const names = ['左上', '右上', '右下', '左下'];
markers.forEach((m, i) => console.log(`  ${names[i]}  (${m.x.toFixed(1)}, ${m.y.toFixed(1)})`));

// 优先用真实考试的版式；没有就退化成一个示意版式（角标位置与题目无关）
let layout;
const examArg = (() => {
  const i = process.argv.indexOf('--exam');
  return i >= 0 ? process.argv[i + 1] : null;
})();
try {
  initDB(dataDir);
  const examId = examArg ?? listExams()[0]?.id;
  const exam = examId ? getExamRow(examId) : null;
  if (exam) {
    layout = buildLayout({ id: exam.id, name: exam.name, grade: exam.grade, questions: listQuestions(exam.id) });
    console.log(`使用版式  ${exam.name}（${layout.pages[0].boxes.length} 题）`);
  }
} catch (err) {
  console.log('读取考试版式失败，改用示意版式：', err.message);
}
if (!layout) {
  layout = buildLayout({
    id: 'diagnose',
    name: '示意版式',
    grade: '',
    questions: Array.from({ length: 10 }, (_, i) => ({
      id: `q${i}`,
      examId: 'd',
      no: String(i + 1),
      kind: 'short',
      maxScore: 5,
      answer: '',
      rubric: '',
      sort: i,
    })),
  });
  console.log('使用示意版式：绿框位置可能与你的答题卡不同，只看红圈是否套住四个角标。');
}

const H = homography(layout.pages[0].markers.map((m) => ({ x: m.x, y: m.y })), markers);
if (!H) {
  console.error('✗ 单应性矩阵求解失败（四个点可能几乎共线）');
  process.exit(3);
}

// 残差：把理论角标映射回去，和检测值比
let maxErr = 0;
layout.pages[0].markers.forEach((m, i) => {
  const p = mapPt(H, { x: m.x, y: m.y });
  maxErr = Math.max(maxErr, Math.hypot(p.x - markers[i].x, p.y - markers[i].y));
});

const expected = raster.width / 210; // 每毫米像素
console.log('');
console.log(`校正残差  ${maxErr.toFixed(2)} px（约 ${(maxErr / expected).toFixed(2)} mm）`);
console.log(`判定      ${maxErr < expected * 3 ? '✓ 几何校正正常' : '! 残差偏大，可能是扫描畸变或角标污损'}`);

// 画 overlay
const canvas = createCanvas(raster.width, raster.height);
const ctx = canvas.getContext('2d');
ctx.drawImage(await loadImage(images[0].jpeg), 0, 0, raster.width, raster.height);

ctx.strokeStyle = '#e11d48';
ctx.lineWidth = Math.max(2, raster.width / 500);
for (const m of markers) {
  ctx.beginPath();
  ctx.arc(m.x, m.y, raster.width / 60, 0, Math.PI * 2);
  ctx.stroke();
}

ctx.strokeStyle = '#16a34a';
ctx.lineWidth = Math.max(1.5, raster.width / 900);
for (const box of layout.pages[0].boxes) {
  const pts = [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ].map((p) => mapPt(H, p));
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.closePath();
  ctx.stroke();
}

const overlay = path.join(outDir, 'overlay.png');
fs.writeFileSync(overlay, canvas.toBuffer('image/png'));
console.log('');
console.log(`示意图    ${overlay}`);
console.log('红圈是识别到的角标，绿框是按版式推算的作答区。绿框应落在此次打印的答题框附近。');

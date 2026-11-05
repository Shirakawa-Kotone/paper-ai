import type { Question, Sheet } from '../shared/types.ts';
import { components, cropPixels, labelDark, loadRaster, MAX_SOURCE_SIDE, type Comp, type Raster } from './crop.ts';
import { renderPages } from './pdf.ts';
import { CROP_W, saveCrop, transcribeCrops, type CropPart } from './cropOcr.ts';
import type { PipelineDeps, RecognizeOutcome } from './pipeline.ts';

/**
 * 通用答题卡（年级组下发、没有定位块）的版面分析。
 *
 * 能识别两类版式特征：
 *   1. 选择题：一排空心小方框（□ A □ B …），用于涂卡；
 *   2. 主观题：成组的横线（作答区）。
 *
 * 找到区域后按"从上到下"的顺序分配给同类型的题目。数量对不上时降置信度，
 * 让它们进人工复核——不猜。
 */

export type Rect = { x: number; y: number; w: number; h: number };

export type OptionBox = Rect & { option: string; ink: number };
export type ChoiceRow = { box: Rect; options: OptionBox[]; y: number };
export type WritingBlock = { box: Rect; lineCount: number };

export type GridBand = { y0: number; y1: number };
export type ChoiceGrid = {
  numberBand: GridBand;
  answerBand: GridBand;
  columns: { x0: number; x1: number }[];
};

export type GenericLayout = {
  width: number;
  height: number;
  mm: number;
  choiceRows: ChoiceRow[];
  choiceGrids: ChoiceGrid[];
  writingBlocks: WritingBlock[];
  header?: Rect;
};

const OPTION_MIN_MM = 2.2;
const OPTION_MAX_MM = 9;
const ROW_TOL_MM = 3.2;
const LINE_MAX_H_MM = 3;
const LINE_MIN_W_MM = 28;
const LINE_GAP_MM = 2.6;
const BLOCK_GAP_MM = 16;

/** 找出"空心小方框"——选择题选项 */
function detectOptionBoxes(raster: Raster, mm: number): Comp[] {
  const mask = labelDark(raster.data, raster.width, raster.height, 165);
  const comps = components(mask, raster.width, raster.height);
  return comps.filter((c) => {
    const w = (c.x1 - c.x0 + 1) / mm;
    const h = (c.y1 - c.y0 + 1) / mm;
    if (w < OPTION_MIN_MM || w > OPTION_MAX_MM) return false;
    if (h < OPTION_MIN_MM || h > OPTION_MAX_MM) return false;
    if (Math.max(w, h) / Math.min(w, h) > 1.9) return false;
    const fill = c.area / ((c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1));
    return fill > 0.04 && fill < 0.72;
  });
}

/** 同一水平线上的方框归为一行 */
function groupOptionRows(boxes: Comp[], mm: number): ChoiceRow[] {
  const rows: { y: number; items: Comp[] }[] = [];
  for (const b of [...boxes].sort((a, b) => a.y0 - b.y0)) {
    const cy = (b.y0 + b.y1) / 2;
    const row = rows.find((r) => Math.abs(r.y - cy) <= ROW_TOL_MM * mm);
    if (row) row.items.push(b);
    else rows.push({ y: cy, items: [b] });
  }

  const out: ChoiceRow[] = [];
  const letters = 'ABCDEFGH';
  for (const row of rows) {
    if (row.items.length < 3) continue;
    const items = row.items.sort((a, b) => a.x0 - b.x0);
    // 相邻两个框的间距要合理，避免把散落的框凑成一行
    const gaps = items.slice(1).map((b, i) => b.x0 - items[i].x1);
    const avgGap = gaps.reduce((a, g) => a + g, 0) / gaps.length;
    if (avgGap > 22 * mm || avgGap < 0.4 * mm) continue;

    const x0 = Math.min(...items.map((b) => b.x0));
    const x1 = Math.max(...items.map((b) => b.x1));
    const y0 = Math.min(...items.map((b) => b.y0));
    const y1 = Math.max(...items.map((b) => b.y1));
    out.push({
      y: row.y,
      box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      options: items.slice(0, 8).map((b, i) => ({
        option: letters[i] ?? String(i + 1),
        x: b.x0,
        y: b.y0,
        w: b.x1 - b.x0,
        h: b.y1 - b.y0,
        ink: -1,
      })),
    });
  }
  return out.sort((a, b) => a.y - b.y);
}

/**
 * 版式里真正的选项行会重复出现（每道选择题一行，x 坐标几乎一样）。
 * 用这个特征过滤掉表头文字、零散方框之类的假阳性。
 */
function filterRepeatingRows(rows: ChoiceRow[], mm: number): ChoiceRow[] {
  if (rows.length <= 4) return rows;

  const clusters: { ref: ChoiceRow; members: ChoiceRow[] }[] = [];
  for (const row of rows) {
    const hit = clusters.find(
      (c) =>
        c.ref.options.length === row.options.length &&
        c.ref.options.every((o, i) => Math.abs(o.x - row.options[i].x) <= 4 * mm),
    );
    if (hit) hit.members.push(row);
    else clusters.push({ ref: row, members: [row] });
  }

  const repeating = clusters.filter((c) => c.members.length >= 3);
  const kept = (repeating.length ? repeating : [clusters.sort((a, b) => b.members.length - a.members.length)[0]])
    .flatMap((c) => c.members)
    .sort((a, b) => a.y - b.y);
  return kept;
}

/** 找长横线，并合并断裂的同一行 */
function detectLines(raster: Raster, mm: number): { x0: number; x1: number; y: number }[] {
  const mask = labelDark(raster.data, raster.width, raster.height, 208);
  const comps = components(mask, raster.width, raster.height);
  const lines = comps
    .map((c) => ({ x0: c.x0, x1: c.x1, y: (c.y0 + c.y1) / 2, h: c.y1 - c.y0 + 1, w: c.x1 - c.x0 + 1 }))
    .filter((c) => c.h <= LINE_MAX_H_MM * mm && c.w >= LINE_MIN_W_MM * mm)
    .sort((a, b) => a.y - b.y || a.x0 - b.x0);

  const merged: { x0: number; x1: number; y: number }[] = [];
  for (const line of lines) {
    const prev = merged.find((m) => Math.abs(m.y - line.y) <= LINE_GAP_MM * mm && line.x0 - m.x1 < 8 * mm && line.x0 >= m.x0 - 4 * mm);
    if (prev) {
      prev.x1 = Math.max(prev.x1, line.x1);
      prev.x0 = Math.min(prev.x0, line.x0);
      prev.y = (prev.y + line.y) / 2;
    } else {
      merged.push({ x0: line.x0, x1: line.x1, y: line.y });
    }
  }
  return merged;
}

/** 把邻近的横线聚成一块作答区（题目之间通常有一段更大的空白） */
function groupWritingBlocks(lines: { x0: number; x1: number; y: number }[], mm: number): WritingBlock[] {
  const sorted = [...lines].sort((a, b) => a.y - b.y);

  // 先量一下"同一题内部"的典型行距
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].y - sorted[i - 1].y;
    const overlap = Math.min(sorted[i - 1].x1, sorted[i].x1) - Math.max(sorted[i - 1].x0, sorted[i].x0);
    if (gap > 0 && overlap > 0) gaps.push(gap);
  }
  const medianGap = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 10 * mm;
  const splitGap = Math.max(BLOCK_GAP_MM * mm, medianGap * 2.1);

  const blocks: { lines: { x0: number; x1: number; y: number }[] }[] = [];
  for (const line of sorted) {
    const target = blocks.find((b) => {
      const last = b.lines[b.lines.length - 1];
      const gap = line.y - last.y;
      const overlap = Math.min(b.lines[0].x1, line.x1) - Math.max(b.lines[0].x0, line.x0);
      const need = Math.min(b.lines[0].x1 - b.lines[0].x0, line.x1 - line.x0) * 0.5;
      return gap > 2 * mm && gap <= splitGap && overlap > need;
    });
    if (target) target.lines.push(line);
    else blocks.push({ lines: [line] });
  }

  return blocks
    .filter((b) => b.lines.length >= 2)
    .map((b) => {
      const x0 = Math.min(...b.lines.map((l) => l.x0));
      const x1 = Math.max(...b.lines.map((l) => l.x1));
      const y0 = Math.min(...b.lines.map((l) => l.y));
      const y1 = Math.max(...b.lines.map((l) => l.y));
      return {
        lineCount: b.lines.length,
        box: { x: x0 - 2 * mm, y: y0 - 5 * mm, w: x1 - x0 + 4 * mm, h: y1 - y0 + 11 * mm },
      };
    })
    .sort((a, b) => a.box.y - b.box.y);
}

/** 表头：页面顶部整条（姓名/班级/考号通常在这） */
function headerRect(raster: Raster, firstRegionY: number): Rect {
  const bottom = Math.min(firstRegionY - 2 * (raster.width / 210), raster.height * 0.16);
  return { x: 0, y: 0, w: raster.width, h: Math.max(raster.height * 0.06, bottom) };
}

function inkRatio(raster: Raster, box: Rect, shrink = 0.18): number {
  const sx = Math.round(box.x + box.w * shrink);
  const sy = Math.round(box.y + box.h * shrink);
  const ex = Math.round(box.x + box.w * (1 - shrink));
  const ey = Math.round(box.y + box.h * (1 - shrink));
  let dark = 0;
  let total = 0;
  for (let y = Math.max(0, sy); y < Math.min(raster.height, ey); y++) {
    for (let x = Math.max(0, sx); x < Math.min(raster.width, ex); x++) {
      const o = (y * raster.width + x) * 4;
      const l = 0.299 * raster.data[o] + 0.587 * raster.data[o + 1] + 0.114 * raster.data[o + 2];
      total++;
      if (l < 145) dark++;
    }
  }
  return total ? dark / total : 0;
}

/* ------------------------- 表格型：题号行 + 答案行 ------------------------- */

/** 用投影法找整行横线（表格边框即使连通成一个大块也能找到） */
function horizontalRules(raster: Raster): number[] {
  const xa = Math.round(raster.width * 0.05);
  const xb = Math.round(raster.width * 0.95);
  const step = Math.max(1, Math.round((xb - xa) / 700));
  const rules: number[] = [];
  let run: number[] = [];

  for (let y = 0; y < raster.height; y++) {
    let dark = 0;
    let total = 0;
    for (let x = xa; x < xb; x += step) {
      const o = (y * raster.width + x) * 4;
      const l = 0.299 * raster.data[o] + 0.587 * raster.data[o + 1] + 0.114 * raster.data[o + 2];
      total++;
      if (l < 205) dark++;
    }
    if (total && dark / total > 0.55) run.push(y);
    else if (run.length) {
      rules.push(run[Math.floor(run.length / 2)]);
      run = [];
    }
  }
  if (run.length) rules.push(run[Math.floor(run.length / 2)]);
  return rules;
}

/** 判断一条行带是不是"题号行"：一排间距均匀的小号印刷数字 */
function isNumberBand(raster: Raster, band: GridBand, mm: number): number[] | null {
  // 题号是细笔画的印刷体，低分辨率下会被抗锯齿冲淡，用较高的阈值才连得起来
  const mask = labelDark(raster.data, raster.width, raster.height, 225);
  const comps = components(mask, raster.width, raster.height).filter((c) => {
    const h = (c.y1 - c.y0 + 1) / mm;
    const w = (c.x1 - c.x0 + 1) / mm;
    if (h < 1.2 || h > 9 || w < 0.4 || w > 12) return false;
    const cy = (c.y0 + c.y1) / 2;
    return cy > band.y0 + 1.2 * mm && cy < band.y1 - 1.2 * mm;
  });
  if (comps.length < 4) return null;

  const centers = comps
    .map((c) => (c.x0 + c.x1) / 2)
    .sort((a, b) => a - b);
  const gaps = centers.slice(1).map((c, i) => c - centers[i]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (mean < 5 * mm || mean > 30 * mm) return null;
  const variance = gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length;
  const cv = Math.sqrt(variance) / mean;
  if (cv > 0.45) return null;
  const span = centers[centers.length - 1] - centers[0];
  if (span < raster.width * 0.4) return null;

  // 按中位间距拟合成均匀栅格，顺手丢掉零星噪点（比如边框碎片）
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)];
  if (medianGap <= 0) return null;
  const count = Math.round(span / medianGap) + 1;
  if (count < 4 || Math.abs(count - centers.length) > Math.max(2, centers.length * 0.2)) return null;
  const start = (centers[0] + centers[centers.length - 1] - medianGap * (count - 1)) / 2;
  return Array.from({ length: count }, (_, i) => start + i * medianGap);
}

/** 识别所有"题号行 + 答题行"的表格 */
export function detectChoiceGrids(raster: Raster, mm: number): ChoiceGrid[] {
  const rules = horizontalRules(raster);
  if (rules.length < 2) return [];

  const bands: GridBand[] = [];
  for (let i = 0; i < rules.length - 1; i++) {
    const gap = rules[i + 1] - rules[i];
    if (gap >= 6 * mm && gap <= 22 * mm) bands.push({ y0: rules[i], y1: rules[i + 1] });
  }

  const grids: ChoiceGrid[] = [];
  for (let i = 0; i < bands.length - 1; i++) {
    const centers = isNumberBand(raster, bands[i], mm);
    if (!centers) continue;

    const answerBand = bands[i + 1];
    // 答题行高度应与题号行接近（1~2 倍）
    const hNum = bands[i].y1 - bands[i].y0;
    const hAns = answerBand.y1 - answerBand.y0;
    if (hAns < hNum * 0.6 || hAns > hNum * 2.6) continue;

    // 直接按题号中心取单元格边界：比依赖竖线更稳（竖线常被手写笔迹干扰）
    const meanGap =
      centers.length > 1 ? (centers[centers.length - 1] - centers[0]) / (centers.length - 1) : 100;
    const edges = [
      centers[0] - meanGap / 2,
      ...centers.slice(1).map((c, k) => (c + centers[k]) / 2),
      centers[centers.length - 1] + meanGap / 2,
    ];
    let columns: { x0: number; x1: number }[] = [];
    for (let k = 0; k < edges.length - 1; k++) columns.push({ x0: edges[k], x1: edges[k + 1] });

    columns = columns.filter((c) => c.x1 - c.x0 > 5 * mm);
    if (columns.length < 4) continue;

    // 答题行里每个格子最多一两个笔迹块；如果是"4 个气泡/题"的涂卡行，
    // 这里的笔迹块数量会远大于列数，说明它是涂卡版式，不该按表格处理。
    const inkComps = components(labelDark(raster.data, raster.width, raster.height, 165), raster.width, raster.height)
      .filter((c) => {
        const cy = (c.y0 + c.y1) / 2;
        const h = (c.y1 - c.y0 + 1) / mm;
        const w = (c.x1 - c.x0 + 1) / mm;
        return cy > answerBand.y0 + 1.5 * mm && cy < answerBand.y1 - 1.5 * mm && h >= 1.5 && h <= 12 && w >= 0.8 && w <= 20;
      });
    if (inkComps.length > columns.length * 1.8) continue;

    grids.push({ numberBand: bands[i], answerBand, columns });
    i++; // 跳过答案行，避免重复
  }
  return grids;
}

/** 分析一页的版面 */
export function analyzeLayout(raster: Raster): GenericLayout {
  const mm = raster.width / 210;
  const optionComps = detectOptionBoxes(raster, mm);
  const choiceRows = filterRepeatingRows(groupOptionRows(optionComps, mm), mm);
  const lines = detectLines(raster, mm);
  const writingBlocks = groupWritingBlocks(lines, mm);
  const choiceGrids = detectChoiceGrids(raster, mm);
  // 表格答题行里的手写字母也会被误当"选项框"，凡是落在表格答题行里的行都丢掉
  const cleanRows = choiceRows.filter(
    (r) => !choiceGrids.some((g) => r.y > g.numberBand.y0 && r.y < g.answerBand.y1),
  );

  const firstY = [cleanRows[0]?.box.y, choiceGrids[0]?.numberBand.y0, writingBlocks[0]?.box.y].filter(
    (v): v is number => typeof v === 'number',
  );
  const header = firstY.length ? headerRect(raster, Math.min(...firstY)) : { x: 0, y: 0, w: raster.width, h: raster.height * 0.14 };

  // 表格型答题卡里，标题文字/题号数字偶尔会被误判成"一行选项框"（通常只有 1~2 行）。
  // 真有涂卡区的话行数会多得多，所以这里按行数做优先级判断。
  const finalRows = choiceGrids.length && cleanRows.length <= 2 ? [] : cleanRows;

  return { width: raster.width, height: raster.height, mm, choiceRows: finalRows, choiceGrids, writingBlocks, header };
}

export type GenericOutcome = {
  layout: GenericLayout;
  answers: {
    questionId: string;
    content: string;
    confidence: number;
    crop: string;
    mode: 'omr' | 'ocr' | 'vision';
  }[];
  name: string;
  studentNo: string;
  pages: number;
};

/** 把检测到的区域按顺序分配给题目 */
export function assignRegions(layout: GenericLayout, questions: Question[]) {
  const ordered = [...questions].sort((a, b) => a.sort - b.sort);
  const choiceQs = ordered.filter((q) => q.kind === 'choice');
  const otherQs = ordered.filter((q) => q.kind !== 'choice');

  const rowMatch = layout.choiceRows.length === choiceQs.length;
  const blockMatch = layout.writingBlocks.length === otherQs.length;

  return {
    rowMatch,
    blockMatch,
    rows: layout.choiceRows.map((row, i) => ({ row, question: choiceQs[i] as Question | undefined })),
    blocks: layout.writingBlocks.map((block, i) => ({ block, question: otherQs[i] as Question | undefined })),
  };
}

/** 通用答题卡识别：版面分析 + 涂卡 + 裁切转写 */
export async function recognizeGeneric(
  sheet: Sheet,
  buffer: Buffer,
  questions: Question[],
  deps: PipelineDeps,
): Promise<RecognizeOutcome | null> {
  const images = await renderPages(buffer, { maxPages: 6, maxSide: MAX_SOURCE_SIDE, scale: 3, quality: 88 });
  if (!images.length) return null;

  const answers = new Map<
    string,
    { content: string; confidence: number; crop: string; mode: 'omr' | 'ocr' | 'vision' }
  >();
  const parts: CropPart[] = [];
  let headerJpeg: Buffer | null = null;
  let totalRows = 0;
  let totalBlocks = 0;
  let sawRows = false;
  let sawGrid = false;

  const ordered = [...questions].sort((a, b) => a.sort - b.sort);
  const choiceQs = ordered.filter((q) => q.kind === 'choice');
  const otherQs = ordered.filter((q) => q.kind !== 'choice');

  let choiceCursor = 0;
  let blockCursor = 0;

  for (const img of images) {
    const raster = await loadRaster(img.jpeg, MAX_SOURCE_SIDE);
    const layout = analyzeLayout(raster);
    const gridCells = layout.choiceGrids.reduce((a, g) => a + g.columns.length, 0);
    if (layout.choiceRows.length) sawRows = true;
    if (!layout.choiceRows.length && gridCells) sawGrid = true;
    totalRows += layout.choiceRows.length || gridCells;
    totalBlocks += layout.writingBlocks.length;

    if (!headerJpeg && layout.header) {
      const crop = cropPixels(raster, layout.header, { maxWidth: 1400, quality: 84 });
      if (crop) headerJpeg = crop.jpeg;
    }

    // 选择题：直接涂卡，不需要模型
    for (const row of layout.choiceRows) {
      const q = choiceQs[choiceCursor++];
      if (!q) break;
      const readings = row.options.map((o) => ({ ...o, ink: inkRatio(raster, o) }));
      const sorted = [...readings].sort((a, b) => b.ink - a.ink);
      const top = sorted[0];
      const second = sorted[1] ?? { option: '', ink: 0 };
      const filled = top && top.ink >= 0.35;
      const ambiguous = filled && second.ink >= 0.35;
      const content = filled ? top.option : '';
      const confidence = !filled ? 0.7 : ambiguous ? 0.35 : Math.min(0.98, 0.62 + (top.ink - second.ink));
      const crop = cropPixels(raster, row.box, { maxWidth: CROP_W, quality: 82 });
      answers.set(q.id, {
        content,
        confidence,
        crop: crop ? saveCrop(deps.dataDir, sheet.id, q.id, crop.jpeg) : '',
        mode: 'omr',
      });
    }

    // 表格型（第一行题号、第二行手写选项）：没有涂卡气泡，只能逐格裁切转写
    if (!layout.choiceRows.length && layout.choiceGrids.length) {
      for (const grid of layout.choiceGrids) {
        for (const col of grid.columns) {
          const q = choiceQs[choiceCursor++];
          if (!q) break;
          const pad = 1.2 * layout.mm;
          const rect = {
            x: col.x0 + pad,
            y: grid.answerBand.y0 + pad,
            w: col.x1 - col.x0 - pad * 2,
            h: grid.answerBand.y1 - grid.answerBand.y0 - pad * 2,
          };
          const crop = cropPixels(raster, rect, { maxWidth: 600, quality: 84 });
          if (!crop) continue;
          const file = saveCrop(deps.dataDir, sheet.id, q.id, crop.jpeg);
          answers.set(q.id, { content: '', confidence: 0, crop: file, mode: 'ocr' });
          parts.push({ no: q.no, qid: q.id, jpeg: crop.jpeg });
        }
      }
    }

    // 主观题：裁切后统一转写
    for (const block of layout.writingBlocks) {
      const q = otherQs[blockCursor++];
      if (!q) break;
      const crop = cropPixels(raster, block.box, { maxWidth: CROP_W, quality: 84 });
      if (!crop) continue;
      const file = saveCrop(deps.dataDir, sheet.id, q.id, crop.jpeg);
      answers.set(q.id, { content: '', confidence: 0, crop: file, mode: 'ocr' });
      parts.push({ no: q.no, qid: q.id, jpeg: crop.jpeg });
    }
  }

  if (!totalRows && !totalBlocks) return null;

  const layoutHint = sawGrid ? '（表格题号行）' : sawRows ? '（涂卡气泡）' : '';
  const rowMatch = totalRows === choiceQs.length;
  const blockMatch = totalBlocks === otherQs.length;
  if (!rowMatch || !blockMatch) {
    deps.log(
      'warn',
      `版面识别到的区域与题目数量不一致（选择题 ${totalRows}/${choiceQs.length}，主观题 ${totalBlocks}/${otherQs.length}），已按顺序对应，请重点复核`,
    );
  }

  // 数量不够的题目留空并标低置信度
  for (const q of ordered) {
    if (answers.has(q.id)) continue;
    answers.set(q.id, { content: '', confidence: 0.2, crop: '', mode: 'ocr' });
  }

  let name = '';
  let studentNo = '';
  if (parts.length || headerJpeg) {
    const allParts: CropPart[] = [];
    if (headerJpeg) allParts.push({ no: 'HEADER', jpeg: headerJpeg, isHeader: 'header' });
    allParts.push(...parts);
    try {
      const { map, name: n, studentNo: sn } = await transcribeCrops(allParts, deps);
      name = n;
      studentNo = sn;
      for (const [qid, v] of map) {
        const prev = answers.get(qid);
        if (!prev) continue;
        answers.set(qid, { ...prev, content: v.content, confidence: v.confidence, mode: 'ocr' });
      }
    } catch (err) {
      deps.log('warn', `通用答题卡转写失败：${(err as Error).message}`);
    }
  }

  deps.log(
    'info',
    `通用答题卡版面：${totalRows} 个选择题位${layoutHint}、${totalBlocks} 块作答区${
      rowMatch && blockMatch ? '' : '（数量与题目不符，已标记复核）'
    }`,
  );

  return {
    method: 'generic',
    studentName: name,
    studentNo,
    answers: [...answers.entries()].map(([questionId, v]) => ({
      questionId,
      content: v.content,
      confidence: v.confidence,
      crop: v.crop || null,
      mode: v.mode,
    })),
    pageCount: images.length,
  };
}

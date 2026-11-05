import { createCanvas, loadImage, type Image, type Canvas } from '@napi-rs/canvas';
import type { LayoutBox, SheetPage } from '../shared/types.ts';

export type Pt = { x: number; y: number };
export type H = [number, number, number, number, number, number, number, number, number];

export type Raster = {
  canvas: Canvas;
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

/**
 * 分辨率预算（集中在这里，方便调）：
 *  - 源图：长边最多 3200px。手机 4000px 的照片会被缩到这里，约 380dpi 等效，足够定位和裁切。
 *  - 单题裁切：最多 1200px 宽（162mm 的作答框 ≈ 188dpi），再宽拼图里也用不上。
 *  - 拼图：1280×1000 一张，低于模型 ~1300×1300 的上限，送进去不会被二次压缩。
 */
export const MAX_SOURCE_SIDE = 3200;
export const CROP_WIDTH = 1200;
/** 拼图上限：1280×1250 ≈ 1.6MP，仍低于模型 ~1300×1300（1.69MP）的缩图阈值 */
export const STRIP_WIDTH = 1280;
export const STRIP_MAX_HEIGHT = 1250;

/** 解码图片（PDF 页会先渲染成 JPEG 再进来） */
export async function loadRaster(buffer: Buffer, maxWidth = MAX_SOURCE_SIDE): Promise<Raster> {
  const img = await loadImage(buffer);
  const ratio = Math.min(1, maxWidth / img.width);
  const w = Math.max(1, Math.round(img.width * ratio));
  const h = Math.max(1, Math.round(img.height * ratio));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img as unknown as Image, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  return { canvas, width: w, height: h, data };
}

const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/* --------------------------- 定位块检测 --------------------------- */

export type Comp = { x0: number; y0: number; x1: number; y1: number; area: number };

export function labelDark(data: Uint8ClampedArray, w: number, h: number, threshold: number): Uint8Array {
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    mask[i] = lum(data[o], data[o + 1], data[o + 2]) < threshold ? 1 : 0;
  }
  return mask;
}

export function components(mask: Uint8Array, w: number, h: number): Comp[] {
  const seen = new Uint8Array(w * h);
  const out: Comp[] = [];
  const stack: number[] = [];

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    seen[start] = 1;
    stack.length = 0;
    stack.push(start);
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    let area = 0;

    while (stack.length) {
      const idx = stack.pop()!;
      const x = idx % w;
      const y = (idx - x) / w;
      area++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      if (x > 0 && mask[idx - 1] && !seen[idx - 1]) {
        seen[idx - 1] = 1;
        stack.push(idx - 1);
      }
      if (x < w - 1 && mask[idx + 1] && !seen[idx + 1]) {
        seen[idx + 1] = 1;
        stack.push(idx + 1);
      }
      if (y > 0 && mask[idx - w] && !seen[idx - w]) {
        seen[idx - w] = 1;
        stack.push(idx - w);
      }
      if (y < h - 1 && mask[idx + w] && !seen[idx + w]) {
        seen[idx + w] = 1;
        stack.push(idx + w);
      }
    }
    out.push({ x0, y0, x1, y1, area });
  }
  return out;
}

/**
 * 在扫描页里找四个实心定位方块。
 * 返回按 [左上, 右上, 右下, 左下] 排序的像素坐标；找不到返回 null。
 */
export function detectMarkers(raster: Raster): Pt[] | null {
  const targetW = 560;
  const ratio = Math.min(1, targetW / raster.width);
  const w = Math.max(1, Math.round(raster.width * ratio));
  const h = Math.max(1, Math.round(raster.height * ratio));

  const small = createCanvas(w, h);
  const ctx = small.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(raster.canvas as unknown as Image, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  const mask = labelDark(data, w, h, 110);
  const comps = components(mask, w, h);

  const minSide = Math.max(6, Math.round((7 / 210) * w * 0.45)); // 定位块短边下界
  const candidates = comps
    .map((c) => {
      const cw = c.x1 - c.x0 + 1;
      const ch = c.y1 - c.y0 + 1;
      return { ...c, cw, ch, fill: c.area / (cw * ch), cx: (c.x0 + c.x1) / 2, cy: (c.y0 + c.y1) / 2 };
    })
    .filter(
      (c) =>
        c.cw >= minSide &&
        c.ch >= minSide &&
        c.fill > 0.62 &&
        c.cw / c.ch > 0.55 &&
        c.cw / c.ch < 1.8 &&
        c.area > 40,
    )
    .sort((a, b) => b.area - a.area)
    .slice(0, 4);

  if (candidates.length < 4) return null;

  // 按几何位置分四象限
  const meanY = candidates.reduce((a, c) => a + c.cy, 0) / 4;
  const top = candidates.filter((c) => c.cy < meanY).sort((a, b) => a.cx - b.cx);
  const bottom = candidates.filter((c) => c.cy >= meanY).sort((a, b) => a.cx - b.cx);
  if (top.length !== 2 || bottom.length !== 2) return null;

  const scale = raster.width / w;
  const toPt = (c: { cx: number; cy: number }): Pt => ({ x: c.cx * scale, y: c.cy * scale });
  return [toPt(top[0]), toPt(top[1]), toPt(bottom[1]), toPt(bottom[0])];
}

/**
 * 没有定位块时的兜底：找答题卡最外圈的边框。
 * 边框是一个闭合矩形，整体是一个连通域；取它的四个对角极值点
 * （min/max of x±y），即使扫描件有倾斜也能拿到真正的角。
 */
export function detectFrameCorners(raster: Raster): Pt[] | null {
  const W = raster.width;
  const H = raster.height;
  const mask = labelDark(raster.data, W, H, 160);
  const comps = components(mask, W, H);

  const frame = comps
    .map((c) => ({ c, w: c.x1 - c.x0 + 1, h: c.y1 - c.y0 + 1 }))
    .filter(({ c, w, h }) => {
      if (w < W * 0.55 || h < H * 0.55) return false;
      const fill = c.area / (w * h);
      return fill < 0.25; // 空心矩形框，填充率很低
    })
    .sort((a, b) => b.w * b.h - a.w * a.h)[0];

  if (!frame) return null;

  const { c } = frame;
  let tl: Pt | null = null;
  let tr: Pt | null = null;
  let br: Pt | null = null;
  let bl: Pt | null = null;
  let minSum = Infinity;
  let maxSum = -Infinity;
  let maxDiff = -Infinity;
  let minDiff = Infinity;

  for (let y = c.y0; y <= c.y1; y++) {
    for (let x = c.x0; x <= c.x1; x++) {
      if (!mask[y * W + x]) continue;
      const sum = x + y;
      const diff = x - y;
      if (sum < minSum) {
        minSum = sum;
        tl = { x, y };
      }
      if (sum > maxSum) {
        maxSum = sum;
        br = { x, y };
      }
      if (diff > maxDiff) {
        maxDiff = diff;
        tr = { x, y };
      }
      if (diff < minDiff) {
        minDiff = diff;
        bl = { x, y };
      }
    }
  }

  if (!tl || !tr || !br || !bl) return null;
  const w = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const h = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  if (w < W * 0.45 || h < H * 0.45) return null;
  return [tl, tr, br, bl];
}

/* --------------------------- 单应性变换 --------------------------- */

export function homography(src: Pt[], dst: Pt[]): H | null {
  if (src.length !== 4 || dst.length !== 4) return null;
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const sol = solve(A, b);
  if (!sol) return null;
  return [sol[0], sol[1], sol[2], sol[3], sol[4], sol[5], sol[6], sol[7], 1];
}

function solve(A: number[][], b: number[]): number[] | null {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-9) return null;
    if (pivot !== col) {
      const t = M[pivot];
      M[pivot] = M[col];
      M[col] = t;
    }
    const p = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (!f) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

export function mapPt(h: H, p: Pt): Pt {
  const d = h[6] * p.x + h[7] * p.y + h[8];
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / d,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / d,
  };
}

/* ----------------------------- 裁切 ----------------------------- */

export type CropResult = { jpeg: Buffer; width: number; height: number; bbox: { x: number; y: number; w: number; h: number } };

export function cropBox(
  raster: Raster,
  h: H,
  box: { x: number; y: number; w: number; h: number },
  opts: { padMm?: number; maxWidth?: number; quality?: number } = {},
): CropResult | null {
  const pad = opts.padMm ?? 0.8;
  const x0mm = box.x - pad;
  const y0mm = box.y - pad;
  const wmm = box.w + pad * 2;
  const hmm = box.h + pad * 2;

  const topLeft = mapPt(h, { x: x0mm, y: y0mm });
  const topRight = mapPt(h, { x: x0mm + wmm, y: y0mm });
  const pxW = Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y);
  if (!Number.isFinite(pxW) || pxW < 4) return null;

  const outW = Math.max(40, Math.min(opts.maxWidth ?? 1000, Math.round(pxW)));
  const outH = Math.max(24, Math.round((outW * hmm) / wmm));

  const canvas = createCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  const out = ctx.createImageData(outW, outH);
  const dst = out.data;

  const clampX = (v: number) => Math.max(0, Math.min(raster.width - 1, v));
  const clampY = (v: number) => Math.max(0, Math.min(raster.height - 1, v));

  for (let j = 0; j < outH; j++) {
    const v = outH === 1 ? 0 : j / (outH - 1);
    for (let i = 0; i < outW; i++) {
      const u = outW === 1 ? 0 : i / (outW - 1);
      const src = mapPt(h, { x: x0mm + u * wmm, y: y0mm + v * hmm });
      const x = clampX(src.x);
      const y = clampY(src.y);
      const x1 = Math.min(raster.width - 1, Math.floor(x));
      const y1 = Math.min(raster.height - 1, Math.floor(y));
      const x2 = Math.min(raster.width - 1, x1 + 1);
      const y2 = Math.min(raster.height - 1, y1 + 1);
      const fx = x - x1;
      const fy = y - y1;

      const o11 = (y1 * raster.width + x1) * 4;
      const o21 = (y1 * raster.width + x2) * 4;
      const o12 = (y2 * raster.width + x1) * 4;
      const o22 = (y2 * raster.width + x2) * 4;
      const d = raster.data;
      const o = (j * outW + i) * 4;

      for (let c = 0; c < 3; c++) {
        const top = d[o11 + c] * (1 - fx) + d[o21 + c] * fx;
        const bottom = d[o12 + c] * (1 - fx) + d[o22 + c] * fx;
        dst[o + c] = top * (1 - fy) + bottom * fy;
      }
      dst[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  const jpeg = canvas.toBuffer('image/jpeg', opts.quality ?? 82);
  return { jpeg, width: outW, height: outH, bbox: { x: 0, y: 0, w: outW, h: outH } };
}

/** 按像素矩形直接裁切（用于没有定位块的通用答题卡） */
export function cropPixels(
  raster: Raster,
  rect: { x: number; y: number; w: number; h: number },
  opts: { maxWidth?: number; quality?: number } = {},
): CropResult | null {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const w = Math.min(raster.width - x, Math.ceil(rect.w));
  const h = Math.min(raster.height - y, Math.ceil(rect.h));
  if (w < 4 || h < 4) return null;
  const scale = Math.min(1, (opts.maxWidth ?? 1000) / w);
  const ow = Math.max(1, Math.round(w * scale));
  const oh = Math.max(1, Math.round(h * scale));
  const canvas = createCanvas(ow, oh);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, ow, oh);
  ctx.drawImage(raster.canvas as unknown as Image, x, y, w, h, 0, 0, ow, oh);
  return { jpeg: canvas.toBuffer('image/jpeg', opts.quality ?? 84), width: ow, height: oh, bbox: { x, y, w, h } };
}

/**
 * 校验：把版式里的作答框映射回扫描图后，四条边是不是真的有印出来的黑线。
 * 防止"题号改过但纸还是旧版式"时，坐标对不上还硬裁。
 */
export function templateMatches(
  raster: Raster,
  h: H,
  page: { boxes: { x: number; y: number; w: number; h: number }[] },
): boolean {
  const samples = page.boxes.slice(0, 6);
  if (!samples.length) return true;

  const lumAt = (x: number, y: number) => {
    const xi = Math.max(0, Math.min(raster.width - 1, Math.round(x)));
    const yi = Math.max(0, Math.min(raster.height - 1, Math.round(y)));
    const o = (yi * raster.width + xi) * 4;
    return 0.299 * raster.data[o] + 0.587 * raster.data[o + 1] + 0.114 * raster.data[o + 2];
  };

  const edgeScore = (box: { x: number; y: number; w: number; h: number }, ox: number, oy: number) => {
    const N = 20;
    let dark = 0;
    let total = 0;
    const check = (p: Pt) => {
      total++;
      let best = 255;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) best = Math.min(best, lumAt(p.x + ox + dx, p.y + oy + dy));
      }
      if (best < 175) dark++;
    };
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      check(mapPt(h, { x: box.x + t * box.w, y: box.y }));
      check(mapPt(h, { x: box.x + t * box.w, y: box.y + box.h }));
      check(mapPt(h, { x: box.x, y: box.y + t * box.h }));
      check(mapPt(h, { x: box.x + box.w, y: box.y + t * box.h }));
    }
    return total ? dark / total : 0;
  };

  // 允许整体平移 1~2mm：老版本打印、或外框对齐有偏差时仍能通过
  const mm = raster.width / 210;
  const shifts = [0, -1, 1, -2, 2];
  let best = 0;
  for (const sx of shifts) {
    for (const sy of shifts) {
      let sum = 0;
      for (const box of samples) sum += edgeScore(box, sx * mm, sy * mm);
      best = Math.max(best, sum / samples.length);
      if (best > 0.6) return true;
    }
  }
  return best > 0.38;
}

/** 整页缩放（用于把扫描页压到适合 OCR 的大小） */
export function resizeRaster(raster: Raster, maxWidth: number): Buffer {
  const scale = Math.min(1, maxWidth / raster.width);
  const canvas = createCanvas(Math.round(raster.width * scale), Math.round(raster.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(raster.canvas as unknown as Image, 0, 0, canvas.width, canvas.height);
  return canvas.toBuffer('image/jpeg', 82);
}

/* ----------------------------- 涂卡识别 ---------------------------- */

export type BubbleReading = { option: string; ratio: number };

/** 计算气泡区域内的深色像素占比（0~1） */
function bubbleInk(raster: Raster, h: H, cx: number, cy: number, r: number): number {
  const center = mapPt(h, { x: cx, y: cy });
  const edge = mapPt(h, { x: cx + r, y: cy });
  const radius = Math.max(2, Math.hypot(edge.x - center.x, edge.y - center.y));

  const x0 = Math.max(0, Math.round(center.x - radius * 0.82));
  const y0 = Math.max(0, Math.round(center.y - radius * 0.82));
  const x1 = Math.min(raster.width - 1, Math.round(center.x + radius * 0.82));
  const y1 = Math.min(raster.height - 1, Math.round(center.y + radius * 0.82));

  let dark = 0;
  let total = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - center.x;
      const dy = y - center.y;
      if (dx * dx + dy * dy > radius * radius * 0.7) continue;
      const o = (y * raster.width + x) * 4;
      const l = lum(raster.data[o], raster.data[o + 1], raster.data[o + 2]);
      total++;
      if (l < 120) dark++;
    }
  }
  return total ? dark / total : 0;
}

export function readChoice(
  raster: Raster,
  h: H,
  box: LayoutBox,
): { answer: string; confidence: number; ambiguous: boolean; readings: BubbleReading[] } {
  const bubbles = box.bubbles ?? [];
  const readings = bubbles.map((b) => ({ option: b.option, ratio: bubbleInk(raster, h, b.cx, b.cy, b.r) }));
  const sorted = [...readings].sort((a, b) => b.ratio - a.ratio);
  const top = sorted[0];
  const second = sorted[1] ?? { option: '', ratio: 0 };

  // 空白气泡因为印了字母和圆圈，本身就有约 0.2 的深色占比，
  // 所以必须用绝对阈值区分"涂了"和"没涂"。
  const FILLED = 0.38;
  if (!top || top.ratio < FILLED) {
    return { answer: '', confidence: 0.82, ambiguous: false, readings };
  }
  const ambiguous = second.ratio >= FILLED;
  const gap = top.ratio - second.ratio;
  return {
    answer: top.option,
    confidence: ambiguous ? 0.35 : Math.min(0.99, 0.62 + gap * 1.4),
    ambiguous,
    readings,
  };
}

/* --------------------------- 拼图（视觉兜底） -------------------------- */

/**
 * 把裁切图拼成一张或多张（左侧用 ASCII 标注题号）。
 *
 * 关键点：视觉模型对图片有分辨率上限（DeepSeek 约 1300×1300，OpenAI 类似），
 * 一张 1200×3000 的长图会被整体缩小，字就糊了。所以按高度分页，
 * 每张控制在 ~1100px 高，保证送进去时基本不被降采样。
 */
export async function composeStrips(
  items: { no: string; jpeg: Buffer }[],
  opts: { width?: number; maxHeight?: number } = {},
): Promise<Buffer[]> {
  if (!items.length) return [];
  const width = opts.width ?? STRIP_WIDTH;
  const maxHeight = opts.maxHeight ?? STRIP_MAX_HEIGHT;
  const labelW = 96;
  const gap = 14;

  const loaded = await Promise.all(items.map(async (it) => ({ no: it.no, img: await loadImage(it.jpeg) })));
  const usable = width - labelW - 24;
  const rows = loaded.map((it) => {
    // 只缩不放：低分辨率的手机照片不会为了"填满画布"被拉大
    const scale = Math.min(1, usable / it.img.width);
    return { no: it.no, img: it.img, w: Math.round(it.img.width * scale), h: Math.round(it.img.height * scale) };
  });

  // 画布宽度跟着最宽的那行走，低分辨率时不会留一大片空白浪费 token
  const widest = rows.reduce((a, r) => Math.max(a, r.w), 0);
  const canvasWidth = Math.min(width, labelW + widest + 24);

  const pages: (typeof rows)[] = [];
  let current: typeof rows = [];
  let usedH = gap;
  for (const r of rows) {
    if (current.length && usedH + r.h + gap > maxHeight) {
      pages.push(current);
      current = [];
      usedH = gap;
    }
    current.push(r);
    usedH += r.h + gap;
  }
  if (current.length) pages.push(current);

  return pages.map((pageRows) => {
    const height = pageRows.reduce((a, r) => a + r.h + gap, gap);
    const canvas = createCanvas(canvasWidth, Math.max(60, height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    let y = gap;
    for (const r of pageRows) {
      ctx.fillStyle = '#111111';
      ctx.font = 'bold 26px sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(`Q${r.no}`, 10, y + r.h / 2);
      ctx.drawImage(r.img as unknown as Image, labelW, y, r.w, r.h);
      ctx.strokeStyle = '#cccccc';
      ctx.lineWidth = 1;
      ctx.strokeRect(labelW, y, r.w, r.h);
      y += r.h + gap;
    }
    return canvas.toBuffer('image/jpeg', 82);
  });
}

/** 兼容旧调用：只返回第一张 */
export async function composeStrip(items: { no: string; jpeg: Buffer }[]): Promise<Buffer> {
  const list = await composeStrips(items);
  return list[0] ?? Buffer.alloc(0);
}

/** 版式 → 单页 mm 尺寸（供前端打印使用） */
export function pageSizeMm() {
  return { width: 210, height: 297 };
}

export type { SheetPage };

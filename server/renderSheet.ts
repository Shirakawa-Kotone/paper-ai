import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import type { SheetLayout } from '../shared/types.ts';

const DPI = 200;
const PX = DPI / 25.4; // 每毫米像素

function pickFont(): string {
  const families = new Set(GlobalFonts.families.map((f) => f.family));
  const wanted = ['Microsoft YaHei', '微软雅黑', 'Hiragino Sans GB', 'Heiti SC', 'Noto Sans CJK SC', 'SimHei', 'PingFang SC'];
  return wanted.find((w) => families.has(w)) ?? 'sans-serif';
}

const FONT = pickFont();

export type RenderedPage = { jpeg: Buffer; widthPt: number; heightPt: number; width: number; height: number };

export function renderSheet(layout: SheetLayout, opts: { dpi?: number } = {}): RenderedPage[] {
  const dpi = opts.dpi ?? DPI;
  const px = dpi / 25.4;
  const W = Math.round(210 * px);
  const H = Math.round(297 * px);
  const out: RenderedPage[] = [];

  for (const page of layout.pages) {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);

    const mm = (v: number) => v * px;

    // 外框
    ctx.strokeStyle = '#111';
    ctx.lineWidth = Math.max(1, mm(0.5));
    ctx.strokeRect(mm(page.frame.x), mm(page.frame.y), mm(page.frame.w), mm(page.frame.h));

    // 四角定位块（实心）
    ctx.fillStyle = '#111';
    for (const m of page.markers) {
      ctx.fillRect(mm(m.x - m.size / 2), mm(m.y - m.size / 2), mm(m.size), mm(m.size));
    }

    // 标题
    ctx.fillStyle = '#111';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `600 ${Math.round(mm(5.4))}px "${FONT}"`;
    ctx.fillText(layout.examName || '化学考试答题卡', mm(105), mm(20.5));

    ctx.font = `${Math.round(mm(3.1))}px "${FONT}"`;
    ctx.fillStyle = '#444';
    const meta = [layout.grade, `满分 ${layout.fullScore} 分`, `第 ${page.index + 1} / ${layout.pageCount} 页`]
      .filter(Boolean)
      .join('   ·   ');
    ctx.fillText(meta, mm(105), mm(28));

    ctx.font = `${Math.round(mm(2.6))}px "${FONT}"`;
    ctx.fillStyle = '#666';
    ctx.fillText('所有题目直接在框内作答：选择题写字母（多选写全，如 ABD），其余写完整过程，不要超出边框', mm(105), mm(33.6));

    // 姓名 / 学号
    ctx.textAlign = 'left';
    ctx.fillStyle = '#111';
    ctx.font = `${Math.round(mm(3.4))}px "${FONT}"`;
    for (const hb of page.header) {
      const label = hb.field === 'name' ? '姓名' : hb.field === 'no' ? '学号' : '班级';
      ctx.fillText(label, mm(hb.x - 16), mm(hb.y + 6));
    }

    ctx.strokeStyle = '#111';
    ctx.lineWidth = Math.max(1, mm(0.3));
    for (const hb of page.header) {
      ctx.strokeRect(mm(hb.x), mm(hb.y), mm(hb.w), mm(hb.h));
    }

    // 题目
    for (const box of page.boxes) {
      const isChoice = box.qkind === 'choice' || box.qkind === 'multi';

      ctx.strokeStyle = '#111';
      ctx.lineWidth = Math.max(1, mm(0.28));
      ctx.strokeRect(mm(box.x), mm(box.y), mm(box.w), mm(box.h));

      // 选择题的题号在格子左边，主观题的题号在左侧留白
      ctx.fillStyle = '#111';
      ctx.font = `600 ${Math.round(isChoice ? mm(3.2) : mm(3.6))}px "${FONT}"`;
      ctx.textBaseline = 'top';
      const labelX = isChoice ? box.x - 6 : 14;
      ctx.fillText(`${box.no}.`, mm(labelX), mm(box.y + (isChoice ? 1.4 : 1.2)));

      if (!isChoice) {
        // 行内浅色横线，方便学生书写
        ctx.strokeStyle = '#e8e8e8';
        ctx.lineWidth = Math.max(1, mm(0.2));
        for (let ly = box.y + 6; ly < box.y + box.h - 2; ly += 6.5) {
          ctx.beginPath();
          ctx.moveTo(mm(box.x + 2), mm(ly));
          ctx.lineTo(mm(box.x + box.w - 2), mm(ly));
          ctx.stroke();
        }
      }
    }

    // 页脚
    ctx.textAlign = 'right';
    ctx.fillStyle = '#999';
    ctx.font = `${Math.round(mm(2.4))}px "${FONT}"`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`paper-ai · 第 ${page.index + 1} 页`, mm(198), mm(291));

    const jpeg = canvas.toBuffer('image/jpeg', 92);
    out.push({ jpeg, width: W, height: H, widthPt: 595.28, heightPt: 841.89 });
  }

  return out;
}



/** 把若干整页图片打成 PDF（不依赖任何 PDF 库） */
export function imagesToPdf(pages: { jpeg: Buffer; widthPt: number; heightPt: number }[]): Buffer {
  return buildPdf(pages);
}

function jpegSize(buf: Buffer): { width: number; height: number } {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  return { width: 0, height: 0 };
}

function buildPdf(pages: { jpeg: Buffer; widthPt: number; heightPt: number }[]): Buffer {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const add = (b: Buffer | string) => {
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1');
    parts.push(buf);
    pos += buf.length;
  };

  add('%PDF-1.4\n');

  const n = pages.length;
  const objCount = 2 + n * 3;
  const pageObj = (i: number) => 3 + i * 3;
  const contentObj = (i: number) => 4 + i * 3;
  const imageObj = (i: number) => 5 + i * 3;

  offsets[1] = pos;
  add('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  offsets[2] = pos;
  add(`2 0 obj\n<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${n} >>\nendobj\n`);

  pages.forEach((p, i) => {
    const w = p.widthPt;
    const h = p.heightPt;
    offsets[pageObj(i)] = pos;
    add(
      `${pageObj(i)} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${imageObj(i)} 0 R >> >> /Contents ${contentObj(i)} 0 R >>\nendobj\n`,
    );

    const content = `q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`;
    offsets[contentObj(i)] = pos;
    add(`${contentObj(i)} 0 obj\n<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream\nendobj\n`);

    const { width, height } = jpegSize(p.jpeg);
    offsets[imageObj(i)] = pos;
    add(
      `${imageObj(i)} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`,
    );
    add(p.jpeg);
    add('\nendstream\nendobj\n');
  });

  const xref = pos;
  add(`xref\n0 ${objCount + 1}\n0000000000 65535 f \n`);
  for (let i = 1; i <= objCount; i++) add(`${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`);
  add(`trailer\n<< /Size ${objCount + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  return Buffer.concat(parts);
}


/** 手机照片（JPG/PNG/WebP）直接转成一页 PDF，页宽按 A4 宽度、高度按比例 */
export async function imageToPdf(buffer: Buffer, maxSide = 3200): Promise<Buffer> {
  const img = await loadImage(buffer);
  const ratio = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * ratio));
  const h = Math.max(1, Math.round(img.height * ratio));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img as never, 0, 0, w, h);
  const jpeg = canvas.toBuffer('image/jpeg', 90);
  // 页宽按像素/3 折算：渲染时统一用 scale=3，这样能 1:1 还原原始像素，
  // 不会因为塞进 A4 页面再放大而丢掉清晰度。
  const widthPt = w / 3;
  const heightPt = h / 3;
  return imagesToPdf([{ jpeg, widthPt, heightPt }]);
}

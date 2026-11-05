import { createCanvas, loadImage } from '@napi-rs/canvas';

export type PdfTextPage = { index: number; text: string };
export type PdfText = { pageCount: number; pages: PdfTextPage[]; text: string; chars: number };
export type PdfImage = { index: number; jpeg: Buffer; width: number; height: number; base64: string };

let pdfjsPromise: Promise<any> | null = null;
async function pdfjs(): Promise<any> {
  if (!pdfjsPromise) {
    // legacy 构建在 Node 下无需 DOM / worker
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsPromise;
}

/**
 * 抽取 PDF 文本层。会按坐标重建行，避免 pdf.js 默认按 gref 顺序拼接导致串行。
 */
export async function extractText(buffer: Buffer, opts: { maxPages?: number; maxChars?: number } = {}): Promise<PdfText> {
  const maxPages = opts.maxPages ?? 40;
  const maxChars = opts.maxChars ?? 40_000;
  const lib = await pdfjs();
  const data = new Uint8Array(buffer); // 复制，避免 pdf.js 转移并 detach 原 buffer
  const doc = await lib.getDocument({
    data,
    useSystemFonts: false,
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;

  const pages: PdfTextPage[] = [];
  let total = '';
  const n = Math.min(doc.numPages, maxPages);
  for (let p = 1; p <= n; p++) {
    const page = await doc.getPage(p);
    try {
      const content = await page.getTextContent();
      const text = layoutText(content.items as any[]);
      pages.push({ index: p, text });
      if (total.length < maxChars) total += (total ? '\n\n' : '') + text;
    } finally {
      page.cleanup?.();
    }
    if (total.length >= maxChars) break;
  }
  await doc.destroy?.();

  const clipped = total.slice(0, maxChars);
  return {
    pageCount: doc.numPages ?? n,
    pages,
    text: clipped,
    chars: clipped.replace(/\s/g, '').length,
  };
}

/** 按 y 坐标分行、x 坐标排序，尽量还原阅读顺序。 */
function layoutText(items: any[]): string {
  const lines: { y: number; parts: { x: number; str: string }[] }[] = [];
  for (const it of items) {
    const str = typeof it.str === 'string' ? it.str : '';
    if (!str.trim()) continue;
    const tr = it.transform as number[] | undefined;
    const x = tr?.[4] ?? 0;
    const y = tr?.[5] ?? 0;
    const line = lines.find((l) => Math.abs(l.y - y) <= 3);
    if (line) line.parts.push({ x, str });
    else lines.push({ y, parts: [{ x, str }] });
  }
  lines.sort((a, b) => b.y - a.y);
  return lines
    .map((l) =>
      l.parts
        .sort((a, b) => a.x - b.x)
        .map((p) => p.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .join('\n');
}

/**
 * 把 PDF 页面渲染成 JPEG。用 pdf-to-img（内部 @napi-rs/canvas，Windows/macOS 均有预编译包）。
 */
export async function renderPages(
  buffer: Buffer,
  opts: { maxPages?: number; maxSide?: number; quality?: number; scale?: number } = {},
): Promise<PdfImage[]> {
  const maxPages = opts.maxPages ?? 8;
  const maxSide = opts.maxSide ?? 1600;
  const quality = opts.quality ?? 78;
  const scale = opts.scale ?? 2;

  const { pdf } = await import('pdf-to-img');
  const doc = await pdf(buffer, { scale });

  const out: PdfImage[] = [];
  let index = 1;
  for await (const png of doc) {
    if (index > maxPages) break;
    const img = await loadImage(png);
    const ratio = Math.min(1, maxSide / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * ratio));
    const h = Math.max(1, Math.round(img.height * ratio));
    const cv = createCanvas(w, h);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const jpeg = cv.toBuffer('image/jpeg', quality);
    out.push({ index, jpeg, width: w, height: h, base64: jpeg.toString('base64') });
    index++;
  }
  return out;
}

export function dataUrl(jpeg: Buffer): string {
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

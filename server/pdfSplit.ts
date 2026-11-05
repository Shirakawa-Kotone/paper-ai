import { PDFDocument } from 'pdf-lib';

/** 读 PDF 页数（不解析内容，很快） */
export async function pdfPageCount(buffer: Buffer): Promise<number> {
  const doc = await PDFDocument.load(new Uint8Array(buffer), { ignoreEncryption: true });
  return doc.getPageCount();
}

/** 按每 groupSize 页切一份，返回多个 PDF */
export async function splitPdf(buffer: Buffer, groupSize: number): Promise<Buffer[]> {
  const src = await PDFDocument.load(new Uint8Array(buffer), { ignoreEncryption: true });
  const total = src.getPageCount();
  const out: Buffer[] = [];
  for (let start = 0; start < total; start += groupSize) {
    const doc = await PDFDocument.create();
    const count = Math.min(groupSize, total - start);
    const pages = await doc.copyPages(src, Array.from({ length: count }, (_, i) => start + i));
    for (const p of pages) doc.addPage(p);
    out.push(Buffer.from(await doc.save()));
  }
  return out;
}

export function splitName(fileName: string, index: number, parts: number): string {
  const base = fileName.replace(/\.pdf$/i, '');
  const pad = String(index + 1).padStart(String(parts).length, '0');
  return `${base}-${pad}.pdf`;
}

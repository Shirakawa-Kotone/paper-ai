import fs from 'node:fs';
import path from 'node:path';
import type { AiSettings } from '../shared/types.ts';
import { extractJson, type LlmClient } from './llm.ts';
import { composeStrips } from './crop.ts';
import { dataUrl } from './pdf.ts';
import { normalizeNo } from './template.ts';

export { CROP_WIDTH as CROP_W } from './crop.ts';

export function saveCrop(dataDir: string, sheetId: string, key: string, jpeg: Buffer): string {
  const dir = path.join(dataDir, 'crops', sheetId);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.jpg`;
  fs.writeFileSync(path.join(dir, name), jpeg);
  return name;
}

export type CropPart = { no: string; qid?: string; jpeg: Buffer; isHeader?: 'name' | 'no' | 'header' };

export type CropDeps = {
  dataDir: string;
  llm: LlmClient;
  ai: AiSettings;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
};

export async function transcribeCrops(
  parts: CropPart[],
  deps: CropDeps,
): Promise<{ map: Map<string, { content: string; confidence: number }>; name: string; studentNo: string }> {
  const map = new Map<string, { content: string; confidence: number }>();
  let name = '';
  let studentNo = '';

  const texts = parts.filter((p) => p.qid);
  if (!texts.length) return { map, name, studentNo };

  if (!deps.ai.visionModel?.trim()) {
    throw new Error('请先在「设置」里配置视觉模型，识别答题卡内容需要它');
  }

  const stripItems: { no: string; jpeg: Buffer }[] = parts.map((part) => ({
    no:
      part.isHeader === 'name'
        ? 'NAME'
        : part.isHeader === 'no'
          ? 'ID'
          : part.isHeader === 'header'
            ? 'HEADER'
            : part.no,
    jpeg: part.jpeg,
  }));

  const strips = await composeStrips(stripItems);
  deps.log('info', `拼图 ${strips.length} 张（${stripItems.length} 个作答框），已按模型分辨率上限切分`);

  const res = await deps.llm.chat({
    model: deps.llm.visionModel,
    json: true,
    maxTokens: 4096,
    temperature: 0,
    thinking: 'disabled', // 纯抄录，不需要思考链
    messages: [
      {
        role: 'system',
        content:
          '你是答题卡转写员。图片是按题号裁切后竖向拼接的各题作答区域，左侧 Q1/Q2… 是题号，NAME 是姓名栏，ID 是学号栏，HEADER 是包含姓名/班级/考号的整块表头。\n' +
          '只输出 JSON，不要解释。学生写什么抄什么，保留式子、上下标、单位、错别字；空白填 ""；看不清用「□」占位。\n' +
          '多张图片时要全部读完，不要只看第一张。',
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              (strips.length > 1
                ? `下面共有 ${strips.length} 张图，是同一份答题卡按顺序切分的连续部分，请合并起来一起转写。\n`
                : '') +
              '请逐行转写图片内容，输出：\n' +
              '{"name":"","no":"","answers":[{"no":"1","content":"","confidence":0.9}]}\n' +
              'answers 必须覆盖图片中出现的全部 Q 行，顺序一致。confidence 是你对逐个字的把握。\n' +
              'no 必须与图片左侧标签完全一致：左边写 Q1-1，no 就写 "1-1"；别自己改写题号。\n' +
              '若存在 HEADER，请从中提取姓名填入 name、学号/考号填入 no。',
          },
          ...strips.map((buf) => ({
            type: 'image_url' as const,
            image_url: { url: dataUrl(buf), detail: 'high' as const },
          })),
        ],
      },
    ],
  });

  const parsed = extractJson<{
    name?: string;
    no?: string;
    answers?: { no?: string; content?: string; confidence?: number }[] | Record<string, unknown>;
  }>(res.text);

  const keyOf = (raw: unknown) => {
    let t = String(raw ?? '').trim();
    t = t.replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    t = t.replace(/^[Qq]\s*/, '').replace(/^第\s*/, '').replace(/\s*题$/, '');
    t = t.replace(/[、.。:：,，)）\]]+$/g, '');
    return t.replace(/\s+/g, '');
  };
  const looseOf = (k: string) => k.match(/^\d+(?:[-.]\d+)*/)?.[0]?.replace(/\./g, '-') ?? k;

  const byKey = new Map<string, string>();
  for (const part of parts) if (part.qid) byKey.set(keyOf(part.no), part.qid);
  const byLoose = new Map<string, string | null>();
  for (const part of parts) {
    if (!part.qid) continue;
    const l = looseOf(keyOf(part.no));
    byLoose.set(l, byLoose.has(l) ? null : part.qid);
  }
  const resolve = (raw: unknown): string | undefined => {
    const k = keyOf(raw);
    const exact = byKey.get(k);
    if (exact) return exact;
    const l = looseOf(k);
    const looseHit = byLoose.get(l);
    if (typeof looseHit === 'string') return looseHit;
    const n = normalizeNo(k);
    return parts.find((p) => p.qid && normalizeNo(p.no) === n)?.qid;
  };

  const items: { no?: string; content?: string; confidence?: number }[] = Array.isArray(parsed?.answers)
    ? (parsed!.answers as { no?: string; content?: string; confidence?: number }[])
    : parsed?.answers && typeof parsed.answers === 'object'
      ? Object.entries(parsed.answers).map(([no, v]) =>
          v && typeof v === 'object'
            ? { no, ...(v as Record<string, unknown>) }
            : { no, content: String(v ?? '') },
        )
      : [];

  if (parsed) {
    name = String(parsed.name ?? '').trim() || name;
    studentNo = String(parsed.no ?? '').trim() || studentNo;
  }

  for (const item of items) {
    const qid = resolve(item.no);
    if (!qid) continue;
    map.set(qid, {
      content: String(item.content ?? '').trim(),
      confidence: item.confidence == null ? 0.8 : Math.max(0, Math.min(1, Number(item.confidence))),
    });
  }

  if (!map.size) {
    deps.log(
      'warn',
      `模型返回的内容没能对上题号（本题号：${parts.filter((p) => p.qid).map((p) => p.no).join('/')}），原始返回：${res.text.slice(0, 240)}`,
    );
  }

  return { map, name, studentNo };
}

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

  // 图片左侧用「行号」标注（Q1、Q2…），而不是真题号。
  // 三级题号（15-4-1）让模型抄写极易错位，改成行号后只要数对行即可。
  const qidParts = parts.filter((p) => p.qid);
  const labelToQid = new Map<string, string>();
  const legend: string[] = [];
  const labelOf = new Map<(typeof parts)[number], string>();

  parts.forEach((part) => {
    if (part.qid) {
      const idx = qidParts.indexOf(part) + 1;
      const label = String(idx);
      labelToQid.set(label, part.qid);
      legend.push(`Q${label} = 第${part.no}题`);
      labelOf.set(part, label);
    } else if (part.isHeader === 'name') {
      labelOf.set(part, 'NAME');
    } else if (part.isHeader === 'no') {
      labelOf.set(part, 'ID');
    } else {
      labelOf.set(part, 'HEADER');
    }
  });

  const stripItems = parts.map((part) => ({ no: labelOf.get(part) ?? 'X', jpeg: part.jpeg }));

  const strips = await composeStrips(stripItems);
  deps.log('info', `拼图 ${strips.length} 张（${stripItems.length} 个作答框），已按模型分辨率上限切分`);

  const res = await deps.llm.chat({
    model: deps.llm.visionModel,
    json: true,
    maxTokens: 8000,
    temperature: 0,
    thinking: 'disabled', // 纯抄录，不需要思考链
    messages: [
      {
        role: 'system',
        content:
          '你是答题卡转写员。图片是按行裁切后竖向拼接的各题作答区域。\n' +
          '左侧的 Q1/Q2… 是**行号**，不是题号；NAME 是姓名栏，ID 是学号栏，HEADER 是包含姓名/班级/考号的整块表头。\n' +
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
              `行号与真实题号的对应关系（转写时不用管，只要按行号回填）：\n${legend.join('\n')}\n\n` +
              '请逐行转写图片内容，输出：\n' +
              '{"name":"","no":"","answers":[{"no":"1","content":"","confidence":0.9}]}\n' +
              'answers 必须覆盖图片中出现的每一条 Q 行，顺序一致。\n' +
              '**no 只填行号本身**：左侧写 Q3 就填 "3"，不要填真实题号，也不要加字母。\n' +
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
    t = t.replace(/^[（(\[【]+/, '');
    t = t.replace(/[、.。:：,，)）\]】》]+$/g, '');
    t = t.replace(/[.．]/g, '-');
    return t.replace(/\s+/g, '');
  };
  const looseOf = (k: string) => k.match(/^\d+(?:-\d+)*/)?.[0] ?? k;

  // 真题号 → qid（精确、且只在唯一时才用）
  const byKey = new Map<string, string | null>();
  for (const part of parts) {
    if (!part.qid) continue;
    const k = keyOf(part.no);
    byKey.set(k, byKey.has(k) ? null : part.qid);
  }

  const resolve = (raw: unknown): string | undefined => {
    const k = keyOf(raw);

    // 1) 行号（正常路径）
    const byLabel = labelToQid.get(k) ?? labelToQid.get(looseOf(k));
    if (byLabel) return byLabel;

    // 2) 模型还是回了真题号
    const exact = byKey.get(k);
    if (typeof exact === 'string') return exact;

    // 3) 逐级退让，但**只在唯一时**才认，多个候选就不猜，宁可标记复核
    const n = normalizeNo(k);
    const hits = parts.filter((p) => p.qid && normalizeNo(p.no) === n);
    return hits.length === 1 ? hits[0].qid : undefined;
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

  const unmatched: string[] = [];
  for (const item of items) {
    const qid = resolve(item.no);
    if (!qid) {
      unmatched.push(String(item.no ?? '?'));
      continue;
    }
    map.set(qid, {
      content: String(item.content ?? '').trim(),
      confidence: item.confidence == null ? 0.8 : Math.max(0, Math.min(1, Number(item.confidence))),
    });
  }

  if (unmatched.length) {
    deps.log('warn', `有 ${unmatched.length} 行没对上题号：${unmatched.join('、')}（已跳过，其余正常入库）`);
  }
  if (!map.size) {
    deps.log(
      'warn',
      `模型返回的内容没能对上题号（本题号：${qidParts.map((p) => p.no).join('/')}），原始返回：${res.text.slice(0, 240)}`,
    );
  }

  return { map, name, studentNo };
}

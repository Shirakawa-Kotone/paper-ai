import fs from 'node:fs';
import path from 'node:path';
import type { AiSettings, GradeSource, Question, Sheet } from '../shared/types.ts';
import { extractJson, LlmError, type LlmClient, type Msg } from './llm.ts';
import { dataUrl, extractText, renderPages } from './pdf.ts';
import {
  composeStrip,
  cropBox,
  detectFrameCorners,
  detectMarkers,
  homography,
  loadRaster,
  MAX_SOURCE_SIDE,
  readChoice,
  templateMatches,
} from './crop.ts';
import type { SheetLayout } from '../shared/types.ts';
import { CROP_W, saveCrop, transcribeCrops, type CropPart } from './cropOcr.ts';
import { recognizeGeneric } from './generic.ts';
import { buildLayout } from './template.ts';

export type PipelineDeps = {
  dataDir: string;
  llm: LlmClient;
  ai: AiSettings;
  subject: string;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
};

export type RecognizeOutcome = {
  method: 'text' | 'vision' | 'template' | 'generic';
  studentName: string;
  studentNo: string;
  answers: {
    questionId: string;
    content: string;
    confidence: number | null;
    crop?: string | null;
    mode?: string | null;
  }[];
  pageCount: number;
};

const fmtScore = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function questionLine(q: Question): string {
  const kindLabel: Record<string, string> = {
    choice: '选择题',
    fill: '填空题',
    equation: '方程式/公式',
    calc: '计算题',
    short: '简答题',
  };
  return `第${q.no}题｜${kindLabel[q.kind] ?? '题目'}｜满分${fmtScore(q.maxScore)}分`;
}

/* ------------------------------- 题号归一 ------------------------------- */

const CN_NUM: Record<string, string> = {
  一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9', 十: '10',
};

export function normalizeNo(raw: unknown): string {
  let s = String(raw ?? '').trim();
  s = s.replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)); // 全角数字
  s = s.replace(/[（(]\s*[)）]/g, ''); // 空括号
  s = s.replace(/^第\s*/, '').replace(/\s*题$/, '');
  s = s.replace(/[、.。:：,，)）\]]+$/g, '');
  s = s.replace(/\s+/g, '');
  if (CN_NUM[s]) s = CN_NUM[s];
  const m = s.match(/^0*(\d+(?:\.\d+)?)/);
  return m ? m[1] : s;
}

function buildNoIndex(questions: Question[]): Map<string, Question> {
  const map = new Map<string, Question>();
  for (const q of questions) {
    map.set(normalizeNo(q.no), q);
    const num = q.no.match(/\d+/)?.[0];
    if (num) map.set(normalizeNo(num), q);
  }
  return map;
}

/* ------------------------------- 文本层判断 ------------------------------ */

function looksLikeTextLayer(text: string, questions: Question[]): boolean {
  const chars = text.replace(/\s/g, '').length;
  if (chars < 80) return false;
  if (chars >= 300) return true;
  const hits = questions.filter((q) => new RegExp(`(^|\\D)0*${escapeRe(q.no)}(\\D|$)`).test(text)).length;
  return hits >= Math.max(1, Math.ceil(questions.length * 0.3));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* -------------------------------- 识别 -------------------------------- */

const recognizeSystem = (subject: string) => `你是一名严谨的答题卡信息提取员。你只做"抄录"，不做任何判断、评分或改写。
严格要求：
1. 只输出一个 JSON 对象，不要输出解释、不要用 Markdown 代码块。
2. 学生写了什么就抄什么，保留公式/化学式、上下标、单位、错别字原样；看不清的片段用「□」占位。这是${subject}学科。
3. 某一题完全没有作答时，content 填空字符串 ""；不要编造内容。
4. confidence 是你对该题抄录准确度的自评，0~1 的小数。`;

function recognizeUserPrompt(questions: Question[], subject: string, hint?: { text: string; source: string }): string {
  const lines = questions.map(questionLine).join('\n');
  let p = `这是同一名学生的${subject}答题卡。请提取：
A. 学生姓名（studentName）与考号/学号（studentNo），没有就留空；
B. 每一题的作答原文（answers）。

题目清单（共 ${questions.length} 题）：
${lines}

输出 JSON 结构：
{"studentName":"张三","studentNo":"20260312","answers":[{"no":"1","content":"作答原文","confidence":0.95}]}

注意：
- no 必须使用上面清单里的题号，逐题输出，不要合并、不要遗漏；
- 只抄录学生手写的作答，不要抄题干；
- 图像可能倾斜、有涂改，以最终可见内容为准。`;

  if (hint?.text) {
    p += `\n\n【${hint.source}给出的辅助OCR转录，可能存在错字、漏字、顺序错乱，仅用于辅助定位，不要直接照抄】\n${hint.text}`;
  }
  return p;
}

export async function recognizeSheet(
  sheet: Sheet,
  storedName: string,
  questions: Question[],
  deps: PipelineDeps,
  layout?: SheetLayout | null,
): Promise<RecognizeOutcome> {
  const filePath = path.join(deps.dataDir, 'uploads', storedName);
  if (!fs.existsSync(filePath)) throw new Error('原始 PDF 已丢失，请删除后重新上传');
  const buffer = fs.readFileSync(filePath);

  // 没有保存过版式时，按当前题目现算一份——只要纸是本系统打的，坐标就是对的
  const effectiveLayout =
    layout && layout.pages.length
      ? layout
      : buildLayout({ id: sheet.examId, name: '', grade: '', questions });

  // 优先走"模板 + 定位块裁切"路线：坐标已知，识别最稳、最省 token
  if (effectiveLayout && effectiveLayout.pages.length) {
    try {
      const out = await recognizeByTemplate(sheet, buffer, effectiveLayout, deps);
      if (out) return out;
      deps.log('info', '没有检测到四角定位块，改用版面分析（年级组答题卡模式）');
    } catch (err) {
      // 模型接口本身出问题（欠费/鉴权/限流）时不要回退：换条路也一样失败，只会把错误藏起来
      if (err instanceof LlmError) throw err;
      deps.log('warn', `模板裁切失败，回退整页识别：${(err as Error).message}`);
    }
  }

  const textResult = await extractText(buffer, { maxPages: 12 });
  const textMode = looksLikeTextLayer(textResult.text, questions);
  const noIndex = buildNoIndex(questions);

  // 没有定位块的"年级组答题卡"：靠版面分析（选项框 / 横线）切分
  if (!textMode) {
    try {
      const generic = await recognizeGeneric(sheet, buffer, questions, deps);
      if (generic) return generic;
    } catch (err) {
      deps.log('warn', `通用版面分析失败，改用整页识别：${(err as Error).message}`);
    }
  }

  let method: 'text' | 'vision' = 'text';
  let messages: Msg[] = [];
  let model = deps.llm.textModel;

  if (textMode) {
    deps.log('info', `使用 PDF 文本层识别（${textResult.chars} 字）`);
    method = 'text';
    model = deps.llm.textModel;
    messages = [
      { role: 'system', content: recognizeSystem(deps.subject) },
      {
        role: 'user',
        content: `${recognizeUserPrompt(questions, deps.subject)}\n\n【PDF 提取的文本，可能存在顺序错乱】\n${textResult.text.slice(0, 24000)}`,
      },
    ];
  } else {
    deps.log('info', 'PDF 无有效文本层，转为图片识别');
    const images = await renderPages(buffer, { maxPages: 6, maxSide: 1600, quality: 78 });
    if (!images.length) throw new Error('PDF 渲染失败，文件可能已损坏或加密');

    if (!deps.ai.visionModel?.trim()) {
      throw new Error('这份 PDF 是扫描件，请先到「设置」配置视觉模型');
    }
    method = 'vision';
    model = deps.llm.visionModel;
    messages = [
      { role: 'system', content: recognizeSystem(deps.subject) },
      {
        role: 'user',
        content: [
          { type: 'text', text: recognizeUserPrompt(questions, deps.subject) },
          ...images.slice(0, 6).map((img) => ({
            type: 'image_url' as const,
            image_url: { url: dataUrl(img.jpeg), detail: 'high' as const },
          })),
        ],
      },
    ];
  }

  const res = await deps.llm.chat({ model, messages, json: true, maxTokens: 3000, temperature: 0 });
  let parsed = extractJson<{
    studentName?: string;
    studentNo?: string;
    answers?: unknown;
  }>(res.text);

  if (!parsed) {
    // 再试一次，要求更严格
    deps.log('warn', '识别结果不是合法 JSON，正在重试一次');
    const retry = await deps.llm.chat({
      model,
      messages: [...messages, { role: 'assistant', content: res.text.slice(0, 800) }, { role: 'user', content: '上面的输出不是合法 JSON。请重新输出，只输出一个 JSON 对象，不要任何其他文字。' }],
      json: true,
      maxTokens: 3000,
      temperature: 0,
      retries: 1,
    });
    parsed = extractJson(retry.text);
  }
  if (!parsed) throw new Error('模型返回的内容无法解析为 JSON，请重试或换用更强的模型');

  const rawAnswers =
    (parsed.answers as unknown) ??
    (Array.isArray(parsed) ? parsed : undefined) ??
    (Object.entries(parsed).find(([k]) => /answer|作答|答案/.test(k))?.[1] as unknown);

  const collected: RecognizeOutcome['answers'] = [];
  const push = (rawNo: unknown, rawContent: unknown, rawConf: unknown) => {
    const key = normalizeNo(rawNo);
    const q = noIndex.get(key);
    if (!q) return;
    const content = String(rawContent ?? '').trim();
    const conf = rawConf == null || Number.isNaN(Number(rawConf)) ? null : Math.max(0, Math.min(1, Number(rawConf)));
    collected.push({ questionId: q.id, content, confidence: conf });
  };

  if (Array.isArray(rawAnswers)) {
    for (const item of rawAnswers) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      push(o.no ?? o.question ?? o.id ?? o['题号'], o.content ?? o.answer ?? o['作答'], o.confidence ?? o.conf);
    }
  } else if (rawAnswers && typeof rawAnswers === 'object') {
    for (const [k, v] of Object.entries(rawAnswers as Record<string, unknown>)) {
      if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        push(k, o.content ?? o.answer ?? '', o.confidence);
      } else push(k, v, null);
    }
  }

  if (!collected.length) throw new Error('没有从答题卡中提取到任何作答，请检查 PDF 是否清晰、题号是否匹配');

  // 去重：同一题多次出现取最长的
  const merged = new Map<string, RecognizeOutcome['answers'][number]>();
  for (const a of collected) {
    const prev = merged.get(a.questionId);
    if (!prev || a.content.length > prev.content.length) merged.set(a.questionId, a);
  }

  const studentName = String(parsed.studentName ?? (parsed as any).name ?? '').trim();
  const studentNo = String(parsed.studentNo ?? (parsed as any).number ?? '').trim();

  return {
    method,
    studentName,
    studentNo,
    answers: [...merged.values()],
    pageCount: textResult.pageCount,
  };
}

/* -------------------------------- 评分 -------------------------------- */

const gradeSystem = (subject: string) => {
  const isChem = /化学/.test(subject);
  const subjectRule = isChem
    ? '2. 化学方程式：化学式错、未配平、缺反应条件、气体/沉淀符号缺失，按评分标准依次扣分。'
    : '2. 公式、单位、有效数字、术语写错按评分标准扣分；步骤缺失但结果正确，按标准给分。';
  return `你是一名有 20 年教龄的高中${subject}阅卷老师，严格执行给定的评分标准。
评分原则：
1. 按给分点给分，不因书写潦草、顺序不同而扣分；只扣知识点错误。
${subjectRule}
3. 计算结果正确但过程缺失，按标准给分；结果错误但思路正确的，给过程分。
4. 学生未作答给 0 分；答非所问给 0 分。
5. 分数必须是 0 到满分之间、且以 0.5 为步长的数；无法确定时从严给分并降低 confidence。
6. comment 用一句中文说清扣分原因或亮点，不超过 40 字，不要写"根据标准"这类空话。`;
};

export type GradeItem = {
  questionId: string;
  score: number;
  comment: string;
  needsReview: boolean;
  source: GradeSource;
  model: string;
};

export function normalizeChoice(v: string): string {
  return v
    .replace(/[\uFF21-\uFF3A]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s,，、.。;；:：]/g, '')
    .toUpperCase();
}

export function sameAnswer(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/\s+/g, '')
      .replace(/[，。；：、,.;:]/g, '')
      .toLowerCase();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isNaN(nx) && !Number.isNaN(ny)) return Math.abs(nx - ny) < 1e-9;
  return false;
}

function clampScore(score: number, max: number): number {
  const s = Math.round(score * 2) / 2;
  return Math.max(0, Math.min(max, s));
}

type AiGrade = { no?: string; score?: number; comment?: string; confidence?: number };

const KIND_LABEL: Record<string, string> = {
  choice: '单选题',
  multi: '多选题',
  fill: '填空题',
  equation: '化学方程式',
  calc: '计算题',
  short: '简答题',
};

/**
 * 把"题目 + 参考答案 + 评分标准 + 输出格式"拼成一段固定前缀。
 * 同一场考试每次调用完全一致 —— 大模型的前缀缓存（DeepSeek/OpenAI 都支持）
 * 会命中这段，只有学生作答那部分需要重新计费。
 */
export function buildGradingPrefix(questions: Question[], subject = '化学'): string {
  const block = questions
    .map((q) => {
      const lines = [`第${q.no}题｜${KIND_LABEL[q.kind] ?? q.kind}｜满分${q.maxScore}分`];
      lines.push(`参考答案：${q.answer || '（未提供）'}`);
      if (q.rubric.trim()) lines.push(`评分标准：${q.rubric.trim()}`);
      return lines.join('\n');
    })
    .join('\n\n');

  return `${gradeSystem(subject)}

【本场考试的题目与评分标准（${subject}）】
${block}

【输出格式】
只输出一个 JSON 对象，不要解释：
{"items":[{"no":"题号","score":数字,"comment":"评语","confidence":0.0~1.0}]}

要求：
- items 必须覆盖上面全部 ${questions.length} 道题，顺序一致；
- score 不得超过该题满分，且为 0.5 的整数倍；
- confidence 表示你对这个分数的把握，明显拿不准时给 0.5 以下。`;
}

async function gradeWithAi(
  deps: PipelineDeps,
  questions: Question[],
  answers: Map<string, string>,
  log: (level: 'info' | 'warn' | 'error', message: string) => void,
): Promise<Map<string, { score: number; comment: string; confidence: number }>> {
  const out = new Map<string, { score: number; comment: string; confidence: number }>();
  if (!questions.length) return out;

  // 固定前缀放 system：同一场考试的所有学生共享，缓存命中
  const system = buildGradingPrefix(questions, deps.subject);
  // 只有学生作答是变量
  const studentAnswers = questions.map((q) => ({
    no: q.no,
    answer: (answers.get(q.id) ?? '').slice(0, 1500),
  }));

  const res = await deps.llm.chat({
    model: deps.llm.textModel,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `学生作答：\n${JSON.stringify(studentAnswers)}\n\n请逐题评分。` },
    ],
    json: true,
    maxTokens: 4000,
    temperature: 0,
  });

  const parsed = extractJson<{ items?: AiGrade[] }>(res.text);
  const arr = Array.isArray(parsed?.items) ? parsed!.items : Array.isArray(parsed) ? (parsed as unknown as AiGrade[]) : [];
  if (!arr.length) throw new Error('评分结果不是预期的 JSON 结构');

  const byNo = new Map(questions.map((q) => [normalizeNo(q.no), q]));
  for (const item of arr) {
    const q = byNo.get(normalizeNo(item.no));
    if (!q) continue;
    const score = Number(item.score);
    if (!Number.isFinite(score)) continue;
    out.set(q.id, {
      score: clampScore(score, q.maxScore),
      comment: String(item.comment ?? '').trim().slice(0, 120),
      confidence: item.confidence == null ? 0.8 : Math.max(0, Math.min(1, Number(item.confidence))),
    });
  }
  return out;
}

export async function gradeSheet(
  questions: Question[],
  answers: Map<string, string>,
  deps: PipelineDeps,
  opts: { lowConfidence?: Set<string> } = {},
): Promise<GradeItem[]> {
  const low = opts.lowConfidence ?? new Set<string>();
  const results: GradeItem[] = [];
  const pending: Question[] = [];

  for (const q of questions) {
    const ans = (answers.get(q.id) ?? '').trim();
    const std = (q.answer ?? '').trim();

    if (!ans) {
      results.push({
        questionId: q.id,
        score: 0,
        comment: '未作答',
        // 选择题是客观题，答对答错都由系统直接定，不进人工复核
        needsReview: q.kind === 'choice' ? false : low.has(q.id),
        source: 'rule',
        model: '',
      });
      continue;
    }
    if (!std) {
      results.push({
        questionId: q.id,
        score: 0,
        comment: '缺少标准答案，未评分',
        needsReview: q.kind !== 'choice',
        source: 'rule',
        model: '',
      });
      continue;
    }
    if (q.kind === 'choice') {
      const na = normalizeChoice(ans);
      const ns = normalizeChoice(std);
      const sorted = (x: string) => [...x].sort().join('');
      // 单选的场景下，允许 "B" / "B." / "选B" 这类写法
      const picked = ns.length === 1 ? (na.match(/[A-H]/)?.[0] ?? na) : na;
      const ok = !!picked && (picked === ns || (ns.length > 1 && sorted(picked) === sorted(ns)));
      results.push({
        questionId: q.id,
        score: ok ? q.maxScore : 0,
        comment: ok ? '正确' : `应选 ${std}`,
        needsReview: false,
        source: 'rule',
        model: '',
      });
      continue;
    }
    if (q.kind === 'fill' && sameAnswer(ans, std)) {
      results.push({ questionId: q.id, score: q.maxScore, comment: '与标准答案一致', needsReview: false, source: 'rule', model: '' });
      continue;
    }
    pending.push(q);
  }

  if (pending.length) {
    let aiGrades: Map<string, { score: number; comment: string; confidence: number }>;
    try {
      aiGrades = await gradeWithAi(deps, pending, answers, deps.log);
    } catch (err) {
      deps.log('warn', `批量评分失败，改为逐题评分：${(err as Error).message}`);
      aiGrades = new Map();
      for (const q of pending) {
        try {
          const one = await gradeWithAi(deps, [q], answers, deps.log);
          const v = one.get(q.id);
          if (v) aiGrades.set(q.id, v);
        } catch (e2) {
          deps.log('error', `第${q.no}题评分失败：${(e2 as Error).message}`);
        }
      }
    }

    for (const q of pending) {
      const g = aiGrades.get(q.id);
      if (!g) {
        results.push({
          questionId: q.id,
          score: 0,
          comment: 'AI 未能给出评分，请人工复核',
          needsReview: true,
          source: 'ai',
          model: deps.llm.textModel,
        });
        continue;
      }
      const flagged =
        low.has(q.id) ||
        g.confidence < 0.7 ||
        (g.score === 0 && (answers.get(q.id) ?? '').trim().length > 30) ||
        (g.score === q.maxScore && q.maxScore >= 8);
      results.push({
        questionId: q.id,
        score: g.score,
        comment: g.comment,
        needsReview: flagged,
        source: 'ai',
        model: deps.llm.textModel,
      });
    }
  }

  return results;
}


/* --------------------------- 模板模式识别 --------------------------- */

/**
 * 模板模式：定位四角 → 单应性校正 → 逐题裁切 → 涂卡/OCR 转写。
 * 一页里找不到定位块就返回 null，交给上游回退。
 */
export async function recognizeByTemplate(
  sheet: Sheet,
  buffer: Buffer,
  layout: SheetLayout,
  deps: PipelineDeps,
): Promise<RecognizeOutcome | null> {
  const images = await renderPages(buffer, {
    maxPages: Math.min(layout.pageCount + 2, 12),
    maxSide: MAX_SOURCE_SIDE,
    scale: 3,
    quality: 88,
  });
  if (!images.length) return null;

  const answers = new Map<string, { content: string; confidence: number; crop: string; mode: 'omr' | 'ocr' | 'vision' }>();
  const parts: CropPart[] = [];
  let nameCrop: Buffer | null = null;
  let noCrop: Buffer | null = null;
  let matchedPages = 0;

  for (const [idx, img] of images.entries()) {
    const page = layout.pages[idx];
    if (!page) continue;

    const raster = await loadRaster(img.jpeg, MAX_SOURCE_SIDE);
    deps.log('info', `第 ${idx + 1} 页 ${raster.width}×${raster.height}px（约 ${Math.round(raster.width / 210 * 25.4)}dpi）`);

    // 优先用四角定位块；找不到就退而用外框（很多人用浏览器直接打印，会丢掉黑色方块）
    let srcPts: { x: number; y: number }[] = page.markers.map((m) => ({ x: m.x, y: m.y }));
    let dstPts = detectMarkers(raster);
    if (!dstPts) {
      const framePts = detectFrameCorners(raster);
      if (!framePts) continue;
      srcPts = [
        { x: page.frame.x, y: page.frame.y },
        { x: page.frame.x + page.frame.w, y: page.frame.y },
        { x: page.frame.x + page.frame.w, y: page.frame.y + page.frame.h },
        { x: page.frame.x, y: page.frame.y + page.frame.h },
      ];
      dstPts = framePts;
      deps.log('info', '没找到四角定位块，改用外框对齐（建议打印时用「下载 PDF」，精度更高）');
    }

    const H = homography(srcPts, dstPts);
    if (!H) continue;
    if (!templateMatches(raster, H, page)) {
      deps.log('warn', '检测到定位块，但作答框位置与当前题目版式不符（可能改过题号后用了旧答题卡），已跳过模板模式');
      return null;
    }
    matchedPages++;

    for (const hb of page.header) {
      const crop = cropBox(raster, H, hb, { maxWidth: 700, quality: 84 });
      if (!crop) continue;
      if (hb.field === 'name') nameCrop = crop.jpeg;
      if (hb.field === 'no') noCrop = crop.jpeg;
    }

    for (const box of page.boxes) {
      if (box.qkind === 'choice' && box.bubbles?.length) {
        const r = readChoice(raster, H, box);
        const crop = cropBox(raster, H, box, { maxWidth: CROP_W, quality: 82 });
        answers.set(box.qid, {
          content: r.answer,
          confidence: r.confidence,
          crop: crop ? saveCrop(deps.dataDir, sheet.id, box.qid, crop.jpeg) : '',
          mode: 'omr',
        });
      } else {
        const crop = cropBox(raster, H, box, { maxWidth: CROP_W, quality: 84 });
        if (!crop) continue;
        const file = saveCrop(deps.dataDir, sheet.id, box.qid, crop.jpeg);
        parts.push({ no: box.no, qid: box.qid, jpeg: crop.jpeg });
        answers.set(box.qid, { content: '', confidence: 0, crop: file, mode: 'ocr' });
      }
    }
  }

  if (!matchedPages) return null;

  if (nameCrop) parts.unshift({ no: 'NAME', jpeg: nameCrop, isHeader: 'name' });
  if (noCrop) parts.unshift({ no: 'ID', jpeg: noCrop, isHeader: 'no' });

  deps.log('info', `命中答题卡模板：${matchedPages} 页，${answers.size} 个作答框`);

  let name = '';
  let studentNo = '';
  if (parts.some((p) => p.qid)) {
    const { map, name: n, studentNo: sn } = await transcribeCrops(parts, deps);
    name = n;
    studentNo = sn;
    for (const [qid, v] of map) {
      const prev = answers.get(qid);
      if (!prev) continue;
      answers.set(qid, {
        ...prev,
        content: v.content,
        confidence: prev.mode === 'ocr' ? v.confidence : prev.confidence,
        mode: v.content ? 'ocr' : prev.mode,
      });
    }
  } else {
    // 全是选择题时，姓名/学号仍需转写
    const headerParts = parts.filter((p) => p.isHeader);
    if (headerParts.length) {
      try {
        const { name: n, studentNo: sn } = await transcribeCrops(headerParts, deps);
        name = n;
        studentNo = sn;
      } catch (err) {
        deps.log('warn', `姓名/学号识别失败：${(err as Error).message}`);
      }
    }
  }

  const out = [...answers.entries()].map(([qid, v]) => ({
    questionId: qid,
    content: v.content,
    confidence: v.confidence,
    crop: v.crop || null,
    mode: v.mode,
  }));

  if (!out.length) return null;

  return {
    method: 'template',
    studentName: name,
    studentNo,
    answers: out,
    pageCount: images.length,
  };
}

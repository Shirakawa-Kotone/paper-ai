import type { QuestionKind } from '../shared/types.ts';
import { extractJson } from './llm.ts';
import { dataUrl, extractText, renderPages } from './pdf.ts';
import type { PipelineDeps } from './pipeline.ts';

export type ParsedQuestion = {
  no: string;
  kind: QuestionKind;
  maxScore: number;
  answer: string;
  note: string;
};

export type PaperImportResult = {
  questions: ParsedQuestion[];
  notes: string;
  method: 'text' | 'vision';
  title: string;
};

const KIND_MAP: Record<string, QuestionKind> = {
  选择: 'choice',
  单选: 'choice',
  多选: 'multi',
  '不定项': 'multi',
  choice: 'choice',
  填空: 'fill',
  默写: 'fill',
  fill: 'fill',
  方程式: 'equation',
  书写: 'equation',
  equation: 'equation',
  计算: 'calc',
  calc: 'calc',
  简答: 'short',
  问答: 'short',
  实验: 'short',
  short: 'short',
};

function toKind(raw: unknown): QuestionKind {
  const s = String(raw ?? '').trim();
  if (KIND_MAP[s as keyof typeof KIND_MAP]) return KIND_MAP[s];
  for (const [key, kind] of Object.entries(KIND_MAP)) {
    if (s.includes(key)) return kind;
  }
  return 'short';
}

function toScore(raw: unknown): number {
  const n = Number(String(raw ?? '').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 200 ? 0 : Math.round(n * 2) / 2;
}

const systemPrompt = (subject: string) =>
  `你是${subject}教研组的试卷录入助手。你只做"结构化提取"，不改题、不判分、不解释。
只输出一个 JSON 对象，不要 Markdown 代码块，不要任何多余文字。`;

function userPrompt(subject: string, questionHint: string): string {
  return `请把这份${subject}试卷的题目清单提取成结构化数据。

${questionHint}

输出 JSON：
{
  "title": "试卷标题（如 高二期中试卷）",
  "questions": [
    {"no":"1","kind":"choice","maxScore":3,"answer":"B"}
  ],
  "notes": "有什么不确定的地方，一句话说明"
}

提取规则：
1. 题号按试卷原样，不要重新编号；
2. kind 只能是 choice（单选题）/ multi（多选题）/ fill（填空题）/ equation（方程式、公式题）/ calc（计算题）/ short（简答题、实验题、说理题）；
3. maxScore 这道题的分值。题干或大题说明里写了"每小题 3 分""共 30 分"的，按说明算出单题分值；实在没有就填 0；
4. answer 是参考答案。试卷末尾附了答案就填；没有就留空字符串，不要自己编；
5. 只提取"需要学生作答"的题目，说明文字、卷头、答题卡说明不要算题；
6. 大题里带 (1)(2) 小问的，按题号拆成多条（如 17(1) → no "17-1"）。`;
}

export async function importPaper(
  buffer: Buffer,
  fileName: string,
  deps: PipelineDeps,
): Promise<PaperImportResult> {
  const text = await extractText(buffer, { maxPages: 12, maxChars: 30_000 });
  const usable = text.chars > 200;

  let messages;
  let method: 'text' | 'vision';
  let model: string;

  if (usable) {
    method = 'text';
    model = deps.llm.textModel;
    deps.log('info', `试卷文本层可用（${text.chars} 字），走文本解析`);
    messages = [
      { role: 'system' as const, content: systemPrompt(deps.subject) },
      {
        role: 'user' as const,
        content: `${userPrompt(deps.subject, '下面是试卷的文本内容（PDF 抽取，可能有换行错乱）：')}\n\n${text.text}`,
      },
    ];
  } else {
    method = 'vision';
    if (!deps.ai.visionModel?.trim()) {
      throw new Error('这份试卷是扫描件，需要先配置视觉模型才能识别');
    }
    model = deps.llm.visionModel;
    deps.log('info', '试卷没有文本层，改用视觉模型逐页识别');
    const pages = await renderPages(buffer, { maxPages: 8, maxSide: 2200, scale: 3, quality: 86 });
    if (!pages.length) throw new Error('无法读取这份文件，请确认是 PDF 或图片');
    messages = [
      { role: 'system' as const, content: systemPrompt(deps.subject) },
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: userPrompt(deps.subject, '下面是一份试卷的扫描页。') },
          ...pages.map((p) => ({
            type: 'image_url' as const,
            image_url: { url: dataUrl(p.jpeg), detail: 'high' as const },
          })),
        ],
      },
    ];
  }

  const res = await deps.llm.chat({ model, messages, json: true, maxTokens: 4000, temperature: 0, thinking: 'disabled' });
  const parsed = extractJson<{
    title?: string;
    notes?: string;
    questions?: { no?: string; kind?: string; maxScore?: number | string; answer?: string }[];
  }>(res.text);

  if (!parsed || !Array.isArray(parsed.questions) || !parsed.questions.length) {
    throw new Error('没能从试卷里解析出题目，请确认文件清晰、或改用文字版 PDF');
  }

  const questions: ParsedQuestion[] = [];
  const seen = new Set<string>();
  parsed.questions.forEach((q, i) => {
    let no = String(q.no ?? '').trim();
    if (!no) no = String(i + 1);
    no = no.replace(/^第\s*/, '').replace(/\s*题$/, '').trim();
    if (seen.has(no)) no = `${no}-${i}`;
    seen.add(no);
    questions.push({
      no,
      kind: toKind(q.kind),
      maxScore: toScore(q.maxScore),
      answer: String(q.answer ?? '').trim().slice(0, 3000),
      note: String(fileName ?? '').slice(0, 120),
    });
  });

  return {
    questions,
    notes: String(parsed.notes ?? '').slice(0, 500),
    method,
    title: String(parsed.title ?? '').slice(0, 120),
  };
}

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type {
  AiSettings,
  AiSettingsView,
  Question,
  Sheet,
} from '../shared/types.ts';
import * as db from './db.ts';
import { PROVIDERS, LlmClient, listModels, testConnection } from './llm.ts';
import { gradeSheet, recognizeSheet, type PipelineDeps } from './pipeline.ts';
import { buildLayout } from './template.ts';
import { imageToPdf, imagesToPdf, renderSheet } from './renderSheet.ts';
import { pdfPageCount, splitName, splitPdf } from './pdfSplit.ts';
import { importPaper } from './paperImport.ts';
import { buildReportWorkbook } from './excel.ts';
import * as jobs from './jobs.ts';

const CREATE_EXAM = z.object({
  name: z.string().trim().min(1, '考试名称不能为空').max(120),
  subject: z.string().trim().max(20).optional(),
  grade: z.string().trim().max(40).optional(),
});

const QUESTION = z.object({
  id: z.string().optional(),
  no: z.string().trim().min(1, '题号不能为空').max(20),
  kind: z.enum(['choice', 'multi', 'fill', 'equation', 'calc', 'short']),
  maxScore: z.number().min(0).max(200),
  answer: z.string().max(8000).optional().default(''),
  rubric: z.string().max(8000).optional().default(''),
});

const AI_PATCH = z.object({
  provider: z.enum(['deepseek', 'opencode-go', 'zhipu', 'moonshot', 'qwen', 'openai', 'ollama', 'custom']).optional(),
  baseURL: z.string().trim().max(500).optional(),
  apiKey: z.string().max(500).optional(),
  textModel: z.string().trim().max(120).optional(),
  visionModel: z.string().trim().max(120).optional(),
  jsonMode: z.boolean().optional(),
  concurrency: z.number().int().min(1).max(8).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

const OCR_PATCH = z.object({
  engine: z.enum(['none', 'tesseract', 'sidecar']).optional(),
  sidecarURL: z.string().trim().max(500).optional(),
  enabled: z.boolean().optional(),
});

export type AppContext = { dataDir: string };

const nowISO = () => new Date().toISOString();

/** 版本号从根 package.json 读，避免每处手写 */
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8')).version as string;
  } catch {
    return '0.0.0';
  }
})();

export function buildApi(ctx: AppContext) {
  const api = new Hono();

  const deps = (job?: jobs.Job, subject = '化学'): PipelineDeps => ({
    dataDir: ctx.dataDir,
    llm: LlmClient.from(db.getAiSettings()),
    ai: db.getAiSettings(),
    subject,
    log: (level, message) => {
      if (job) jobs.log(job, level, message);
      else console.log(`[pipeline] ${level}: ${message}`);
    },
  });

  api.onError((err, c) => {
    console.error('[api]', err);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  });

  /* ------------------------------- 健康检查 ------------------------------ */

  api.get('/health', (c) =>
    c.json({
      ok: true,
      version: VERSION,
      node: process.version,
      dataDir: ctx.dataDir,
      time: nowISO(),
    }),
  );

  /* -------------------------------- 设置 -------------------------------- */

  api.get('/settings', async (c) => {
    const ai = db.getAiSettings();
    const view: AiSettingsView = {
      ...ai,
      hasApiKey: !!ai.apiKey,
      apiKeyMask: ai.apiKey ? `${ai.apiKey.slice(0, 3)}…${ai.apiKey.slice(-4)}` : '',
    };
    return c.json({
      ai: view,
      providers: PROVIDERS,
      envKey: !!process.env.PAPER_AI_API_KEY,
    });
  });

  api.put('/settings/ai', async (c) => {
    const parsed = AI_PATCH.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不合法' }, 400);
    db.saveAiSettings(parsed.data as Partial<AiSettings>);
    return c.json({ ok: true });
  });

  api.post('/settings/models', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { baseURL?: string; apiKey?: string };
    const saved = db.getAiSettings();
    const baseURL = (body.baseURL ?? saved.baseURL ?? '').trim();
    const apiKey = (body.apiKey ?? '').trim() || saved.apiKey;
    try {
      const models = await listModels(baseURL, apiKey);
      return c.json({ models, visionCount: models.filter((m) => m.vision).length });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  api.post('/settings/test', async (c) => {
    const cfg = db.getAiSettings();
    if (!cfg.baseURL || (!cfg.apiKey && !/localhost|127\.0\.0\.1/.test(cfg.baseURL))) {
      return c.json({ error: '请先填写 Base URL 与 API Key' }, 400);
    }
    try {
      const r = await testConnection(cfg);
      return c.json({ ...r, ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  /* -------------------------------- 考试 -------------------------------- */

  api.get('/exams', (c) => c.json(db.listExams()));

  api.post('/exams', async (c) => {
    const parsed = CREATE_EXAM.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不合法' }, 400);
    const exam = db.createExam(parsed.data);
    return c.json(exam, 201);
  });

  api.get('/exams/:id', (c) => {
    const detail = db.getExamDetail(c.req.param('id'));
    if (!detail) return c.json({ error: '考试不存在' }, 404);
    return c.json(detail);
  });

  api.patch('/exams/:id', async (c) => {
    const id = c.req.param('id');
    if (!db.getExamRow(id)) return c.json({ error: '考试不存在' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Partial<{ name: string; subject: string; grade: string }>;
    db.updateExam(id, body);
    return c.json(db.getExamRow(id));
  });

  api.delete('/exams/:id', (c) => {
    const id = c.req.param('id');
    // 清掉答题卡文件
    for (const sh of db.listSheets(id)) {
      const p = path.join(ctx.dataDir, 'uploads', db.getSheetStoredName(sh.id));
      if (p && fs.existsSync(p)) fs.rmSync(p, { force: true });
    }
    db.deleteExam(id);
    return c.json({ ok: true });
  });

  api.put('/exams/:id/questions', async (c) => {
    const examId = c.req.param('id');
    if (!db.getExamRow(examId)) return c.json({ error: '考试不存在' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { questions?: unknown };
    const list = z.array(QUESTION).safeParse(body.questions);
    if (!list.success) return c.json({ error: list.error.issues[0]?.message ?? '题目数据不合法' }, 400);

    // 题号唯一性校验
    const seen = new Set<string>();
    for (const q of list.data) {
      if (seen.has(q.no)) return c.json({ error: `题号「${q.no}」重复，请修改后再保存` }, 400);
      seen.add(q.no);
    }

    const saved = db.replaceQuestions(
      examId,
      list.data.map((q) => ({
        id: q.id && q.id.length > 0 ? q.id : randomUUID(),
        no: q.no,
        kind: q.kind,
        maxScore: q.maxScore,
        answer: q.answer ?? '',
        rubric: q.rubric ?? '',
        sort: 0,
      })) as Omit<Question, 'examId'>[],
    );
    return c.json(saved);
  });

  /* ------------------------------- 答题卡 ------------------------------- */

  api.post('/exams/:id/sheets', async (c) => {
    const examId = c.req.param('id');
    if (!db.getExamRow(examId)) return c.json({ error: '考试不存在' }, 404);

    const form = await c.req.formData();
    // 整班一个 PDF 时，按每份答题卡 N 页自动拆分（0/1 = 不拆）
    const groupSize = Math.max(0, Math.min(20, Number(form.get('groupSize') ?? 0) || 0));
    const files: File[] = [];
    for (const [, v] of form.entries()) {
      if (v && typeof v === 'object' && 'arrayBuffer' in v) files.push(v as File);
    }
    if (!files.length) return c.json({ error: '没有收到文件' }, 400);
    if (files.length > 60) return c.json({ error: '一次最多上传 60 份' }, 400);

    const uploads = path.join(ctx.dataDir, 'uploads');
    fs.mkdirSync(uploads, { recursive: true });

    const created: Sheet[] = [];
    const skipped: string[] = [];
    const splitInfo: { name: string; pages: number; parts: number }[] = [];
    for (const f of files) {
      const isPdf = /\.pdf$/i.test(f.name);
      const isImage = /\.(jpe?g|png|webp)$/i.test(f.name);
      if (!isPdf && !isImage) {
        skipped.push(`${f.name}（只支持 PDF / JPG / PNG）`);
        continue;
      }
      if (f.size > 40 * 1024 * 1024) {
        skipped.push(`${f.name}（超过 40MB）`);
        continue;
      }
      let buf: Buffer = Buffer.from(await f.arrayBuffer());

      if (isPdf) {
        if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
          skipped.push(`${f.name}（文件头不是 PDF，可能已损坏）`);
          continue;
        }
      } else {
        const head = buf.subarray(0, 12);
        const isJpeg = head[0] === 0xff && head[1] === 0xd8;
        const isPng = head.subarray(0, 4).toString('latin1') === '\x89PNG';
        const isWebp = head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
        if (!isJpeg && !isPng && !isWebp) {
          skipped.push(`${f.name}（文件头不像图片）`);
          continue;
        }
        try {
          // 手机照片统一转成一页 PDF，后续流程完全一样
          buf = await imageToPdf(buf);
        } catch (err) {
          skipped.push(`${f.name}（图片解码失败：${(err as Error).message}）`);
          continue;
        }
      }
      let parts: { buf: Buffer; name: string }[] = [{ buf, name: f.name }];
      if (isPdf && groupSize > 1) {
        try {
          const pages = await pdfPageCount(buf);
          if (pages > groupSize) {
            if (pages % groupSize === 0) {
              const chunks = await splitPdf(buf, groupSize);
              parts = chunks.map((b, i) => ({ buf: b, name: splitName(f.name, i, chunks.length) }));
              splitInfo.push({ name: f.name, pages, parts: chunks.length });
            } else {
              skipped.push(`${f.name}（共 ${pages} 页，不能被 ${groupSize} 整除，按一份处理）`);
            }
          }
        } catch (err) {
          skipped.push(`${f.name}（拆分失败，按一份处理：${(err as Error).message}）`);
        }
      }

      for (const part of parts) {
        if (part.buf.length > 40 * 1024 * 1024) {
          skipped.push(`${part.name}（超过 40MB）`);
          continue;
        }
        const id = randomUUID();
        const storedName = `${id}.pdf`;
        fs.writeFileSync(path.join(uploads, storedName), part.buf);
        created.push(db.createSheet({ id, examId, fileName: part.name, storedName }));
      }
    }
    return c.json({ sheets: created, skipped, split: splitInfo }, 201);
  });

  api.patch('/sheets/:id', async (c) => {
    const id = c.req.param('id');
    const sheet = db.getSheet(id);
    if (!sheet) return c.json({ error: '答题卡不存在' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      studentName?: string;
      studentNo?: string;
      answers?: Record<string, string>;
      status?: string;
    };
    if (body.studentName !== undefined || body.studentNo !== undefined) {
      db.updateSheet(id, {
        studentName: body.studentName ?? sheet.studentName,
        studentNo: body.studentNo ?? sheet.studentNo,
      });
    }
    if (body.answers) {
      const questions = db.listQuestions(sheet.examId);
      const valid = new Set(questions.map((q) => q.id));
      for (const [qid, content] of Object.entries(body.answers)) {
        if (!valid.has(qid)) continue;
        db.setAnswer(id, qid, String(content ?? ''), null);
      }
      if (sheet.status !== 'recognized') db.updateSheet(id, { status: 'recognized', method: 'manual' });
    }
    return c.json(db.getSheet(id));
  });

  api.delete('/sheets/:id', (c) => {
    const id = c.req.param('id');
    const stored = db.getSheetStoredName(id);
    if (stored) {
      const p = path.join(ctx.dataDir, 'uploads', stored);
      if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    }
    db.deleteSheet(id);
    return c.json({ ok: true });
  });

  /* ------------------------------ 试卷导入 ------------------------------ */

  api.post('/exams/:id/import-paper', async (c) => {
    const examId = c.req.param('id');
    const examRow = db.getExamRow(examId);
    if (!examRow) return c.json({ error: '考试不存在' }, 404);

    const form = await c.req.formData();
    let file: File | null = null;
    for (const [, v] of form.entries()) {
      if (v && typeof v === 'object' && 'arrayBuffer' in v) {
        file = v as File;
        break;
      }
    }
    if (!file) return c.json({ error: '没有收到文件' }, 400);
    if (!/\.(pdf|png|jpe?g)$/i.test(file.name)) {
      return c.json({ error: '只支持 PDF 或图片' }, 400);
    }
    if (file.size > 40 * 1024 * 1024) return c.json({ error: '文件超过 40MB' }, 400);

    const ai = db.getAiSettings();
    if (!ai.baseURL) return c.json({ error: '请先在设置里配置模型接口' }, 400);

    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const d = deps(undefined, examRow.subject);
      const result = await importPaper(buffer, file.name, d);
      return c.json(result);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  /* ------------------------------ 答题卡模板 ----------------------------- */

  const layoutFor = (examId: string) => {
    const detail = db.getExamDetail(examId);
    if (!detail) return null;
    if (!detail.questions.length) return null;
    const stored = db.getExamLayout<ReturnType<typeof buildLayout>>(examId);
    // 题目变化后旧版式失效：以题目数量/总分/题号指纹判断
    const fingerprint = (l: ReturnType<typeof buildLayout>) =>
      l.pages.flatMap((p) => p.boxes.map((b) => `${b.no}:${b.qkind}`)).join('|');
    const fresh = buildLayout({ id: detail.id, name: detail.name, grade: detail.grade, questions: detail.questions });
    if (stored && fingerprint(stored) === fingerprint(fresh)) return stored;
    return fresh;
  };

  api.get('/exams/:id/template', (c) => {
    const layout = layoutFor(c.req.param('id'));
    if (!layout) return c.json({ error: '请先设置试题后再生成答题卡' }, 400);
    return c.json(layout);
  });

  api.get('/exams/:id/template.pdf', (c) => {
    const layout = layoutFor(c.req.param('id'));
    if (!layout) return c.json({ error: '请先设置试题后再生成答题卡' }, 400);
    db.setExamLayout(layout.examId, layout);
    const pages = renderSheet(layout);
    const pdf = imagesToPdf(pages);
    const name = encodeURIComponent(`${layout.examName || '答题卡'}-答题卡.pdf`);
    return c.body(new Uint8Array(pdf), 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename*=UTF-8''${name}`,
      'Cache-Control': 'no-store',
    });
  });

  api.get('/sheets/:id/crops/:key', (c) => {
    const sheetId = c.req.param('id');
    const key = c.req.param('key').replace(/[^a-zA-Z0-9_.-]/g, '');
    if (!key.endsWith('.jpg')) return c.json({ error: '不支持的文件' }, 400);
    const file = path.join(ctx.dataDir, 'crops', sheetId, key);
    if (!fs.existsSync(file)) return c.json({ error: '裁切图不存在' }, 404);
    const buf = fs.readFileSync(file);
    return c.body(new Uint8Array(buf), 200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });

  api.patch('/sheets/:id/answers/:questionId', async (c) => {
    const sheetId = c.req.param('id');
    const questionId = c.req.param('questionId');
    const sheet = db.getSheet(sheetId);
    if (!sheet) return c.json({ error: '答题卡不存在' }, 404);
    const q = db.listQuestions(sheet.examId).find((x) => x.id === questionId);
    if (!q) return c.json({ error: '题目不存在' }, 404);

    const body = (await c.req.json().catch(() => ({}))) as { content?: string };
    db.setAnswer(sheetId, questionId, String(body.content ?? '').slice(0, 4000), null, null, 'manual');
    return c.json({ ok: true });
  });

  /* -------------------------------- 任务 -------------------------------- */

  api.post('/exams/:id/recognize', async (c) => {
    const examId = c.req.param('id');
    const detail = db.getExamDetail(examId);
    if (!detail) return c.json({ error: '考试不存在' }, 404);
    if (!detail.questions.length) return c.json({ error: '请先设置试题' }, 400);

    const body = (await c.req.json().catch(() => ({}))) as { sheetIds?: string[]; force?: boolean };
    const pool = detail.sheets.filter((s) => !body.sheetIds?.length || body.sheetIds.includes(s.id));
    const targets = pool.filter((s) => body.force || s.status !== 'recognized');
    if (!targets.length) return c.json({ error: '没有需要识别的答题卡（都已识别完成）' }, 400);

    const ai = db.getAiSettings();
    if (!ai.baseURL) return c.json({ error: '请先在设置中配置模型接口' }, 400);

    const job = jobs.createJob('recognize', examId, targets.length);
    jobs.log(job, 'info', `开始识别 ${targets.length} 份答题卡`);

    void (async () => {
      try {
        const d = deps(job, detail.subject);
        await jobs.runPool(
          targets,
          Math.max(1, Math.min(2, ai.concurrency)),
          async (sh) => {
            jobs.setCurrent(job, sh.fileName);
            db.updateSheet(sh.id, { status: 'recognizing', error: '' });
            try {
              const stored = db.getSheetStoredName(sh.id);
              const r = await recognizeSheet({ ...sh, status: 'recognizing' }, stored, detail.questions, d, db.getExamLayout(detail.id));
              db.replaceAnswers(
                sh.id,
                r.answers.map((a) => ({
                  questionId: a.questionId,
                  content: a.content,
                  confidence: a.confidence,
                  crop: a.crop ?? null,
                  mode: (a.mode as never) ?? null,
                })),
              );
              db.updateSheet(sh.id, {
                status: 'recognized',
                studentName: r.studentName || sh.studentName,
                studentNo: r.studentNo || sh.studentNo,
                method: r.method,
                error: '',
              });
              const methodLabel =
                r.method === 'text'
                  ? '文本层'
                  : r.method === 'vision'
                    ? '视觉模型'
                    : r.method === 'template'
                      ? '模板裁切'
                      : r.method === 'generic'
                        ? '版面分析'
                        : '本地OCR';
              const filled = r.answers.filter((a) => (a.content ?? '').trim()).length;
              if (!filled) throw new Error('没有识别出任何作答内容（裁切成功，但文字转写为空）');
              jobs.log(
                job,
                'info',
                `${r.studentName || sh.fileName}：识别到 ${filled}/${r.answers.length} 题有作答（${methodLabel}）`,
              );
              jobs.tick(job);
            } catch (err) {
              const msg = (err as Error).message;
              db.updateSheet(sh.id, { status: 'failed', error: msg });
              jobs.log(job, 'error', `${sh.fileName} 识别失败：${msg}`);
              jobs.tick(job, { failed: true });
            }
          },
          () => job.cancelled,
        );
        const lastErr = [...job.logs].reverse().find((l) => l.level === 'error')?.message ?? '未知错误';
        const allFailed = job.done > 0 && job.failed === job.done;
        jobs.finish(
          job,
          job.cancelled ? 'cancelled' : allFailed ? 'failed' : 'done',
          job.cancelled ? '已取消' : allFailed ? `全部失败：${lastErr}` : `识别完成${job.failed ? `（${job.failed} 份失败）` : ''}`,
        );
      } catch (err) {
        jobs.finish(job, 'failed', (err as Error).message);
      }
    })();

    return c.json({ job: jobs.view(job) }, 202);
  });

  api.post('/exams/:id/grade', async (c) => {
    const examId = c.req.param('id');
    const detail = db.getExamDetail(examId);
    if (!detail) return c.json({ error: '考试不存在' }, 404);
    if (!detail.questions.length) return c.json({ error: '请先设置试题' }, 400);

    const body = (await c.req.json().catch(() => ({}))) as {
      sheetIds?: string[];
      force?: boolean;
      forceManual?: boolean;
    };
    const ready = detail.sheets.filter((s) => Object.keys(s.answers).length > 0);
    const pool = ready.filter((s) => !body.sheetIds?.length || body.sheetIds.includes(s.id));
    if (!pool.length) return c.json({ error: '还没有已识别的答题卡' }, 400);

    const ai = db.getAiSettings();
    if (!ai.baseURL) return c.json({ error: '请先在设置中配置模型接口' }, 400);
    if (!ai.textModel) return c.json({ error: '请先配置文本模型' }, 400);

    // 非强制模式下跳过"每题都已有评分"的答题卡，避免重复烧钱
    const fullyGraded = (sh: (typeof pool)[number]) => detail.questions.every((q) => sh.grades[q.id]);
    const targets = body.force ? pool : pool.filter((sh) => !fullyGraded(sh));
    if (!targets.length) {
      return c.json(
        { error: '这些答题卡都已经批改过了；要重跑请点「全部重批」（会重新调用模型）' },
        400,
      );
    }

    const job = jobs.createJob('grade', examId, targets.length);
    jobs.log(job, 'info', `开始批改 ${targets.length} 份答题卡（并发 ${ai.concurrency}）`);

    void (async () => {
      try {
        const d = deps(job, detail.subject);
        await jobs.runPool(
          targets,
          Math.max(1, Math.min(ai.concurrency, 6)),
          async (sh) => {
            jobs.setCurrent(job, sh.studentName || sh.fileName);
            try {
              const answers = new Map(Object.entries(sh.answers).map(([k, v]) => [k, v.content]));
              const lowConfidence = new Set(
                Object.entries(sh.answers)
                  .filter(([, v]) => (v.confidence ?? 1) < 0.62)
                  .map(([k]) => k),
              );
              const computed = await gradeSheet(detail.questions, answers, d, { lowConfidence });

              // 保护人工评分
              const existing = new Map(Object.entries(sh.grades).map(([k, v]) => [k, v]));
              let manualKept = 0;
              for (const g of computed) {
                const prev = existing.get(g.questionId);
                if (prev && prev.source === 'manual' && !body.forceManual) {
                  manualKept++;
                  continue;
                }
                if (prev && prev.source === 'manual' && body.forceManual) {
                  // 允许覆盖，但保留备注
                }
                db.upsertGrade(sh.id, g.questionId, {
                  score: g.score,
                  comment: g.comment,
                  needsReview: g.needsReview,
                  source: g.source,
                  model: g.model,
                });
              }
              const flagged = computed.filter((g) => g.needsReview).length;
              jobs.log(
                job,
                'info',
                `${sh.studentName || sh.fileName}：完成 ${computed.length} 题${flagged ? `，${flagged} 题待复核` : ''}${manualKept ? `，保留 ${manualKept} 处人工评分` : ''}`,
              );
              jobs.tick(job);
            } catch (err) {
              jobs.log(job, 'error', `${sh.studentName || sh.fileName} 批改失败：${(err as Error).message}`);
              jobs.tick(job, { failed: true });
            }
          },
          () => job.cancelled,
        );
        jobs.finish(job, job.cancelled ? 'cancelled' : 'done', job.cancelled ? '已取消' : '批改完成');
      } catch (err) {
        jobs.finish(job, 'failed', (err as Error).message);
      }
    })();

    return c.json({ job: jobs.view(job) }, 202);
  });

  api.patch('/sheets/:sheetId/grades/:questionId', async (c) => {
    const sheetId = c.req.param('sheetId');
    const questionId = c.req.param('questionId');
    const sheet = db.getSheet(sheetId);
    if (!sheet) return c.json({ error: '答题卡不存在' }, 404);
    const q = db.listQuestions(sheet.examId).find((x) => x.id === questionId);
    if (!q) return c.json({ error: '题目不存在' }, 404);

    const body = (await c.req.json().catch(() => ({}))) as { score?: number; comment?: string; needsReview?: boolean };
    const score = Number(body.score);
    if (!Number.isFinite(score) || score < 0 || score > q.maxScore) {
      return c.json({ error: `分数必须在 0 ~ ${q.maxScore} 之间` }, 400);
    }
    db.upsertGrade(sheetId, questionId, {
      score,
      comment: String(body.comment ?? '').slice(0, 500),
      needsReview: body.needsReview ?? false,
      source: 'manual',
      model: '',
    });
    return c.json({ ok: true });
  });

  /* -------------------------------- 报表 -------------------------------- */

  api.get('/exams/:id/report', (c) => {
    const pass = Number(c.req.query('pass') ?? 60);
    const excellent = Number(c.req.query('excellent') ?? 85);
    const report = db.getReport(c.req.param('id'), pass, excellent);
    if (!report) return c.json({ error: '考试不存在' }, 404);
    return c.json(report);
  });

  api.get('/exams/:id/export.xlsx', async (c) => {
    const report = db.getReport(c.req.param('id'));
    if (!report) return c.json({ error: '考试不存在' }, 404);
    const buf = await buildReportWorkbook(report);
    return c.body(new Uint8Array(buf), 200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${report.exam.name || '成绩单'}-成绩单.xlsx`)}`,
      'Cache-Control': 'no-store',
    });
  });

  api.get('/exams/:id/export.csv', (c) => {
    const report = db.getReport(c.req.param('id'));
    if (!report) return c.json({ error: '考试不存在' }, 404);

    const cell = (v: unknown) => {
      const s = String(v ?? '');
      // 防止 Excel 把以 = + - @ 开头的内容当公式执行
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const header = [
      '名次',
      '姓名',
      '学号',
      ...report.questions.map((q) => `${q.no}(${q.maxScore}分)`),
      '总分',
      '得分率%',
      '等级',
      '待复核题数',
      ...report.questions.map((q) => `${q.no}评语`),
    ];
    const lines = [header.map(cell).join(',')];
    for (const r of report.rows) {
      lines.push(
        [
          r.rank,
          r.studentName,
          r.studentNo,
          ...report.questions.map((q) => r.scores[q.id] ?? ''),
          r.total,
          (r.rate * 100).toFixed(1),
          r.grade,
          r.needsReview,
          ...report.questions.map((q) => r.comments[q.id] ?? ''),
        ]
          .map(cell)
          .join(','),
      );
    }
    const csv = '\uFEFF' + lines.join('\r\n');
    const filename = encodeURIComponent(`${report.exam.name || '成绩单'}-成绩单.csv`);
    return c.body(csv, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
    });
  });

  /* -------------------------------- 任务查询 ----------------------------- */

  api.get('/jobs', (c) => c.json(jobs.listJobs()));

  api.get('/jobs/:id', (c) => {
    const job = jobs.getJob(c.req.param('id'));
    if (!job) return c.json({ error: '任务不存在' }, 404);
    return c.json({ ...jobs.view(job), logs: job.logs });
  });

  api.post('/jobs/:id/cancel', (c) => {
    const ok = jobs.cancelJob(c.req.param('id'));
    return c.json({ ok });
  });

  api.get('/jobs/:id/events', (c) => {
    const id = c.req.param('id');
    const job = jobs.getJob(id);
    if (!job) return c.json({ error: '任务不存在' }, 404);

    return streamSSE(c, async (stream) => {
      let logCursor = 0;
      let lastState = '';
      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
      });

      // 先补发历史
      for (const l of job.logs) await stream.writeSSE({ data: JSON.stringify({ type: 'log', ...l }) });
      logCursor = job.logs.length;
      await stream.writeSSE({ data: JSON.stringify({ type: 'snapshot', job: jobs.view(job) }) });

      while (!aborted) {
        const state = `${job.status}|${job.done}|${job.failed}|${job.total}|${job.current}`;
        if (state !== lastState) {
          lastState = state;
          await stream.writeSSE({
            data: JSON.stringify({
              type: 'progress',
              done: job.done,
              failed: job.failed,
              total: job.total,
              current: job.current,
            }),
          });
        }
        while (logCursor < job.logs.length) {
          const l = job.logs[logCursor++];
          await stream.writeSSE({ data: JSON.stringify({ type: 'log', ...l }) });
        }
        if (job.status !== 'running') {
          await stream.writeSSE({
            data: JSON.stringify({
              type: 'done',
              status: job.status,
              failed: job.failed,
              message: job.logs.at(-1)?.message ?? '任务结束',
            }),
          });
          break;
        }
        await stream.sleep(350);
      }
    });
  });

  return api;
}

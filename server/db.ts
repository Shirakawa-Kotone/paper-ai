import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AiSettings,
  Answer,
  Exam,
  ExamDetail,
  ExamReport,
  Grade,
  Question,
  QuestionKind,
  Sheet,
  SheetDetail,
  SheetStatus,
} from '../shared/types.ts';

export type DB = DatabaseSync;

let db: DB;

const now = () => new Date().toISOString();
const n = (v: unknown) => Number(v ?? 0);
const s = (v: unknown) => (v == null ? '' : String(v));

export function initDB(dataDir: string): DB {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'paper-ai.db');
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  migrate();
  return db;
}

export function getDB(): DB {
  if (!db) throw new Error('数据库尚未初始化');
  return db;
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS exam (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '化学',
      grade TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS question (
      id TEXT PRIMARY KEY,
      exam_id TEXT NOT NULL REFERENCES exam(id) ON DELETE CASCADE,
      no TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'short',
      max_score REAL NOT NULL DEFAULT 0,
      answer TEXT NOT NULL DEFAULT '',
      rubric TEXT NOT NULL DEFAULT '',
      sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_question_exam ON question(exam_id, sort);
    CREATE TABLE IF NOT EXISTS sheet (
      id TEXT PRIMARY KEY,
      exam_id TEXT NOT NULL REFERENCES exam(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      stored_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'uploaded',
      student_name TEXT NOT NULL DEFAULT '',
      student_no TEXT NOT NULL DEFAULT '',
      method TEXT,
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sheet_exam ON sheet(exam_id, created_at);
    CREATE TABLE IF NOT EXISTS answer (
      sheet_id TEXT NOT NULL REFERENCES sheet(id) ON DELETE CASCADE,
      question_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      confidence REAL,
      PRIMARY KEY (sheet_id, question_id)
    );
    CREATE TABLE IF NOT EXISTS grade (
      sheet_id TEXT NOT NULL REFERENCES sheet(id) ON DELETE CASCADE,
      question_id TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      comment TEXT NOT NULL DEFAULT '',
      needs_review INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'ai',
      model TEXT NOT NULL DEFAULT '',
      graded_at TEXT NOT NULL,
      PRIMARY KEY (sheet_id, question_id)
    );
    CREATE TABLE IF NOT EXISTS setting (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
  `);
  ensureColumn('exam', 'layout', 'layout TEXT');
  ensureColumn('exam', 'layout_at', 'layout_at TEXT');
  ensureColumn('answer', 'crop', 'crop TEXT');
  ensureColumn('answer', 'mode', 'mode TEXT');

  // 历史数据里题目换过 id，会留下指向已删题目的作答/评分；启动时清一次
  db.exec('DELETE FROM answer WHERE question_id NOT IN (SELECT id FROM question)');
  db.exec('DELETE FROM grade WHERE question_id NOT IN (SELECT id FROM question)');
}

function ensureColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

/* ---------------------------------- exam --------------------------------- */

function mapExam(r: Record<string, unknown>): Exam {
  return {
    id: s(r.id),
    name: s(r.name),
    subject: s(r.subject),
    grade: s(r.grade),
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
  };
}

export function getExamLayout<T = unknown>(examId: string): T | null {
  const r = db.prepare('SELECT layout, layout_at FROM exam WHERE id = ?').get(examId) as Record<string, unknown> | undefined;
  if (!r?.layout) return null;
  try {
    return JSON.parse(s(r.layout)) as T;
  } catch {
    return null;
  }
}

export function setExamLayout(examId: string, layout: unknown): void {
  db.prepare('UPDATE exam SET layout = ?, layout_at = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(layout),
    now(),
    now(),
    examId,
  );
}

export function listExams(): (Exam & { questionCount: number; sheetCount: number; gradedCount: number })[] {
  const rows = db
    .prepare(
      `SELECT e.*,
        (SELECT COUNT(*) FROM question q WHERE q.exam_id = e.id) AS question_count,
        (SELECT COUNT(*) FROM sheet s WHERE s.exam_id = e.id) AS sheet_count,
        (SELECT COUNT(DISTINCT g.sheet_id) FROM grade g JOIN sheet s2 ON s2.id = g.sheet_id WHERE s2.exam_id = e.id) AS graded_count
       FROM exam e ORDER BY e.created_at DESC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    ...mapExam(r),
    questionCount: n(r.question_count),
    sheetCount: n(r.sheet_count),
    gradedCount: n(r.graded_count),
  }));
}

export function createExam(input: { name: string; subject?: string; grade?: string }): Exam {
  const id = randomUUID();
  const t = now();
  db.prepare('INSERT INTO exam (id, name, subject, grade, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    input.name,
    input.subject ?? '化学',
    input.grade ?? '',
    t,
    t,
  );
  return getExamRow(id)!;
}

export function getExamRow(id: string): Exam | undefined {
  const r = db.prepare('SELECT * FROM exam WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? mapExam(r) : undefined;
}

export function updateExam(id: string, patch: Partial<Pick<Exam, 'name' | 'subject' | 'grade'>>): void {
  const cur = getExamRow(id);
  if (!cur) return;
  db.prepare('UPDATE exam SET name = ?, subject = ?, grade = ?, updated_at = ? WHERE id = ?').run(
    patch.name ?? cur.name,
    patch.subject ?? cur.subject,
    patch.grade ?? cur.grade,
    now(),
    id,
  );
}

export function deleteExam(id: string): void {
  db.prepare('DELETE FROM exam WHERE id = ?').run(id);
}

/* -------------------------------- question ------------------------------- */

function mapQuestion(r: Record<string, unknown>): Question {
  return {
    id: s(r.id),
    examId: s(r.exam_id),
    no: s(r.no),
    kind: s(r.kind) as QuestionKind,
    maxScore: n(r.max_score),
    answer: s(r.answer),
    rubric: s(r.rubric),
    sort: n(r.sort),
  };
}

export function listQuestions(examId: string): Question[] {
  const rows = db.prepare('SELECT * FROM question WHERE exam_id = ? ORDER BY sort ASC, no ASC').all(examId) as Record<
    string,
    unknown
  >[];
  return rows.map(mapQuestion);
}

export function replaceQuestions(examId: string, list: Omit<Question, 'examId'>[]): Question[] {
  const tx = db.prepare('SELECT 1');
  void tx;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM question WHERE exam_id = ?').run(examId);
    const insert = db.prepare(
      'INSERT INTO question (id, exam_id, no, kind, max_score, answer, rubric, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    list.forEach((q, i) => {
      insert.run(q.id || randomUUID(), examId, q.no, q.kind, q.maxScore, q.answer ?? '', q.rubric ?? '', i);
    });
    // 题目换了 id 后，指向旧题的作答和评分会变成孤儿（成绩单里会重复计数），一并清掉
    db.prepare('DELETE FROM answer WHERE question_id NOT IN (SELECT id FROM question)').run();
    db.prepare('DELETE FROM grade WHERE question_id NOT IN (SELECT id FROM question)').run();

    db.prepare('UPDATE exam SET updated_at = ? WHERE id = ?').run(now(), examId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return listQuestions(examId);
}

/* ---------------------------------- sheet -------------------------------- */

function mapSheet(r: Record<string, unknown>): Sheet {
  return {
    id: s(r.id),
    examId: s(r.exam_id),
    fileName: s(r.file_name),
    status: s(r.status) as SheetStatus,
    studentName: s(r.student_name),
    studentNo: s(r.student_no),
    method: (r.method as Sheet['method']) ?? null,
    error: s(r.error),
    createdAt: s(r.created_at),
  };
}

export function createSheet(input: {
  id?: string;
  examId: string;
  fileName: string;
  storedName: string;
}): Sheet {
  const id = input.id ?? randomUUID();
  db.prepare(
    'INSERT INTO sheet (id, exam_id, file_name, stored_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, input.examId, input.fileName, input.storedName, 'uploaded', now());
  return getSheet(id)!;
}

export function getSheet(id: string): Sheet | undefined {
  const r = db.prepare('SELECT * FROM sheet WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? mapSheet(r) : undefined;
}

export function getSheetStoredName(id: string): string {
  const r = db.prepare('SELECT stored_name FROM sheet WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return s(r?.stored_name);
}

export function listSheets(examId: string): Sheet[] {
  const rows = db.prepare('SELECT * FROM sheet WHERE exam_id = ? ORDER BY created_at ASC').all(examId) as Record<
    string,
    unknown
  >[];
  return rows.map(mapSheet);
}

export function updateSheet(
  id: string,
  patch: Partial<{
    status: SheetStatus;
    studentName: string;
    studentNo: string;
    method: Sheet['method'];
    error: string;
  }>,
): void {
  const cur = getSheet(id);
  if (!cur) return;
  db.prepare(
    'UPDATE sheet SET status = ?, student_name = ?, student_no = ?, method = ?, error = ? WHERE id = ?',
  ).run(
    patch.status ?? cur.status,
    patch.studentName ?? cur.studentName,
    patch.studentNo ?? cur.studentNo,
    patch.method === undefined ? cur.method : patch.method,
    patch.error ?? cur.error,
    id,
  );
}

export function deleteSheet(id: string): void {
  db.prepare('DELETE FROM sheet WHERE id = ?').run(id);
}

/* --------------------------------- answer -------------------------------- */

export function listAnswers(sheetId: string): Answer[] {
  const rows = db.prepare('SELECT * FROM answer WHERE sheet_id = ?').all(sheetId) as Record<string, unknown>[];
  return rows.map((r) => ({
    questionId: s(r.question_id),
    content: s(r.content),
    confidence: r.confidence == null ? null : n(r.confidence),
    crop: r.crop ? s(r.crop) : null,
    mode: r.mode ? (s(r.mode) as Answer['mode']) : null,
  }));
}

export function setAnswer(
  sheetId: string,
  questionId: string,
  content: string,
  confidence: number | null,
  crop?: string | null,
  mode?: string | null,
): void {
  db.prepare(
    `INSERT INTO answer (sheet_id, question_id, content, confidence, crop, mode) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(sheet_id, question_id) DO UPDATE SET
       content = excluded.content,
       confidence = excluded.confidence,
       crop = COALESCE(excluded.crop, answer.crop),
       mode = COALESCE(excluded.mode, answer.mode)`,
  ).run(sheetId, questionId, content, confidence, crop ?? null, mode ?? null);
}

export function replaceAnswers(sheetId: string, answers: Answer[]): void {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM answer WHERE sheet_id = ?').run(sheetId);
    for (const a of answers) setAnswer(sheetId, a.questionId, a.content, a.confidence, a.crop, a.mode);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* --------------------------------- grade --------------------------------- */

export function listGrades(sheetId: string): Grade[] {
  const rows = db.prepare('SELECT * FROM grade WHERE sheet_id = ?').all(sheetId) as Record<string, unknown>[];
  return rows.map(mapGrade);
}

function mapGrade(r: Record<string, unknown>): Grade {
  return {
    questionId: s(r.question_id),
    score: n(r.score),
    comment: s(r.comment),
    needsReview: n(r.needs_review) === 1,
    source: s(r.source) as Grade['source'],
    model: s(r.model),
    gradedAt: s(r.graded_at),
  };
}

export function upsertGrade(
  sheetId: string,
  questionId: string,
  g: Omit<Grade, 'gradedAt' | 'questionId'> & { gradedAt?: string },
): void {
  db.prepare(
    `INSERT INTO grade (sheet_id, question_id, score, comment, needs_review, source, model, graded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sheet_id, question_id) DO UPDATE SET
       score = excluded.score, comment = excluded.comment, needs_review = excluded.needs_review,
       source = excluded.source, model = excluded.model, graded_at = excluded.graded_at`,
  ).run(
    sheetId,
    questionId,
    g.score,
    g.comment,
    g.needsReview ? 1 : 0,
    g.source,
    g.model,
    g.gradedAt ?? now(),
  );
}

export function clearGrades(sheetId: string, onlyAi = true): void {
  if (onlyAi) db.prepare("DELETE FROM grade WHERE sheet_id = ? AND source <> 'manual'").run(sheetId);
  else db.prepare('DELETE FROM grade WHERE sheet_id = ?').run(sheetId);
}

/* ---------------------------------- views -------------------------------- */

export function getExamDetail(examId: string): ExamDetail | undefined {
  const exam = getExamRow(examId);
  if (!exam) return undefined;
  const questions = listQuestions(examId);
  const fullScore = questions.reduce((a, q) => a + q.maxScore, 0);
  const sheets = listSheets(examId).map((sh) => {
    const answers = Object.fromEntries(listAnswers(sh.id).map((a) => [a.questionId, a]));
    const grades = Object.fromEntries(listGrades(sh.id).map((g) => [g.questionId, g]));
    const total = questions.reduce((a, q) => a + (grades[q.id]?.score ?? 0), 0);
    return {
      ...sh,
      answers,
      grades,
      total,
      fullScore,
      gradedCount: Object.keys(grades).length,
    } satisfies SheetDetail;
  });
  return {
    ...exam,
    questions,
    layout: getExamLayout(examId),
    layoutAt: (() => {
      const r = db.prepare('SELECT layout_at FROM exam WHERE id = ?').get(examId) as Record<string, unknown> | undefined;
      return r?.layout_at ? s(r.layout_at) : null;
    })(),
    fullScore,
    sheets,
    recognizedCount: sheets.filter((x) => x.status === 'recognized').length,
    gradedCount: sheets.filter((x) => x.gradedCount === questions.length && questions.length > 0).length,
  };
}

export function getReport(examId: string, passLine = 60, excellentLine = 85): ExamReport | undefined {
  const detail = getExamDetail(examId);
  if (!detail) return undefined;
  const { questions, fullScore } = detail;
  const exam: Exam = {
    id: detail.id,
    name: detail.name,
    subject: detail.subject,
    grade: detail.grade,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
  };
  const scored = detail.sheets.filter((sh) => sh.gradedCount > 0);

  const rows = scored
    .map((sh) => {
      const scores: Record<string, number | null> = {};
      const comments: Record<string, string> = {};
      let review = 0;
      for (const q of questions) {
        const g = sh.grades[q.id];
        scores[q.id] = g ? g.score : null;
        comments[q.id] = g?.comment ?? '';
        if (g?.needsReview && q.kind !== 'choice') review++;
      }
      const total = questions.reduce((a, q) => a + (scores[q.id] ?? 0), 0);
      const rate = fullScore > 0 ? total / fullScore : 0;
      const grade = rate * 100 >= excellentLine ? '优秀' : rate * 100 >= passLine ? '合格' : '待提高';
      return {
        sheetId: sh.id,
        rank: 0,
        studentName: sh.studentName || sh.fileName.replace(/\.pdf$/i, ''),
        studentNo: sh.studentNo,
        scores,
        comments,
        needsReview: review,
        graded: Object.values(scores).filter((v) => v !== null).length,
        total,
        rate,
        grade,
      };
    })
    .sort((a, b) => b.total - a.total);

  // 并列名次：同分同名次
  rows.forEach((r, i) => {
    r.rank = i > 0 && rows[i - 1].total === r.total ? rows[i - 1].rank : i + 1;
  });

  const totals = rows.map((r) => r.total);
  const count = totals.length;
  const avg = count ? totals.reduce((a, b) => a + b, 0) / count : 0;
  const sorted = [...totals].sort((a, b) => a - b);
  const median = count ? (count % 2 ? sorted[(count - 1) / 2] : (sorted[count / 2 - 1] + sorted[count / 2]) / 2) : 0;
  const stddev = count
    ? Math.sqrt(totals.reduce((a, t) => a + (t - avg) ** 2, 0) / count)
    : 0;

  const buckets = [
    { label: '<60%', lo: 0, hi: passLine },
    { label: `${passLine}~70%`, lo: passLine, hi: 70 },
    { label: '70~80%', lo: 70, hi: 80 },
    { label: '80~90%', lo: 80, hi: 90 },
    { label: '90~100%', lo: 90, hi: 101 },
  ];
  const distribution = buckets.map((b) => ({
    label: b.label,
    count: rows.filter((r) => {
      const p = fullScore ? (r.total / fullScore) * 100 : 0;
      return p >= b.lo && p < b.hi;
    }).length,
  }));

  const questionStats = questions.map((q) => {
    const got = scored.map((sh) => sh.grades[q.id]).filter((g): g is Grade => !!g);
    const sum = got.reduce((a, g) => a + g.score, 0);
    return {
      questionId: q.id,
      no: q.no,
      kind: q.kind,
      maxScore: q.maxScore,
      avgScore: got.length ? sum / got.length : 0,
      rate: got.length && q.maxScore > 0 ? (sum / got.length / q.maxScore) * 100 : 0,
      sampleCount: got.length,
      needsReviewCount: got.filter((g) => g.needsReview).length,
    };
  });

  const reviewQueue = scored.flatMap((sh) =>
    questions
      .map((q) => ({ sh, q, g: sh.grades[q.id] }))
      .filter(
        (x): x is { sh: SheetDetail; q: Question; g: Grade } =>
          !!x.g &&
          x.q.kind !== 'choice' &&
          (x.g.needsReview || (x.sh.answers[x.q.id]?.confidence ?? 1) < 0.62),
      )
      .map((x) => ({
        sheetId: sh.id,
        studentName: sh.studentName || sh.fileName,
        questionId: x.q.id,
        no: x.q.no,
        score: x.g.score,
        maxScore: x.q.maxScore,
        comment: x.g.comment,
        answer: sh.answers[x.q.id]?.content ?? '',
        standardAnswer: x.q.answer,
        crop: sh.answers[x.q.id]?.crop ?? null,
        mode: sh.answers[x.q.id]?.mode ?? null,
        confidence: sh.answers[x.q.id]?.confidence ?? null,
      })),
  );

  return {
    exam,
    questions,
    fullScore,
    rows,
    stats: {
      count,
      avg,
      median,
      max: count ? Math.max(...totals) : 0,
      min: count ? Math.min(...totals) : 0,
      stddev,
      passRate: count ? (rows.filter((r) => r.rate * 100 >= passLine).length / count) * 100 : 0,
      excellentRate: count ? (rows.filter((r) => r.rate * 100 >= excellentLine).length / count) * 100 : 0,
      passLine,
      excellentLine,
    },
    distribution,
    questionStats,
    reviewQueue,
  };
}

/* -------------------------------- settings ------------------------------- */

export function getSetting<T>(key: string, fallback: T): T {
  const r = db.prepare('SELECT v FROM setting WHERE k = ?').get(key) as Record<string, unknown> | undefined;
  if (!r) return fallback;
  try {
    return JSON.parse(s(r.v)) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown): void {
  db.prepare(
    'INSERT INTO setting (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  ).run(key, JSON.stringify(value));
}

export const DEFAULT_AI: AiSettings = {
  provider: 'deepseek',
  baseURL: 'https://api.deepseek.com',
  apiKey: '',
  textModel: 'deepseek-flash',
  visionModel: 'deepseek-flash',
  jsonMode: true,
  concurrency: 3,
  temperature: 0,
};

export function getAiSettings(): AiSettings {
  const saved = getSetting<Partial<AiSettings>>('ai', {});
  const merged = { ...DEFAULT_AI, ...saved };
  // 环境变量优先，方便在目标机上不把 key 存进数据库
  if (process.env.PAPER_AI_API_KEY) merged.apiKey = process.env.PAPER_AI_API_KEY;
  if (process.env.PAPER_AI_BASE_URL) merged.baseURL = process.env.PAPER_AI_BASE_URL;
  if (process.env.PAPER_AI_TEXT_MODEL) merged.textModel = process.env.PAPER_AI_TEXT_MODEL;
  if (process.env.PAPER_AI_VISION_MODEL) merged.visionModel = process.env.PAPER_AI_VISION_MODEL;
  return merged;
}

export function saveAiSettings(patch: Partial<AiSettings>): void {
  const cur = getSetting<Partial<AiSettings>>('ai', {});
  const next: Partial<AiSettings> = { ...cur, ...patch };
  // 空字符串/未提供都表示"不修改已有 Key"，如需清空请显式传 clearApiKey
  if (!patch.apiKey) next.apiKey = cur.apiKey ?? '';
  setSetting('ai', next);
}

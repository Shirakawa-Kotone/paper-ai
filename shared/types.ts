// 前后端共享的数据结构（服务端与 web 都直接 import 本文件）

export type QuestionKind = 'choice' | 'multi' | 'fill' | 'equation' | 'short' | 'calc';

export const QUESTION_KINDS: { id: QuestionKind; label: string; auto: boolean }[] = [
  { id: 'choice', label: '单选题', auto: true },
  { id: 'multi', label: '多选题', auto: true },
  { id: 'fill', label: '填空题', auto: true },
  { id: 'equation', label: '方程式/公式', auto: false },
  { id: 'calc', label: '计算题', auto: false },
  { id: 'short', label: '简答题', auto: false },
];

export type Exam = {
  id: string;
  name: string;
  subject: string;
  grade: string;
  createdAt: string;
  updatedAt: string;
};

export type Question = {
  id: string;
  examId: string;
  no: string;
  kind: QuestionKind;
  maxScore: number;
  answer: string;
  rubric: string;
  sort: number;
};

export type SheetStatus = 'uploaded' | 'recognizing' | 'recognized' | 'failed';
export type RecognizeMethod = 'text' | 'vision' | 'ocr' | 'manual' | 'template' | 'generic';

export type Sheet = {
  id: string;
  examId: string;
  fileName: string;
  status: SheetStatus;
  studentName: string;
  studentNo: string;
  method: RecognizeMethod | null;
  error: string;
  createdAt: string;
};

export type AnswerMode = 'omr' | 'ocr' | 'vision' | 'manual' | 'text';

export type Answer = {
  questionId: string;
  content: string;
  confidence: number | null;
  /** 裁切图文件名（相对 data/crops/<sheetId>/） */
  crop?: string | null;
  mode?: AnswerMode | null;
};

export type GradeSource = 'ai' | 'rule' | 'manual';

export type Grade = {
  questionId: string;
  score: number;
  comment: string;
  needsReview: boolean;
  source: GradeSource;
  model: string;
  gradedAt: string;
};

export type SheetDetail = Sheet & {
  answers: Record<string, Answer>;
  grades: Record<string, Grade>;
  total: number;
  fullScore: number;
  gradedCount: number;
};

export type ExamDetail = Exam & {
  questions: Question[];
  layout?: unknown | null;
  layoutAt?: string | null;
  fullScore: number;
  sheets: SheetDetail[];
  recognizedCount: number;
  gradedCount: number;
};

export type QuestionStat = {
  questionId: string;
  no: string;
  kind: QuestionKind;
  maxScore: number;
  avgScore: number;
  rate: number;
  sampleCount: number;
  needsReviewCount: number;
};

export type ExamReport = {
  exam: Exam;
  questions: Question[];
  fullScore: number;
  rows: {
    sheetId: string;
    rank: number;
    studentName: string;
    studentNo: string;
    scores: Record<string, number | null>;
    comments: Record<string, string>;
    needsReview: number;
    graded: number;
    total: number;
    rate: number;
    grade: string;
  }[];
  stats: {
    count: number;
    avg: number;
    median: number;
    max: number;
    min: number;
    stddev: number;
    passRate: number;
    excellentRate: number;
    passLine: number;
    excellentLine: number;
  };
  distribution: { label: string; count: number }[];
  questionStats: QuestionStat[];
  reviewQueue: {
    sheetId: string;
    studentName: string;
    questionId: string;
    no: string;
    score: number;
    maxScore: number;
    comment: string;
    answer: string;
    standardAnswer: string;
    crop: string | null;
    mode: string | null;
    confidence: number | null;
  }[];
};

export type AiProviderId =
  | 'deepseek'
  | 'opencode-go'
  | 'zhipu'
  | 'moonshot'
  | 'qwen'
  | 'openai'
  | 'ollama'
  | 'custom';

export type AiProvider = {
  id: AiProviderId;
  /** 该服务商要求的额外请求头（如 OpenCode 的会话头） */
  extraHeaders?: Record<string, string>;
  label: string;
  baseURL: string;
  textModel: string;
  visionModel: string;
  supportsVision: boolean;
  supportsJsonMode: boolean;
  keyHint: string;
  docs: string;
};


export type AiSettings = {
  provider: AiProviderId;
  baseURL: string;
  apiKey: string; // 读取时永远为空，仅写入
  textModel: string;
  visionModel: string;
  jsonMode: boolean;
  concurrency: number;
  temperature: number;
};

export type AiSettingsView = Omit<AiSettings, 'apiKey'> & {
  hasApiKey: boolean;
  apiKeyMask: string;
};



export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled';

export type JobEvent =
  | { type: 'snapshot'; job: JobView }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string; at: string }
  | { type: 'progress'; done: number; failed: number; total: number; current: string }
  | { type: 'done'; status: JobStatus; failed: number; message: string };

export type JobView = {
  id: string;
  kind: 'recognize' | 'grade';
  examId: string;
  status: JobStatus;
  total: number;
  done: number;
  failed: number;
  current: string;
  startedAt: string;
  finishedAt: string | null;
};


/* ---------------------------- 答题卡版式 ---------------------------- */

export type Bubble = { option: string; cx: number; cy: number; r: number };

export type LayoutBox = {
  kind: 'question';
  qid: string;
  no: string;
  qkind: QuestionKind;
  x: number;
  y: number;
  w: number;
  h: number;
  bubbles?: Bubble[];
};

export type HeaderBox = {
  kind: 'header';
  field: 'name' | 'no' | 'class';
  x: number;
  y: number;
  w: number;
  h: number;
};

export type Marker = { x: number; y: number; size: number };

export type SheetPage = {
  index: number;
  markers: Marker[];
  frame: { x: number; y: number; w: number; h: number };
  header: HeaderBox[];
  boxes: LayoutBox[];
};

export type SheetLayout = {
  examId: string;
  examName: string;
  grade: string;
  fullScore: number;
  pageCount: number;
  pages: SheetPage[];
  createdAt: string;
};


/** 建考试时可选的学科 */
export const SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '生物', '思想政治', '历史', '地理', '通用'] as const;

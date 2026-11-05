import type {
  AiSettings,
  AiSettingsView,
  AiProvider,
  Exam,
  ExamDetail,
  ExamReport,
  JobEvent,
  JobView,
  Question,
  QuestionKind,
  Sheet,
} from '../../shared/types.ts';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError('无法连接本地服务，请确认服务仍在运行', 0);
  }
  const type = res.headers.get('content-type') ?? '';
  const data: unknown = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const msg =
      typeof data === 'object' && data && 'error' in data
        ? String((data as { error: unknown }).error)
        : `请求失败（${res.status}）`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const put = (body: unknown): RequestInit => ({ ...json(body), method: 'PUT' });
const patch = (body: unknown): RequestInit => ({ ...json(body), method: 'PATCH' });

export type ExamSummary = Exam & { questionCount: number; sheetCount: number; gradedCount: number };

export type { JobView };

export type SettingsPayload = {
  ai: AiSettingsView;
  providers: (AiProvider & { models: { text: string[]; vision: string[] } })[];
  envKey: boolean;
};

export const api = {
  health: () => request<{ ok: boolean; node: string; dataDir: string }>('/health'),

  settings: () => request<SettingsPayload>('/settings'),
  saveAi: (patchBody: Partial<AiSettings> & { clearApiKey?: boolean }) =>
    request<{ ok: boolean }>('/settings/ai', put(patchBody)),
  testAi: () => request<{ ok: boolean; model: string; ms: number; reply: string }>('/settings/test', json({})),
  listModels: (body: { baseURL?: string; apiKey?: string }) =>
    request<{ models: { id: string; vision: boolean }[]; visionCount: number }>('/settings/models', json(body)),

  listExams: () => request<ExamSummary[]>('/exams'),
  createExam: (body: { name: string; grade?: string; subject?: string }) =>
    request<Exam>('/exams', json(body)),
  getExam: (id: string) => request<ExamDetail>(`/exams/${id}`),
  updateExam: (id: string, body: Partial<Pick<Exam, 'name' | 'grade' | 'subject'>>) =>
    request<Exam>(`/exams/${id}`, patch(body)),
  deleteExam: (id: string) => request<{ ok: boolean }>(`/exams/${id}`, { method: 'DELETE' }),

  importPaper: async (examId: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    return request<{
      questions: { no: string; kind: QuestionKind; maxScore: number; answer: string; note: string }[];
      notes: string;
      method: 'text' | 'vision';
      title: string;
    }>(`/exams/${examId}/import-paper`, { method: 'POST', body: fd });
  },

  saveQuestions: (examId: string, questions: Partial<Question>[]) =>
    request<Question[]>(`/exams/${examId}/questions`, {
      ...put({ questions }),
    }),

  uploadSheets: async (examId: string, files: File[], groupSize = 0) => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    fd.append('groupSize', String(groupSize));
    return request<{
      sheets: Sheet[];
      skipped: string[];
      split: { name: string; pages: number; parts: number }[];
    }>(`/exams/${examId}/sheets`, { method: 'POST', body: fd });
  },
  updateAnswer: (sheetId: string, questionId: string, content: string) =>
    request<{ ok: boolean }>(`/sheets/${sheetId}/answers/${questionId}`, patch({ content })),

  template: (examId: string) => request<unknown>(`/exams/${examId}/template`),

  updateSheet: (id: string, body: { studentName?: string; studentNo?: string; answers?: Record<string, string> }) =>
    request<Sheet>(`/sheets/${id}`, patch(body)),
  deleteSheet: (id: string) => request<{ ok: boolean }>(`/sheets/${id}`, { method: 'DELETE' }),

  recognize: (examId: string, body: { sheetIds?: string[]; force?: boolean }) =>
    request<{ job: JobView }>(`/exams/${examId}/recognize`, json(body)),
  grade: (examId: string, body: { sheetIds?: string[]; force?: boolean; forceManual?: boolean }) =>
    request<{ job: JobView }>(`/exams/${examId}/grade`, json(body)),
  setGrade: (sheetId: string, questionId: string, body: { score: number; comment?: string; needsReview?: boolean }) =>
    request<{ ok: boolean }>(`/sheets/${sheetId}/grades/${questionId}`, patch(body)),

  report: (examId: string, pass = 60, excellent = 85) =>
    request<ExamReport>(`/exams/${examId}/report?pass=${pass}&excellent=${excellent}`),

  job: (id: string) => request<{ id: string; logs: { level: string; message: string; at: string }[] }>(`/jobs/${id}`),
  cancelJob: (id: string) => request<{ ok: boolean }>(`/jobs/${id}/cancel`, json({})),
};

export const csvUrl = (examId: string) => `/api/exams/${examId}/export.csv`;

export const xlsxUrl = (examId: string) => `/api/exams/${examId}/export.xlsx`;

export const templatePdfUrl = (examId: string) => `/api/exams/${examId}/template.pdf`;

export const cropUrl = (sheetId: string, crop: string) => `/api/sheets/${sheetId}/crops/${crop}`;

/** 订阅任务进度（SSE），返回取消订阅函数。 */
export function subscribeJob(id: string, onEvent: (e: JobEvent) => void, onError?: () => void): () => void {
  const es = new EventSource(`/api/jobs/${id}/events`);
  es.onmessage = (ev) => {
    try {
      onEvent(JSON.parse(ev.data) as JobEvent);
    } catch {
      /* 忽略坏帧 */
    }
  };
  es.onerror = () => {
    onError?.();
    es.close();
  };
  return () => es.close();
}

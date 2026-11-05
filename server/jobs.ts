import { randomUUID } from 'node:crypto';
import type { JobEvent, JobStatus, JobView } from '../shared/types.ts';

type LogLevel = 'info' | 'warn' | 'error';
type LogEntry = { level: LogLevel; message: string; at: string };

export type Job = {
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
  logs: LogEntry[];
  listeners: Set<(e: JobEvent) => void>;
  cancelled: boolean;
};

const jobs = new Map<string, Job>();
const MAX_LOGS = 300;
const MAX_JOBS = 30;

export function createJob(kind: Job['kind'], examId: string, total = 0): Job {
  const job: Job = {
    id: randomUUID(),
    kind,
    examId,
    status: 'running',
    total,
    done: 0,
    failed: 0,
    current: '',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    logs: [],
    listeners: new Set(),
    cancelled: false,
  };
  jobs.set(job.id, job);
  prune();
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): JobView[] {
  return [...jobs.values()].map(view).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return false;
  job.cancelled = true;
  log(job, 'warn', '收到取消请求，正在结束当前任务…');
  return true;
}

export function view(job: Job): JobView {
  const { id, kind, examId, status, total, done, failed, current, startedAt, finishedAt } = job;
  return { id, kind, examId, status, total, done, failed, current, startedAt, finishedAt };
}

export function snapshot(job: Job): JobEvent {
  return { type: 'snapshot', job: view(job) };
}

function broadcast(job: Job, event: JobEvent) {
  for (const fn of job.listeners) {
    try {
      fn(event);
    } catch {
      /* 单个订阅者出错不影响其它人 */
    }
  }
}

export function log(job: Job, level: LogLevel, message: string) {
  const entry: LogEntry = { level, message, at: new Date().toISOString() };
  job.logs.push(entry);
  if (job.logs.length > MAX_LOGS) job.logs.splice(0, job.logs.length - MAX_LOGS);
  broadcast(job, { type: 'log', ...entry });
}

export function setCurrent(job: Job, current: string) {
  job.current = current;
  broadcast(job, { type: 'progress', done: job.done, failed: job.failed, total: job.total, current });
}

export function tick(job: Job, opts: { failed?: boolean; current?: string } = {}) {
  job.done += 1;
  if (opts.failed) job.failed += 1;
  if (opts.current !== undefined) job.current = opts.current;
  broadcast(job, { type: 'progress', done: job.done, failed: job.failed, total: job.total, current: job.current });
}

export function finish(job: Job, status: JobStatus, message: string) {
  job.status = status;
  job.finishedAt = new Date().toISOString();
  job.current = '';
  log(job, status === 'failed' ? 'error' : 'info', message);
  broadcast(job, { type: 'done', status, failed: job.failed, message });
  job.listeners.clear();
}

export function subscribe(id: string, fn: (e: JobEvent) => void): (() => void) | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  job.listeners.add(fn);
  return () => job.listeners.delete(fn);
}

export function historyFor(job: Job): JobEvent[] {
  return job.logs.map((l) => ({ type: 'log', ...l }));
}

function prune() {
  if (jobs.size <= MAX_JOBS) return;
  const finished = [...jobs.values()]
    .filter((j) => j.status !== 'running')
    .sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? ''));
  for (const j of finished.slice(0, jobs.size - MAX_JOBS)) jobs.delete(j.id);
}

/** 简单的并发池；支持取消。 */
export async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  isCancelled: () => boolean,
): Promise<void> {
  let cursor = 0;
  const width = Math.max(1, Math.min(concurrency, items.length || 1));
  const runners = Array.from({ length: width }, async () => {
    while (true) {
      if (isCancelled()) return;
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

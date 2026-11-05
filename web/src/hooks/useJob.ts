import type { JobEvent, JobView } from '../../../shared/types.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeJob } from '../api.ts';

export type LogLine = { level: 'info' | 'warn' | 'error'; message: string; at: string };

export function useJob(onDone?: () => void) {
  const [job, setJob] = useState<JobView | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [running, setRunning] = useState(false);
  const closeRef = useRef<(() => void) | null>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const stop = useCallback(() => {
    closeRef.current?.();
    closeRef.current = null;
    setRunning(false);
  }, []);

  useEffect(() => () => closeRef.current?.(), []);

  const start = useCallback((next: JobView) => {
    closeRef.current?.();
    setJob(next);
    setLogs([]);
    setRunning(true);
    closeRef.current = subscribeJob(
      next.id,
      (e: JobEvent) => {
        if (e.type === 'log') {
          setLogs((prev) => [...prev.slice(-250), { level: e.level, message: e.message, at: e.at }]);
        } else if (e.type === 'progress') {
          setJob((prev) =>
            prev ? { ...prev, done: e.done, failed: e.failed, total: e.total, current: e.current } : prev,
          );
        } else if (e.type === 'snapshot') {
          setJob(e.job);
        } else if (e.type === 'done') {
          setJob((prev) => (prev ? { ...prev, status: e.status, finishedAt: new Date().toISOString() } : prev));
          setRunning(false);
          closeRef.current?.();
          closeRef.current = null;
          doneRef.current?.();
        }
      },
      () => setRunning(false),
    );
  }, []);

  const reset = useCallback(() => {
    stop();
    setJob(null);
    setLogs([]);
  }, [stop]);

  return { job, logs, running, start, stop, reset };
}

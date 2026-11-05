import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExamDetail } from '../../shared/types.ts';
import { api, type ExamSummary } from './api.ts';
import { Icon } from './icons.tsx';
import { ExamListPage, ExamShell, SettingsDialog } from './pages/Shell.tsx';
import { QuestionsPage } from './pages/Questions.tsx';
import { SheetsPage } from './pages/Sheets.tsx';
import { GradingPage } from './pages/Grading.tsx';
import { ReportPage } from './pages/Report.tsx';
import { ReviewPage } from './pages/Review.tsx';
import { PrintPage } from './pages/Print.tsx';
import { Modal, Spinner, ToastProvider, useToast } from './components/ui.tsx';
import { LeaveGuardProvider, useLeaveGuard } from './guard.tsx';

type Tab = 'questions' | 'sheets' | 'grading' | 'review' | 'report';
type Route = { kind: 'list' } | { kind: 'exam'; id: string; tab: Tab } | { kind: 'print'; id: string };

const TABS: Tab[] = ['questions', 'sheets', 'grading', 'review', 'report'];

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [a, id, tab] = raw.split('/');
  if (a === 'exam' && id) {
    if (tab === 'print') return { kind: 'print', id };
    return { kind: 'exam', id, tab: TABS.includes(tab as Tab) ? (tab as Tab) : 'questions' };
  }
  return { kind: 'list' };
}

function AppInner() {
  const toast = useToast();
  const [route, setRoute] = useState<Route>(() => parseHash());
  const [exams, setExams] = useState<ExamSummary[]>([]);
  const [loadingExams, setLoadingExams] = useState(true);
  const [exam, setExam] = useState<ExamDetail | null>(null);
  const [loadingExam, setLoadingExam] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const guard = useLeaveGuard();
  const [pendingHash, setPendingHash] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const allowNextHash = useRef(false);
  const lastHash = useRef(window.location.hash);

  useEffect(() => {
    const onHash = () => {
      // 程序内跳转，直接放行
      if (allowNextHash.current) {
        allowNextHash.current = false;
        lastHash.current = window.location.hash;
        setRoute(parseHash());
        return;
      }
      // 浏览器前进/后退：有未保存改动就回滚并询问
      if (guard.dirty) {
        const target = window.location.hash;
        allowNextHash.current = true;
        window.location.hash = lastHash.current;
        setPendingHash(target);
        return;
      }
      lastHash.current = window.location.hash;
      setRoute(parseHash());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [guard.dirty]);

  const loadExams = useCallback(async () => {
    setLoadingExams(true);
    try {
      setExams(await api.listExams());
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setLoadingExams(false);
    }
  }, [toast]);

  const loadExam = useCallback(
    async (id: string) => {
      setLoadingExam(true);
      try {
        setExam(await api.getExam(id));
      } catch (e) {
        toast((e as Error).message, 'bad');
        window.location.hash = '#/';
      } finally {
        setLoadingExam(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    if (route.kind === 'list') void loadExams();
    else if (route.kind === 'exam') void loadExam(route.id);
  }, [route, loadExams, loadExam]);

  const go = (hash: string) => {
    if (guard.dirty) {
      setPendingHash(hash);
      return;
    }
    allowNextHash.current = true;
    window.location.hash = hash;
  };

  const leaveNow = (hash: string) => {
    guard.setDirty(false);
    allowNextHash.current = true;
    setPendingHash(null);
    window.location.hash = hash;
  };

  const saveAndLeave = async () => {
    if (!pendingHash) return;
    setLeaving(true);
    try {
      const ok = await guard.runSave();
      if (ok) leaveNow(pendingHash);
    } finally {
      setLeaving(false);
    }
  };

  const reloadExam = useCallback(async () => {
    if (route.kind === 'exam') await loadExam(route.id);
  }, [route, loadExam]);

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => go('#/')}>
          <Icon name="flask" size={18} />
          AI 改卷台
        </button>
        {route.kind === 'exam' && exam && (
          <div className="crumb">
            <Icon name="chevron-right" size={13} />
            <strong>{exam.name}</strong>
          </div>
        )}
        <div className="topbar-spacer" />
        <button className="btn btn-ghost btn-sm" onClick={() => setSettingsOpen(true)}>
          <Icon name="gear" size={15} />
          设置
        </button>
      </header>

      {route.kind === 'print' ? (
        <PrintPage examId={route.id} onBack={() => go(`#/exam/${route.id}/questions`)} />
      ) : route.kind === 'list' ? (
        <ExamListPage
          exams={exams}
          loading={loadingExams}
          onOpen={(id) => go(`#/exam/${id}/questions`)}
          onCreated={() => void loadExams()}
        />
      ) : loadingExam && !exam ? (
        <div className="row" style={{ justifyContent: 'center', padding: 80 }}>
          <Spinner />
        </div>
      ) : exam && exam.id === route.id ? (
        <ExamShell
          exam={exam}
          tab={route.tab}
          onTab={(t) => go(`#/exam/${exam.id}/${t}`)}
          onBack={() => go('#/')}
        >
          {route.tab === 'questions' && <QuestionsPage exam={exam} reload={reloadExam} />}
          {route.tab === 'sheets' && <SheetsPage exam={exam} reload={reloadExam} />}
          {route.tab === 'grading' && <GradingPage exam={exam} reload={reloadExam} />}
          {route.tab === 'review' && <ReviewPage exam={exam} reload={reloadExam} />}
          {route.tab === 'report' && <ReportPage exam={exam} reload={reloadExam} />}
        </ExamShell>
      ) : null}

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <Modal
        open={!!pendingHash}
        title="题目还没保存"
        onClose={() => setPendingHash(null)}
        footer={
          <>
            <button className="btn" onClick={() => setPendingHash(null)}>
              继续编辑
            </button>
            <button className="btn btn-danger" onClick={() => pendingHash && leaveNow(pendingHash)}>
              放弃改动
            </button>
            <button className="btn btn-primary" onClick={() => void saveAndLeave()} disabled={leaving}>
              {leaving ? <Spinner light /> : null}
              保存并离开
            </button>
          </>
        }
      >
        <p style={{ lineHeight: 1.8 }}>「试题」页有未保存的改动，现在离开会丢掉。</p>
      </Modal>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <LeaveGuardProvider>
        <AppInner />
      </LeaveGuardProvider>
    </ToastProvider>
  );
}

import { useMemo, useState } from 'react';
import type { ExamDetail } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { useJob } from '../hooks/useJob.ts';
import { Badge, Empty, Progress, Spinner, useToast } from '../components/ui.tsx';
import { Icon } from '../icons.tsx';

export function GradingPage({ exam, reload }: { exam: ExamDetail; reload: () => Promise<void> }) {
  const toast = useToast();
  const job = useJob(() => {
    toast('批改完成，结果已刷新', 'ok');
    void reload();
  });
  const [forceManual, setForceManual] = useState(false);

  const ready = useMemo(() => exam.sheets.filter((s) => Object.keys(s.answers).length > 0), [exam.sheets]);
  const fullyGraded = useMemo(
    () => exam.sheets.filter((s) => exam.questions.length > 0 && s.gradedCount >= exam.questions.length),
    [exam.sheets, exam.questions.length],
  );
  const missingAnswers = exam.questions.filter((q) => !q.answer.trim());
  const choiceIds = useMemo(() => new Set(exam.questions.filter((q) => q.kind === 'choice').map((q) => q.id)), [exam.questions]);
  const needsReview = useMemo(
    () =>
      exam.sheets.reduce(
        (a, s) =>
          a + Object.values(s.grades).filter((g) => g.needsReview && !choiceIds.has(g.questionId)).length,
        0,
      ),
    [exam.sheets, choiceIds],
  );
  const manualCount = useMemo(
    () =>
      exam.sheets.reduce((a, s) => a + Object.values(s.grades).filter((g) => g.source === 'manual').length, 0),
    [exam.sheets],
  );

  const start = async (force: boolean) => {
    if (!ready.length) {
      toast('还没有已识别的答题卡，请先到「答题卡」页识别', 'bad');
      return;
    }
    try {
      const r = await api.grade(exam.id, {
        sheetIds: force ? undefined : ready.map((s) => s.id),
        force,
        forceManual,
      });
      job.start(r.job);
      toast(force ? '已提交全部重批' : '已提交批改', 'ok');
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };

  return (
    <div className="stack">
      <div className="stat-grid">
        <div className="stat">
          <div className="k">试题</div>
          <div className="v">
            {exam.questions.length}
            <small>题 / {exam.fullScore} 分</small>
          </div>
        </div>
        <div className="stat">
          <div className="k">可批改答题卡</div>
          <div className="v">
            {ready.length}
            <small>份</small>
          </div>
        </div>
        <div className="stat">
          <div className="k">已完成批改</div>
          <div className="v">
            {fullyGraded.length}
            <small>份</small>
          </div>
        </div>
        <div className="stat">
          <div className="k">待人工复核</div>
          <div className="v" style={{ color: needsReview ? 'var(--warn)' : undefined }}>
            {needsReview}
            <small>处</small>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2>批改</h2>
            <div className="desc">
              选择题、与答案完全一致的填空题走规则判定（不花钱）；其余题目按参考答案与给分点交给模型评分。
            </div>
          </div>
          <div className="row">
            {job.running ? (
              <button className="btn btn-danger" onClick={job.stop}>
                <Icon name="x" size={15} />
                停止
              </button>
            ) : (
              <>
                <button
                  className="btn"
                  onClick={() => void start(true)}
                  disabled={!ready.length}
                  title="忽略已有评分，全部重新批改"
                >
                  <Icon name="refresh" size={15} />
                  全部重批
                </button>
                <button className="btn btn-primary" onClick={() => void start(false)} disabled={!ready.length}>
                  <Icon name="play" size={15} />
                  开始批改
                </button>
              </>
            )}
          </div>
        </div>

        <div className="card-body stack" style={{ gap: 14 }}>
          <div className="row between" style={{ alignItems: 'flex-start' }}>
            <label className="check">
              <input type="checkbox" checked={forceManual} onChange={(e) => setForceManual(e.target.checked)} />
              覆盖人工复核过的评分
              {manualCount > 0 && <span className="faint">（当前有 {manualCount} 处人工评分）</span>}
            </label>
            <div className="row" style={{ gap: 8 }}>
              {missingAnswers.length > 0 && (
                <Badge tone="warn">{missingAnswers.length} 题缺标准答案，将记 0 分并标记复核</Badge>
              )}
            </div>
          </div>

          {(job.job || job.logs.length > 0) && (
            <div className="stack" style={{ gap: 10 }}>
              <div className="row between">
                <div className="row" style={{ gap: 8 }}>
                  {job.running && <Spinner />}
                  <span className="small">
                    {job.job
                      ? `${job.job.done}/${job.job.total} 份${job.job.failed ? ` · 失败 ${job.job.failed}` : ''}${job.job.current ? ` · ${job.job.current}` : ''}`
                      : ''}
                  </span>
                </div>
                <span className="hint">
                  {job.running ? '批改中，可以切到别的标签页，任务会在后台继续' : '本次批改已结束'}
                </span>
              </div>
              <Progress value={job.job?.done ?? 0} total={job.job?.total ?? 1} ok={!job.running} />
              <div className="log">
                {job.logs.map((l, i) => (
                  <div key={i} className={`log-line ${l.level}`}>
                    <span className="t">{new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                    <span>{l.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {ready.length === 0 ? (
            <Empty icon="file" title="还没有可批改的答题卡" desc="先到「答题卡」页上传 PDF 并完成识别。" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 46 }} className="center">
                      #
                    </th>
                    <th>学生</th>
                    <th style={{ width: 150 }}>批改进度</th>
                    <th style={{ width: 90 }} className="num">
                      总分
                    </th>
                    <th style={{ width: 90 }} className="center">
                      待复核
                    </th>
                    <th style={{ width: 90 }} className="center">
                      人工修改
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {exam.sheets.map((s, i) => {
                    const graded = s.gradedCount;
                    const total = exam.questions.length;
                    const review = Object.values(s.grades).filter((g) => g.needsReview && !choiceIds.has(g.questionId)).length;
                    const manual = Object.values(s.grades).filter((g) => g.source === 'manual').length;
                    return (
                      <tr key={s.id}>
                        <td className="center muted">{i + 1}</td>
                        <td>
                          <div style={{ fontWeight: 500 }}>{s.studentName || s.fileName}</div>
                          <div className="faint small">{s.studentNo || '未识别学号'}</div>
                        </td>
                        <td>
                          <div className="row" style={{ gap: 8 }}>
                            <div className="progress" style={{ flex: 1 }}>
                              <i
                                style={{
                                  width: `${total ? (graded / total) * 100 : 0}%`,
                                  background: graded >= total ? 'var(--ok)' : 'var(--accent)',
                                }}
                              />
                            </div>
                            <span className="faint small nowrap">
                              {graded}/{total}
                            </span>
                          </div>
                        </td>
                        <td className="num" style={{ fontWeight: 600 }}>
                          {total && graded ? s.total : '—'}
                        </td>
                        <td className="center">
                          {review > 0 ? <Badge tone="warn">{review}</Badge> : <span className="faint">—</span>}
                        </td>
                        <td className="center">
                          {manual > 0 ? <Badge tone="accent">{manual}</Badge> : <span className="faint">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

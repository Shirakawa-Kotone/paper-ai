import { useCallback, useEffect, useState } from 'react';
import type { ExamDetail, ExamReport } from '../../../shared/types.ts';
import { api, xlsxUrl } from '../api.ts';
import { DistributionChart, RateChart } from '../components/charts.tsx';
import { Badge, Empty, Spinner, useToast } from '../components/ui.tsx';
import { Icon } from '../icons.tsx';

function ScoreCell({
  value,
  max,
  review,
  onSave,
}: {
  value: number | null;
  max: number;
  review: boolean;
  onSave: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n >= 0) onSave(Math.min(n, max));
    setEditing(false);
  };

  if (editing) {
    return (
      <td className="center" style={{ padding: '4px 6px' }}>
        <input
          className="input sm"
          autoFocus
          style={{ width: 56, textAlign: 'center' }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      </td>
    );
  }

  const cls =
    value === null ? '' : value <= 0 ? 'zero' : value >= max * 0.85 ? 'good' : '';
  return (
    <td
      className={`cell-score ${cls} ${review ? 'review' : ''}`}
      title="点击修改分数"
      onClick={() => {
        setDraft(value === null ? '' : String(value));
        setEditing(true);
      }}
    >
      {value === null ? <span className="faint">—</span> : value}
    </td>
  );
}

export function ReportPage({ exam, reload }: { exam: ExamDetail; reload: () => Promise<void> }) {
  const toast = useToast();
  const [report, setReport] = useState<ExamReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [pass, setPass] = useState(60);
  const [excellent, setExcellent] = useState(85);
  const [editing, setEditing] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.report(exam.id, pass, excellent);
      setReport(r);
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setLoading(false);
    }
  }, [exam.id, pass, excellent, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveScore = async (sheetId: string, questionId: string, score: number) => {
    try {
      await api.setGrade(sheetId, questionId, { score, needsReview: false });
      await load();
      await reload();
      toast('分数已更新', 'ok');
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };

  if (loading && !report) {
    return (
      <div className="row" style={{ justifyContent: 'center', padding: 60 }}>
        <Spinner />
      </div>
    );
  }

  if (!report) return null;

  if (!report.rows.length) {
    return (
      <div className="card">
        <Empty
          icon="chart"
          title="还没有成绩"
          desc="完成答题卡识别和批改后，这里会显示成绩单、分数段分布和各题得分率。"
        />
      </div>
    );
  }

  const { stats } = report;

  return (
    <div className="stack">
      <div className="row between no-print">
        <div className="row" style={{ gap: 10 }}>
          <span className="small muted">及格线</span>
          <input
            className="input sm"
            type="number"
            min={0}
            max={100}
            value={pass}
            onChange={(e) => setPass(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
            style={{ width: 64 }}
          />
          <span className="small muted">优秀线</span>
          <input
            className="input sm"
            type="number"
            min={0}
            max={100}
            value={excellent}
            onChange={(e) => setExcellent(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
            style={{ width: 64 }}
          />
          {loading && <Spinner />}
        </div>
        <div className="row">
          <a className="btn" href={xlsxUrl(exam.id)} download>
            <Icon name="download" size={15} />
            导出 Excel
          </a>
          <button className="btn" onClick={() => window.print()}>
            <Icon name="printer" size={15} />
            打印
          </button>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat">
          <div className="k">参考人数</div>
          <div className="v">
            {stats.count}
            <small>人</small>
          </div>
        </div>
        <div className="stat">
          <div className="k">平均分</div>
          <div className="v">
            {stats.avg.toFixed(1)}
            <small>/ {report.fullScore}</small>
          </div>
        </div>
        <div className="stat">
          <div className="k">中位数</div>
          <div className="v">{stats.median}</div>
        </div>
        <div className="stat">
          <div className="k">最高 / 最低</div>
          <div className="v">
            {stats.max}
            <small>/ {stats.min}</small>
          </div>
        </div>
        <div className="stat">
          <div className="k">及格率</div>
          <div className="v">
            {stats.passRate.toFixed(0)}
            <small>%</small>
          </div>
        </div>
        <div className="stat">
          <div className="k">优秀率</div>
          <div className="v">
            {stats.excellentRate.toFixed(0)}
            <small>%</small>
          </div>
        </div>
        <div className="stat">
          <div className="k">标准差</div>
          <div className="v">{stats.stddev.toFixed(1)}</div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>分数段分布</h2>
          </div>
          <div className="card-body">
            <DistributionChart data={report.distribution} />
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>各题得分率</h2>
          </div>
          <div className="card-body">
            <RateChart items={report.questionStats.map((q) => ({ no: q.no, rate: q.rate }))} />
          </div>
        </div>
      </div>

      {report.reviewQueue.length > 0 && (
        <div className="card">
          <div className="card-head">
            <div>
              <h2>
                待复核
                <Badge tone="warn">{report.reviewQueue.length} 处</Badge>
              </h2>
              <div className="desc">模型对这几处没把握或分数异常，建议抽查。确认后填入分数即可。</div>
            </div>
          </div>
          <div className="card-body">
            <div className="review-list">
              {report.reviewQueue.map((item) => {
                const key = `${item.sheetId}:${item.questionId}`;
                return (
                  <div className="review-item" key={key}>
                    <div className="top">
                      <span className="who">{item.studentName}</span>
                      <Badge tone="muted">第 {item.no} 题</Badge>
                      <span className="muted small">
                        当前 {item.score} / {item.maxScore} 分
                      </span>
                      {item.comment && <span className="muted small">· {item.comment}</span>}
                    </div>
                    <div className="ans">
                      <span className="k">学生作答</span>
                      {item.answer || '（空）'}
                    </div>
                    <div className="ans">
                      <span className="k">参考答案</span>
                      {item.standardAnswer || '（未填写）'}
                    </div>
                    <div className="row">
                      <input
                        className="input score"
                        type="number"
                        min={0}
                        max={item.maxScore}
                        step={0.5}
                        value={editing[key] ?? String(item.score)}
                        onChange={(e) => setEditing((p) => ({ ...p, [key]: e.target.value }))}
                      />
                      <span className="faint small">/{item.maxScore}</span>
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={() => {
                          const v = Number(editing[key] ?? item.score);
                          if (Number.isFinite(v)) void saveScore(item.sheetId, item.questionId, Math.min(v, item.maxScore));
                        }}
                      >
                        <Icon name="check" size={13} />
                        确认分数
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div>
            <h2>成绩单</h2>
            <div className="desc">点击任意分数可直接修改，回车保存。带黄点的格子表示 AI 建议复核。</div>
          </div>
          <span className="badge muted">共 {report.rows.length} 人</span>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 52 }} className="center sticky-col sticky-1">
                  名次
                </th>
                <th style={{ minWidth: 120 }} className="sticky-col sticky-2">
                  姓名
                </th>
                {report.questions.map((q) => (
                  <th key={q.id} className="center" style={{ minWidth: 62 }}>
                    <div>{q.no}</div>
                    <div className="faint" style={{ fontSize: 11, fontWeight: 400 }}>
                      {q.maxScore}
                    </div>
                  </th>
                ))}
                <th className="num" style={{ width: 80 }}>
                  总分
                </th>
                <th style={{ width: 110 }}>得分率</th>
                <th style={{ width: 76 }}>等级</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.sheetId}>
                  <td className="center sticky-col sticky-1 muted">{r.rank}</td>
                  <td className="sticky-col sticky-2" style={{ fontWeight: 500 }}>
                    {r.studentName}
                    {r.studentNo && <div className="faint small">{r.studentNo}</div>}
                  </td>
                  {report.questions.map((q) => {
                    const g = exam.sheets.find((s) => s.id === r.sheetId)?.grades[q.id];
                    return (
                      <ScoreCell
                        key={q.id}
                        value={r.scores[q.id]}
                        max={q.maxScore}
                        review={!!g?.needsReview}
                        onSave={(v) => void saveScore(r.sheetId, q.id, v)}
                      />
                    );
                  })}
                  <td className="num" style={{ fontWeight: 600 }}>
                    {r.total}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 7 }}>
                      <div className="progress" style={{ flex: 1, height: 5 }}>
                        <i style={{ width: `${Math.round(r.rate * 100)}%` }} />
                      </div>
                      <span className="faint small nowrap">{Math.round(r.rate * 100)}%</span>
                    </div>
                  </td>
                  <td>
                    <Badge tone={r.grade === '优秀' ? 'ok' : r.grade === '合格' ? 'accent' : 'bad'}>{r.grade}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>题目分析</h2>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 90 }}>题号</th>
                <th style={{ width: 110 }}>类型</th>
                <th style={{ width: 90 }} className="num">
                  满分
                </th>
                <th style={{ width: 110 }} className="num">
                  平均得分
                </th>
                <th>得分率</th>
                <th style={{ width: 88 }} className="num">
                  待复核
                </th>
              </tr>
            </thead>
            <tbody>
              {report.questionStats.map((q) => (
                <tr key={q.questionId}>
                  <td style={{ fontWeight: 500 }}>第 {q.no} 题</td>
                  <td className="muted">
                    {{ choice: '单选题', multi: '多选题', fill: '填空题', equation: '方程式/公式', calc: '计算题', short: '简答题' }[
                      q.kind
                    ] ?? q.kind}
                  </td>
                  <td className="num">{q.maxScore}</td>
                  <td className="num">{q.avgScore.toFixed(1)}</td>
                  <td>
                    <div className="row" style={{ gap: 8 }}>
                      <div className="progress" style={{ flex: 1, height: 5 }}>
                        <i
                          style={{
                            width: `${Math.round(q.rate)}%`,
                            background: q.rate >= 80 ? 'var(--ok)' : q.rate >= 60 ? 'var(--accent)' : 'var(--bad)',
                          }}
                        />
                      </div>
                      <span className="faint small nowrap">{q.rate.toFixed(0)}%</span>
                    </div>
                  </td>
                  <td className="num">{q.needsReviewCount || <span className="faint">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExamDetail, Sheet, SheetDetail } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { useJob } from '../hooks/useJob.ts';
import { Badge, Empty, Field, Modal, Progress, Spinner, useConfirm, useToast } from '../components/ui.tsx';
import { Icon } from '../icons.tsx';

const STATUS: Record<string, { tone: 'muted' | 'warn' | 'ok' | 'bad'; label: string }> = {
  uploaded: { tone: 'muted', label: '待识别' },
  recognizing: { tone: 'warn', label: '识别中' },
  recognized: { tone: 'ok', label: '已识别' },
  failed: { tone: 'bad', label: '失败' },
};

const METHOD: Record<string, string> = {
  text: '文本层',
  vision: '视觉模型',
  ocr: '本地 OCR',
  manual: '手动录入',
  template: '模板裁切',
  generic: '版面分析',
};

export function SheetsPage({ exam, reload }: { exam: ExamDetail; reload: () => Promise<void> }) {
  const toast = useToast();
  const { confirm, view: confirmView } = useConfirm();
  const [uploading, setUploading] = useState(false);
  const layoutPages = (exam.layout as { pageCount?: number } | null | undefined)?.pageCount ?? 0;
  const [groupSize, setGroupSize] = useState(layoutPages > 1 ? layoutPages : 1);
  const [over, setOver] = useState(false);
  const [editing, setEditing] = useState<SheetDetail | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [nameDraft, setNameDraft] = useState<Record<string, string>>({});
  const [noDraft, setNoDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    setNameDraft(Object.fromEntries(exam.sheets.map((s) => [s.id, s.studentName])));
    setNoDraft(Object.fromEntries(exam.sheets.map((s) => [s.id, s.studentNo])));
  }, [exam.sheets]);

  const job = useJob(() => void reload());

  const pending = useMemo(() => exam.sheets.filter((s) => s.status !== 'recognized'), [exam.sheets]);
  const done = exam.sheets.length - pending.length;

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    try {
      const r = await api.uploadSheets(exam.id, files, groupSize);
      if (r.skipped.length) toast(`已跳过：${r.skipped.join('；')}`, 'bad');
      const splitMsg = r.split?.length
        ? `，其中 ${r.split.map((x) => `${x.name}（${x.pages} 页）拆成 ${x.parts} 份`).join('；')}`
        : '';
      if (r.sheets.length) toast(`已添加 ${r.sheets.length} 份答题卡${splitMsg}`, 'ok');
      await reload();
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setUploading(false);
    }
  };

  const start = async (force: boolean) => {
    try {
      const ids = force ? undefined : pending.map((s) => s.id);
      const r = await api.recognize(exam.id, { sheetIds: ids, force });
      if (!r.job.total) {
        toast('没有需要识别的答题卡', 'bad');
        return;
      }
      job.start(r.job);
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };

  const remove = async (s: Sheet) => {
    const ok = await confirm(`删除《${s.fileName}》？该学生的作答与评分会一起删除。`);
    if (!ok) return;
    try {
      await api.deleteSheet(s.id);
      await reload();
      toast('已删除', 'ok');
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };

  const saveName = async (s: Sheet) => {
    const name = (nameDraft[s.id] ?? '').trim();
    const no = (noDraft[s.id] ?? '').trim();
    if (name === s.studentName && no === s.studentNo) return;
    try {
      await api.updateSheet(s.id, { studentName: name, studentNo: no });
      await reload();
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };

  const saveAnswers = async () => {
    if (!editing) return;
    setSavingEdit(true);
    try {
      const answers: Record<string, string> = {};
      for (const q of exam.questions) {
        const el = document.getElementById(`ans-${q.id}`) as HTMLTextAreaElement | null;
        answers[q.id] = el?.value ?? '';
      }
      const nameEl = document.getElementById('edit-name') as HTMLInputElement | null;
      const noEl = document.getElementById('edit-no') as HTMLInputElement | null;
      await api.updateSheet(editing.id, {
        answers,
        studentName: nameEl?.value ?? '',
        studentNo: noEl?.value ?? '',
      });
      await reload();
      setEditing(null);
      toast('作答已保存', 'ok');
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setSavingEdit(false);
    }
  };

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <div>
            <h2>
              答题卡
              <span className="badge muted">{exam.sheets.length} 份</span>
              <span className="badge ok">已识别 {done}</span>
              {pending.length > 0 && <span className="badge warn">待处理 {pending.length}</span>}
            </h2>
            <div className="desc">每份文件对应一名学生（PDF 或照片）。文字版 PDF 直接读文本层；扫描件/照片会转成图片交给视觉模型。</div>
          </div>
          <div className="row">
            <button
              className="btn"
              onClick={() => {
                window.location.hash = `#/exam/${exam.id}/print`;
              }}
              title="生成并打印标准答题卡，四角定位块用于自动裁切"
            >
              <Icon name="printer" size={15} />
              出答题卡
            </button>
            {job.running ? (
              <button className="btn btn-danger" onClick={job.stop}>
                <Icon name="x" size={15} />
                停止
              </button>
            ) : (
              <>
                <button className="btn" onClick={() => void start(true)} disabled={!exam.sheets.length}>
                  <Icon name="refresh" size={15} />
                  全部重识别
                </button>
                <button className="btn btn-primary" onClick={() => void start(false)} disabled={!pending.length}>
                  <Icon name="play" size={15} />
                  开始识别{pending.length ? `（${pending.length}）` : ''}
                </button>
              </>
            )}
          </div>
        </div>

        <div className="card-body">
          <div className="row" style={{ gap: 10, marginBottom: 10 }}>
            <span className="small muted">整班一个 PDF 时，按每份</span>
            <input
              className="input sm"
              type="number"
              min={0}
              max={20}
              value={groupSize}
              onChange={(e) => setGroupSize(Math.max(0, Math.min(20, Number(e.target.value) || 0)))}
              style={{ width: 62 }}
              title="每份答题卡占几页；设为 0 或 1 表示不拆分"
            />
            <span className="small muted">
              页自动拆分
              {layoutPages > 1 ? `（当前答题卡 ${layoutPages} 页/份）` : ''}
            </span>
          </div>
          <div className="hint" style={{ marginBottom: 12, lineHeight: 1.8 }}>
            两种答题卡都支持，上传后自动判断：
            <b>本系统生成的答题卡</b>有四角定位块，按坐标精确裁切；
            <b>年级组下发的答题卡</b>没有定位块，靠版面分析：涂卡型找选项气泡，表格型找"题号行 + 答题行"，再按从上到下的顺序对应题目。
          </div>
          <div
            className={`dropzone ${over ? 'over' : ''}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              void upload([...e.dataTransfer.files].filter((f) => /\.(pdf|jpe?g|png|webp)$/i.test(f.name)));
            }}
          >
            {uploading ? (
              <>
                <Spinner />
                <strong>正在上传…</strong>
              </>
            ) : (
              <>
                <Icon name="upload" size={22} />
                <strong>点击选择，或把 PDF 拖到这里</strong>
                <small>可一次选多份；PDF 或手机拍的照片都行，单份不超过 40MB</small>
              </>
            )}
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf,.jpg,.jpeg,.png,.webp"
              multiple
              hidden
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                void upload(files);
              }}
            />
          </div>

          {(job.job || job.logs.length > 0) && (
            <div className="stack" style={{ marginTop: 16, gap: 10 }}>
              <div className="row between">
                <div className="row" style={{ gap: 8 }}>
                  {job.running && <Spinner />}
                  <span className="small">
                    {job.job
                      ? `${job.job.done}/${job.job.total} 份${job.job.failed ? ` · 失败 ${job.job.failed}` : ''}${job.job.current ? ` · ${job.job.current}` : ''}`
                      : ''}
                  </span>
                </div>
                <span className="hint">{job.running ? '识别中，可继续操作其它标签页' : '本次识别已结束'}</span>
              </div>
              <Progress value={job.job?.done ?? 0} total={job.job?.total ?? 1} ok={!job.running} />
              <div className="log">
                {job.logs.length === 0 ? (
                  <div className="faint">等待日志…</div>
                ) : (
                  job.logs.map((l, i) => (
                    <div key={i} className={`log-line ${l.level}`}>
                      <span className="t">{new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                      <span>{l.message}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {exam.sheets.length === 0 ? (
            <Empty
              icon="users"
              title="还没有答题卡"
              desc="把扫描或导出的学生答题卡 PDF 拖进上面的区域，每份 PDF 一名学生。"
            />
          ) : (
            <div className="table-wrap" style={{ marginTop: 16, borderTop: '1px solid var(--line)' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 46 }} className="center">
                      #
                    </th>
                    <th style={{ width: 150 }}>学生姓名</th>
                    <th style={{ width: 130 }}>学号</th>
                    <th>文件</th>
                    <th style={{ width: 96 }}>状态</th>
                    <th style={{ width: 96 }}>识别方式</th>
                    <th style={{ width: 92 }} />
                  </tr>
                </thead>
                <tbody>
                  {exam.sheets.map((s, i) => {
                    const st = STATUS[s.status] ?? STATUS.uploaded;
                    return (
                      <tr key={s.id}>
                        <td className="center muted">{i + 1}</td>
                        <td>
                          <input
                            className="input sm"
                            value={nameDraft[s.id] ?? ''}
                            placeholder="待识别"
                            onChange={(e) => setNameDraft((p) => ({ ...p, [s.id]: e.target.value }))}
                            onBlur={() => void saveName(s)}
                          />
                        </td>
                        <td>
                          <input
                            className="input sm"
                            value={noDraft[s.id] ?? ''}
                            placeholder="—"
                            onChange={(e) => setNoDraft((p) => ({ ...p, [s.id]: e.target.value }))}
                            onBlur={() => void saveName(s)}
                          />
                        </td>
                        <td>
                          <div className="truncate" style={{ maxWidth: 320 }} title={s.fileName}>
                            {s.fileName}
                          </div>
                          {s.error && s.status === 'failed' && (
                            <div className="small" style={{ color: 'var(--bad)', marginTop: 2 }}>
                              {s.error}
                            </div>
                          )}
                          <div className="faint small">{Object.keys(s.answers).length} 题有作答</div>
                        </td>
                        <td>
                          <Badge tone={st.tone}>{st.label}</Badge>
                        </td>
                        <td className="muted small">{s.method ? METHOD[s.method] : '—'}</td>
                        <td>
                          <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                            <button className="icon-btn" title="查看 / 修改作答" onClick={() => setEditing(s)}>
                              <Icon name="eye" size={15} />
                            </button>
                            <button className="icon-btn danger" title="删除" onClick={() => void remove(s)}>
                              <Icon name="trash" size={15} />
                            </button>
                          </div>
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

      <Modal
        open={!!editing}
        wide
        title={`作答详情 · ${editing?.fileName ?? ''}`}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button className="btn" onClick={() => setEditing(null)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={saveAnswers} disabled={savingEdit}>
              {savingEdit ? <Spinner light /> : <Icon name="check" size={15} />}
              保存
            </button>
          </>
        }
      >
        {editing && (
          <div className="stack">
            <div className="grid-2">
              <Field label="学生姓名">
                <input id="edit-name" className="input" defaultValue={editing.studentName} />
              </Field>
              <Field label="学号">
                <input id="edit-no" className="input" defaultValue={editing.studentNo} />
              </Field>
            </div>
            {exam.questions.map((q) => (
              <Field key={q.id} label={`第 ${q.no} 题 · ${q.maxScore} 分`} optional>
                <textarea
                  id={`ans-${q.id}`}
                  className="textarea"
                  rows={2}
                  defaultValue={editing.answers[q.id]?.content ?? ''}
                  placeholder="该学生此题的作答（未作答留空）"
                />
              </Field>
            ))}
            <div className="hint">修改后会被标记为「手动录入」，不会被重新识别覆盖，除非你点击「全部重识别」。</div>
          </div>
        )}
      </Modal>

      {confirmView}
    </div>
  );
}

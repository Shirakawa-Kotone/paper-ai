import { useEffect, useMemo, useRef, useState } from 'react';
import { useLeaveGuard } from '../guard.tsx';
import type { ExamDetail, Question, QuestionKind } from '../../../shared/types.ts';
import { QUESTION_KINDS } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { Badge, Field, Modal, Spinner, useConfirm, useToast } from '../components/ui.tsx';
import { Icon } from '../icons.tsx';

type Draft = {
  key: string;
  id?: string;
  no: string;
  kind: QuestionKind;
  maxScore: string;
  answer: string;
  rubric: string;
};

const KIND_LABEL: Record<QuestionKind, string> = {
  choice: '单选题',
  multi: '多选题',
  fill: '填空题',
  equation: '方程式/公式',
  calc: '计算题',
  short: '简答题',
};

const labelToKind = (raw: string): QuestionKind | null => {
  const t = raw.trim();
  if (!t) return null;
  const hit = QUESTION_KINDS.find((k) => k.label === t || k.label.replace('题', '') === t.replace('题', ''));
  if (hit) return hit.id;
  if (/^(选择|单选题|choice)$/i.test(t)) return 'choice';
  if (/^(填空|fill)$/i.test(t)) return 'fill';
  if (/方程|equation/i.test(t)) return 'equation';
  if (/计算|calc/i.test(t)) return 'calc';
  if (/简答|short|问答/i.test(t)) return 'short';
  return null;
};

const toDraft = (q: Question): Draft => ({
  key: q.id,
  id: q.id,
  no: q.no,
  kind: q.kind,
  maxScore: String(q.maxScore),
  answer: q.answer,
  rubric: q.rubric,
});

export function QuestionsPage({ exam, reload }: { exam: ExamDetail; reload: () => Promise<void> }) {
  const toast = useToast();
  const { confirm, view: confirmView } = useConfirm();
  const [drafts, setDrafts] = useState<Draft[]>(() => exam.questions.map(toDraft));
  const [saving, setSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const { setDirty: markDirty, registerSave } = useLeaveGuard();
  const [paperOpen, setPaperOpen] = useState(false);
  const [paperBusy, setPaperBusy] = useState(false);
  const [paperError, setPaperError] = useState('');
  const [paper, setPaper] = useState<{
    title: string;
    notes: string;
    method: 'text' | 'vision';
    questions: { no: string; kind: QuestionKind; maxScore: number; answer: string; note: string }[];
  } | null>(null);
  const paperInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDrafts(exam.questions.map(toDraft));
  }, [exam.questions]);

  const dirty = useMemo(() => {
    if (drafts.length !== exam.questions.length) return true;
    return drafts.some((d, i) => {
      const q = exam.questions[i];
      return (
        !q ||
        d.id !== q.id ||
        d.no !== q.no ||
        d.kind !== q.kind ||
        Number(d.maxScore) !== q.maxScore ||
        d.answer !== q.answer ||
        d.rubric !== q.rubric
      );
    });
  }, [drafts, exam.questions]);

  const total = drafts.reduce((a, d) => a + (Number(d.maxScore) || 0), 0);

  // 有未保存改动时，切页面/关标签都会先确认
  useEffect(() => {
    markDirty(dirty);
    return () => markDirty(false);
  }, [dirty, markDirty]);


  const patch = (key: string, p: Partial<Draft>) =>
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...p } : d)));

  const add = () => {
    const nextNo = String(
      Math.max(0, ...drafts.map((d) => Number(d.no) || 0)) + 1,
    );
    setDrafts((prev) => [
      ...prev,
      { key: `new-${Date.now()}-${prev.length}`, no: nextNo, kind: 'short', maxScore: '5', answer: '', rubric: '' },
    ]);
  };

  const remove = async (key: string) => {
    const d = drafts.find((x) => x.key === key);
    if (d && (d.answer || d.id)) {
      const ok = await confirm(`删除第 ${d.no} 题？该题已有的作答和评分会失去关联。`);
      if (!ok) return;
    }
    setDrafts((prev) => prev.filter((x) => x.key !== key));
  };

  const validate = (): string | null => {
    if (!drafts.length) return '至少需要一道题';
    const seen = new Set<string>();
    for (const d of drafts) {
      const no = d.no.trim();
      if (!no) return '题号不能为空';
      if (seen.has(no)) return `题号「${no}」重复`;
      seen.add(no);
      const score = Number(d.maxScore);
      if (!Number.isFinite(score) || score <= 0) return `第 ${no} 题的满分必须是大于 0 的数字`;
      if (score > 200) return `第 ${no} 题的满分过大`;
    }
    return null;
  };

  const save = async (): Promise<boolean> => {
    const err = validate();
    if (err) {
      toast(err, 'bad');
      return false;
    }
    setSaving(true);
    try {
      await api.saveQuestions(
        exam.id,
        drafts.map((d) => ({
          id: d.id,
          no: d.no.trim(),
          kind: d.kind,
          maxScore: Number(d.maxScore),
          answer: d.answer,
          rubric: d.rubric,
        })),
      );
      await reload();
      markDirty(false);
      toast('试题已保存', 'ok');
      return true;
    } catch (e) {
      toast((e as Error).message, 'bad');
      return false;
    } finally {
      setSaving(false);
    }
  };

  // 让"保存并离开"能调用到最新的 save
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    registerSave(() => saveRef.current());
    return () => registerSave(null);
  }, [registerSave]);

  const parsePaper = async (file: File) => {
    setPaperBusy(true);
    setPaperError('');
    setPaper(null);
    try {
      const r = await api.importPaper(exam.id, file);
      setPaper(r);
      if (!r.questions.length) setPaperError('没有解析出题目');
    } catch (e) {
      setPaperError((e as Error).message);
    } finally {
      setPaperBusy(false);
    }
  };

  const applyPaper = () => {
    if (!paper) return;
    setDrafts(
      paper.questions.map((q, i) => ({
        key: `paper-${Date.now()}-${i}`,
        no: q.no,
        kind: q.kind,
        maxScore: String(q.maxScore || 5),
        answer: q.answer,
        rubric: '',
      })),
    );
    setPaperOpen(false);
    toast(`已填入 ${paper.questions.length} 道题，检查分值后记得点保存`, 'ok');
  };

  const importLines = (text: string) => {
    const rows = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const parsed: Draft[] = [];
    for (const [i, line] of rows.entries()) {
      const parts = line.split(/[,，\t]/).map((p) => p.trim());
      if (parts.length < 2) continue;
      const no = parts[0];
      let score: number;
      let kind: QuestionKind = 'short';
      let answer = '';

      const maybeScore = Number(parts[1]);
      if (Number.isFinite(maybeScore)) {
        score = maybeScore;
        const maybeKind = parts[2] ? labelToKind(parts[2]) : null;
        if (maybeKind) {
          kind = maybeKind;
          answer = parts.slice(3).join('，');
        } else {
          answer = parts.slice(2).join('，');
        }
      } else {
        // 题号,类型,分值,答案
        const maybeKind = labelToKind(parts[1]);
        if (!maybeKind) continue;
        kind = maybeKind;
        score = Number(parts[2]);
        answer = parts.slice(3).join('，');
      }
      if (!Number.isFinite(score) || score <= 0) continue;
      parsed.push({
        key: `imp-${Date.now()}-${i}`,
        no,
        kind,
        maxScore: String(score),
        answer,
        rubric: '',
      });
    }
    if (!parsed.length) {
      toast('没有解析出题目，请检查格式', 'bad');
      return;
    }
    setDrafts(parsed);
    setImportOpen(false);
    toast(`已导入 ${parsed.length} 道题，记得点保存`, 'ok');
  };

  const missing = drafts.filter((d) => !d.answer.trim()).length;

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <div>
            <h2>
              试题与参考答案
              <span className="badge muted">共 {drafts.length} 题</span>
              <span className="badge accent">满分 {total} 分</span>
              {missing > 0 && <span className="badge warn">{missing} 题缺参考答案</span>}
            </h2>
            <div className="desc">
              题号必须与答题卡上的题号一致。单选题填一个字母（如 <span className="mono">B</span>）；多选题填全部正确选项（如{' '}
              <span className="mono">ABD</span>），并在<b>给分点</b>里写清少选/错选怎么给分，AI 按它判；主观题同理。
            </div>
          </div>
          <div className="row">
            <button
              className="btn"
              onClick={() => {
                setPaper(null);
                setPaperError('');
                setPaperOpen(true);
              }}
              title="上传试卷 PDF 或照片，自动提取题目、题型和分值"
            >
              <Icon name="file" size={15} />
              导入试卷
            </button>
            <button className="btn" onClick={() => setImportOpen(true)}>
              <Icon name="upload" size={15} />
              批量粘贴
            </button>
            <button className="btn" onClick={add}>
              <Icon name="plus" size={15} />
              添加一题
            </button>
            <button className="btn btn-primary" onClick={save} disabled={!dirty || saving}>
              {saving ? <Spinner light /> : <Icon name="check" size={15} />}
              保存
            </button>
          </div>
        </div>

        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 72 }}>题号</th>
                <th style={{ width: 136 }}>类型</th>
                <th style={{ width: 88 }}>满分</th>
                <th style={{ minWidth: 240 }}>参考答案</th>
                <th style={{ minWidth: 240 }}>给分点（提升 AI 准确率）</th>
                <th style={{ width: 52 }} />
              </tr>
            </thead>
            <tbody>
              {drafts.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: 28, color: 'var(--muted)' }}>
                    还没有题目，点右上角「添加一题」或「批量导入」
                  </td>
                </tr>
              )}
              {drafts.map((d) => (
                <tr key={d.key}>
                  <td>
                    <input
                      className="input sm"
                      value={d.no}
                      onChange={(e) => patch(d.key, { no: e.target.value })}
                      style={{ width: 56 }}
                    />
                  </td>
                  <td>
                    <select
                      className="select"
                      value={d.kind}
                      onChange={(e) => patch(d.key, { kind: e.target.value as QuestionKind })}
                      style={{ height: 30, fontSize: 13 }}
                    >
                      {QUESTION_KINDS.map((k) => (
                        <option key={k.id} value={k.id}>
                          {k.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      className="input sm"
                      type="number"
                      min={0}
                      step={0.5}
                      value={d.maxScore}
                      onChange={(e) => patch(d.key, { maxScore: e.target.value })}
                      style={{ width: 64 }}
                    />
                  </td>
                  <td>
                    <textarea
                      className="textarea"
                      rows={2}
                      value={d.answer}
                      onChange={(e) => patch(d.key, { answer: e.target.value })}
                      placeholder={d.kind === 'choice' ? 'B' : '参考答案 / 得分要点'}
                      style={{ minHeight: 42, fontSize: 13 }}
                    />
                  </td>
                  <td>
                    <textarea
                      className="textarea"
                      rows={2}
                      value={d.rubric}
                      onChange={(e) => patch(d.key, { rubric: e.target.value })}
                      placeholder="例如：公式 2 分，代入数据 2 分，结果 1 分"
                      style={{ minHeight: 42, fontSize: 13 }}
                    />
                  </td>
                  <td>
                    <button className="icon-btn danger" title="删除本题" onClick={() => remove(d.key)}>
                      <Icon name="trash" size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {dirty && (
        <div className="row hint">
          <Badge tone="warn">未保存</Badge>
          修改只在本地，记得点右上角「保存」。
        </div>
      )}

      <Modal
        open={paperOpen}
        title="从试卷生成试题"
        wide
        onClose={() => setPaperOpen(false)}
        footer={
          <>
            <button className="btn" onClick={() => setPaperOpen(false)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={applyPaper} disabled={!paper || paperBusy}>
              <Icon name="check" size={15} />
              填入表格
            </button>
          </>
        }
      >
        <div className="stack">
          <div className="hint">
            上传试卷的 PDF 或清晰照片，系统会提取<b>题号、题型、分值和参考答案</b>，填进下面的试题表，确认后再保存。
            扫描件需要配置视觉模型。
          </div>

          <input
            ref={paperInput}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void parsePaper(f);
            }}
          />

          <div className="row">
            <button className="btn" onClick={() => paperInput.current?.click()} disabled={paperBusy}>
              {paperBusy ? <Spinner /> : <Icon name="upload" size={15} />}
              {paperBusy ? '正在解析，扫描件可能要等 20 秒…' : '选择试卷文件'}
            </button>
            {paper && (
              <span className="hint">
                解析方式：{paper.method === 'text' ? 'PDF 文本层' : '视觉模型'}
                {paper.title ? ` · 《${paper.title}》` : ''}
              </span>
            )}
          </div>

          {paperError && <div className="badge bad">{paperError}</div>}

          {paper && paper.questions.length > 0 && (
            <>
              {paper.notes && <div className="hint">模型备注：{paper.notes}</div>}
              <div className="table-wrap" style={{ maxHeight: 360, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 70 }}>题号</th>
                      <th style={{ width: 110 }}>题型</th>
                      <th style={{ width: 70 }} className="num">
                        分值
                      </th>
                      <th>参考答案</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paper.questions.map((q, i) => (
                      <tr key={`${q.no}-${i}`}>
                        <td>{q.no}</td>
                        <td className="muted">{KIND_LABEL[q.kind] ?? q.kind}</td>
                        <td className="num" style={{ color: q.maxScore ? undefined : 'var(--warn)' }}>
                          {q.maxScore || '待填'}
                        </td>
                        <td className="muted" style={{ maxWidth: 380 }}>
                          <div className="truncate">{q.answer || '—'}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="hint">
                共 {paper.questions.length} 题。分值不确定的会先用 5 分占位，填入表格后可以在表里改。
              </div>
            </>
          )}
        </div>
      </Modal>

      <Modal
        open={importOpen}
        title="批量粘贴试题"
        wide
        onClose={() => setImportOpen(false)}
        footer={
          <>
            <button className="btn" onClick={() => setImportOpen(false)}>
              取消
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                const el = document.getElementById('import-area') as HTMLTextAreaElement | null;
                if (el) importLines(el.value);
              }}
            >
              导入并覆盖
            </button>
          </>
        }
      >
        <div className="stack">
          <Field
            label="每行一道题"
            hint="格式：题号,类型,满分,参考答案 —— 例如 `1,选择题,5,B` 或 `2,方程式,6,MnO2 + 4HCl(浓) = MnCl2 + Cl2↑ + 2H2O`。类型可省略（默认简答题）。"
          >
            <textarea
              id="import-area"
              className="textarea"
              rows={12}
              spellCheck={false}
              placeholder={`1,选择题,5,B
2,方程式,6,MnO2 + 4HCl(浓) = MnCl2 + Cl2↑ + 2H2O
3,简答题,8,先加稀盐酸酸化，再加 BaCl2 溶液，产生白色沉淀
4,计算题,6,pH = -lg(0.1) = 1`}
              style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}
            />
          </Field>
          <div className="hint">导入会覆盖当前列表（包括题号和答案），但已存在的题目若题号相同，作答与评分会保留。</div>
        </div>
      </Modal>

      {confirmView}
    </div>
  );
}

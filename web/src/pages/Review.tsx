import { useMemo, useState } from 'react';
import type { ExamDetail } from '../../../shared/types.ts';
import { api, cropUrl } from '../api.ts';
import { collectReviewItems } from '../review.ts';
import { Badge, Empty, Modal, Spinner, useToast } from '../components/ui.tsx';
import { Icon } from '../icons.tsx';

const MODE_LABEL: Record<string, string> = {
  omr: '涂卡',
  ocr: 'OCR',
  vision: '视觉模型',
  manual: '手动',
  text: '文本层',
};

export function ReviewPage({ exam, reload }: { exam: ExamDetail; reload: () => Promise<void> }) {
  const toast = useToast();
  const items = useMemo(() => collectReviewItems(exam), [exam]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ src: string; title: string } | null>(null);

  const keyOf = (sheetId: string, qid: string) => `${sheetId}:${qid}`;

  const act = async (sheetId: string, qid: string, fn: () => Promise<unknown>, message: string) => {
    const key = keyOf(sheetId, qid);
    setBusy(key);
    try {
      await fn();
      await reload();
      toast(message, 'ok');
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  if (!items.length) {
    return (
      <div className="card">
        <Empty
          icon="check-circle"
          title="没有待复核的题目"
          desc="识别把握足够、AI 评分稳定的题都不会出现在这里。若想抽查，可以到「成绩」里点击任意分数修改。"
        />
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <div>
            <h2>
              待复核
              <Badge tone="warn">{items.length} 处</Badge>
            </h2>
            <div className="desc">
              左边是系统从答题卡上裁下来的原图，中间是可以改写的识别文本。看不清就直接判对/判错，不用纠结 OCR。
            </div>
          </div>
        </div>
      </div>

      {items.map((item) => {
        const key = keyOf(item.sheet.id, item.question.id);
        const crop = item.answer?.crop;
        const src = crop ? cropUrl(item.sheet.id, crop) : null;
        const text = drafts[key] ?? item.answer?.content ?? '';
        const score = item.grade?.score ?? 0;
        const max = item.question.maxScore;

        return (
          <div className="card" key={key}>
            <div className="review-row">
              <div className="review-crop">
                {src ? (
                  <button
                    className="crop-btn"
                    onClick={() =>
                      setPreview({
                        src,
                        title: `${item.sheet.studentName || item.sheet.fileName} · 第 ${item.question.no} 题`,
                      })
                    }
                    title="点击放大"
                  >
                    <img src={src} alt={`第${item.question.no}题作答`} />
                  </button>
                ) : (
                  <div className="crop-empty">
                    <Icon name="file" size={18} />
                    <span>没有裁切图</span>
                  </div>
                )}
              </div>

              <div className="review-main">
                <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                  <strong>{item.sheet.studentName || item.sheet.fileName}</strong>
                  <Badge tone="muted">第 {item.question.no} 题</Badge>
                  <Badge tone="muted">{max} 分</Badge>
                  {item.answer?.mode && <Badge tone="accent">{MODE_LABEL[item.answer.mode] ?? item.answer.mode}</Badge>}
                  {item.reasons.map((r) => (
                    <Badge key={r} tone="warn">
                      {r}
                    </Badge>
                  ))}
                  <span className="faint small">
                    {item.grade ? `当前 ${score} 分` : '未评分'}
                    {item.answer?.confidence != null ? ` · 置信度 ${(item.answer.confidence * 100).toFixed(0)}%` : ''}
                  </span>
                </div>

                <div className="field" style={{ marginBottom: 10 }}>
                  <div className="label">识别文本（可修改）</div>
                  <textarea
                    className="textarea"
                    rows={2}
                    value={text}
                    placeholder="识别为空，可以手动补上学生的作答"
                    onChange={(e) => setDrafts((p) => ({ ...p, [key]: e.target.value }))}
                    style={{ fontFamily: 'var(--mono)', fontSize: 13 }}
                  />
                </div>

                <div className="field" style={{ marginBottom: 12 }}>
                  <div className="label">参考答案</div>
                  <div className="answer-ref">{item.question.answer || '（未填写参考答案）'}</div>
                </div>

                <div className="row" style={{ gap: 8 }}>
                  <button
                    className="btn btn-sm"
                    disabled={busy === key}
                    onClick={() =>
                      act(
                        item.sheet.id,
                        item.question.id,
                        () => api.updateAnswer(item.sheet.id, item.question.id, text),
                        '识别文本已保存',
                      )
                    }
                  >
                    <Icon name="check" size={13} />
                    保存文本
                  </button>

                  <span className="divider-v" />

                  <button
                    className="btn btn-sm"
                    disabled={busy === key}
                    onClick={() =>
                      act(
                        item.sheet.id,
                        item.question.id,
                        () => api.setGrade(item.sheet.id, item.question.id, { score: max, needsReview: false }),
                        '已判为正确（满分）',
                      )
                    }
                  >
                    <Icon name="check-circle" size={13} />
                    判对（{max}）
                  </button>
                  <button
                    className="btn btn-sm"
                    disabled={busy === key}
                    onClick={() =>
                      act(
                        item.sheet.id,
                        item.question.id,
                        () =>
                          api.setGrade(item.sheet.id, item.question.id, {
                            score: 0,
                            needsReview: false,
                            comment: '人工判定错误',
                          }),
                        '已判为错误（0 分）',
                      )
                    }
                  >
                    <Icon name="x" size={13} />
                    判错（0）
                  </button>

                  <span className="divider-v" />

                  <input
                    className="input score"
                    type="number"
                    min={0}
                    max={max}
                    step={0.5}
                    value={drafts[`${key}:score`] ?? String(score)}
                    onChange={(e) => setDrafts((p) => ({ ...p, [`${key}:score`]: e.target.value }))}
                  />
                  <span className="faint small">/{max}</span>
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={busy === key}
                    onClick={() => {
                      const v = Number(drafts[`${key}:score`] ?? score);
                      if (!Number.isFinite(v)) return toast('请输入有效分数', 'bad');
                      void act(
                        item.sheet.id,
                        item.question.id,
                        () =>
                          api.setGrade(item.sheet.id, item.question.id, {
                            score: Math.max(0, Math.min(v, max)),
                            needsReview: false,
                          }),
                        '分数已更新',
                      );
                    }}
                  >
                    {busy === key ? <Spinner light /> : '确认分数'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })}

      <Modal open={!!preview} title={preview?.title ?? ''} onClose={() => setPreview(null)} wide>
        {preview && <img src={preview.src} alt="作答原图" style={{ width: '100%', borderRadius: 8 }} />}
      </Modal>
    </div>
  );
}

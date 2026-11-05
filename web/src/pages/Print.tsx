import { useEffect, useState } from 'react';
import { api, templatePdfUrl } from '../api.ts';
import type { SheetLayout } from '../../../shared/types.ts';
import { Icon } from '../icons.tsx';
import { Spinner, useToast } from '../components/ui.tsx';

export function PrintPage({ examId, onBack }: { examId: string; onBack: () => void }) {
  const toast = useToast();
  const [layout, setLayout] = useState<SheetLayout | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        setLayout((await api.template(examId)) as SheetLayout);
      } catch (e) {
        toast((e as Error).message, 'bad');
      } finally {
        setLoading(false);
      }
    })();
  }, [examId, toast]);

  if (loading) {
    return (
      <div className="row" style={{ justifyContent: 'center', padding: 80 }}>
        <Spinner />
      </div>
    );
  }
  if (!layout) return null;

  return (
    <div className="print-page">
      <div className="print-bar no-print">
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          <Icon name="chevron-left" size={13} />
          返回
        </button>
        <div className="row" style={{ gap: 8 }}>
          <span className="hint">A4 纵向 · 共 {layout.pageCount} 页 · 打印时请关闭"适应页面"缩放</span>
          <a className="btn" href={templatePdfUrl(examId)} download>
            <Icon name="download" size={15} />
            下载 PDF
          </a>
          <button className="btn btn-primary" onClick={() => window.print()}>
            <Icon name="printer" size={15} />
            打印
          </button>
        </div>
      </div>

      <div className="sheet-stack">
        {layout.pages.map((page) => (
          <div className="sheet-page" key={page.index}>
            <div
              className="sheet-frame"
              style={{ left: `${page.frame.x}mm`, top: `${page.frame.y}mm`, width: `${page.frame.w}mm`, height: `${page.frame.h}mm` }}
            />
            {page.markers.map((m, i) => (
              <div
                key={i}
                className="sheet-marker"
                style={{
                  left: `${m.x - m.size / 2}mm`,
                  top: `${m.y - m.size / 2}mm`,
                  width: `${m.size}mm`,
                  height: `${m.size}mm`,
                  borderWidth: `${m.size / 2}mm`,
                }}
              />
            ))}

            <div className="sheet-title">{layout.examName || '化学考试答题卡'}</div>
            <div className="sheet-meta">
              {[layout.grade, `满分 ${layout.fullScore} 分`, `第 ${page.index + 1} / ${layout.pageCount} 页`]
                .filter(Boolean)
                .join('   ·   ')}
            </div>
            <div className="sheet-note">所有题目直接在框内作答：选择题写字母（多选写全，如 ABD），其余写完整过程，不要超出边框</div>

            {page.header.map((h) => (
              <div key={h.field}>
                <div
                  className="sheet-header-label"
                  style={{ left: `${h.field === 'name' ? 16 : 106}mm`, top: `${h.y + 2.6}mm` }}
                >
                  {h.field === 'name' ? '姓名' : '学号'}
                </div>
                <div
                  className="sheet-input-box"
                  style={{ left: `${h.x}mm`, top: `${h.y}mm`, width: `${h.w}mm`, height: `${h.h}mm` }}
                />
              </div>
            ))}

            {page.boxes.map((box) => {
              const isChoice = box.qkind === 'choice' || box.qkind === 'multi';
              return (
                <div key={box.qid}>
                  <div
                    className="sheet-qno"
                    style={{
                      left: `${isChoice ? box.x - 6 : 14}mm`,
                      top: `${box.y + (isChoice ? 1.4 : 1.2)}mm`,
                      fontSize: isChoice ? '3.2mm' : undefined,
                    }}
                  >
                    {box.no}.
                  </div>
                  <div
                    className="sheet-box"
                    style={{ left: `${box.x}mm`, top: `${box.y}mm`, width: `${box.w}mm`, height: `${box.h}mm` }}
                  />
                  {!isChoice &&
                    Array.from({ length: Math.max(0, Math.floor((box.h - 7) / 6.5)) }).map((_, k) => (
                      <div
                        key={k}
                        className="sheet-rule"
                        style={{
                          left: `${box.x + 2}mm`,
                          top: `${box.y + 6 + k * 6.5}mm`,
                          width: `${box.w - 4}mm`,
                        }}
                      />
                    ))}
                </div>
              );
            })}

            <div className="sheet-footer">
              paper-ai · 第 {page.index + 1} 页
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

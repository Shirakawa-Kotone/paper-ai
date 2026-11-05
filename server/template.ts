import type {
  HeaderBox,
  LayoutBox,
  Marker,
  Question,
  QuestionKind,
  SheetLayout,
  SheetPage,
} from '../shared/types.ts';

/** A4 尺寸，单位 mm */
export const PAGE = { width: 210, height: 297 } as const;

const MARGIN = { left: 12, right: 12, top: 10, bottom: 10 };
const FRAME = {
  x: MARGIN.left,
  y: MARGIN.top,
  w: PAGE.width - MARGIN.left - MARGIN.right,
  h: PAGE.height - MARGIN.top - MARGIN.bottom,
};
const MARKER_SIZE = 7;
const MARKER_INSET = 8;
const HEADER_BOX_Y = 38;
const CONTENT_TOP = 53;
const CONTENT_BOTTOM = 274;

const BOX_X = 26;
const BOX_W = 162;

/** 选择题排成网格：一行 6 个，只留一个小方框让学生写字母 */
const CHOICE_COLS = 6;
const CHOICE_CELL_W = BOX_W / CHOICE_COLS; // 27mm
const CHOICE_ROW_H = 10;
const CHOICE_BOX_W = 19;
const CHOICE_BOX_H = 8;
const CHOICE_BOX_DX = 6.8;


/** 主观题的高度：在能写字的前提下尽量压缩 */
const HEIGHT: Record<QuestionKind, number> = {
  choice: CHOICE_ROW_H,
  multi: CHOICE_ROW_H,
  fill: 11,
  equation: 14,
  calc: 18,
  short: 24,
};
const GAP_AFTER_TEXT = 3;

export function markerCenters(): Marker[] {
  const x1 = FRAME.x + MARKER_INSET + MARKER_SIZE / 2;
  const x2 = FRAME.x + FRAME.w - MARKER_INSET - MARKER_SIZE / 2;
  const y1 = FRAME.y + MARKER_INSET + MARKER_SIZE / 2;
  const y2 = FRAME.y + FRAME.h - MARKER_INSET - MARKER_SIZE / 2;
  return [
    { x: x1, y: y1, size: MARKER_SIZE },
    { x: x2, y: y1, size: MARKER_SIZE },
    { x: x2, y: y2, size: MARKER_SIZE },
    { x: x1, y: y2, size: MARKER_SIZE },
  ];
}

/**
 * 根据题目生成答题卡版式。前后端共用同一套毫米坐标，
 * 因此"打印的框"和"裁切的框"永远对得上。
 *
 * 排版策略：
 *  - 选择题 6 个一行，每格 27×10mm，学生直接写 A/B/C/D，不用涂卡；
 *  - 主观题按题型给不同高度的作答框，尽量一页放下。
 */
export function buildLayout(exam: {
  id: string;
  name: string;
  grade: string;
  questions: Question[];
}): SheetLayout {
  const markers = markerCenters();
  const pages: SheetPage[] = [];
  let page = newPage(0, markers);
  let y = CONTENT_TOP;
  let col = 0; // 当前选择题格子的列号，0 表示不在选择题行里

  const newPageIfNeeded = (need: number) => {
    if (y + need <= CONTENT_BOTTOM) return;
    pages.push(page);
    page = newPage(pages.length, markers);
    y = CONTENT_TOP;
    col = 0;
  };

  const flushChoiceRow = () => {
    if (col === 0) return;
    col = 0;
    y += CHOICE_ROW_H;
  };

  for (const q of exam.questions) {
    if (q.kind === 'choice' || q.kind === 'multi') {
      if (col === 0) newPageIfNeeded(CHOICE_ROW_H);
      const cellX = BOX_X + col * CHOICE_CELL_W;
      page.boxes.push({
        kind: 'question',
        qid: q.id,
        no: q.no,
        qkind: q.kind,
        x: cellX + CHOICE_BOX_DX,
        y: y + 1,
        w: CHOICE_BOX_W,
        h: CHOICE_BOX_H,
      });
      col += 1;
      if (col >= CHOICE_COLS) {
        col = 0;
        y += CHOICE_ROW_H;
      }
      continue;
    }

    flushChoiceRow();
    const h = HEIGHT[q.kind] ?? 16;
    newPageIfNeeded(h);
    page.boxes.push({
      kind: 'question',
      qid: q.id,
      no: q.no,
      qkind: q.kind,
      x: BOX_X,
      y,
      w: BOX_W,
      h,
    });
    y += h + GAP_AFTER_TEXT;
  }
  flushChoiceRow();
  pages.push(page);

  const fullScore = exam.questions.reduce((a, q) => a + (Number(q.maxScore) || 0), 0);
  return {
    examId: exam.id,
    examName: exam.name,
    grade: exam.grade,
    fullScore,
    pageCount: pages.length,
    pages,
    createdAt: new Date().toISOString(),
  };
}

function newPage(index: number, markers: Marker[]): SheetPage {
  return {
    index,
    markers: markers.map((m) => ({ ...m })),
    frame: { ...FRAME },
    header: [
      { kind: 'header', field: 'name', x: 34, y: HEADER_BOX_Y, w: 62, h: 9 },
      { kind: 'header', field: 'no', x: 124, y: HEADER_BOX_Y, w: 66, h: 9 },
    ] as HeaderBox[],
    boxes: [] as LayoutBox[],
  };
}

/** 题号规范化（与识别管线保持一致） */
export function normalizeNo(raw: unknown): string {
  let s = String(raw ?? '').trim();
  s = s.replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(/^第\s*/, '').replace(/\s*题$/, '');
  s = s.replace(/[、.。:：,，)）\]]+$/g, '');
  s = s.replace(/\s+/g, '');
  const m = s.match(/^0*(\d+(?:\.\d+)?)/);
  return m ? m[1] : s;
}

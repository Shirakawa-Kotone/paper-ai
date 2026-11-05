import type { Answer, ExamDetail, Grade, Question, SheetDetail } from '../../shared/types.ts';

export type ReviewItem = {
  sheet: SheetDetail;
  question: Question;
  answer: Answer | undefined;
  grade: Grade | undefined;
  reasons: string[];
};

export const LOW_CONFIDENCE = 0.62;

export function collectReviewItems(exam: ExamDetail): ReviewItem[] {
  const items: ReviewItem[] = [];
  for (const sheet of exam.sheets) {
    for (const question of exam.questions) {
      // 选择题（客观题）不进人工复核
      if (question.kind === 'choice') continue;
      const answer = sheet.answers[question.id];
      const grade = sheet.grades[question.id];
      if (!answer && !grade) continue;
      const reasons: string[] = [];
      if (answer && (answer.confidence ?? 1) < LOW_CONFIDENCE) reasons.push('识别把握不足');
      if (grade?.needsReview) reasons.push('AI 建议复核');
      if (answer && answer.content && !grade) reasons.push('尚未评分');
      if (reasons.length) items.push({ sheet, question, answer, grade, reasons });
    }
  }
  return items.sort((a, b) => (a.sheet.studentName || '').localeCompare(b.sheet.studentName || ''));
}

import type { Lesson, LessonSource } from './stores.js';

/**
 * A correction becomes a lesson (`docs/fira-architecture.md`, §5): the owner edits a reply in the review center, or a client fixes his agent's
 * answer in the cabinet. The lesson is text (question, what was said, how it should be), kept at the company, and comes back as a few-shot
 * when a close question arrives. An edit that changes nothing, or only spaces and punctuation, teaches nothing and gives null.
 */
export interface EditInput {
  companyId: string;
  agentId: string;
  roleId: string;
  /** What the person asked (for a review item of HQ: the brief of the task). */
  question: string;
  before: string;
  after: string;
  source: LessonSource;
  at: number;
}

const squash = (s: string): string => s.toLowerCase().replace(/[\s.,!?;:«»"'()-]+/g, '');

export function lessonFromEdit(e: EditInput): Omit<Lesson, 'id'> | null {
  const good = e.after.trim();
  if (!good || !e.question.trim()) return null;
  if (squash(good) === squash(e.before)) return null;
  return {
    companyId: e.companyId, agentId: e.agentId, roleId: e.roleId, question: e.question.trim().slice(0, 500), bad: e.before.trim().slice(0, 1500),
    good: good.slice(0, 1500), source: e.source, createdAt: e.at,
  };
}

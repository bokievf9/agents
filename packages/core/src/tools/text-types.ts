/** Shapes of the lexicon data used by `text.humanize` and `text.detect` (data lives in `text-lexicon-en.ts` and `text-lexicon-ru.ts`). */
export interface InvisibleRule {
  /** `U+200B` or a range `U+E0000-U+E007F`. */
  cp: string;
  name: string;
  /** `delete` removes the character, `space` turns it into a plain space. */
  action: 'delete' | 'space';
}

export interface TypoRule {
  from: string;
  name: string;
  to: string;
}

/**
 * One stock word or phrase. `find` may end with `*` (any letters after the stem: Russian endings). `replace`:
 * a plain text; `''` deletes the match; `null` only reports (a rewrite needs judgement); a `replace` ending with `*` keeps the matched ending.
 */
export interface LexEntry {
  find: string;
  replace: string | null;
  family: string;
}

export interface StructureRule {
  id: string;
  /** JS regex source and flags. */
  regex: string;
  flags: string;
  name: string;
  fix: string;
}

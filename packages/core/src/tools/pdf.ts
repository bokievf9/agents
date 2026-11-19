import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { z } from 'zod';

/**
 * A4 PDF of a structured document (КП, договор, счёт, акт): title, meta lines, sections with paragraphs and an optional table,
 * signature lines, a footer with page numbers. Fonts: Onest (OFL) from `packages/core/assets/fonts`. The Onest files are
 * subsets (Latin, Cyrillic and Cyrillic Extended apart), so every line is written in runs, each in the subset that has its letters.
 */
export const pdfDocSchema = z.object({
  title: z.string().trim().min(1).max(200),
  meta: z.array(z.string().max(300)).max(20).default([]),
  sections: z
    .array(
      z.object({
        heading: z.string().max(200).optional(),
        paragraphs: z.array(z.string().max(5000)).max(50).default([]),
        table: z
          .object({
            columns: z.array(z.string().max(100)).min(1).max(8),
            rows: z.array(z.array(z.string().max(500))).max(300),
            /** Relative column widths (default equal). */
            widths: z.array(z.number().positive()).optional(),
          })
          .refine((t) => t.rows.every((r) => r.length === t.columns.length), { message: 'every row needs one cell per column' })
          .refine((t) => !t.widths || t.widths.length === t.columns.length, { message: 'one width per column' })
          .optional(),
      }),
    )
    .max(60),
  footer: z.string().max(300).optional(),
  /** One signature block per line, e.g. «Исполнитель: ____________ / Fir Tech». */
  signatures: z.array(z.string().max(200)).max(4).default([]),
});
export type PdfDoc = z.input<typeof pdfDocSchema>;

export const FONT_DIR = fileURLToPath(new URL('../../assets/fonts/', import.meta.url));
const FONTS = {
  lat: 'onest-latin-400-normal.woff',
  latB: 'onest-latin-700-normal.woff',
  cyr: 'onest-cyrillic-400-normal.woff',
  cyrB: 'onest-cyrillic-700-normal.woff',
  ext: 'onest-cyrillic-ext-400-normal.woff',
  extB: 'onest-cyrillic-ext-700-normal.woff',
} as const;

export const fontsPresent = (dir = FONT_DIR): boolean => Object.values(FONTS).every((f) => existsSync(`${dir}${f}`));

/**
 * Characters of the Cyrillic subset of Onest (fontsource range); the Cyrillic Extended subset (`onest-cyrillic-ext-*`: Tajik ҳ, қ, ҷ, ӯ, ғ, ӣ,
 * also Ukrainian ґ in the first subset) has its own range; everything else is drawn with the Latin subset.
 */
const CYR = /[́Ѐ-џҐ-ґҰ-ұ№]/;
const EXT = /[Ѡ-ԯᲀ-ᲊ₴ⷠ-ⷿꙀ-ꚟ]/;

export type Script = 'lat' | 'cyr' | 'ext';
const scriptOf = (ch: string): Script => (CYR.test(ch) ? 'cyr' : EXT.test(ch) ? 'ext' : 'lat');
const fontName = (script: Script, bold: boolean): string => (script === 'lat' ? (bold ? 'latB' : 'lat') : script === 'cyr' ? (bold ? 'cyrB' : 'cyr') : bold ? 'extB' : 'ext');

/**
 * Splits a line into runs of one subset. The Cyrillic subsets have no space, digits or punctuation, so those always go to the
 * Latin subset (which has them). `cyr` stays true for the first Cyrillic subset only.
 */
export function scriptRuns(text: string): { cyr: boolean; script: Script; text: string }[] {
  const out: { cyr: boolean; script: Script; text: string }[] = [];
  for (const ch of text) {
    const script = scriptOf(ch);
    const last = out[out.length - 1];
    if (last && last.script === script) last.text += ch;
    else out.push({ cyr: script === 'cyr', script, text: ch });
  }
  return out;
}

const A4 = { w: 595.28, h: 841.89 };
const M = 50;

export async function renderPdf(input: PdfDoc, fontDir = FONT_DIR): Promise<{ bytes: Buffer; pages: number }> {
  const d = pdfDocSchema.parse(input);
  const doc = new PDFDocument({ size: 'A4', margins: { top: M, bottom: M + 20, left: M, right: M }, bufferPages: true, info: { Title: d.title, Producer: 'Fir Tech', Creator: 'Fir Tech HQ' } });
  for (const [name, file] of Object.entries(FONTS)) doc.registerFont(name, `${fontDir}${file}`);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    doc.on('end', () => resolve());
    doc.on('error', reject);
  });
  const width = A4.w - 2 * M;
  const bottom = A4.h - M - 20;

  /** Writes one line of mixed text at the cursor (or at x,y), wrapping in `w`. */
  const write = (text: string, o: { size: number; bold?: boolean; x?: number; y?: number; w?: number; align?: 'left' | 'center' | 'right'; color?: string; gap?: number }) => {
    const runs = scriptRuns(text || ' ');
    doc.fontSize(o.size).fillColor(o.color ?? '#111');
    runs.forEach((r, i) => {
      doc.font(fontName(r.script, o.bold === true));
      const opts = { width: o.w ?? width, align: o.align ?? 'left', continued: i < runs.length - 1, lineGap: o.gap ?? 2 };
      if (i === 0 && o.x !== undefined && o.y !== undefined) doc.text(r.text, o.x, o.y, opts);
      else if (i === 0 && o.x !== undefined) doc.text(r.text, o.x, doc.y, opts);
      else doc.text(r.text, opts);
    });
  };
  const heightOf = (text: string, size: number, w: number, bold = false) => {
    doc.font(bold ? 'latB' : 'lat').fontSize(size);
    return doc.heightOfString(text || ' ', { width: w, lineGap: 2 });
  };
  const ensure = (h: number) => {
    if (doc.y + h > bottom) doc.addPage();
  };

  write(d.title, { size: 18, bold: true });
  doc.moveDown(0.4);
  for (const m of d.meta) write(m, { size: 10, color: '#444' });
  if (d.meta.length) doc.moveDown(0.6);

  for (const s of d.sections) {
    if (s.heading) {
      ensure(heightOf(s.heading, 13, width, true) + 30);
      doc.moveDown(0.5);
      write(s.heading, { size: 13, bold: true });
      doc.moveDown(0.3);
    }
    for (const p of s.paragraphs) {
      ensure(Math.min(heightOf(p, 10.5, width), 60));
      write(p, { size: 10.5 });
      doc.moveDown(0.4);
    }
    if (s.table) {
      const t = s.table;
      const rel = t.widths ?? t.columns.map(() => 1);
      const sum = rel.reduce((a, b) => a + b, 0);
      const cols = rel.map((r) => (r / sum) * width);
      const pad = 4;
      const drawRow = (cells: string[], head: boolean) => {
        const h = Math.max(...cells.map((c, i) => heightOf(c, 9.5, cols[i]! - 2 * pad, head))) + 2 * pad;
        if (doc.y + h > bottom) {
          doc.addPage();
          if (!head) drawRow(t.columns, true);
        }
        const y = doc.y;
        let x = M;
        if (head) doc.rect(M, y, width, h).fill('#f1f1f1');
        cells.forEach((c, i) => {
          doc.rect(x, y, cols[i]!, h).lineWidth(0.5).strokeColor('#999').stroke();
          write(c, { size: 9.5, bold: head, x: x + pad, y: y + pad, w: cols[i]! - 2 * pad });
          x += cols[i]!;
        });
        doc.x = M;
        doc.y = y + h;
      };
      ensure(40);
      doc.moveDown(0.2);
      drawRow(t.columns, true);
      for (const r of t.rows) drawRow(r, false);
      doc.moveDown(0.6);
    }
  }

  if (d.signatures.length) {
    ensure(40 * d.signatures.length + 20);
    doc.moveDown(1.5);
    for (const sig of d.signatures) {
      write(sig, { size: 10.5, x: M });
      doc.moveDown(1.2);
    }
  }

  const range = doc.bufferedPageRange();
  const pages = range.count;
  for (let i = 0; i < pages; i++) {
    doc.switchToPage(range.start + i);
    const line = `${d.footer ? `${d.footer} · ` : ''}стр. ${i + 1} из ${pages}`;
    // the footer sits in the bottom margin: lift the margin for this write so PDFKit does not add a page
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    // centred by hand: PDFKit centres each continued run on its own
    doc.fontSize(8);
    const lineW = scriptRuns(line).reduce((s, r) => s + doc.font(fontName(r.script, false)).widthOfString(r.text), 0);
    write(line, { size: 8, x: M + Math.max(0, (width - lineW) / 2), y: A4.h - M, w: width, color: '#777' });
    doc.page.margins.bottom = keep;
  }
  doc.end();
  await done;
  return { bytes: Buffer.concat(chunks), pages };
}

type PdfSection = NonNullable<PdfDoc['sections']>[number];

/**
 * A Markdown document (the templates of Documents: `#` title, `##` sections, paragraphs, `-` lists, `|` tables) as a `PdfDoc`.
 * Emphasis marks are dropped; the limits of `pdfDocSchema` are respected (long documents are cut, never refused).
 */
export function markdownToPdfDoc(md: string, o: { title?: string; footer?: string } = {}): PdfDoc {
  const clean = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/^\s*>\s?/, '').trim();
  let title = o.title ?? '';
  const sections: PdfSection[] = [];
  let cur: { heading?: string; paragraphs: string[]; table?: { columns: string[]; rows: string[][] } } = { paragraphs: [] };
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) cur.paragraphs.push(para.join(' ').slice(0, 5000));
    para = [];
  };
  const flushSection = () => {
    flushPara();
    if (cur.heading || cur.paragraphs.length || cur.table) sections.push({ ...(cur.heading ? { heading: cur.heading } : {}), paragraphs: cur.paragraphs.slice(0, 50), ...(cur.table ? { table: cur.table } : {}) });
    cur = { paragraphs: [] };
  };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    if (/^#\s+/.test(line) && !title) {
      title = clean(line.replace(/^#\s+/, ''));
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      flushSection();
      cur.heading = clean(line.replace(/^#{1,6}\s+/, '')).slice(0, 200);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara();
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // the separator row
      const cells = line.trim().slice(1, -1).split('|').map((c) => clean(c).slice(0, 500));
      if (!cur.table) cur.table = { columns: cells.slice(0, 8).map((c) => c.slice(0, 100)), rows: [] };
      else if (cur.table.rows.length < 300) cur.table.rows.push(cur.table.columns.map((_, i) => cells[i] ?? ''));
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item || /^\s*\d+[.)]\s+/.test(line)) {
      flushPara();
      cur.paragraphs.push((item ? `• ${clean(item[1]!)}` : clean(line)).slice(0, 5000));
      continue;
    }
    para.push(clean(line));
  }
  flushSection();
  return { title: (title || 'Документ').slice(0, 200), sections: sections.slice(0, 60), ...(o.footer ? { footer: o.footer } : {}) };
}

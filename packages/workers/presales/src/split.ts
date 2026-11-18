export const TG_LIMIT = 4096;

/** Cuts a long text into Telegram-sized messages: at a blank line, then a line break, then a space, then hard. */
export function splitMessage(text: string, limit = TG_LIMIT): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const head = rest.slice(0, limit);
    let cut = Math.max(head.lastIndexOf('\n\n'), 0);
    if (cut < limit / 2) cut = Math.max(head.lastIndexOf('\n'), 0);
    if (cut < limit / 2) cut = Math.max(head.lastIndexOf(' '), 0);
    if (cut < limit / 2) cut = limit;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

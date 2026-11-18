import type { FinanceReport, PeriodCosts } from './aggregate.js';

export const usd = (n: number): string => `$${n.toFixed(2)}`;

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

const all = (p: PeriodCosts): number => p.usd + p.fixedUsd;
const toks = (p: PeriodCosts): number => p.inputTokens + p.outputTokens;

function part(label: string, p: PeriodCosts): string {
  return `${label} ${usd(all(p))} (API ${usd(p.usd)}, серверы ${usd(p.fixedUsd)}, токенов ${tokens(toks(p))})`;
}

/** The finance line for the morning summary: yesterday, week, month. */
export function dailyLine(r: FinanceReport): string {
  const depts = r.month.byDept.filter((d) => d.usd > 0 || d.inputTokens > 0);
  const lines = [`Финансы: ${part('вчера', r.yesterday)}.`, `${part('Неделя', r.week)}. ${part('Месяц', r.month)}.`];
  if (depts.length) lines.push(`По отделам за месяц: ${depts.map((d) => `${d.dept} ${usd(d.usd)} (${tokens(d.inputTokens + d.outputTokens)})`).join(', ')}.`);
  const over = Object.entries(r.budgets).filter(([d, b]) => (r.month.byDept.find((x) => x.dept === d)?.usd ?? 0) >= b * 0.8);
  if (over.length) lines.push(`Близко к лимиту: ${over.map(([d, b]) => `${d} ${usd(r.month.byDept.find((x) => x.dept === d)!.usd)} из ${usd(b)}`).join(', ')}.`);
  if (r.revenue.month > 0 || r.revenue.yesterday > 0) lines.push(`Выручка (оплаченные счета): вчера ${usd(r.revenue.yesterday)}, месяц ${usd(r.revenue.month)}.`);
  return lines.join('\n');
}

/** Sunday report: month to date, by department and agent, fixed items, forecast to the month's end. */
export function monthlyReport(r: FinanceReport): string {
  const m = r.month;
  const out: string[] = [`Расходы за месяц на данный момент (${r.monthDays} из ${r.daysInMonth} дн.): ${usd(all(m))}.`];
  out.push(`API ${usd(m.usd)}, токенов ${tokens(toks(m))}, вызовов ${m.calls}. Серверы и подписки за этот срок ${usd(m.fixedUsd)} из ${usd(r.fixedMonthTotal)} в месяц.`);
  if (m.byDept.length) {
    out.push(
      'Отделы:\n' +
        m.byDept
          .map((d) => {
            const b = r.budgets[d.dept];
            return `- ${d.dept}: ${usd(d.usd)}, токенов ${tokens(d.inputTokens + d.outputTokens)}${b ? `, лимит ${usd(b)} (${Math.round((d.usd / b) * 100)}%)` : ''}`;
          })
          .join('\n'),
    );
    out.push('Агенты:\n' + m.byAgent.slice(0, 8).map((a) => `- ${a.agentId} (${a.dept}): ${usd(a.usd)}, ${tokens(a.inputTokens + a.outputTokens)}`).join('\n'));
  } else out.push('Вызовов модели за месяц нет.');
  const fixedItems = Object.entries(r.fixed);
  if (fixedItems.length) out.push(`Постоянные в месяц: ${fixedItems.map(([k, v]) => `${k} ${usd(v)}`).join(', ')}.`);
  if (r.monthDays > 0) {
    const forecast = (m.usd / r.monthDays) * r.daysInMonth + r.fixedMonthTotal;
    out.push(`Прогноз на весь месяц: ${usd(forecast)} (API по текущему темпу плюс постоянные).`);
  }
  if (r.revenue.month > 0) out.push(`Выручка за месяц (оплаченные счета): ${usd(r.revenue.month)}. Расходы ${usd(all(m))}, разница ${usd(r.revenue.month - all(m))}.`);
  out.push(`Вчера: ${part('', r.yesterday).trim()}.`);
  return out.join('\n');
}

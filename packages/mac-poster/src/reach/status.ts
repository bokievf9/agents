import { isEnabled, parseDoctor, type RunCli } from './runner.js';

export interface StatusDeps {
  runCli: RunCli;
  /** The queue counts of HQ (`GET /admin/reach/jobs`); absent or throwing: the line says HQ is not reachable. */
  counts?: () => Promise<Record<string, number>>;
}

interface ChannelInfo {
  name: string;
  level: string;
  login: boolean;
  actions: number;
}

function parseChannels(stdout: string): ChannelInfo[] | null {
  try {
    const j = JSON.parse(stdout) as { channels?: unknown };
    if (!Array.isArray(j.channels)) return null;
    return j.channels
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && typeof (c as Record<string, unknown>).name === 'string')
      .map((c) => ({ name: String(c.name), level: String(c.level ?? ''), login: !!c.login, actions: Array.isArray(c.actions) ? c.actions.length : 0 }));
  } catch {
    return null;
  }
}

/** The lines of `reach:status`: the channels of `agent-reach` with their set-up state, and the queue counts of HQ. */
export async function reachStatus(d: StatusDeps): Promise<string[]> {
  const lines: string[] = [];
  const [channels, doctor] = await Promise.all([d.runCli(['channels'], 30_000), d.runCli(['doctor'], 30_000)]);
  if (channels.spawnError) {
    lines.push(`agent-reach не найден: ${channels.spawnError}`, 'Установка: uv tool install https://github.com/Panniantong/Agent-Reach/archive/refs/tags/v1.6.0.zip, затем agent-reach setup');
  } else {
    const list = parseChannels(channels.stdout);
    const status = new Map((parseDoctor(doctor.stdout) ?? []).map((c) => [c.channel, c]));
    if (!list) lines.push('agent-reach channels: ответ не разобрался');
    else {
      lines.push('Каналы Agent Reach (канал, уровень, состояние, действий, вход):');
      for (const c of list) {
        const s = status.get(c.name);
        lines.push(`  ${c.name.padEnd(12)} ${c.level.padEnd(13)} ${(s?.status ?? '?').padEnd(11)} ${String(c.actions).padStart(2)}  ${c.login ? 'нужен вход владельца (agent-reach login ' + c.name + ')' : 'без входа'}${s && isEnabled(s) ? '' : '  [выключен]'}`);
      }
    }
  }
  if (d.counts) {
    try {
      const c = await d.counts();
      lines.push(`Очередь HQ: ждут ${c.queued ?? 0}, в работе ${c.running ?? 0}, готово ${c.done ?? 0}, с ошибкой ${c.failed ?? 0}.`);
    } catch (e) {
      lines.push(`Очередь HQ недоступна: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return lines;
}

/**
 * Links into Shell (firtech.pro/admin) for the one HQ bot: every reminder and every answer of the assistant ends with one of these.
 * The screens are the site's (`firtech/src/app/admin`): every link goes to a Shell section (`/admin/<section>?tab=&focus=`),
 * never to the pixel office (owner 2026-11-22, audit fix 3).
 */
export type ShellScreen = 'home' | 'review' | 'leads' | 'lead' | 'clients' | 'projects' | 'project' | 'chats' | 'money' | 'tasks' | 'company' | 'calls' | 'settings';

export const SHELL_SCREENS: readonly ShellScreen[] = ['home', 'review', 'leads', 'lead', 'clients', 'projects', 'project', 'chats', 'money', 'tasks', 'company', 'calls', 'settings'];

export interface ShellLinks {
  base: string;
  to(screen: ShellScreen, id?: number | string | null): string;
}

export function shellLinks(siteUrl = 'https://firtech.pro'): ShellLinks {
  const base = `${siteUrl.replace(/\/+$/, '')}/admin`;
  const sec = (path: string, q: Record<string, string | number | null | undefined> = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
    const s = p.toString();
    return `${base}/${path}${s ? `?${s}` : ''}`;
  };
  return {
    base,
    to(screen, id) {
      switch (screen) {
        case 'review': return id === null || id === undefined ? sec('approvals') : sec("approvals", { id: `ap_${id}` });
        case 'leads': return sec('clients', { tab: 'pipeline' });
        case 'lead': return sec('clients', { tab: 'pipeline', focus: id });
        case 'clients': return sec('clients', { tab: 'clients', focus: id });
        case 'calls': return sec('clients', { tab: 'calls' });
        case 'projects': return sec('projects');
        case 'project': return sec('projects', { focus: id });
        case 'chats': return sec('chats', { thread: id });
        case 'settings': return sec('settings');
        case 'money': return sec('finance', { tab: 'invoices', focus: id });
        case 'tasks': return sec('tasks');
        case 'company': return sec('agents');
        default: return sec('inbox');
      }
    },
  };
}

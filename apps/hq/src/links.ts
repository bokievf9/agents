/**
 * Links into the Пульт (firtech.pro/admin) for the one HQ bot: every reminder and every answer of the assistant ends with one of these.
 * The screens are the site's (`firtech/src/app/admin`): the office hub opens a panel by `?panel=&tab=&focus=`, the review center an approval
 * by `?id=ap_<link id>`, the chats page is its own route.
 */
export type PultScreen = 'home' | 'review' | 'leads' | 'lead' | 'clients' | 'projects' | 'project' | 'chats' | 'money' | 'tasks' | 'company' | 'calls' | 'settings';

export const PULT_SCREENS: readonly PultScreen[] = ['home', 'review', 'leads', 'lead', 'clients', 'projects', 'project', 'chats', 'money', 'tasks', 'company', 'calls', 'settings'];

export interface PultLinks {
  base: string;
  to(screen: PultScreen, id?: number | string | null): string;
}

export function pultLinks(siteUrl = 'https://firtech.pro'): PultLinks {
  const base = `${siteUrl.replace(/\/+$/, '')}/admin`;
  const office = (q: string) => `${base}/office?${q}`;
  const focus = (id: number | string | null | undefined) => (id === null || id === undefined || id === '' ? '' : `&focus=${encodeURIComponent(String(id))}`);
  return {
    base,
    to(screen, id) {
      switch (screen) {
        case 'review': return id === null || id === undefined ? `${base}/review` : `${base}/review?id=ap_${encodeURIComponent(String(id))}`;
        case 'leads': return office('panel=sales&tab=leads');
        case 'lead': return office(`panel=sales&tab=leads${focus(id)}`);
        case 'clients': return office(`panel=sales&tab=clients${focus(id)}`);
        case 'calls': return office('panel=sales&tab=calls');
        case 'projects': return office('panel=production');
        case 'project': return office(`panel=production${focus(id)}`);
        case 'chats': return id === null || id === undefined || id === '' ? `${base}/chats` : `${base}/chats?thread=${encodeURIComponent(String(id))}`;
        case 'settings': return office('panel=company&tab=settings');
        case 'money': return office(`panel=backoffice&tab=invoices${focus(id)}`);
        case 'tasks': return office('panel=director&tab=tasks');
        case 'company': return office('panel=company');
        default: return `${base}/office`;
      }
    },
  };
}

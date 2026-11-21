/**
 * What a builder link (`/ru/builder?b=k.salon~p.agent~l.telegram-playground~z.no`) says about where the agent lives and whether the client gets a site. The site
 * encodes it as the `l.` chunk (delivery channels, `none` for an empty choice) and the `z.` chunk (`need`, `no`, `have`); the lead's estimate or message carries the link.
 * Unknown ids are dropped, like the site's own decoder does. Contract: `docs/admin-crm-api.md`, «Площадка агента».
 */
export const DELIVERY_CHANNELS = ['telegram', 'widget', 'whatsapp', 'playground'] as const;
export const SITE_NEEDS = ['need', 'no', 'have'] as const;

export interface BuilderPlan {
  /** `null`: the link has no `l.` chunk (never asked); `[]`: nothing ticked. */
  delivery: string[] | null;
  siteNeed: 'need' | 'no' | 'have' | null;
}

/** The `b` value of the first builder link in the texts, or ''. */
function builderValue(texts: string[]): string {
  for (const t of texts) {
    const m = /\/(?:ru|en)\/builder(?:\/estimate)?\?(?:[^\s)"'<>#]*&)?b=([^\s)"'<>&#]+)/.exec(t);
    if (m) {
      try {
        return decodeURIComponent(m[1]!);
      } catch {
        return m[1]!;
      }
    }
  }
  return '';
}

export function parseBuilderPlan(...texts: string[]): BuilderPlan {
  const plan: BuilderPlan = { delivery: null, siteNeed: null };
  for (const chunk of builderValue(texts).slice(0, 4000).split('~')) {
    const [head = '', second = ''] = chunk.split('.');
    if (head === 'l') {
      const ids = second.split('-').filter((x): x is (typeof DELIVERY_CHANNELS)[number] => (DELIVERY_CHANNELS as readonly string[]).includes(x));
      if (ids.length || second === 'none') plan.delivery = [...new Set(ids)];
    } else if (head === 'z') {
      const need = (SITE_NEEDS as readonly string[]).find((x) => x === second);
      if (need) plan.siteNeed = need as BuilderPlan['siteNeed'];
    }
  }
  return plan;
}

/** The playground agent is part of the sale: the build lists the Fir Tech playground as a delivery place, or it is an agent product without a site. */
export function wantsPlayground(plan: BuilderPlan, direction: string | null | undefined): boolean {
  return Boolean(plan.delivery?.includes('playground')) || (direction === 'agent' && plan.siteNeed === 'no');
}

/**
 * What the price of a project does not include (owner decision 2026-11-19): domain, hosting, server and paid third-party services
 * are paid by the client directly. One fixed line for the КП, the estimate, the contract and the invoice; it lives here, not in the
 * workers, so that the reference figures (a domain a year, hosting a month) are written once. The site prints the same sentences
 * (`builder.scope` in firtech/src/content), with «заказчик» instead of «вы» in the variants for a client who has a domain or hosting.
 */
export interface Infrastructure {
  /** The client already has a domain (true), has none (false) or was not asked (null or absent). */
  hasDomain?: boolean | null;
  hasHosting?: boolean | null;
}

const THIRD_PARTY = 'платные сторонние сервисы (SMS, API, платежи)';

/** The conditions line for a client; both unknown or both missing give the default sentence. */
export function costsLine(h: Infrastructure = {}): string {
  const domain = h.hasDomain === true;
  const hosting = h.hasHosting === true;
  if (domain && hosting) return `Домен и хостинг у заказчика есть, используем их; ${THIRD_PARTY} оплачиваются отдельно.`;
  if (domain) return `Домен у заказчика есть, используем его. Хостинг, сервер и ${THIRD_PARTY} в сумму не входят: заказчик оплачивает их напрямую. Для ориентира: хостинг от $5 в месяц.`;
  if (hosting) return `Хостинг у заказчика есть, используем его. Домен и ${THIRD_PARTY} в сумму не входят: заказчик оплачивает их напрямую. Для ориентира: домен $10-15 в год.`;
  return `Домен, хостинг, сервер и ${THIRD_PARTY} в сумму не входят: заказчик оплачивает их напрямую, цена у всех разная. Для ориентира: домен $10-15 в год, хостинг от $5 в месяц.`;
}

/**
 * What a free text (the builder's summary from the site, a lead's message) says about the client's own domain and hosting.
 * `null` is «no signal», never «no»: only the site's scope sentences and the plain «домен и хостинг у меня есть» are read.
 */
export function detectInfrastructure(text: string): { hasDomain: boolean | null; hasHosting: boolean | null } {
  const t = text.toLowerCase();
  const both = /домен и хостинг (?:у (?:вас|заказчика|клиента|меня|нас) )?(?:уже )?есть|(?:уже )?есть домен и хостинг|already have a domain and hosting|have (?:a )?domain and hosting/.test(t);
  const domain = both || /домен (?:у (?:вас|заказчика|клиента|меня|нас) )?(?:уже )?есть|(?:уже )?есть (?:свой )?домен|already have a domain|have (?:a )?domain/.test(t);
  const hosting = both || /хостинг (?:у (?:вас|заказчика|клиента|меня|нас) )?(?:уже )?есть|(?:уже )?есть (?:свой )?хостинг|already have hosting|have (?:a )?hosting/.test(t);
  return { hasDomain: domain ? true : null, hasHosting: hosting ? true : null };
}

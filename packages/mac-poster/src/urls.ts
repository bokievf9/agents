/** Instagram URL helpers (pure, tested without a browser). */

const POST_PATH = /^\/(?:[A-Za-z0-9._]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/?/;

/** A post or reel link (absolute or relative, with or without the username prefix) as the canonical URL; null otherwise. */
export function canonicalPostUrl(href: string): string | null {
  let path: string;
  try {
    const u = new URL(href, 'https://www.instagram.com');
    if (!/(^|\.)instagram\.com$/.test(u.hostname)) return null;
    path = u.pathname;
  } catch {
    return null;
  }
  const m = POST_PATH.exec(path);
  if (!m) return null;
  const kind = m[1] === 'p' || m[1] === 'tv' ? 'p' : 'reel';
  return `https://www.instagram.com/${kind}/${m[2]}/`;
}

export const profileUrl = (username: string): string => `https://www.instagram.com/${encodeURIComponent(username.replace(/^@/, ''))}/`;

/** A username from a profile link (`/name/`); null for system paths. */
export function usernameFromHref(href: string): string | null {
  let path: string;
  try {
    path = new URL(href, 'https://www.instagram.com').pathname;
  } catch {
    return null;
  }
  const m = /^\/([A-Za-z0-9._]{1,30})\/?$/.exec(path);
  if (!m) return null;
  const reserved = ['explore', 'reels', 'direct', 'accounts', 'stories', 'p', 'reel', 'tv', 'about', 'legal', 'developer', 'web', 'challenge', 'emails', 'notifications'];
  return reserved.includes(m[1]!.toLowerCase()) ? null : m[1]!;
}

/** The first post link of `after` that was not on the profile `before` (pinned posts stay in both); null when none is new. */
export function newestNew(before: string[], after: string[]): string | null {
  const old = new Set(before.map(canonicalPostUrl).filter(Boolean));
  for (const h of after) {
    const c = canonicalPostUrl(h);
    if (c && !old.has(c)) return c;
  }
  return null;
}

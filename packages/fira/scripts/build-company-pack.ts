import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanDoc, docFile, flattenContent, isSecretPath, packIndex, PACKAGE_DIR, type PackDoc } from '../src/index.js';

/**
 * `pnpm --filter fira build-company-pack [--workspace <dir>] [--site <dir>] [--out <dir>] [--check]`: the knowledge pack of Fir Tech (tenant 0).
 * Public: the site's content (`firtech/src/content/*.ts`: products, flagships, solutions, how we work, stages and payment, guarantee, terms, privacy,
 * FAQ) and its sales documents (`firtech/docs/sales-playbook-site.md`, `products-contract.md`). Internal: `COMPANY.md`, `docs/architecture-hq.md` of
 * the workspace, `docs/fira-architecture.md`, `docs/process-census.md`, `knowledge/playbooks/*.md`, `apps/hq/instructions/*.md` of this repo.
 * Live facts (prices, call windows, statuses) stay with the tools. Secret files are refused, secret lines cut. Prints counts only, never texts.
 * `--check` writes nothing and exits 1 when the pack on disk differs from the sources (for CI on a machine that has them).
 */

const REPO = resolve(PACKAGE_DIR, '..', '..');

const arg = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** Sections of the site dictionary (`ru.ts`) that are knowledge, with the title of their document. */
const SITE_SECTIONS: [string, string][] = [
  ['products', 'Продукты Fir Tech'], ['productPage', 'Страницы продуктов'], ['aiTeams', 'ИИ-отделы и ИИ-компания'], ['ladder', 'Лестница: агент, автопилот, отдел'],
  ['solutions', 'Решения по нишам'], ['services', 'Услуги'], ['serviceDetails', 'Услуги подробно'], ['how', 'Как мы работаем'], ['process', 'Процесс работы'],
  ['pricingHome', 'Цены и этапы оплаты'], ['payHow', 'Как платить'], ['guarantee', 'Гарантия'], ['sla', 'Скорость ответа'], ['faq', 'Частые вопросы'],
  ['terms', 'Оферта'], ['privacy', 'Политика конфиденциальности'], ['referral', 'Рекомендации'], ['comparePage', 'Сравнение с рынком'], ['demoSection', 'Демо на сайте'],
];

/** Lines of a public document that talk code (paths, ids in backticks, HQ internals): a visitor never needs them. */
const CODE_LINE = /`[^`]*(\/|\.ts|\.md|\.json|_[a-z]|[a-z][A-Z])[^`]*`|\b(src|apps|packages|docs)\/|\bHQ\b|\bPR\b|\bAPI\b/;
const publicText = (md: string): string => md.split('\n').filter((l) => !CODE_LINE.test(l)).join('\n');

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function readSafe(path: string, root: string): string | null {
  if (isSecretPath(relative(root, path))) {
    console.error(`refused (secret path): ${relative(root, path)}`);
    return null;
  }
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

async function siteDocs(site: string, workspace: string): Promise<PackDoc[]> {
  const out: PackDoc[] = [];
  const ruPath = join(site, 'src', 'content', 'ru.ts');
  if (existsSync(ruPath)) {
    const ru = ((await import(pathToFileURL(ruPath).href)) as { default: Record<string, unknown> }).default;
    for (const [key, title] of SITE_SECTIONS) {
      const lines = flattenContent(ru[key]);
      if (lines.length) out.push({ id: `public-site-${slug(key)}`, title, tier: 'public', source: relative(workspace, ruPath) + `#${key}`, text: lines.join('\n') });
    }
  } else console.error('site content not found: public site documents skipped');
  const promisesPath = join(site, 'src', 'content', 'solution-promises.ts');
  if (existsSync(promisesPath)) {
    const m = (await import(pathToFileURL(promisesPath).href)) as { solutionPromises: Record<string, { ru: string }> };
    out.push({ id: 'public-site-solution-promises', title: 'Обещания решений по нишам', tier: 'public', source: relative(workspace, promisesPath), text: Object.entries(m.solutionPromises).map(([k, v]) => `${k}: ${v.ru}`).join('\n') });
  }
  for (const f of ['sales-playbook-site.md', 'products-contract.md']) {
    const path = join(site, 'docs', f);
    const md = readSafe(path, workspace);
    if (md) out.push({ id: `public-${slug(basename(f, '.md'))}`, title: f === 'sales-playbook-site.md' ? 'Как продаём (playbook сайта)' : 'Линейка продуктов (контракт сайта)', tier: 'public', source: relative(workspace, path), text: publicText(md) });
  }
  return out;
}

function internalDocs(workspace: string, repo: string): PackDoc[] {
  const files: [string, string][] = [
    [join(workspace, 'COMPANY.md'), 'Fir Tech как компания агентов'],
    [join(workspace, 'docs', 'architecture-hq.md'), 'Архитектура HQ'],
    [join(repo, 'docs', 'fira-architecture.md'), 'Архитектура Fira'],
    [join(repo, 'docs', 'process-census.md'), 'Перепись процессов'],
  ];
  for (const dir of [join(repo, 'knowledge', 'playbooks'), join(repo, 'apps', 'hq', 'instructions')]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) files.push([join(dir, f), `${dir.endsWith('playbooks') ? 'Плейбук' : 'Инструкция'}: ${basename(f, '.md')}`]);
  }
  const out: PackDoc[] = [];
  for (const [path, title] of files) {
    const md = readSafe(path, workspace);
    if (!md) continue;
    // a path of this repo reads as `agents/...` wherever the clone lives
    const rel = path.startsWith(`${repo}/`) ? `agents/${relative(repo, path)}` : relative(workspace, path);
    out.push({ id: `internal-${slug(rel.replace(/\.md$/, '').replace(/^agents\//, ''))}`, title, tier: 'internal', source: rel, text: md });
  }
  return out;
}

async function main(argv: string[]): Promise<number> {
  const workspace = resolve(arg(argv, 'workspace') ?? process.env.FIR_WORKSPACE ?? join(REPO, '..'));
  const site = resolve(arg(argv, 'site') ?? join(workspace, 'firtech'));
  const out = resolve(arg(argv, 'out') ?? join(PACKAGE_DIR, 'company-packs', 'firtech'));
  const check = argv.includes('--check');
  const raw = [...(await siteDocs(site, workspace)), ...internalDocs(workspace, REPO)];
  let cut = 0;
  const ids = raw.map((d) => d.id);
  if (new Set(ids).size !== ids.length) throw new Error('company pack: two documents share an id');
  const docs = raw.map((d) => {
    const c = cleanDoc(d);
    cut += c.cut;
    return c.doc;
  }).filter((d) => d.text.trim().length > 0);
  const index = packIndex('firtech', docs);
  const files = new Map<string, string>([...docs.map((d) => [`${d.id}.md`, docFile(d)] as [string, string]), ['index.json', `${JSON.stringify(index, null, 2)}\n`]]);
  if (check) {
    const stale = [...files].filter(([f, body]) => !existsSync(join(out, f)) || readFileSync(join(out, f), 'utf8') !== body);
    console.log(`company pack: ${docs.length} documents, ${stale.length} differ`);
    return stale.length ? 1 : 0;
  }
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(out)) if (!files.has(f)) rmSync(join(out, f));
  for (const [f, body] of files) writeFileSync(join(out, f), body);
  const by = (t: string) => docs.filter((d) => d.tier === t).length;
  console.log(`company pack firtech: ${docs.length} documents (public ${by('public')}, internal ${by('internal')}), ${docs.reduce((a, d) => a + d.text.length, 0)} chars, ${cut} secret lines cut`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  },
);

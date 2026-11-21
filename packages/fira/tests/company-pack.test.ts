import { describe, expect, it } from 'vitest';
import { cleanDoc, docFile, flattenContent, hasSecret, isSecretPath, loadCompanyKnowledge, packIndex, redactSecrets, type PackDoc } from '../src/index.js';

describe('the company pack: all the knowledge of Fir Tech, with secrecy tiers', () => {
  it('secret files are refused by their path: env files, server env, data, keys', () => {
    for (const p of ['.env', '.env.local', 'apps/hq/.env.example', 'deploy/server-env.md', 'data/clients.json', 'apps/hq/data/hq.db', 'secrets/x.md', 'keys/id_ed25519', 'cert.pem']) expect(isSecretPath(p), p).toBe(true);
    for (const p of ['COMPANY.md', 'docs/fira-architecture.md', 'knowledge/playbooks/sales.md', 'firtech/src/content/ru.ts', 'docs/metadata.md']) expect(isSecretPath(p), p).toBe(false);
  });

  it('lines with tokens, keys, IP addresses and passwords are cut; the rest stays', () => {
    const text = [
      'Оплата по этапам.',
      'ключ sk-ant-api03-abcdefghijkl в env',
      'RESEND re_1234567890abcdef',
      'Supabase sb_secret_abcdefgh123',
      'age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs',
      'сервер 201.79.122.133 и 127.0.0.1:8080',
      'TELEGRAM 1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1',
      'пароль: hunter2',
      'ANTHROPIC_API_KEY=xyz',
      'Гарантия первого этапа.',
    ].join('\n');
    const r = redactSecrets(text);
    expect(r.text).toBe('Оплата по этапам.\nГарантия первого этапа.');
    expect(r.cut).toBe(8);
    expect(hasSecret('Переменная ANTHROPIC_API_KEY задаёт ключ')).toBe(false);
  });

  it('the site content flattens to its sentences (no ids, paths or short labels), the index is stable', () => {
    expect(flattenContent({ a: 'Короткая', b: ['Агент отвечает клиентам круглосуточно и записывает их.', 'agent-card-id'], c: { d: 'Агент отвечает клиентам круглосуточно и записывает их.' } })).toEqual(['Агент отвечает клиентам круглосуточно и записывает их.']);
    const docs: PackDoc[] = [
      { id: 'internal-b', title: 'B', tier: 'internal', source: 'b.md', text: 'вн' },
      { id: 'public-a', title: 'A', tier: 'public', source: 'a.md', text: 'пуб' },
    ];
    expect(packIndex('firtech', docs).docs.map((d) => d.id)).toEqual(['public-a', 'internal-b']);
    expect(docFile(cleanDoc({ ...docs[1]!, text: 'текст\nsk-ant-secretsecret' }).doc)).toBe('---\nid: public-a\ntitle: A\ntier: public\nsource: a.md\n---\nтекст\n');
  });

  it('the pack of Fir Tech on disk: public site knowledge and internal documents, every chunk tiered, no secret line anywhere', () => {
    const chunks = loadCompanyKnowledge('firtech', { now: 1 });
    expect(chunks.length).toBeGreaterThan(100);
    const pub = chunks.filter((c) => c.tier === 'public');
    const internal = chunks.filter((c) => c.tier === 'internal');
    expect(pub.length).toBeGreaterThan(20);
    expect(internal.length).toBeGreaterThan(20);
    expect(chunks.every((c) => c.companyId === 'firtech' && (c.tier === 'public' || c.tier === 'internal'))).toBe(true);
    expect(chunks.some((c) => hasSecret(c.text))).toBe(false);
    // the facts a visitor asks about are public: the guarantee, the payment by stages, the terms
    expect(pub.some((c) => /возвращаем оплату первого этапа/.test(c.text))).toBe(true);
    expect(pub.some((c) => /по этапам/.test(c.text))).toBe(true);
    // how the company works inside is internal only
    expect(pub.some((c) => /Директор|ревью-центр/i.test(c.ref ?? ''))).toBe(false);
    expect(internal.some((c) => /COMPANY\.md/.test(c.ref ?? ''))).toBe(true);
    expect(loadCompanyKnowledge('nobody')).toEqual([]);
  });
});

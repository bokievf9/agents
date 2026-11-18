import { openDb } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { DeployStore, deployPlan, parseTarget } from '../src/index.js';

describe('deployer', () => {
  it('the plan has the checklist, the target and the monitoring request', () => {
    const plan = deployPlan({ id: 3, client: 'Роза' }, { projectId: 3, kind: 'client', location: 'host.client.uz', url: 'https://rosa.uz' });
    expect(plan.title).toBe('Деплой: Роза');
    for (const w of ['CI', 'DNS', 'TLS', 'Health']) expect(plan.body).toContain(w);
    expect(plan.body).toContain('Сервер клиента: host.client.uz');
    expect(plan.monitoringTask.title).toBe('добавить https://rosa.uz в мониторинг');
    expect(deployPlan({ id: 3, client: 'Роза' }, undefined).body).toContain('Цель деплоя не задана');
  });

  it('targets are stored per project and credentials are refused', () => {
    const s = new DeployStore(openDb(':memory:'), () => 1);
    s.set({ projectId: 1, kind: 'ours', location: '/opt/a', url: '' });
    s.set({ projectId: 1, kind: 'client', location: 'h', url: 'https://x.uz' });
    expect(s.get(1)).toEqual({ projectId: 1, kind: 'client', location: 'h', url: 'https://x.uz' });
    expect(parseTarget('Роза ours /opt/rosa https://rosa.uz')).toEqual({ ref: 'Роза', kind: 'ours', location: '/opt/rosa', url: 'https://rosa.uz' });
    expect(typeof parseTarget('Роза client root:pass@host')).toBe('string');
    expect(typeof parseTarget('Роза client host токен123')).toBe('string');
    expect(typeof parseTarget('Роза')).toBe('string');
  });
});

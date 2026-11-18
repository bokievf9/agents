import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Templates {
  kp: string;
  estimate: string;
  contract: string;
}

export function loadTemplates(dir: string): Templates {
  const read = (f: string) => readFileSync(join(dir, f), 'utf8');
  return { kp: read('kp.md'), estimate: read('estimate.md'), contract: read('contract.md') };
}

/** Fills `{{name}}`. A variable the template needs but the caller did not give is a bug, not an empty string. */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`Template variable {{${name}}} has no value`);
    return v;
  });
}

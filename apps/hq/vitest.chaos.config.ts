import { defineConfig } from 'vitest/config';
import { shared } from './vitest.config.js';

/** P-29: the chaos walks alone (`pnpm --filter hq test` runs this after the main pass): one file, no parallel workers, the full time each seed needs. */
export default defineConfig({
  resolve: shared.resolve,
  ssr: shared.ssr,
  test: { include: ['tests/drill/chaos.test.ts'], fileParallelism: false, testTimeout: 180_000, server: { deps: { inline: shared.inline } } },
});

import { defineConfig } from 'vitest/config';

/**
 * P-29 (2026-11-22): the random walks of `tests/drill/chaos.test.ts` run in their own pass after this one (`vitest.chaos.config.ts`, one file, no
 * parallel workers): under the load of the whole suite they took 6-30 s per seed and flaked. The rest of the suite runs here, 30 s per test.
 */
export const CHAOS = ['tests/drill/chaos.test.ts', '**/node_modules/**'];
/** The resolve and inline settings both passes share. */
export const shared = {
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  inline: [/@fir\/core/, /@fir\/hq/, /@fir\/fira/, /@fir\/worker-content-maker/, /@fir\/worker-(finance|lead-intake|monitoring|presales|prospector|referral|trend-scout|publisher|seo|analyst|billing|customer-support|onboarding|project-manager|reviewer|deployer|documents|knowledge)/],
};

export default defineConfig({
  resolve: shared.resolve,
  ssr: shared.ssr,
  test: { include: ['tests/**/*.test.ts'], exclude: CHAOS, testTimeout: 30_000, server: { deps: { inline: shared.inline } } },
});

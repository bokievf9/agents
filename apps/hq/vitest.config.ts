import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 15_000, server: { deps: { inline: [/@fir\/core/, /@fir\/hq/, /@fir\/worker-content-maker/, /@fir\/worker-(finance|lead-intake|monitoring|presales|prospector|referral|trend-scout|publisher|seo|analyst|billing|customer-support|onboarding|project-manager|reviewer|deployer|documents|knowledge)/] } } },
});

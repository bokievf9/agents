import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setCodec('h264');
// NodeNext sources import `./Reel.js`; webpack must find `Reel.tsx` for it (same override as in src/job.ts).
Config.overrideWebpackConfig((config) => ({ ...config, resolve: { ...config.resolve, extensionAlias: { '.js': ['.tsx', '.ts', '.js'] } } }));

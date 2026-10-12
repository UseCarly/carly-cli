import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Source lives two levels below package.json; bundled entries live in dist/.
export const version: string = (() => {
  try { return require('../package.json').version; }
  catch { return require('../../package.json').version; }
})();

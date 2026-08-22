// vitest.config.mjs — test runner config.
// Aliases the native Capacitor HTTP plugin (built only into www/vendor by
// `npm run build:http`) to an offline stub so importing api.js under Vitest
// does not fail import-analysis. Tests never execute the native branch.
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: './vendor/http-plugin.js',
        replacement: fileURLToPath(new URL('./tests/fixtures/http-plugin-stub.js', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/packages/tmux-bash',
  test: {
    name: '@aliaksei-raketski/pi-tmux-bash',
    watch: false,
    // These suites exercise process-global tmux state, filesystem watchers, and
    // lifecycle timers. Serial files prevent worker oversubscription from turning
    // bounded lifecycle assertions into scheduler-dependent CI failures.
    fileParallelism: false,
    globals: true,
    environment: 'node',
    include: ['extensions/**/test/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));

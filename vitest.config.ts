import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    pool: 'forks',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/cli.ts', 'bin/**'],
      thresholds: {
        perFile: true,
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 75,
      },
    },
  },
});

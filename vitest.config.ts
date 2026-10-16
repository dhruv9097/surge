import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests import workspace libs from source, so no build is needed first.
const alias = {
  '@surge/common/telemetry': fileURLToPath(
    new URL('./libs/common/src/telemetry/index.ts', import.meta.url),
  ),
  '@surge/common': fileURLToPath(new URL('./libs/common/src/index.ts', import.meta.url)),
  '@surge/testing': fileURLToPath(new URL('./libs/testing/src/index.ts', import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['{apps,libs}/*/src/**/*.spec.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['{apps,libs}/*/src/**/*.int-spec.ts'],
          testTimeout: 120_000,
          hookTimeout: 180_000,
          // Each file starts its own containers; running them one at a time
          // keeps CI runners from being oversubscribed.
          fileParallelism: false,
        },
      },
    ],
  },
});

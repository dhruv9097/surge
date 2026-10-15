import 'reflect-metadata';
import { bootstrapHttpApp } from '@surge/common';
import { AppModule } from './app.module.js';
import { loadAppConfig } from './config.js';

// The worker serves no public API; HTTP is only for health checks and metrics.
async function main() {
  const config = loadAppConfig();
  await bootstrapHttpApp(AppModule.forRoot(config), config);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

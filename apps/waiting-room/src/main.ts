import 'reflect-metadata';
import { bootstrapHttpApp } from '@surge/common';
import { AppModule } from './app.module.js';
import { loadAppConfig } from './config.js';

async function main() {
  const config = loadAppConfig();
  await bootstrapHttpApp(AppModule.forRoot(config), config);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

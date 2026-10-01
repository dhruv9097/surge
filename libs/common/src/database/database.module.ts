import { DynamicModule, Global, Module } from '@nestjs/common';
import type { DatabaseConfig } from '../config/config.js';
import { DatabaseService } from './database.service.js';

@Global()
@Module({})
export class DatabaseModule {
  static forRoot(config: DatabaseConfig): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [{ provide: DatabaseService, useFactory: () => new DatabaseService(config) }],
      exports: [DatabaseService],
    };
  }
}

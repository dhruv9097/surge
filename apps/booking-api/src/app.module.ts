import { DynamicModule, Module } from '@nestjs/common';
import { DatabaseModule, HealthModule, ObservabilityModule, RedisModule } from '@surge/common';
import type { Config } from './config.js';

@Module({})
export class AppModule {
  static forRoot(config: Config): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ObservabilityModule.forRoot(config),
        DatabaseModule.forRoot(config),
        RedisModule.forRoot(config),
        HealthModule,
      ],
    };
  }
}

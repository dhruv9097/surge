import { DynamicModule, Module } from '@nestjs/common';
import { DatabaseModule, HealthModule, ObservabilityModule, RedisModule } from '@surge/common';
import { APP_CONFIG, type Config } from './config.js';
import { QueueController } from './queue/queue.controller.js';
import { QueueService } from './queue/queue.service.js';

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
      controllers: [QueueController],
      providers: [{ provide: APP_CONFIG, useValue: config }, QueueService],
    };
  }
}

import { DynamicModule, Module } from '@nestjs/common';
import { DatabaseModule, HealthModule, ObservabilityModule } from '@surge/common';
import { APP_CONFIG, type Config } from './config.js';
import { KafkaService } from './kafka/kafka.service.js';
import { OrderProcessorService } from './orders/order-processor.service.js';
import { OutboxRelayService } from './outbox/outbox-relay.service.js';

@Module({})
export class AppModule {
  static forRoot(config: Config): DynamicModule {
    return {
      module: AppModule,
      imports: [ObservabilityModule.forRoot(config), DatabaseModule.forRoot(config), HealthModule],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        KafkaService,
        OutboxRelayService,
        OrderProcessorService,
      ],
    };
  }
}

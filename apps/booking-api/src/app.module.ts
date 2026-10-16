import { DynamicModule, Module } from '@nestjs/common';
import {
  AdmissionTokens,
  DatabaseModule,
  HealthModule,
  ObservabilityModule,
  RedisModule,
} from '@surge/common';
import { ADMISSION_TOKENS, AdmissionGuard } from './common/admission.guard.js';
import { APP_CONFIG, type Config } from './config.js';
import { EventsController } from './events/events.controller.js';
import { EventsService } from './events/events.service.js';
import { HoldsController } from './holds/holds.controller.js';
import { InventoryService } from './inventory/inventory.service.js';
import { OrdersController } from './orders/orders.controller.js';
import { OrdersService } from './orders/orders.service.js';

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
      controllers: [EventsController, HoldsController, OrdersController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        {
          provide: ADMISSION_TOKENS,
          useFactory: () => new AdmissionTokens(config.ADMISSION_TOKEN_SECRET),
        },
        AdmissionGuard,
        EventsService,
        InventoryService,
        OrdersService,
      ],
    };
  }
}

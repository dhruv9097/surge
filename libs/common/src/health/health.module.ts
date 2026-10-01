import { Global, Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller.js';
import { LifecycleService } from './lifecycle.service.js';

@Global()
@Module({
  imports: [TerminusModule.forRoot({ logger: false })],
  controllers: [HealthController],
  providers: [LifecycleService],
  exports: [LifecycleService],
})
export class HealthModule {}

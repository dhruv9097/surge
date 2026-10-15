import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import {
  Admin,
  Consumer,
  Producer,
  ProduceAcks,
  stringDeserializers,
  stringSerializers,
} from '@platformatic/kafka';
import { Topics } from '@surge/common';
import { APP_CONFIG, type Config } from '../config.js';

export type StringProducer = Producer<string, string, string, string>;
export type StringConsumer = Consumer<string, string, string, string>;

/**
 * Owns the Kafka clients for the worker. The producer is idempotent with
 * acks=all, so a retried send cannot duplicate a message on the broker and an
 * acknowledged message survives a broker failover.
 */
@Injectable()
export class KafkaService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(KafkaService.name);
  readonly producer: StringProducer;
  private readonly consumers: StringConsumer[] = [];

  constructor(@Inject(APP_CONFIG) private readonly config: Config) {
    this.producer = new Producer({
      clientId: `${config.SERVICE_NAME}-producer`,
      bootstrapBrokers: config.KAFKA_BROKERS,
      serializers: stringSerializers,
      idempotent: true,
      acks: ProduceAcks.ALL,
    });
  }

  /** Creates topics on first start. Safe to run from every replica. */
  async onModuleInit() {
    const admin = new Admin({
      clientId: `${this.config.SERVICE_NAME}-admin`,
      bootstrapBrokers: this.config.KAFKA_BROKERS,
    });
    try {
      const existing = new Set(await admin.listTopics());
      const missing = [Topics.ORDERS, Topics.ORDERS_DLQ].filter((t) => !existing.has(t));
      if (missing.length > 0) {
        await admin.createTopics({
          topics: missing,
          partitions: this.config.KAFKA_ORDERS_PARTITIONS,
          replicas: 1,
        });
        this.logger.log({ topics: missing }, 'Created Kafka topics');
      }
    } finally {
      await admin.close();
    }
  }

  createConsumer(groupId: string): StringConsumer {
    const consumer = new Consumer({
      groupId,
      clientId: `${this.config.SERVICE_NAME}-${groupId}`,
      bootstrapBrokers: this.config.KAFKA_BROKERS,
      deserializers: stringDeserializers,
    });
    this.consumers.push(consumer);
    return consumer;
  }

  async onApplicationShutdown() {
    await Promise.allSettled(this.consumers.map((c) => c.close()));
    await this.producer.close();
  }
}

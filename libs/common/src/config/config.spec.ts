import { baseConfigSchema, ConfigError, databaseConfigSchema, loadConfig } from './config.js';

describe('loadConfig', () => {
  const schema = baseConfigSchema.extend(databaseConfigSchema.shape);

  it('applies defaults and coerces numeric env strings', () => {
    const config = loadConfig(schema, {
      SERVICE_NAME: 'svc',
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      PORT: '4000',
      LOG_HTTP_REQUESTS: 'false',
    });
    expect(config.PORT).toBe(4000);
    expect(config.DB_POOL_MAX).toBe(10);
    expect(config.LOG_HTTP_REQUESTS).toBe(false);
    expect(config.NODE_ENV).toBe('development');
  });

  it('rejects invalid config with every problem listed', () => {
    const load = () => loadConfig(schema, { PORT: 'abc', DATABASE_URL: 'not a url' });
    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/SERVICE_NAME/);
    expect(load).toThrow(/PORT/);
    expect(load).toThrow(/DATABASE_URL/);
  });
});

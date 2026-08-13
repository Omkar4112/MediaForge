import IORedis from 'ioredis';
import { env } from './env';

// BullMQ requires maxRetriesPerRequest: null on the connection it manages.
export function createRedisConnection(): IORedis {
  return new IORedis({
    host: env.redis.host,
    port: env.redis.port,
    maxRetriesPerRequest: null,
    lazyConnect: true,
    connectTimeout: 5000,
    commandTimeout: 5000,
    enableOfflineQueue: false,
  });
}

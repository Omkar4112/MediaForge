import IORedis from 'ioredis';
import { env } from './env';

// BullMQ requires maxRetriesPerRequest: null on the connection it manages.
export function createRedisConnection(): IORedis {
  const redisUrl = process.env.REDIS_URL;

  if (redisUrl) {
    // Hosted Redis (Render, Railway, Upstash, etc.) typically provides a
    // single connection URL.  Pass it directly to ioredis.
    return new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      // Render Redis requires TLS; ioredis auto-enables TLS for rediss:// URLs
      // but some providers use redis:// with separate TLS config.
      ...(redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
    });
  }

  // Local / Docker Compose fallback: use host + port from env config.
  return new IORedis({
    host: env.redis.host,
    port: env.redis.port,
    maxRetriesPerRequest: null,
    connectTimeout: 5000,
  });
}

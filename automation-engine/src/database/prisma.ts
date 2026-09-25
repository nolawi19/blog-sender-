import { PrismaClient } from '@prisma/client';
import type { Logger } from '../observability/logger.js';

/**
 * Adds Prisma pool parameters to the connection string unless already present.
 * The pool is intentionally small: PostgreSQL is only touched off the hot path
 * (snapshot loads, batched execution writes, dead-letter records).
 */
export function withPoolParams(databaseUrl: string, poolSize: number): string {
  const url = new URL(databaseUrl);
  if (!url.searchParams.has('connection_limit')) url.searchParams.set('connection_limit', String(poolSize));
  if (!url.searchParams.has('pool_timeout')) url.searchParams.set('pool_timeout', '10');
  return url.toString();
}

export function createPrismaClient(options: { databaseUrl: string; poolSize: number; logger: Logger }): PrismaClient {
  const prisma = new PrismaClient({
    datasources: { db: { url: withPoolParams(options.databaseUrl, options.poolSize) } },
    log: [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
  });
  prisma.$on('warn', (e) => options.logger.warn({ target: e.target }, e.message));
  prisma.$on('error', (e) => options.logger.error({ target: e.target }, e.message));
  return prisma;
}

export async function checkDatabase(prisma: PrismaClient): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

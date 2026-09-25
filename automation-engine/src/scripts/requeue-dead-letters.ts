/**
 * Safe requeueing of dead-lettered jobs.
 *
 *   npm run dlq:list
 *   npm run dlq:requeue -- --id <deadLetterId>
 *   npm run dlq:requeue -- --all [--limit 100] [--dry-run]
 *   npm run dlq:requeue -- --discard --id <deadLetterId>
 *
 * Safety properties:
 *  - Each row is claimed with a conditional update (PENDING -> REQUEUED), so two
 *    operators running this concurrently cannot requeue the same job twice.
 *  - If enqueueing fails, the claim is reverted to PENDING.
 *  - The job keeps its step-level resume state: steps that already succeeded
 *    (e.g. a Telegram message that was sent) are not executed again.
 */
import { loadConfig } from '../config.js';
import { createPrismaClient } from '../database/prisma.js';
import { createLogger } from '../observability/logger.js';
import { createAutomationQueue, EXECUTE_JOB_NAME } from '../queue/automation.queue.js';
import { closeRedis, createRedisConnection, waitForRedis } from '../queue/connection.js';
import { automationJobDataSchema } from '../types/workflow.js';

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const id = argValue(args, '--id');
  const all = args.includes('--all');
  const list = args.includes('--list');
  const discard = args.includes('--discard');
  const dryRun = args.includes('--dry-run');
  const limit = Math.min(Number(argValue(args, '--limit') ?? 100), 10_000);

  if (!list && !id && !all) {
    process.stderr.write('usage: requeue-dead-letters (--list | --id <id> | --all) [--limit N] [--dry-run] [--discard]\n');
    process.exit(2);
  }

  const config = loadConfig();
  const logger = createLogger({ level: 'warn', service: 'dlq-requeue' });
  const prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL, poolSize: 2, logger });

  try {
    const rows = await prisma.deadLetterJob.findMany({
      where: id ? { id, status: 'PENDING' } : { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    if (list || dryRun) {
      for (const row of rows) {
        const error = row.error as { code?: string; message?: string };
        process.stdout.write(`${row.id}  ${row.createdAt.toISOString()}  ${row.errorCategory.padEnd(14)} attempts=${row.attempts}  ${error.code ?? ''} ${error.message ?? ''}\n`);
      }
      process.stdout.write(`${rows.length} pending dead-letter job(s)${dryRun ? ' (dry run, nothing changed)' : ''}\n`);
      return;
    }

    if (discard) {
      const result = await prisma.deadLetterJob.updateMany({ where: { id: { in: rows.map((r) => r.id) }, status: 'PENDING' }, data: { status: 'DISCARDED' } });
      process.stdout.write(`discarded ${result.count} dead-letter job(s)\n`);
      return;
    }

    const redis = createRedisConnection(config.REDIS_URL, 'worker', logger);
    await waitForRedis(redis);
    const queue = createAutomationQueue(redis, config.MAX_RETRIES);
    let requeued = 0;
    try {
      for (const row of rows) {
        const parsed = automationJobDataSchema.safeParse(row.payload);
        if (!parsed.success) {
          process.stdout.write(`skip ${row.id}: payload is not a valid job (discard it with --discard --id ${row.id})\n`);
          continue;
        }
        const claimed = await prisma.deadLetterJob.updateMany({
          where: { id: row.id, status: 'PENDING' },
          data: { status: 'REQUEUED', requeuedAt: new Date() },
        });
        if (claimed.count === 0) continue;

        const jobId = `exec-${parsed.data.executionId}-rq-${Date.now()}`;
        try {
          await queue.add(EXECUTE_JOB_NAME, { ...parsed.data, requeuedFrom: row.id }, { jobId });
          await prisma.deadLetterJob.update({ where: { id: row.id }, data: { requeueJobId: jobId } });
          requeued++;
          process.stdout.write(`requeued ${row.id} as job ${jobId}\n`);
        } catch (err) {
          await prisma.deadLetterJob.update({ where: { id: row.id }, data: { status: 'PENDING', requeuedAt: null } });
          process.stdout.write(`failed to requeue ${row.id}: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    } finally {
      await queue.close();
      await closeRedis(redis);
    }
    process.stdout.write(`requeued ${requeued}/${rows.length} dead-letter job(s)\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`requeue-dead-letters failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

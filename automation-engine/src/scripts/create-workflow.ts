/**
 * Creates or updates a user, credentials, a webhook endpoint and workflows from
 * a JSON definition, then tells running gateways/workers to reload.
 *
 *   npm run workflow:create -- examples/blog-to-telegram.workflow.json [--rotate-token] [--pause-others]
 *   node dist/scripts/create-workflow.js examples/blog-to-telegram.workflow.json
 *
 * --rotate-token  issue a new bearer token (the old one stops working)
 * --pause-others  pause other active workflows on the same endpoint that are not in the file
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { createPrismaClient } from '../database/prisma.js';
import { createDefaultRegistry } from '../integrations/index.js';
import { compileTemplate, compileValue } from '../mapper/template-mapper.js';
import { createLogger } from '../observability/logger.js';
import { closeRedis, createRedisConnection, waitForRedis } from '../queue/connection.js';
import { CredentialCipher, credentialSchemas, isKnownProvider } from '../security/credentials.js';
import { hashToken, signPayload } from '../security/hmac.js';
import { EVENT_TYPE_PATTERN, SLUG_PATTERN, workflowDefinitionSchema } from '../types/workflow.js';
import { publishCacheInvalidation } from '../workflows/workflow-loader.js';

const fileSchema = z.object({
  owner: z.object({ email: z.email(), name: z.string().max(200).optional() }),
  credentials: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        provider: z.string().min(1).max(50),
        /** Map of credential field -> environment variable name. Secrets never live in the file. */
        fromEnv: z.record(z.string(), z.string()),
      }),
    )
    .default([]),
  endpoint: z.object({
    slug: z.string().regex(SLUG_PATTERN),
    source: z.string().min(1).max(64),
    authType: z.enum(['NONE', 'BEARER', 'HMAC']).default('BEARER'),
    defaultEventType: z.string().regex(EVENT_TYPE_PATTERN).optional(),
    idempotencyField: z.string().regex(/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/).optional(),
    dedupeByPayloadHash: z.boolean().default(true),
    /** Env var holding a per-endpoint HMAC secret; defaults to WEBHOOK_SECRET. */
    hmacSecretEnv: z.string().optional(),
  }),
  workflows: z.array(workflowDefinitionSchema).min(1),
});

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const rotateToken = args.includes('--rotate-token');
  const pauseOthers = args.includes('--pause-others');
  if (!file) {
    process.stderr.write('usage: create-workflow <definition.json> [--rotate-token] [--pause-others]\n');
    process.exit(2);
  }

  const config = loadConfig();
  const logger = createLogger({ level: 'warn', service: 'create-workflow' });
  const definition = fileSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  const cipher = new CredentialCipher(config.encryptionKey, config.ENCRYPTION_KEY_ID);

  // Validate everything before touching the database.
  const knownActions = new Set(createDefaultRegistry(config, logger).listActionTypes());
  const credentialNames = new Set(definition.credentials.map((c) => c.name));
  for (const workflow of definition.workflows) {
    const keys = new Set<string>();
    workflow.steps.forEach((step, index) => {
      const key = step.key ?? `step_${index + 1}`;
      if (keys.has(key)) throw new Error(`Workflow "${workflow.name}": duplicate step key "${key}"`);
      keys.add(key);
      if (!knownActions.has(step.type)) throw new Error(`Workflow "${workflow.name}": unknown step type "${step.type}" (known: ${[...knownActions].join(', ')})`);
      if (step.credential && !credentialNames.has(step.credential)) throw new Error(`Step "${key}" references unknown credential "${step.credential}"`);
      compileValue(step.config);
      if (step.runIf) compileTemplate(step.runIf);
    });
  }

  const prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL, poolSize: 2, logger });
  try {
    const summary = await prisma.$transaction(async (tx) => {
      let issuedToken: string | null = null;
      const user = await tx.user.upsert({
        where: { email: definition.owner.email },
        create: { email: definition.owner.email, name: definition.owner.name ?? null },
        update: { name: definition.owner.name ?? null },
      });

      const credentialIds = new Map<string, string>();
      for (const cred of definition.credentials) {
        const data: Record<string, string> = {};
        const missing: string[] = [];
        for (const [field, envName] of Object.entries(cred.fromEnv)) {
          const value = process.env[envName];
          if (value) data[field] = value;
          else missing.push(envName);
        }
        if (missing.length > 0) {
          process.stdout.write(`! credential "${cred.name}" skipped: ${missing.join(', ')} not set (steps will use the worker's TELEGRAM_BOT_TOKEN fallback)\n`);
          continue;
        }
        if (isKnownProvider(cred.provider)) credentialSchemas[cred.provider].parse(data);
        const row = await tx.credential.upsert({
          where: { userId_name: { userId: user.id, name: cred.name } },
          create: { userId: user.id, name: cred.name, provider: cred.provider, encryptedData: cipher.encryptJson(data), keyVersion: cipher.keyId },
          update: { provider: cred.provider, encryptedData: cipher.encryptJson(data), keyVersion: cipher.keyId },
        });
        credentialIds.set(cred.name, row.id);
      }

      const ep = definition.endpoint;
      const existing = await tx.webhookEndpoint.findUnique({ where: { slug: ep.slug } });
      if (existing && existing.userId !== user.id) throw new Error(`Endpoint slug "${ep.slug}" belongs to another user`);
      let tokenHash = existing?.tokenHash ?? null;
      if (ep.authType === 'BEARER' && (!tokenHash || rotateToken)) {
        issuedToken = randomBytes(32).toString('base64url');
        tokenHash = hashToken(issuedToken);
      }
      const hmacSecret = ep.hmacSecretEnv ? process.env[ep.hmacSecretEnv] : undefined;
      if (ep.hmacSecretEnv && !hmacSecret) throw new Error(`${ep.hmacSecretEnv} is not set`);
      const endpointData = {
        source: ep.source,
        authType: ep.authType,
        tokenHash: ep.authType === 'BEARER' ? tokenHash : null,
        hmacSecretEncrypted: hmacSecret ? cipher.encrypt(hmacSecret) : null,
        defaultEventType: ep.defaultEventType ?? null,
        idempotencyField: ep.idempotencyField ?? null,
        dedupeByPayloadHash: ep.dedupeByPayloadHash,
        isActive: true,
      };
      const endpoint = await tx.webhookEndpoint.upsert({
        where: { slug: ep.slug },
        create: { userId: user.id, slug: ep.slug, ...endpointData },
        update: endpointData,
      });

      const workflowSummaries: Array<{ id: string; name: string; version: number; event: string }> = [];
      for (const wf of definition.workflows) {
        const steps = wf.steps.map((step, index) => ({
          position: index,
          key: step.key ?? `step_${index + 1}`,
          type: step.type,
          config: step.config as Prisma.InputJsonObject,
          runIf: step.runIf ?? null,
          timeoutMs: step.timeoutMs ?? null,
          credentialId: step.credential ? (credentialIds.get(step.credential) ?? null) : null,
        }));
        const current = await tx.workflow.findUnique({ where: { endpointId_name: { endpointId: endpoint.id, name: wf.name } } });
        let saved;
        if (current) {
          await tx.workflowStep.deleteMany({ where: { workflowId: current.id } });
          saved = await tx.workflow.update({
            where: { id: current.id },
            data: {
              description: wf.description ?? null,
              triggerType: wf.trigger.type,
              triggerEvent: wf.trigger.event,
              status: 'ACTIVE',
              version: { increment: 1 },
              steps: { create: steps },
            },
          });
        } else {
          saved = await tx.workflow.create({
            data: {
              userId: user.id,
              endpointId: endpoint.id,
              name: wf.name,
              description: wf.description ?? null,
              triggerType: wf.trigger.type,
              triggerEvent: wf.trigger.event,
              steps: { create: steps },
            },
          });
        }
        workflowSummaries.push({ id: saved.id, name: saved.name, version: saved.version, event: saved.triggerEvent });
      }

      // Workflows on this endpoint that the file does not define also run for every event.
      const others = await tx.workflow.findMany({
        where: { endpointId: endpoint.id, status: 'ACTIVE', name: { notIn: definition.workflows.map((w) => w.name) } },
        select: { id: true, name: true, triggerEvent: true },
      });
      if (pauseOthers && others.length > 0) {
        await tx.workflow.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { status: 'PAUSED', version: { increment: 1 } } });
      }
      return { endpoint, workflows: workflowSummaries, others, issuedToken };
    });

    const redis = createRedisConnection(config.REDIS_URL, 'client', logger);
    try {
      await waitForRedis(redis, 5_000);
      const receivers = await publishCacheInvalidation(redis, `workflow update: ${definition.endpoint.slug}`);
      process.stdout.write(`✓ cache invalidation sent to ${receivers} running process(es)\n`);
    } catch {
      process.stdout.write('! could not reach Redis; running processes will pick up changes within CACHE_REFRESH_INTERVAL_MS\n');
    } finally {
      await closeRedis(redis);
    }

    const url = `${config.PUBLIC_BASE_URL ?? `http://localhost:${config.PORT}`}/webhooks/${summary.endpoint.slug}`;
    process.stdout.write(`\n✓ endpoint "${summary.endpoint.slug}" (${summary.endpoint.authType})  ${url}\n`);
    for (const wf of summary.workflows) process.stdout.write(`✓ workflow "${wf.name}" v${wf.version} on "${wf.event}"  id=${wf.id}\n`);
    for (const other of summary.others) {
      process.stdout.write(
        pauseOthers
          ? `✓ paused other workflow "${other.name}" on "${other.triggerEvent}"  id=${other.id}\n`
          : `! also active on this endpoint (runs for "${other.triggerEvent}" too): "${other.name}"  id=${other.id}  (re-run with --pause-others to pause it)\n`,
      );
    }

    if (summary.endpoint.authType === 'BEARER') {
      if (summary.issuedToken) {
        process.stdout.write(`\nWebhook token (shown once, store it now):\n  ${summary.issuedToken}\n`);
        process.stdout.write(`\nTest it:\n  curl -sS -X POST ${url} -H 'content-type: application/json' -H 'authorization: Bearer ${summary.issuedToken}' --data-binary @examples/post-published.json\n`);
      } else {
        process.stdout.write('\nExisting webhook token kept (re-run with --rotate-token to issue a new one).\n');
      }
    } else if (summary.endpoint.authType === 'HMAC') {
      const ts = Math.floor(Date.now() / 1000);
      const sample = '{"title":"hello"}';
      process.stdout.write(`\nHMAC example (valid for ${config.WEBHOOK_HMAC_TOLERANCE_SEC}s):\n  X-Webhook-Timestamp: ${ts}\n  X-Webhook-Signature: ${signPayload(hmacSecretFor(definition.endpoint.hmacSecretEnv, config.WEBHOOK_SECRET), ts, sample)}\n  body: ${sample}\n`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

function hmacSecretFor(envName: string | undefined, fallback: string): string {
  return (envName ? process.env[envName] : undefined) ?? fallback;
}

main().catch((err: unknown) => {
  process.stderr.write(`create-workflow failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

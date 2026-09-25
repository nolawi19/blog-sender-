import { z } from 'zod';
import type { CompiledTemplate, CompiledValue } from '../mapper/template-mapper.js';
import type { DecryptedCredential } from '../security/credentials.js';

// ---------------------------------------------------------------------------
// Normalized event: the only shape the worker and templates ever see.
// ---------------------------------------------------------------------------

export const normalizedEventSchema = z.object({
  id: z.uuid(),
  source: z.string().min(1).max(64),
  type: z.string().min(1).max(128),
  timestamp: z.string(),
  headers: z.record(z.string(), z.string()),
  query: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  body: z.record(z.string(), z.unknown()),
  metadata: z.object({
    requestId: z.string(),
    userAgent: z.string().nullable(),
    ip: z.string().nullable(),
    endpoint: z.string(),
    receivedAt: z.number(),
  }),
});

export type NormalizedEvent = z.infer<typeof normalizedEventSchema>;

// ---------------------------------------------------------------------------
// Queue job payload (one job per matched workflow).
// ---------------------------------------------------------------------------

export const stepResumeRecordSchema = z.object({
  output: z.unknown(),
  completedAt: z.number(),
});

export const automationJobDataSchema = z.object({
  executionId: z.uuid(),
  workflowId: z.string().min(1),
  workflowVersion: z.number().int().nonnegative(),
  endpointId: z.string().min(1),
  idempotencyKey: z.string().nullable(),
  event: normalizedEventSchema,
  timings: z.object({
    receivedAt: z.number(),
    enqueuedAt: z.number(),
  }),
  /** Outputs of steps already completed by a previous attempt (step-level resume). */
  resume: z.object({ completedSteps: z.record(z.string(), stepResumeRecordSchema) }).optional(),
  /** Set when a dead-lettered job is requeued manually. */
  requeuedFrom: z.string().optional(),
  /** Times the job was postponed because of a rate limit (does not consume retry attempts). */
  rateLimitDeferrals: z.number().int().nonnegative().optional(),
});

export type AutomationJobData = z.infer<typeof automationJobDataSchema>;
export type StepResumeRecord = z.infer<typeof stepResumeRecordSchema>;

// ---------------------------------------------------------------------------
// Workflow definitions as authored (JSON files, admin tooling).
// ---------------------------------------------------------------------------

export const STEP_KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
export const SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
export const EVENT_TYPE_PATTERN = /^[a-zA-Z0-9_.:-]{1,128}$/;

export const workflowStepDefinitionSchema = z.object({
  key: z.string().regex(STEP_KEY_PATTERN).optional(),
  type: z.string().regex(/^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/, 'step type must look like "integration.action"'),
  config: z.record(z.string(), z.unknown()),
  credential: z.string().min(1).optional(),
  runIf: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(100).max(300_000).optional(),
});

export const workflowDefinitionSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  trigger: z.object({
    type: z.literal('webhook'),
    event: z.union([z.literal('*'), z.string().regex(EVENT_TYPE_PATTERN)]),
  }),
  steps: z.array(workflowStepDefinitionSchema).min(1).max(50),
});

export type WorkflowStepDefinition = z.infer<typeof workflowStepDefinitionSchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

// ---------------------------------------------------------------------------
// Runtime (in-memory, pre-compiled) representations.
// ---------------------------------------------------------------------------

export type WebhookAuthType = 'NONE' | 'BEARER' | 'HMAC';

export interface RuntimeEndpoint {
  id: string;
  slug: string;
  userId: string;
  source: string;
  authType: WebhookAuthType;
  tokenHash: string | null;
  /** Decrypted per-endpoint HMAC secret, or null to use WEBHOOK_SECRET. */
  hmacSecret: string | null;
  defaultEventType: string | null;
  idempotencyPath: ReadonlyArray<string> | null;
  dedupeByPayloadHash: boolean;
}

export interface RuntimeStep {
  id: string;
  key: string;
  position: number;
  type: string;
  config: CompiledValue;
  runIf: CompiledTemplate | null;
  credential: DecryptedCredential | null;
  timeoutMs: number | null;
}

export interface RuntimeWorkflow {
  id: string;
  name: string;
  userId: string;
  endpointId: string;
  triggerEvent: string;
  version: number;
  steps: ReadonlyArray<RuntimeStep>;
}

// ---------------------------------------------------------------------------
// Execution results.
// ---------------------------------------------------------------------------

export type StepStatus = 'succeeded' | 'skipped' | 'resumed' | 'failed';

export interface StepExecutionRecord {
  stepId: string;
  stepKey: string;
  type: string;
  status: StepStatus;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  templateMs: number;
  /** Epoch ms when the outbound request was initiated, if any. */
  requestStartedAt?: number;
  /** requestStartedAt - event receipt time. */
  outboundStartLatencyMs?: number;
  /** Outbound request start to response received. */
  externalLatencyMs?: number;
  output?: unknown;
  error?: unknown;
}

export interface ExecutionOutcome {
  steps: StepExecutionRecord[];
  firstRequestStartedAt?: number;
}

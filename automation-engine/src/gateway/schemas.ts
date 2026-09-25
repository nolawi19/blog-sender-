import { z } from 'zod';
import { EVENT_TYPE_PATTERN, SLUG_PATTERN } from '../types/workflow.js';

export const webhookParamsSchema = z.object({
  endpoint: z.string().regex(SLUG_PATTERN, 'invalid endpoint identifier'),
});

/** Webhook payloads must be JSON objects; arrays and scalars are rejected. */
export const webhookBodySchema = z.record(z.string(), z.unknown());

export const eventTypeSchema = z.string().regex(EVENT_TYPE_PATTERN, 'event type must match [a-zA-Z0-9_.:-]{1,128}');

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, 'idempotency key must be printable ASCII without spaces');

/** Headers the gateway reads explicitly. Everything else is forwarded as-is (strings only). */
export const webhookHeadersSchema = z.object({
  'idempotency-key': idempotencyKeySchema.optional(),
  'x-event-id': idempotencyKeySchema.optional(),
  'x-event-type': eventTypeSchema.optional(),
});

/** JSON schema for the 202 response; Fastify compiles it into a fast serializer. */
export const acceptedResponseJsonSchema = {
  type: 'object',
  properties: {
    accepted: { type: 'boolean' },
    duplicate: { type: 'boolean' },
    eventId: { type: 'string' },
    requestId: { type: 'string' },
    eventType: { type: 'string' },
    executions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { executionId: { type: 'string' }, workflowId: { type: 'string' } },
      },
    },
  },
} as const;

export const errorResponseJsonSchema = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        requestId: { type: 'string' },
        details: {},
      },
    },
  },
} as const;

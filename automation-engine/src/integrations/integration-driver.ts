import type { z } from 'zod';
import { ConfigurationError } from '../errors.js';
import type { Logger } from '../observability/logger.js';
import type { DecryptedCredential } from '../security/credentials.js';

/**
 * Extension point for integrations. A driver (Telegram, HTTP, and later Discord,
 * Slack, Email, WhatsApp...) contributes named actions such as
 * "telegram.sendPhoto". The workflow engine only knows this interface, so adding
 * an integration means writing a driver and registering it; the worker and the
 * engine do not change.
 */

export interface ActionContext {
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly credential: DecryptedCredential | null;
  readonly executionId: string;
  readonly workflowId: string;
  readonly stepId: string;
  readonly stepKey: string;
  readonly attempt: number;
  /** Drivers call this immediately before handing the request to the network. */
  markRequestStart(): void;
  /** Drivers call this when response headers arrive. */
  markResponse(): void;
}

export interface ActionResult {
  output: unknown;
}

export interface ActionDefinition<TConfig> {
  /** Fully qualified action type, e.g. "telegram.sendPhoto". */
  type: string;
  /** Validates the rendered step configuration. */
  configSchema: z.ZodType<TConfig>;
  /** Provider of the credential this action needs, or null. */
  credentialProvider?: string | null;
  execute(config: TConfig, context: ActionContext): Promise<ActionResult>;
}

/** Type-erased action as stored in the registry. */
export interface RegisteredAction {
  readonly type: string;
  readonly credentialProvider: string | null;
  run(rawConfig: unknown, context: ActionContext): Promise<ActionResult>;
}

export function defineAction<TConfig>(definition: ActionDefinition<TConfig>): RegisteredAction {
  return {
    type: definition.type,
    credentialProvider: definition.credentialProvider ?? null,
    async run(rawConfig, context) {
      const parsed = definition.configSchema.safeParse(rawConfig);
      if (!parsed.success) {
        throw new ConfigurationError(`Invalid configuration for ${definition.type}`, {
          code: 'STEP_CONFIG_INVALID',
          details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
        });
      }
      return definition.execute(parsed.data, context);
    },
  };
}

export interface IntegrationDriver {
  readonly name: string;
  readonly actions: readonly RegisteredAction[];
  /** Optional warm-up (e.g. pre-opening pooled connections). */
  init?(): Promise<void>;
  close?(): Promise<void>;
}

export class DriverRegistry {
  private readonly drivers: IntegrationDriver[] = [];
  private readonly actions = new Map<string, RegisteredAction>();

  register(driver: IntegrationDriver): this {
    for (const action of driver.actions) {
      if (!action.type.startsWith(`${driver.name}.`)) {
        throw new ConfigurationError(`Action "${action.type}" must be namespaced under "${driver.name}."`);
      }
      if (this.actions.has(action.type)) throw new ConfigurationError(`Action "${action.type}" is already registered`);
      this.actions.set(action.type, action);
    }
    this.drivers.push(driver);
    return this;
  }

  get(type: string): RegisteredAction | undefined {
    return this.actions.get(type);
  }

  listActionTypes(): string[] {
    return [...this.actions.keys()].sort();
  }

  async initAll(): Promise<void> {
    await Promise.all(this.drivers.map((d) => d.init?.()));
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(this.drivers.map((d) => d.close?.()));
  }
}

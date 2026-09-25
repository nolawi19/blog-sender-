import { AppError, classifyError, ConfigurationError, serializeError } from '../errors.js';
import type { ActionContext, DriverRegistry } from '../integrations/integration-driver.js';
import { isTruthy, renderTemplate, renderValue, type TemplateContext } from '../mapper/template-mapper.js';
import type { Logger } from '../observability/logger.js';
import type { LatencyRecorder } from '../observability/metrics.js';
import { nowMs, roundMs, type Clock } from '../observability/timing.js';
import type { ExecutionOutcome, NormalizedEvent, RuntimeWorkflow, StepExecutionRecord, StepResumeRecord } from '../types/workflow.js';

export interface WorkflowEngineOptions {
  registry: DriverRegistry;
  logger: Logger;
  metrics?: LatencyRecorder;
  clock?: Clock;
  defaultStepTimeoutMs: number;
}

export interface ExecuteWorkflowInput {
  workflow: RuntimeWorkflow;
  event: NormalizedEvent;
  executionId: string;
  attempt: number;
  /** Gateway receipt time (epoch ms), the start of the latency budget. */
  receivedAt: number;
  /** Outputs of steps finished by an earlier attempt; those steps are not re-run. */
  completedSteps?: Readonly<Record<string, StepResumeRecord>>;
  signal: AbortSignal;
  /** Persists resume state after each successful step (except the last). */
  onStepCompleted?: (stepKey: string, record: StepResumeRecord) => Promise<void>;
}

/** Carries the classified cause plus the per-step records gathered so far. */
export class StepFailedError extends Error {
  constructor(
    readonly error: AppError,
    readonly failedStep: StepExecutionRecord,
    readonly steps: StepExecutionRecord[],
  ) {
    super(error.message);
    this.name = 'StepFailedError';
  }
}

interface StepContextEntry {
  output: unknown;
  skipped?: boolean;
}

/**
 * Executes a workflow's steps in order. Integration-agnostic: each step type is
 * resolved through the DriverRegistry, its config is rendered from pre-compiled
 * templates, validated by the action's schema, and executed with a per-step
 * timeout. Outputs are exposed to later steps as {{steps.<key>.output...}}.
 */
export class WorkflowEngine {
  private readonly clock: Clock;

  constructor(private readonly options: WorkflowEngineOptions) {
    this.clock = options.clock ?? nowMs;
  }

  async execute(input: ExecuteWorkflowInput): Promise<ExecutionOutcome> {
    const { workflow, event } = input;
    const stepOutputs: Record<string, StepContextEntry> = {};
    const context: TemplateContext = {
      trigger: event,
      steps: stepOutputs,
      workflow: { id: workflow.id, name: workflow.name, version: workflow.version },
      execution: { id: input.executionId, attempt: input.attempt },
    };
    const records: StepExecutionRecord[] = [];
    let firstRequestStartedAt: number | undefined;

    for (let index = 0; index < workflow.steps.length; index++) {
      const step = workflow.steps[index];
      if (!step) continue;
      const isLast = index === workflow.steps.length - 1;
      const startedAt = this.clock();
      const record: StepExecutionRecord = {
        stepId: step.id,
        stepKey: step.key,
        type: step.type,
        status: 'succeeded',
        startedAt,
        finishedAt: startedAt,
        durationMs: 0,
        templateMs: 0,
      };
      const finish = (): void => {
        record.finishedAt = this.clock();
        record.durationMs = roundMs(record.finishedAt - record.startedAt);
        records.push(record);
      };

      const resumed = input.completedSteps?.[step.key];
      if (resumed) {
        stepOutputs[step.key] = { output: resumed.output };
        record.status = 'resumed';
        record.output = resumed.output;
        finish();
        continue;
      }

      try {
        if (input.signal.aborted) throw classifyError(input.signal.reason);

        const renderStarted = this.clock();
        if (step.runIf && !isTruthy(renderTemplate(step.runIf, context))) {
          record.templateMs = roundMs(this.clock() - renderStarted);
          record.status = 'skipped';
          stepOutputs[step.key] = { output: null, skipped: true };
          finish();
          continue;
        }
        const config = renderValue(step.config, context);
        record.templateMs = roundMs(this.clock() - renderStarted);
        this.options.metrics?.observe('template_render', record.templateMs, { action: step.type });

        const action = this.options.registry.get(step.type);
        if (!action) {
          throw new ConfigurationError(`No integration registered for step type "${step.type}"`, { code: 'UNKNOWN_STEP_TYPE' });
        }
        if (step.credential && action.credentialProvider && step.credential.provider !== action.credentialProvider) {
          throw new ConfigurationError(
            `Step "${step.key}" uses a "${step.credential.provider}" credential but ${step.type} expects "${action.credentialProvider}"`,
            { code: 'CREDENTIAL_MISMATCH' },
          );
        }

        const timeoutMs = step.timeoutMs ?? this.options.defaultStepTimeoutMs;
        let requestStartedAt: number | undefined;
        let lastRequestStartedAt: number | undefined;
        let responseAt: number | undefined;
        const actionContext: ActionContext = {
          signal: AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]),
          logger: this.options.logger.child({ executionId: input.executionId, workflowId: workflow.id, stepId: step.id, stepKey: step.key }),
          credential: step.credential,
          executionId: input.executionId,
          workflowId: workflow.id,
          stepId: step.id,
          stepKey: step.key,
          attempt: input.attempt,
          markRequestStart: () => {
            const now = this.clock();
            requestStartedAt ??= now;
            lastRequestStartedAt = now;
          },
          markResponse: () => {
            responseAt = this.clock();
          },
        };

        let result;
        try {
          result = await action.run(config, actionContext);
        } finally {
          if (requestStartedAt !== undefined) {
            record.requestStartedAt = requestStartedAt;
            record.outboundStartLatencyMs = roundMs(requestStartedAt - input.receivedAt);
            firstRequestStartedAt ??= requestStartedAt;
            this.options.metrics?.observe('outbound_request_start', record.outboundStartLatencyMs, { action: step.type });
          }
          if (responseAt !== undefined && lastRequestStartedAt !== undefined) {
            record.externalLatencyMs = roundMs(responseAt - lastRequestStartedAt);
            this.options.metrics?.observe('external_api', record.externalLatencyMs, { action: step.type });
          }
        }

        record.output = result.output;
        stepOutputs[step.key] = { output: result.output };
        finish();
        if (!isLast && input.onStepCompleted) {
          await input.onStepCompleted(step.key, { output: result.output, completedAt: record.finishedAt });
        }
      } catch (raw) {
        const error = classifyError(raw);
        record.status = 'failed';
        record.error = serializeError(error);
        finish();
        throw new StepFailedError(error, record, records);
      }
    }

    const outcome: ExecutionOutcome = { steps: records };
    if (firstRequestStartedAt !== undefined) outcome.firstRequestStartedAt = firstRequestStartedAt;
    return outcome;
  }
}

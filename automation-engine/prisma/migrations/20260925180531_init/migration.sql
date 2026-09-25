-- CreateEnum
CREATE TYPE "WebhookAuthType" AS ENUM ('NONE', 'BEARER', 'HMAC');

-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('QUEUED', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTERED');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "DeadLetterStatus" AS ENUM ('PENDING', 'REQUEUED', 'DISCARDED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credentials" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "encrypted_data" TEXT NOT NULL,
    "key_version" TEXT NOT NULL DEFAULT 'v1',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "auth_type" "WebhookAuthType" NOT NULL DEFAULT 'BEARER',
    "token_hash" TEXT,
    "hmac_secret_encrypted" TEXT,
    "default_event_type" TEXT,
    "idempotency_field" TEXT,
    "dedupe_by_payload_hash" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflows" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "trigger_type" TEXT NOT NULL DEFAULT 'webhook',
    "trigger_event" TEXT NOT NULL,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_steps" (
    "id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "credential_id" UUID,
    "run_if" TEXT,
    "timeout_ms" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workflow_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "executions" (
    "id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "workflow_version" INTEGER NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "request_id" TEXT,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "trigger_payload" JSONB,
    "error" JSONB,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "enqueued_at" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "queue_latency_ms" DOUBLE PRECISION,
    "outbound_start_latency_ms" DOUBLE PRECISION,
    "execution_duration_ms" DOUBLE PRECISION,
    "total_latency_ms" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_logs" (
    "id" BIGSERIAL NOT NULL,
    "execution_id" UUID NOT NULL,
    "step_id" UUID,
    "step_key" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "level" "LogLevel" NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "data" JSONB,
    "duration_ms" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dead_letter_jobs" (
    "id" UUID NOT NULL,
    "execution_id" UUID,
    "job_id" TEXT NOT NULL,
    "queue_name" TEXT NOT NULL,
    "workflow_id" UUID,
    "event_id" UUID,
    "payload" JSONB NOT NULL,
    "error" JSONB NOT NULL,
    "error_category" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "status" "DeadLetterStatus" NOT NULL DEFAULT 'PENDING',
    "requeued_at" TIMESTAMPTZ(3),
    "requeue_job_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "dead_letter_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "credentials_user_id_provider_idx" ON "credentials"("user_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "credentials_user_id_name_key" ON "credentials"("user_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_endpoints_slug_key" ON "webhook_endpoints"("slug");

-- CreateIndex
CREATE INDEX "webhook_endpoints_user_id_idx" ON "webhook_endpoints"("user_id");

-- CreateIndex
CREATE INDEX "webhook_endpoints_is_active_idx" ON "webhook_endpoints"("is_active");

-- CreateIndex
CREATE INDEX "workflows_endpoint_id_status_trigger_event_idx" ON "workflows"("endpoint_id", "status", "trigger_event");

-- CreateIndex
CREATE INDEX "workflows_user_id_idx" ON "workflows"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflows_endpoint_id_name_key" ON "workflows"("endpoint_id", "name");

-- CreateIndex
CREATE INDEX "workflow_steps_credential_id_idx" ON "workflow_steps"("credential_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_steps_workflow_id_position_key" ON "workflow_steps"("workflow_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_steps_workflow_id_key_key" ON "workflow_steps"("workflow_id", "key");

-- CreateIndex
CREATE INDEX "executions_workflow_id_created_at_idx" ON "executions"("workflow_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "executions_status_created_at_idx" ON "executions"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "executions_event_id_idx" ON "executions"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "executions_job_id_key" ON "executions"("job_id");

-- CreateIndex
CREATE INDEX "execution_logs_execution_id_created_at_idx" ON "execution_logs"("execution_id", "created_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_endpoint_id_key_key" ON "idempotency_keys"("endpoint_id", "key");

-- CreateIndex
CREATE INDEX "dead_letter_jobs_status_created_at_idx" ON "dead_letter_jobs"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "dead_letter_jobs_workflow_id_idx" ON "dead_letter_jobs"("workflow_id");

-- CreateIndex
CREATE INDEX "dead_letter_jobs_execution_id_idx" ON "dead_letter_jobs"("execution_id");

-- AddForeignKey
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executions" ADD CONSTRAINT "executions_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MaxBotDialogState" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "maxUserId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "MaxBotDialogState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MaxBotDialogState_maxUserId_key" ON "MaxBotDialogState"("maxUserId");
CREATE INDEX "MaxBotDialogState_expiresAt_idx" ON "MaxBotDialogState"("expiresAt");

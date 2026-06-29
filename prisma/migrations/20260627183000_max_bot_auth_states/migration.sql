CREATE TABLE "MaxAuthState" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "state" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "userId" UUID,
    "maxUserId" TEXT,
    "completedUserId" UUID,
    "error" TEXT,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "consumedAt" TIMESTAMPTZ,
    "completedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaxAuthState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MaxAuthState_state_key" ON "MaxAuthState"("state");
CREATE INDEX "MaxAuthState_purpose_idx" ON "MaxAuthState"("purpose");
CREATE INDEX "MaxAuthState_userId_idx" ON "MaxAuthState"("userId");
CREATE INDEX "MaxAuthState_expiresAt_idx" ON "MaxAuthState"("expiresAt");

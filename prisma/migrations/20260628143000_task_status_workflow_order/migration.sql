ALTER TABLE "Task" ALTER COLUMN "status" DROP DEFAULT;

ALTER TYPE "TaskStatus" RENAME TO "TaskStatus_old";

CREATE TYPE "TaskStatus" AS ENUM (
    'IN_PROGRESS',
    'WAITING',
    'NEEDS_ADMIN',
    'DONE',
    'CANCELLED'
);

ALTER TABLE "Task"
    ALTER COLUMN "status" TYPE "TaskStatus"
    USING ("status"::text::"TaskStatus");

ALTER TABLE "Task"
    ALTER COLUMN "status" SET DEFAULT 'IN_PROGRESS';

DROP TYPE "TaskStatus_old";

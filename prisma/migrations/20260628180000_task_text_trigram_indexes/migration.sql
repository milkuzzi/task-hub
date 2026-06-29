CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Task_title_trgm_idx"
ON "Task"
USING GIN ("title" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Task_description_trgm_idx"
ON "Task"
USING GIN ("description" gin_trgm_ops)
WHERE "description" IS NOT NULL;

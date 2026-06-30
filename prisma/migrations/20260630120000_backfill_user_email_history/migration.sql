INSERT INTO "UserEmail" ("id", "userId", "email", "usedFrom")
SELECT gen_random_uuid(), "User"."id", "User"."email", "User"."createdAt"
FROM "User"
WHERE NOT EXISTS (
  SELECT 1
  FROM "UserEmail"
  WHERE "UserEmail"."userId" = "User"."id"
    AND "UserEmail"."email" = "User"."email"
);

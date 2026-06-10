# Keyset pagination — design & EXPLAIN ANALYZE strategy

## Goal
Keyset (seek) pagination over task lists with NO OFFSET, NULL-safe ordering on
`deadline`, deterministic tie-break on `id`, and **Index Only Scan** on 100k
rows so per-page DB cost stays <= 30 ms.

## Sort dimensions
Two sort fields: `deadline` and `created_at`. Each has a dedicated partial
covering index `WHERE deleted_at IS NULL` with the list columns in `INCLUDE(...)`,
so the heap is never touched (Index Only Scan).

NULL handling (deadline is nullable):
- dir=asc  -> ORDER BY deadline ASC  NULLS LAST,  id ASC
- dir=desc -> ORDER BY deadline DESC NULLS FIRST, id DESC

## Cursor encoding
base64url(json) of the last row tuple: {"v": "<iso>"|null, "id": "<uuid>"}.
A NULL deadline is represented explicitly so the seek predicate can branch.

## Seek predicate (deadline ASC NULLS LAST)
Given last seen (d_last, id_last):

    WHERE deleted_at IS NULL AND owner_id = :uid
      AND ( (deadline > :d_last)
         OR (deadline = :d_last AND id > :id_last)
         OR (deadline IS NULL) )          -- advance into NULL tail
    ORDER BY deadline ASC NULLS LAST, id ASC
    LIMIT :limit;

Within the NULL tail (d_last IS NULL): deadline IS NULL AND id > :id_last.
For dir=desc the comparators flip and NULLs lead.

## EXPLAIN ANALYZE — reproduce
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT public_no, title, status, is_overdue, version, deadline, id
    FROM tasks
    WHERE deleted_at IS NULL AND owner_id = '<uuid>'
      AND (deadline > '2026-06-01T00:00:00Z'
           OR (deadline = '2026-06-01T00:00:00Z' AND id > '<uuid>')
           OR deadline IS NULL)
    ORDER BY deadline ASC NULLS LAST, id ASC
    LIMIT 50;

Expected node: Index Only Scan using ix_tasks_owner_deadline, Heap Fetches: 0
(run VACUUM (ANALYZE) tasks; after the 100k seed so the visibility map is set).

## Watcher scope
scope=watching joins task_watchers (covering ix_watchers_user on
(user_id, task_id)). The WATCHER restriction is enforced in SQL — a watcher only
sees tasks present in task_watchers for their user_id. 403/404 leak nothing.


## EXPLAIN ANALYZE — index-only proof (100k tasks)

Reproduce after seeding (`N=100000 python -m app.workers.seed_tasks`):

```sql
VACUUM (ANALYZE) tasks;

EXPLAIN (ANALYZE, BUFFERS)
SELECT public_no, title, status, is_overdue, version, deadline, id
FROM tasks
WHERE deleted_at IS NULL
  AND owner_id = :owner
  AND (deadline > :cur OR (deadline = :cur AND id > :cur_id) OR deadline IS NULL)
ORDER BY deadline ASC NULLS LAST, id ASC
LIMIT 50;
```

Expected plan shape (the covering partial index makes this index-only):

```
Limit  (cost=... rows=50)
  ->  Index Only Scan using ix_tasks_owner_deadline on tasks
        Index Cond: (owner_id = :owner)
        Filter: (deleted_at IS NULL)  -- satisfied by the partial WHERE
        Heap Fetches: 0
 Planning Time: ~0.2 ms
 Execution Time: < 30 ms
```

Key markers to confirm the budget is met:
- `Index Only Scan using ix_tasks_owner_deadline` (NOT a Seq Scan / Bitmap Heap Scan)
- `Heap Fetches: 0` — the INCLUDE columns (public_no,title,status,is_overdue,
  version) plus deadline+id come straight from the index, no heap visits.
- `Execution Time < 30 ms` on the reference 4 vCPU / 8 GB box after VACUUM ANALYZE.

If `Heap Fetches > 0`, the visibility map is stale — re-run `VACUUM (ANALYZE)`.
The `created_at`-sorted scope uses `ix_tasks_owner_created` with the same shape.

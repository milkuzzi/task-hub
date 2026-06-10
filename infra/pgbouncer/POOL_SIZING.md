# PgBouncer pool sizing (4 vCPU reference)

  DEFAULT_POOL_SIZE = ceil(active_concurrent_txn / (1 + think_time/txn_time))

Practical rule used here:
  DEFAULT_POOL_SIZE = 2-3 x vCPU  =>  20 (rounded for headroom on 4 vCPU)
  MAX_CLIENT_CONN   = 1000        (front-side multiplexing)

App side (per gunicorn worker), see backend/app/core/config.py:
  per_worker_pool = max(2, floor(DEFAULT_POOL_SIZE / gunicorn_workers))
                  = floor(20 / 4) = 5   -> db_pool_size = 5, max_overflow = 0

Why transaction mode + statement_cache_size=0:
  Transaction pooling rebinds server connections per-transaction, so asyncpg
  prepared statements (cached on a specific server conn) would leak across
  clients. Disabling the cache (statement_cache_size=0) is mandatory.

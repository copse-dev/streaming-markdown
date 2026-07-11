# Setting up connection pooling

Great question — connection pooling is the single biggest lever for database
throughput under load. Here's how the pieces fit together.

## Why a pool

Opening a TCP connection and authenticating costs **1–3 round trips** before a
single query runs. A pool keeps a set of established connections warm and hands
them out, so the per-query overhead drops to roughly zero.

Two numbers to size it by:

1. **Max connections** — bounded by your database's `max_connections` minus
   headroom for admin/replication. Oversizing here just moves the queue into the
   database, where it's more expensive.
2. **Idle timeout** — how long an unused connection lingers before it's closed.
   Too short and you churn; too long and you pin server resources.

## A minimal configuration

```ts
const pool = createPool({
  max: 20,            // per instance; 20 × replicas ≤ db max_connections
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
})

// Always release, even on error:
const client = await pool.connect()
try {
  return await client.query('select * from orders where id = $1', [id])
} finally {
  client.release()
}
```

> **Watch out:** a leaked client (a missing `release()`) permanently shrinks the
> pool. Under load the symptom is *rising latency with flat CPU* — every request
> waits on `connect()`. Wrap acquisition in `try/finally`, always.

## Checklist

- [x] Cap `max` so `max × replicas` stays under the server limit
- [x] Set a short `connectionTimeoutMillis` so a saturated pool fails fast
- [ ] Add a metric on pool wait time (the leading indicator of exhaustion)

See the [pool tuning guide](https://example.com/pooling) for replica math and
the `pg_stat_activity` queries to watch in production.

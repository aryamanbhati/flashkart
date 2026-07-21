# Architectural decisions

This is the "why" document. Every hard choice in this repo gets a paragraph here so it can be defended in an interview. Fill in as phases land.

---

## Phase 1 — Foundation

### Monorepo (npm workspaces), not three repos

Api and worker MUST agree on the shape of an `Order`, an idempotency-key payload, a job payload. Three repos → duplicated types → drift. A monorepo with `@flashkart/shared` gives compile-time contracts across services. npm workspaces is enough (no need for pnpm/Turborepo yet) and adds zero build tooling.

### TypeScript everywhere

Catches DTO-shape bugs at compile time. Common interview follow-up: "how do you keep contracts between your api and your queue worker in sync?" — TS + shared package is the clean answer.

### ESM (`"type": "module"`)

Forward-looking. TypeScript's `NodeNext` module resolution requires the `.js` extension on relative imports even in `.ts` files — a gotcha coming from CommonJS, but standard once you get used to it.

### ioredis, not node-redis

`defineCommand({ numberOfKeys, lua })` lets us register the atomic-decrement Lua script once at boot and call it as a typed method. `node-redis` supports scripts but the API is clunkier. Also: BullMQ requires `ioredis` with `maxRetriesPerRequest: null`.

### Env validation with Zod at startup

If a required var is missing we crash with a readable error listing every problem, before any downstream client tries to use `undefined`. Small pattern; big impact during interview demos where "why is this broken?" would otherwise burn a minute.

### Live/ready health-check split

- `/health/live` — process responsive? Used by K8s livenessProbe. Does NOT check downstream deps. If it did, a Mongo outage would restart every api pod, amplifying the outage.
- `/health/ready` — Mongo + Redis reachable? Used by K8s readinessProbe. If either is down, LB pulls this pod out until deps recover.

### Redis with AOF (`appendonly yes`, `appendfsync everysec`)

We keep inventory counters in Redis during a sale. Without AOF, a crash loses them entirely. AOF's `everysec` mode risks ≤1s of writes vs RDB snapshots' minutes. Interview follow-up: *"what if Redis crashes mid-sale?"* → AOF durability + a reconciliation job that syncs Redis stock back to Mongo periodically.

### Named volumes for `node_modules` in dev

Bind-mounting the whole repo would push Windows-compiled native modules into a Linux container and break `bcryptjs`/`ioredis`. Overlaying a named volume at `/app/api/node_modules` (etc) lets the container use its own Linux-native install seeded from the image on first mount.

### Separate api and worker processes (not threads)

Worker replicas scale independently of api pods. A big sale spike hits the api hard; queue-drain rate is bounded by the payment provider. Different scale dimensions → different processes.

### Graceful shutdown on SIGTERM

Stop accepting new connections → wait for in-flight requests (10s cap) → close DB connections → exit. Without this, K8s rolling deploys drop the tail of every rolling batch's requests.

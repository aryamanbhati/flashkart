# Deploying to Railway

Railway hosts our three services (`api`, `worker`, `web`) + provisioned Redis + provisioned Mongo. The web at `flashkart-web.up.railway.app`, api at `flashkart-api.up.railway.app` (URLs will differ — Railway generates them).

## Prerequisites

1. Railway account: <https://railway.app>
2. Verify GitHub connection is authorized so Railway can pull from the repo.

## Setup — 4 services in one project

### Step 1: create the project

- Railway dashboard → **New Project** → **Deploy from GitHub repo** → pick `aryamanbhati/flashkart`.
- Railway creates the first service from the repo. Rename it to **`api`** in service settings.

### Step 2: point `api` at its Dockerfile + envs

Service settings for `api`:

- **Source** → Repo `aryamanbhati/flashkart`, branch `main`
- **Build** → Dockerfile path: `api/Dockerfile`
- **Deploy** → Start Command: (blank — Dockerfile CMD is used)
- **Networking** → Generate Domain (one click; you'll get something like `flashkart-api-production.up.railway.app`) — copy it.
- **Variables**:
  ```
  NODE_ENV                = production
  API_PORT                = 4000
  CORS_ORIGIN             = https://<web-domain>       # filled in after step 4
  JWT_ACCESS_SECRET       = <64 random bytes hex>      # `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`
  JWT_REFRESH_SECRET      = <different 64 random bytes hex>
  JWT_ACCESS_TTL          = 15m
  JWT_REFRESH_TTL         = 7d
  MONGO_URI               = ${{Mongo.MONGO_URL}}       # Railway reference variable — set after step 5
  REDIS_URL               = ${{Redis.REDIS_URL}}
  RATE_LIMIT_BYPASS_TOKEN = <blank>                    # LEAVE EMPTY IN PROD — disables bypass
  ```

### Step 3: add `worker` service

- Project dashboard → **New** → **GitHub Repo** → same repo, this time named **`worker`**.
- **Build** → Dockerfile path: `worker/Dockerfile`
- **Variables**:
  ```
  NODE_ENV   = production
  MONGO_URI  = ${{Mongo.MONGO_URL}}
  REDIS_URL  = ${{Redis.REDIS_URL}}
  ```
- **Networking** → NO generated domain — worker isn't publicly reachable.

### Step 4: add `web` service

- Project dashboard → **New** → **GitHub Repo** → same repo, named **`web`**.
- **Build** → Dockerfile path: `web/Dockerfile`
- **Build args** (this is important — Vite bakes env into the bundle at build time):
  ```
  VITE_API_URL = https://<api-domain-from-step-2>
  ```
- **Networking** → Generate Domain — this becomes `flashkart.aryaman.dev` later, or just use the Railway subdomain.
- Copy this domain, go BACK to the `api` service, and set `CORS_ORIGIN = https://<web-domain>`.

### Step 5: provision managed databases

Project dashboard:

- **New** → **Database** → **Add MongoDB** → default settings. Rename to **`Mongo`**.
- **New** → **Database** → **Add Redis** → default settings. Rename to **`Redis`**.

The `${{Mongo.MONGO_URL}}` and `${{Redis.REDIS_URL}}` reference variables in the api + worker configs will auto-resolve to the internal connection strings — no manual copying.

### Step 6: redeploy api + worker with the DB references

If you set the Mongo/Redis variables before adding the databases, they were `undefined` at boot and the services crashed. Trigger a **Redeploy** on both `api` and `worker` after the databases are healthy.

### Step 7: seed data

Once the deploy is green:

```bash
# From your local terminal, one-off:
railway run --service api npx tsx api/src/scripts/seed.ts
```

Or use Railway's built-in shell UI on the `api` service.

## Verify

- <https://\<api-domain\>/health/ready> → `200 {"status":"ok"}`
- <https://\<web-domain\>> → the app renders, you can register + buy.
- WebSocket + realtime updates → open two tabs, buy on one, see the other tick.

## Cost sanity check

Railway's free tier gives \~$5/mo in credits. This stack (2 tiny node services + 1 tiny nginx + Mongo + Redis) fits in that budget when idle and briefly overshoots during heavy load. Fine for a portfolio artifact; scale-up needs a credit card.

## Custom domain later

If you buy a domain:

- Railway service → Networking → Add custom domain → `flashkart.aryaman.dev` (or whatever).
- Railway shows a CNAME target. Add it as a DNS record at your registrar.
- Update `CORS_ORIGIN` on api and `VITE_API_URL` build arg on web to the new domain, redeploy.

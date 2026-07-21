# Prod Dockerfile for the api.
#
# Design note: we run the api under `tsx` in prod, not compiled JS. Why:
#   * @flashkart/shared is source-linked (main -> src/index.ts) so compiled JS
#     would need shared compiled separately. Adds friction for little gain.
#   * tsx cold-start cost is ~200ms — irrelevant for a long-running Express pod.
#   * Same runner as dev = zero prod-vs-dev drift risk.
#
# Later, if we needed to squeeze cold-start (e.g. serverless), we'd switch
# shared to a proper build step. Not worth the complexity today.

FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production

# Manifests first — install layer caches on source-only changes.
COPY package.json package-lock.json ./
COPY api/package.json ./api/
COPY worker/package.json ./worker/
COPY web/package.json ./web/
COPY packages/shared/package.json ./packages/shared/

# npm ci = exact lockfile install. --include-workspace-root pulls the root
# devDeps so tsx and typescript are available in the container.
RUN npm ci --workspaces --include-workspace-root

# Source.
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY api ./api

USER node
EXPOSE 4000
WORKDIR /app/api
CMD ["npx", "tsx", "src/index.ts"]

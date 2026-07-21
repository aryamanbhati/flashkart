# Prod Dockerfile for the worker. Same tsx-runtime rationale as api/Dockerfile.

FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY api/package.json ./api/
COPY worker/package.json ./worker/
COPY web/package.json ./web/
COPY packages/shared/package.json ./packages/shared/

RUN npm ci --workspaces --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY worker ./worker

USER node
WORKDIR /app/worker
CMD ["npx", "tsx", "src/index.ts"]

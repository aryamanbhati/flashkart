# Prod Dockerfile for the web. Two stages:
#   1. builder — install deps, `vite build` -> web/dist (static files)
#   2. runtime  — nginx serving those static files. ~25MB image, no Node needed.
#
# VITE_API_URL is a BUILD-TIME env — Vite bakes it into the bundle. Railway
# passes it as a build arg; if you rebuild for a different environment you get
# a different bundle. That's how Vite envs work.

# ---- 1. build stage --------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}

COPY package.json package-lock.json ./
COPY api/package.json ./api/
COPY worker/package.json ./worker/
COPY web/package.json ./web/
COPY packages/shared/package.json ./packages/shared/

RUN npm ci --workspaces --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY web ./web

WORKDIR /app/web
RUN npm run build

# ---- 2. runtime stage -----------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# SPA-aware nginx: fall through to index.html for client-side routes.
COPY web/nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/web/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

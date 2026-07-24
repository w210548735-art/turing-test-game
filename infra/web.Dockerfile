# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS build
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci --workspace apps/web --workspace packages/protocol --include-workspace-root=false

COPY packages/protocol packages/protocol
COPY apps/web apps/web
RUN npm run build --workspace packages/protocol
RUN npm run build --workspace apps/web

FROM caddy:2.10-alpine
COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /workspace/apps/web/dist /srv
EXPOSE 80 443
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:80/healthz || exit 1

# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS build
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci --workspace apps/server --workspace packages/protocol --include-workspace-root=false

COPY packages/protocol packages/protocol
COPY apps/server apps/server
RUN npm run build --workspace packages/protocol
RUN npm run build --workspace apps/server
RUN npm prune --omit=dev --workspace apps/server

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /workspace
RUN addgroup -S app && adduser -S -G app app
COPY --from=build --chown=app:app /workspace/node_modules ./node_modules
COPY --from=build --chown=app:app /workspace/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=app:app /workspace/apps/server/dist ./apps/server/dist
COPY --from=build --chown=app:app /workspace/apps/server/drizzle ./apps/server/drizzle
COPY --from=build --chown=app:app /workspace/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build --chown=app:app /workspace/packages/protocol/dist ./packages/protocol/dist
USER app
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/src/index.js"]

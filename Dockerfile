FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/control-plane-api/package.json ./apps/control-plane-api/package.json
COPY apps/web-console/package.json ./apps/web-console/package.json
COPY services/device-worker/package.json ./services/device-worker/package.json
COPY services/verification-runner/package.json ./services/verification-runner/package.json
COPY services/extension-admin/package.json ./services/extension-admin/package.json
COPY packages ./packages
COPY apps/control-plane-api ./apps/control-plane-api
COPY tsconfig.base.json ./
RUN npm ci
RUN npm run build --workspace @forgex/control-plane-api \
  && npm prune --omit=dev

FROM node:24-bookworm-slim AS control-plane
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/control-plane-api/package.json ./apps/control-plane-api/package.json
COPY --from=build --chown=node:node /app/apps/control-plane-api/dist ./apps/control-plane-api/dist
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=node:node /app/packages/domain/package.json ./packages/domain/package.json
COPY --from=build --chown=node:node /app/packages/domain/dist ./packages/domain/dist
COPY --from=build --chown=node:node /app/packages/extensions/package.json ./packages/extensions/package.json
COPY --from=build --chown=node:node /app/packages/extensions/dist ./packages/extensions/dist
COPY --from=build --chown=node:node /app/packages/application/package.json ./packages/application/package.json
COPY --from=build --chown=node:node /app/packages/application/dist ./packages/application/dist
COPY --from=build --chown=node:node /app/packages/postgres/package.json ./packages/postgres/package.json
COPY --from=build --chown=node:node /app/packages/postgres/dist ./packages/postgres/dist
COPY --from=build --chown=node:node /app/packages/postgres/migrations ./packages/postgres/migrations
USER node
EXPOSE 3000
CMD ["npm", "run", "start", "--workspace", "@forgex/control-plane-api"]

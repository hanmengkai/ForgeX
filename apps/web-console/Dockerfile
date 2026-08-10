FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/control-plane-api/package.json ./apps/control-plane-api/package.json
COPY apps/web-console/package.json ./apps/web-console/package.json
COPY services/device-worker/package.json ./services/device-worker/package.json
COPY services/verification-runner/package.json ./services/verification-runner/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/extensions/package.json ./packages/extensions/package.json
COPY packages/application/package.json ./packages/application/package.json
COPY packages/postgres/package.json ./packages/postgres/package.json
COPY packages/contracts ./packages/contracts
COPY apps/web-console ./apps/web-console
COPY tsconfig.base.json ./
RUN npm ci
ARG VITE_FORGEX_PROJECT_NAME=我的项目
ENV VITE_FORGEX_PROJECT_NAME=$VITE_FORGEX_PROJECT_NAME
RUN npm run build --workspace @forgex/web-console

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web-console/dist /usr/share/nginx/html
EXPOSE 8080

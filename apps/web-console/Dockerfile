FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.json tsconfig.base.json ./
RUN npm ci
ARG VITE_FORGEX_PROJECT_NAME=我的项目
ENV VITE_FORGEX_PROJECT_NAME=$VITE_FORGEX_PROJECT_NAME
RUN npm run build --workspace @forgex/web-console

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web-console/dist /usr/share/nginx/html
EXPOSE 8080

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY services ./services
COPY tsconfig.json tsconfig.base.json tsconfig.test.json ./
RUN npm ci
RUN npm run build

FROM node:24-bookworm-slim AS control-plane
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
CMD ["npm", "run", "start", "--workspace", "@forgex/control-plane-api"]

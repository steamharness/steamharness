FROM node:24-bookworm-slim AS build
ARG STEAMHARNESS_NPM_REGISTRY=https://registry.npmjs.org
ENV COREPACK_NPM_REGISTRY=${STEAMHARNESS_NPM_REGISTRY}
WORKDIR /source
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY memory-service ./memory-service
RUN pnpm --filter @steamharness/memory-service install --frozen-lockfile --ignore-scripts --registry=${STEAMHARNESS_NPM_REGISTRY}
RUN pnpm --filter @steamharness/memory-service build
RUN npm_config_registry=${STEAMHARNESS_NPM_REGISTRY} pnpm --filter @steamharness/memory-service deploy --prod --legacy /runtime
FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build --chown=node:node /runtime ./
RUN mkdir /data && chown node:node /data
USER node
ENV STEAMHARNESS_MEMORY_DATA_DIR=/data STEAMHARNESS_MEMORY_HOST=0.0.0.0
EXPOSE 7141
CMD ["node", "dist/index.js"]

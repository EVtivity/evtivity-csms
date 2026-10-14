FROM node:24-slim AS deps
# A registry connection reset (ECONNRESET) failed whole release builds; retry longer.
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/lib/package.json packages/lib/
COPY packages/database/package.json packages/database/
COPY packages/payments/package.json packages/payments/
COPY packages/services/package.json packages/services/
COPY packages/ai/package.json packages/ai/
COPY packages/api/package.json packages/api/
COPY packages/ocpp/package.json packages/ocpp/
COPY packages/v2g-exi/package.json packages/v2g-exi/
COPY packages/ocpi/package.json packages/ocpi/
COPY packages/csms/package.json packages/csms/
COPY packages/portal/package.json packages/portal/
COPY packages/codegen/package.json packages/codegen/
COPY packages/css/package.json packages/css/
COPY packages/octt/package.json packages/octt/
COPY packages/ocpi-simulator/package.json packages/ocpi-simulator/
COPY packages/worker/package.json packages/worker/

RUN npm ci --ignore-scripts

FROM deps AS build

COPY tsconfig.base.json tsconfig.json ./
COPY scripts/build.mjs scripts/build.mjs
COPY packages/ocpi-simulator/ packages/ocpi-simulator/

RUN node scripts/build.mjs ocpi-simulator

FROM node:24-slim
# A registry connection reset (ECONNRESET) failed whole release builds; retry longer.
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/lib/package.json packages/lib/
COPY packages/database/package.json packages/database/
COPY packages/payments/package.json packages/payments/
COPY packages/services/package.json packages/services/
COPY packages/ai/package.json packages/ai/
COPY packages/api/package.json packages/api/
COPY packages/ocpp/package.json packages/ocpp/
COPY packages/v2g-exi/package.json packages/v2g-exi/
COPY packages/ocpi/package.json packages/ocpi/
COPY packages/csms/package.json packages/csms/
COPY packages/portal/package.json packages/portal/
COPY packages/codegen/package.json packages/codegen/
COPY packages/css/package.json packages/css/
COPY packages/octt/package.json packages/octt/
COPY packages/ocpi-simulator/package.json packages/ocpi-simulator/
COPY packages/worker/package.json packages/worker/

RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /app/dist/ocpi-simulator.mjs dist/ocpi-simulator.mjs
COPY --from=build /app/dist/ocpi-simulator.mjs.map dist/ocpi-simulator.mjs.map

LABEL org.opencontainers.image.source="https://github.com/EVtivity/evtivity-csms-helm"
LABEL org.opencontainers.image.licenses="BUSL-1.1"
LABEL org.opencontainers.image.vendor="EVtivity"

USER node

ENV NODE_OPTIONS="--enable-source-maps"

# Declare /tmp so ECS on Fargate copies it (root-owned, mode 1777) into the
# scratch volume the task mounts there. Without VOLUME, Fargate creates the
# volume as root 0755 and the node user cannot write to it under a read-only
# root filesystem. Kubernetes ignores VOLUME.
VOLUME ["/tmp"]
CMD ["node", "dist/ocpi-simulator.mjs"]

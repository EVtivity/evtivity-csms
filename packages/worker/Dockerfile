FROM node:24-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/lib/package.json packages/lib/
COPY packages/database/package.json packages/database/
COPY packages/payments/package.json packages/payments/
COPY packages/api/package.json packages/api/
COPY packages/ocpp/package.json packages/ocpp/
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
COPY packages/lib/ packages/lib/
COPY packages/database/ packages/database/
COPY packages/payments/ packages/payments/
COPY packages/ocpp/ packages/ocpp/
COPY packages/css/ packages/css/
COPY packages/octt/ packages/octt/
COPY packages/api/ packages/api/
COPY packages/worker/ packages/worker/

RUN node scripts/build.mjs worker

FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/lib/package.json packages/lib/
COPY packages/database/package.json packages/database/
COPY packages/payments/package.json packages/payments/
COPY packages/api/package.json packages/api/
COPY packages/ocpp/package.json packages/ocpp/
COPY packages/ocpi/package.json packages/ocpi/
COPY packages/csms/package.json packages/csms/
COPY packages/portal/package.json packages/portal/
COPY packages/codegen/package.json packages/codegen/
COPY packages/css/package.json packages/css/
COPY packages/octt/package.json packages/octt/
COPY packages/ocpi-simulator/package.json packages/ocpi-simulator/
COPY packages/worker/package.json packages/worker/

RUN npm ci --omit=dev --ignore-scripts && npm rebuild argon2

COPY --from=build /app/dist/worker.mjs dist/worker.mjs
COPY --from=build /app/dist/worker.mjs.map dist/worker.mjs.map
COPY packages/api/src/templates/ templates/api/
COPY packages/ocpp/src/templates/ templates/ocpp/

LABEL org.opencontainers.image.source="https://github.com/EVtivity/evtivity-csms-helm"
LABEL org.opencontainers.image.license="LicenseRef-EVtivity-EULA"
LABEL org.opencontainers.image.vendor="EVtivity"

COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/evtivity-entrypoint

USER node

ENV NODE_OPTIONS="--enable-source-maps"
ENV API_TEMPLATES_DIR="/app/templates/api"
ENV OCPP_TEMPLATES_DIR="/app/templates/ocpp"

# Declare /tmp so ECS on Fargate copies it (root-owned, mode 1777) into the
# scratch volume the task mounts there. Without VOLUME, Fargate creates the
# volume as root 0755 and the node user cannot write to it under a read-only
# root filesystem. Kubernetes ignores VOLUME.
VOLUME ["/tmp"]
ENTRYPOINT ["evtivity-entrypoint"]
CMD ["node", "dist/worker.mjs"]

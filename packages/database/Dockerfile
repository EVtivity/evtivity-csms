# The dependency manifests with every workspace version set to 0.0.0
# (scripts/docker-dependency-manifests.mjs). A release changes only the version
# fields, so the npm ci layers below stay cached; the real manifests are copied
# back after each install.
FROM --platform=$BUILDPLATFORM node:24-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS manifests
WORKDIR /real
COPY package.json package-lock.json ./
COPY packages/lib/package.json packages/lib/
COPY packages/database/package.json packages/database/
COPY packages/payments/package.json packages/payments/
COPY packages/payment-terminals/package.json packages/payment-terminals/
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
COPY packages/ocpi-simulator/package.json packages/ocpi-simulator/
COPY scripts/docker-dependency-manifests.mjs /tmp/docker-dependency-manifests.mjs
RUN node /tmp/docker-dependency-manifests.mjs /real /app

FROM node:24-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS deps
# A registry connection reset (ECONNRESET) failed whole release builds; retry longer.
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000

WORKDIR /app

COPY --from=manifests /app/ ./

RUN npm ci --ignore-scripts && npm rebuild argon2
COPY --from=manifests /real/ ./

COPY tsconfig.base.json tsconfig.json ./
COPY packages/lib/ packages/lib/
COPY packages/database/ packages/database/
# verify-migrations-applied.mjs and check-migrations.mjs are referenced by
# `npm run migrate` from packages/database; without scripts/ in the image the
# migrate-job container fails on a missing script. The lib build below needs it
# too: a lib test imports scripts/lib/dev-live.mjs.
COPY scripts/ scripts/
# sync-admin-permissions (the last step of `npm run migrate`) imports @evtivity/lib,
# whose package entry is the compiled dist/.
RUN npm run build --workspace=packages/lib
LABEL org.opencontainers.image.source="https://github.com/EVtivity/evtivity-csms"
LABEL org.opencontainers.image.licenses="BUSL-1.1"
LABEL org.opencontainers.image.vendor="EVtivity"

COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/evtivity-entrypoint
# Migrations and seeds run as the unprivileged node user (UID 1000), as the
# Helm jobs and the CDK database job expect. The image files stay root-owned
# and read-only to it.
USER node
# Declare /tmp so ECS on Fargate copies it (root-owned, mode 1777) into the
# scratch volume the task mounts there. Without VOLUME, Fargate creates the
# volume as root 0755 and the node user cannot write to it under a read-only
# root filesystem. Kubernetes ignores VOLUME.
VOLUME ["/tmp"]
ENTRYPOINT ["evtivity-entrypoint"]
CMD ["sh", "-c", "cd packages/database && npm run migrate"]

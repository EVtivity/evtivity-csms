FROM node:24-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/lib/package.json packages/lib/
COPY packages/database/package.json packages/database/
COPY packages/payments/package.json packages/payments/
COPY packages/services/package.json packages/services/
COPY packages/api/package.json packages/api/
COPY packages/ocpp/package.json packages/ocpp/
COPY packages/v2g-exi/package.json packages/v2g-exi/
COPY packages/ocpi/package.json packages/ocpi/
COPY packages/csms/package.json packages/csms/
COPY packages/portal/package.json packages/portal/
COPY packages/codegen/package.json packages/codegen/
COPY packages/css/package.json packages/css/
COPY packages/ocpi-simulator/package.json packages/ocpi-simulator/

RUN npm ci --ignore-scripts && npm rebuild argon2

COPY tsconfig.base.json tsconfig.json ./
COPY packages/lib/ packages/lib/
COPY packages/database/ packages/database/
# sync-admin-permissions (the last step of `npm run migrate`) imports @evtivity/lib,
# whose package entry is the compiled dist/.
RUN npm run build --workspace=packages/lib
# verify-migrations-applied.mjs and check-migrations.mjs are referenced by
# `npm run migrate` from packages/database; without scripts/ in the image the
# migrate-job container fails on a missing script.
COPY scripts/ scripts/
LABEL org.opencontainers.image.source="https://github.com/EVtivity/evtivity-csms-helm"
LABEL org.opencontainers.image.licenses="BUSL-1.1"
LABEL org.opencontainers.image.vendor="EVtivity"

COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/evtivity-entrypoint
# Declare /tmp so ECS on Fargate copies it (root-owned, mode 1777) into the
# scratch volume the task mounts there. Without VOLUME, Fargate creates the
# volume as root 0755 and the node user cannot write to it under a read-only
# root filesystem. Kubernetes ignores VOLUME.
VOLUME ["/tmp"]
ENTRYPOINT ["evtivity-entrypoint"]
CMD ["sh", "-c", "cd packages/database && npm run migrate"]

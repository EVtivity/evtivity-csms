# The build output is static files, so build once on the native platform instead of
# again under emulation for each target architecture.
FROM --platform=$BUILDPLATFORM node:24-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/lib/package.json packages/lib/
COPY packages/csms/package.json packages/csms/

RUN npm ci --ignore-scripts --workspace=packages/csms

COPY packages/csms/ packages/csms/
COPY packages/lib/ packages/lib/
COPY tsconfig.base.json ./

RUN npm run build --workspace=packages/csms

# Runs as the unprivileged nginx user (uid 101). The pid file and temp
# paths live under /tmp, so the root filesystem can stay read-only.
FROM nginxinc/nginx-unprivileged:alpine

COPY --from=build /app/packages/csms/dist /usr/share/nginx/html
COPY packages/csms/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 packages/csms/docker-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
# Declare /tmp so ECS on Fargate copies it (mode 1777) into the scratch volume
# the task mounts there. Without VOLUME, Fargate creates the volume as root
# 0755 and uid 101 cannot write to it. Kubernetes ignores VOLUME.
VOLUME ["/tmp"]

LABEL org.opencontainers.image.source="https://github.com/EVtivity/evtivity-csms-helm"
LABEL org.opencontainers.image.licenses="BUSL-1.1"
LABEL org.opencontainers.image.vendor="EVtivity"

EXPOSE 8080

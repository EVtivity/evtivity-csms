# The dependency manifests with every workspace version set to 0.0.0
# (scripts/docker-dependency-manifests.mjs). A release changes only the version
# fields, so the npm ci layers below stay cached; the real manifests are copied
# back after each install.
FROM --platform=$BUILDPLATFORM node:24-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS manifests
WORKDIR /real
COPY package.json package-lock.json ./
COPY packages/lib/package.json packages/lib/
COPY packages/csms/package.json packages/csms/
COPY scripts/docker-dependency-manifests.mjs /tmp/docker-dependency-manifests.mjs
RUN node /tmp/docker-dependency-manifests.mjs /real /app

# The build output is static files, so build once on the native platform instead of
# again under emulation for each target architecture.
FROM --platform=$BUILDPLATFORM node:24-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
# A registry connection reset (ECONNRESET) failed whole release builds; retry longer.
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000

WORKDIR /app

COPY --from=manifests /app/ ./

RUN npm ci --ignore-scripts --workspace=packages/csms
COPY --from=manifests /real/ ./

COPY packages/csms/ packages/csms/
COPY packages/lib/ packages/lib/
COPY tsconfig.base.json ./

RUN npm run build --workspace=packages/csms

# Runs as the unprivileged nginx user (uid 101). The pid file and temp
# paths live under /tmp, so the root filesystem can stay read-only.
FROM nginxinc/nginx-unprivileged:alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e

COPY --from=build /app/packages/csms/dist /usr/share/nginx/html
COPY packages/csms/nginx.conf /etc/nginx/conf.d/default.conf
COPY packages/csms/nginx-security-headers.conf /etc/nginx/evtivity-security-headers.conf.template
COPY --chmod=755 packages/csms/docker-security-headers.sh /docker-entrypoint.d/30-security-headers.sh
COPY --chmod=755 packages/csms/docker-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
# Declare /tmp so ECS on Fargate copies it (mode 1777) into the scratch volume
# the task mounts there. Without VOLUME, Fargate creates the volume as root
# 0755 and uid 101 cannot write to it. Kubernetes ignores VOLUME.
VOLUME ["/tmp"]

LABEL org.opencontainers.image.source="https://github.com/EVtivity/evtivity-csms"
LABEL org.opencontainers.image.licenses="BUSL-1.1"
LABEL org.opencontainers.image.vendor="EVtivity"

EXPOSE 8080

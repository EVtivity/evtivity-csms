FROM node:24-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/lib/package.json packages/lib/
COPY packages/database/package.json packages/database/
COPY packages/api/package.json packages/api/
COPY packages/ocpp/package.json packages/ocpp/
COPY packages/ocpi/package.json packages/ocpi/
COPY packages/csms/package.json packages/csms/
COPY packages/portal/package.json packages/portal/
COPY packages/codegen/package.json packages/codegen/
COPY packages/css/package.json packages/css/
COPY packages/ocpi-simulator/package.json packages/ocpi-simulator/

RUN npm ci --ignore-scripts

FROM deps AS build

COPY tsconfig.base.json tsconfig.json ./
COPY scripts/build.mjs scripts/build.mjs
COPY packages/lib/ packages/lib/
COPY packages/database/ packages/database/
COPY packages/ocpp/ packages/ocpp/
COPY packages/css/ packages/css/

RUN node scripts/build.mjs css

FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/lib/package.json packages/lib/
COPY packages/database/package.json packages/database/
COPY packages/api/package.json packages/api/
COPY packages/ocpp/package.json packages/ocpp/
COPY packages/ocpi/package.json packages/ocpi/
COPY packages/csms/package.json packages/csms/
COPY packages/portal/package.json packages/portal/
COPY packages/codegen/package.json packages/codegen/
COPY packages/css/package.json packages/css/
COPY packages/ocpi-simulator/package.json packages/ocpi-simulator/

RUN npm ci --omit=dev --ignore-scripts && npm rebuild argon2

COPY --from=build /app/dist/css.mjs dist/css.mjs
COPY --from=build /app/dist/css.mjs.map dist/css.mjs.map
COPY scripts/generate-test-certs.sh scripts/generate-test-certs.sh
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/* \
    && bash scripts/generate-test-certs.sh packages/css/test-certs \
    && chown -R node:node packages/css/test-certs

LABEL org.opencontainers.image.source="https://github.com/EVtivity/evtivity-csms-helm"
LABEL org.opencontainers.image.license="LicenseRef-EVtivity-EULA"
LABEL org.opencontainers.image.vendor="EVtivity"

USER node
EXPOSE 8082

ENV NODE_OPTIONS="--enable-source-maps"

CMD ["node", "dist/css.mjs"]

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

RUN node scripts/build.mjs ocpp

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

COPY --from=build /app/dist/ocpp.mjs dist/ocpp.mjs
COPY --from=build /app/dist/ocpp.mjs.map dist/ocpp.mjs.map
COPY packages/ocpp/src/templates/ templates/ocpp/
COPY packages/api/src/templates/ templates/api/

LABEL org.opencontainers.image.source="https://github.com/EVtivity/evtivity-csms-helm"
LABEL org.opencontainers.image.license="LicenseRef-EVtivity-EULA"
LABEL org.opencontainers.image.vendor="EVtivity"

USER node
EXPOSE 8080 8081 8443

ENV NODE_OPTIONS="--enable-source-maps --max-old-space-size=4096"
ENV OCPP_TEMPLATES_DIR="/app/templates/ocpp"
ENV API_TEMPLATES_DIR="/app/templates/api"

CMD ["node", "dist/ocpp.mjs"]

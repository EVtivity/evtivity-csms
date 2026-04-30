FROM node:24-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/portal/package.json packages/portal/

RUN npm ci --ignore-scripts --workspace=packages/portal

COPY packages/portal/ packages/portal/
COPY tsconfig.base.json ./

RUN npm run build --workspace=packages/portal

FROM nginx:alpine

COPY --from=build /app/packages/portal/dist /usr/share/nginx/html
COPY packages/portal/nginx.conf /etc/nginx/conf.d/default.conf
COPY packages/portal/docker-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh

LABEL org.opencontainers.image.source="https://github.com/EVtivity/evtivity-csms-helm"
LABEL org.opencontainers.image.license="LicenseRef-EVtivity-EULA"
LABEL org.opencontainers.image.vendor="EVtivity"

EXPOSE 80

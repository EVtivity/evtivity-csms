FROM node:24-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/csms/package.json packages/csms/

RUN npm ci --ignore-scripts --workspace=packages/csms

COPY packages/csms/ packages/csms/
COPY tsconfig.base.json ./

RUN npm run build --workspace=packages/csms

FROM nginx:alpine

COPY --from=build /app/packages/csms/dist /usr/share/nginx/html
COPY packages/csms/nginx.conf /etc/nginx/conf.d/default.conf

LABEL org.opencontainers.image.source="https://github.com/EVtivity/evtivity-csms-helm"
LABEL org.opencontainers.image.license="LicenseRef-EVtivity-EULA"
LABEL org.opencontainers.image.vendor="EVtivity"

EXPOSE 80

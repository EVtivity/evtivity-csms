# Development

Two ways to run the system locally. Both require Docker and Node.js 24+.

## 1. Local Development (recommended)

Run infrastructure in Docker, application services natively with hot reload. Best for active development.

### Prerequisites

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Install dependencies:

```bash
npm install
```

### Start infrastructure

```bash
npm run dev:infra
```

Starts PostgreSQL, Redis, database migrations, seed data, Mailpit, Prometheus, Grafana, Loki, and Alloy in Docker containers. Wait for the migrate container to exit before starting services.

### Start services

Open a separate terminal for each service you need:

| Command                    | Description                                     | Port                         | URL                   |
| -------------------------- | ----------------------------------------------- | ---------------------------- | --------------------- |
| `npm run dev:infra`        | PostgreSQL, Redis, migrations, seed, monitoring | 5433, 6379, 9090, 7107, 7108 | --                    |
| `npm run dev:api`          | REST API server (hot reload)                    | 7102                         | http://localhost:7102 |
| `npm run dev:ocpp`         | OCPP WebSocket server (hot reload)              | 7103                         | ws://localhost:7103   |
| `npm run dev:csms`         | Operator dashboard (Vite dev server)            | 7100                         | http://localhost:7100 |
| `npm run dev:portal`       | Driver portal (Vite dev server)                 | 7101                         | http://localhost:7101 |
| `npm run dev:worker`       | Background job worker (hot reload)              | --                           | --                    |
| `npm run dev:css`          | Charging station simulator                      | --                           | --                    |
| `npm run dev:ocpi`         | OCPI roaming server (hot reload)                | 7104                         | http://localhost:7104 |
| `npm run dev:ocpi-sim`     | OCPI eMSP simulator                             | 7105                         | http://localhost:7105 |
| `npm run dev:ocpi-sim-cpo` | OCPI CPO simulator                              | 7106                         | http://localhost:7106 |

Infrastructure UIs started by `dev:infra`:

| Service    | URL                   |
| ---------- | --------------------- |
| Grafana    | http://localhost:7107 |
| Prometheus | http://localhost:9090 |
| Mailpit    | http://localhost:7108 |

A typical development session runs `dev:infra`, `dev:api`, `dev:ocpp`, and `dev:csms`.

### Auto-login

The `.env` file configures auto-login for development:

```
VITE_CSMS_AUTO_LOGIN=admin@evtivity.local
VITE_PORTAL_AUTO_LOGIN=driver@evtivity.local
```

Remove or comment out these lines to disable auto-login.

### Database commands

| Command               | Description                                    |
| --------------------- | ---------------------------------------------- |
| `npm run db:generate` | Generate Drizzle migration from schema changes |
| `npm run db:migrate`  | Apply pending migrations                       |
| `npm run db:seed`     | Run seed data script                           |

### Code quality

| Command                    | Description                                           |
| -------------------------- | ----------------------------------------------------- |
| `npm run typecheck`        | TypeScript type checking                              |
| `npm run lint`             | ESLint                                                |
| `npm run format`           | Prettier format                                       |
| `npm run format:check`     | Prettier check                                        |
| `npm test`                 | Run all unit tests                                    |
| `npm run test:integration` | Run API integration tests (requires running database) |
| `npm run build:prod`       | Build all backend services with esbuild               |

### Monitoring

| Service    | URL                   | Credentials             |
| ---------- | --------------------- | ----------------------- |
| Grafana    | http://localhost:7107 | admin / admin           |
| Prometheus | http://localhost:9090 | --                      |
| Mailpit    | http://localhost:7108 | --                      |
| pgAdmin    | http://localhost:7109 | admin@admin.com / admin |

---

## 2. Minikube (Kubernetes)

Deploy the full Helm chart to a local Kubernetes cluster. Tests the production deployment pipeline.

### Prerequisites

- minikube running (`minikube start`)
- Helm 3 installed
- The `evtivity-csms-helm` repo cloned as a sibling directory

### Install

```bash
./scripts/minikube-install.sh
```

The script:

1. Prompts for gateway implementation (Istio or Envoy Gateway)
2. Builds all Docker images inside minikube's Docker daemon
3. Installs the gateway, PostgreSQL, and Redis via Helm
4. Generates OCPP mTLS certificates
5. Installs the EVtivity CSMS Helm chart with monitoring enabled
6. Creates an admin user and prints the credentials

Access the dashboard at http://csms.evtivity.local (add to `/etc/hosts` pointing to the minikube IP).

### Check status

```bash
kubectl get pods -n evtivity
```

### Uninstall

```bash
./scripts/minikube-uninstall.sh
```

Removes all Helm releases, TLS secrets, PVCs, and optionally the namespace and dev images.

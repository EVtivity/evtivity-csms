# AGENTS.md

Guidance for AI coding agents working in the EVtivity CSMS repository. Humans: see `CONTRIBUTING.md` and the docs at https://www.evtivity.com/docs.

To set up, troubleshoot, or report an issue with a running EVtivity install, use the EVtivity Agent Skills: https://github.com/EVtivity/evtivity-skills (`npx skills add EVtivity/evtivity-skills`).

## Project

An OCPP 1.6 and 2.1 Charging Station Management System. npm workspaces, TypeScript (strict, ESM), Node.js 24 or later.

| Package                                                  | Purpose                                                                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `packages/ocpp`                                          | OCPP WebSocket server: handlers in `src/handlers/v1_6` and `src/handlers/v2_1`, event projections that update the database |
| `packages/api`                                           | Fastify REST API: operator routes under `/v1/`, driver portal routes under `/v1/portal/`                                   |
| `packages/worker`                                        | BullMQ jobs and cron handlers                                                                                              |
| `packages/ocpi`                                          | OCPI 2.2.1 and 2.3.0 roaming                                                                                               |
| `packages/database`                                      | Drizzle ORM schema, migrations, seed                                                                                       |
| `packages/lib`, `packages/services`, `packages/payments` | Shared code: no app package imports another app package                                                                    |
| `packages/csms`, `packages/portal`                       | React operator dashboard and driver portal                                                                                 |
| `packages/css`                                           | Charging station simulator                                                                                                 |
| `packages/ocpp/src/generated`                            | Generated from `schemas/`: never edit by hand                                                                              |

Processes talk through Redis pub/sub and BullMQ, never by importing each other.

## Commands

```bash
npm ci                    # install
npm run typecheck         # tsc -b, strict
npm run lint              # ESLint
npm run format            # Prettier
npm test                  # unit tests (Vitest); one package: npm test -- --project @evtivity/api
bash scripts/docker-build.sh   # local stack with Docker Compose
```

Run `npm run typecheck && npm run lint && npm test` before opening a pull request.

## Rules

- Every `.ts` and `.tsx` source file starts with the BSL 1.1 license header (`npm run license:fix` adds it).
- OCPP field names, types and behavior come from `schemas/ocpp-2.1/` and `schemas/ocpp-1.6/`. Do not guess them.
- A database schema change ships with a new hand-written, idempotent migration in `packages/database/src/migrations/` plus its `meta/_journal.json` entry. Never edit a migration that has shipped. Check with `npm run check:migrations`.
- API routes guard operator endpoints with `authorize('resource:action')`, define Zod schemas with `.describe()` on response fields, and return errors as `{ error, code }`.
- UI text changes update all six locale files (en, de, es, ko, zh, zh-TW) of the package.
- Write or update tests for every change. A failing test is a possible bug: fix the code, not the assertion.
- Commit messages follow Conventional Commits.
- Pull requests need the CLA checkbox (see `CONTRIBUTING.md`). Open an issue first for new features, schema changes, new dependencies or architectural changes.

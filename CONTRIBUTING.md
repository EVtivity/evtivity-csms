# Contributing to EVtivity CSMS

We welcome contributions from the community. This document explains the process.

## Contributor License Agreement

All contributors must agree to the [Contributor License Agreement](CLA.md) before their first contribution can be merged. The CLA assigns copyright of your contribution to EVtivity, which allows us to maintain dual licensing (BSL 1.1 for the public release, commercial licenses for production use).

You indicate agreement by checking the CLA checkbox in your pull request.

## Getting Started

1. Fork the repository.
2. Create a feature branch from `main`.
3. Make your changes.
4. Run `npm run typecheck && npm run lint && npm test` before submitting.
5. Run `npm run test:integration` if your changes affect API routes, database queries, or authentication.
6. Open a pull request against `main`.

## What We Accept

- Bug fixes with a clear description of the problem and reproduction steps.
- Test coverage improvements.
- Documentation corrections and improvements.
- Performance improvements with benchmarks showing the improvement.

## What Requires Discussion First

Open an issue before starting work on:

- New features or significant changes to existing behavior.
- Changes to the database schema.
- New dependencies.
- Architectural changes.

## Code Standards

- TypeScript strict mode. No `any` types without justification.
- Follow existing patterns in the codebase.
- Write tests for all changes. Unit tests for logic, integration tests for API routes.
- Zero stderr output from integration tests.
- All tests must pass before a PR will be reviewed.

## Pull Request Process

1. Fill out the PR template completely.
2. Confirm the CLA checkbox is checked.
3. Ensure CI passes (lint, typecheck, tests).
4. A maintainer will review your PR. Address any feedback.
5. Once approved, a maintainer will merge the PR.

## License

By contributing, you agree that your contributions will be licensed under the [Business Source License 1.1](LICENSE.md) and that you assign copyright to EVtivity as described in the [CLA](CLA.md).

# Contributing

Thanks for your interest in contributing to Velocity. We welcome fixes, tests, documentation, and design proposals.

## Getting started

- Install dependencies: `npm install`
- Run the dev vertical slice locally: `npm run dev`
- Run the lightweight verification tests: `npm run test`
- Run the full TypeScript typecheck: `npm run typecheck`

## Branching and commits

- Fork the repository and create a feature branch named `feat/xyz` or `fix/xyz`.
- Keep changes small and scoped. One logical change per pull request.
- Use the `COMMIT_MESSAGE.md` template for the initial commit; prefer clear, imperative commit messages.

## Code style and tests

- TypeScript is used across the repo. Keep `strict`-compatible practices where reasonable.
- Add tests where appropriate; `test/run-tests.ts` demonstrates the lightweight harness.
- If you add behavior that requires persistence or seeds, include tests that assert deterministic outcomes.

## Creating a pull request

1. Push your branch to your fork.
2. Open a pull request against `main` in this repository.
3. Describe the change, include test results, and list manual steps to reproduce if relevant.

## Reporting issues

- Open an issue with a clear title and reproduction steps. Tag it appropriately (bug, enhancement, security).

## Communications

- For design discussions, open an issue and label it `design` or `proposal`.

Thank you — your contributions help make this project more useful and robust.

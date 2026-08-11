# @slopus/happy-agent-base

Shared foundations for Happy coding agents.

The package is bootstrapped with an empty public API. Future agent-base behavior belongs in
`sources` and is exported through `sources/index.ts`.

```text
sources/index.ts
       |
       v
  dist/index.js
```

## Releasing

From a clean `main` worktree whose `HEAD` matches `origin/main`, run:

```sh
pnpm release:happy-agent-base:patch
```

The local release validates, tests, and builds only `@slopus/happy-agent-base`, then creates and
pushes a `happy-agent-base-vX.Y.Z` tag. The shared GitHub publish workflow again validates, tests,
and builds only this package before publishing it through npm trusted publishing. The npm trusted
publisher must identify `slopus/rig`, `publish.yml`, and the `npm` GitHub environment.

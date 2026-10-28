# Contributing

Thanks for your interest in contributing to `@vortexdd/effect-redis-bun`!

## Setup

The toolchain is pinned with [mise](https://mise.jdx.dev). `mise.toml` pins the Bun version used for development and CI.

```bash
git clone https://github.com/Vortex-Dimension-Digital/effect-redis-bun.git
cd effect-redis-bun
mise install # installs the pinned Bun
bun install
```

Without mise, install the Bun version from `mise.toml` yourself.

## Tooling

| Task                                                     | Command                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| Format ([`bun fmt`](https://bun.com/docs/format))        | `bun run format`                                               |
| Lint ([oxlint](https://oxc.rs/docs/guide/usage/linter))  | `bun run lint`                                                 |
| Type check ([tsrs](https://github.com/oxc-project/tsrs)) | `bun run typecheck`                                            |
| All of the above, without writing                        | `bun run check`                                                |
| Unit tests                                               | `bun test`                                                     |
| Integration tests                                        | `REDIS_URL=redis://127.0.0.1:6379/15 bun run test:integration` |
| Build (`bun build` + `.d.ts` from tsrs)                  | `bun run build`                                                |

There are no config files for the formatter or the linter: both run with their defaults.

### Integration tests

The integration tests need a Redis or Valkey server and are skipped without `REDIS_URL`:

```bash
docker run -d --rm --name redis -p 6379:6379 redis:7.2
REDIS_URL=redis://127.0.0.1:6379/15 REDIS_ALLOW_DESTRUCTIVE=1 bun run test:integration
```

`REDIS_ALLOW_DESTRUCTIVE=1` enables the `size` and `clear` tests, which `FLUSHDB` the database in `REDIS_URL`. Only set it for a throwaway database.

### Running CI locally

The workflows run under [act](https://github.com/nektos/act):

```bash
nix shell nixpkgs#act -c act -s GITHUB_TOKEN="$(gh auth token)" -W .github/workflows/ci.yml
```

## Pull requests

1. Branch from `main` and keep the change focused.
2. Add or update tests. Unit tests use `FakeRedisClient` in `src/index.test.ts`; anything that depends on real server behavior belongs in `src/index.integration.test.ts`.
3. Document public API changes with JSDoc and in `README.md` (and `EXAMPLES.md` when relevant).
4. Make sure `bun run check` and `bun test` pass.
5. Use a [Conventional Commit](https://www.conventionalcommits.org/) as the PR title (`feat: ...`, `fix: ...`, `docs: ...`, add `!` for breaking changes). CI checks it, since a squash merge uses the title as the commit message.

CI must pass before merging: the `Check` job on the pinned Bun, unit tests on the minimum (1.2.22) and latest Bun against the lowest and locked Effect versions, and integration tests against Redis 7.2, Redis 8 and Valkey 9.

## Compatibility

- Runtime: Bun >= 1.2.22 (`engines` in `package.json`).
- Peers: `effect` >= 3.1.2 < 4 and `@effect/platform` >= 0.52.3 < 1. CI tests both ends of these ranges, so avoid APIs that only exist in newer versions, or feature-detect them as `toPlatformError` does.

## Releasing (maintainers)

1. Bump `version` in `package.json` and commit `chore(release): vX.Y.Z`.
2. Tag and push: `git tag vX.Y.Z && git push origin main vX.Y.Z`.
3. The `Release` workflow checks that the tag matches `package.json`, runs the checks, publishes to npm with provenance (trusted publishing) and creates the GitHub release.

To bump the development Bun, run `mise use bun@X.Y.Z` and update `@types/bun` to the same version (Dependabot leaves it alone).

## Reporting issues

Use the issue templates. For security vulnerabilities, see [SECURITY.md](./SECURITY.md).

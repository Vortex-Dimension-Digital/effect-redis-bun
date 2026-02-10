# Contributing Guide

Thanks for your interest in contributing to `effect-bun-redis`! 🎉

## Prerequisites

- **Bun** >= 1.0.0 ([install](https://bun.sh))
- **Git** for version control
- Familiarity with **Effect** and TypeScript

## Development Process

### 1. Fork and Clone

```bash
# Fork the repository on GitHub, then:
git clone https://github.com/YOUR_USERNAME/effect-bun-redis.git
cd effect-bun-redis
```

### 2. Install Dependencies

```bash
bun install
```

### 3. Create a Branch

```bash
git checkout -b feature/my-new-feature
# or
git checkout -b fix/my-bug-fix
```

### 4. Make Changes

Edit code in `src/`. Make sure to:

- Maintain consistency with existing style
- Add JSDoc to public functions
- Update tests if necessary
- Update documentation if API changes

### 5. Verify Quality

```bash
# Lint
bun run lint

# Type checking
bun run check-types

# Tests
bun test

# Build
bun run build
```

**All checks must pass** before opening a PR.

### 6. Commit

We use [Conventional Commits](https://www.conventionalcommits.org/):

```bash
# Features
git commit -m "feat: add TTL support to set operation"

# Bug fixes
git commit -m "fix: correctly handle rejected connections"

# Documentation
git commit -m "docs: improve usage examples"

# Refactoring
git commit -m "refactor: simplify scan logic"

# Tests
git commit -m "test: add edge cases for clear operation"

# CI/Tooling
git commit -m "ci: update release workflow"
```

### 7. Push and Pull Request

```bash
git push origin feature/my-new-feature
```

Then open a Pull Request on GitHub. Include:

- **Clear description** of changes
- **Motivation** - why is this necessary?
- **Tests** - how did you verify it works?
- **Breaking changes** - if any, describe them

## Project Structure

```
effect-bun-redis/
├── src/
│   ├── index.ts         # Main implementation
│   └── index.test.ts    # Unit tests
├── dist/                # Build output (generated)
├── .github/
│   ├── workflows/       # CI/CD workflows
│   └── dependabot.yml   # Dependency configuration
├── README.md            # Main documentation
├── EXAMPLES.md          # Advanced examples
├── CONTRIBUTING.md      # This guide
├── LICENSE              # MIT License
├── package.json         # Package configuration
├── tsconfig.json        # TypeScript config
└── biome.json           # Linter/formatter config
```

## Code Standards

### TypeScript

- **Strict mode** enabled
- Explicit types in public APIs
- No `any` - use `unknown` if needed
- Prefer `const` over `let`

### Effect

- Use `Effect.gen` for complex logic
- Handle errors with specific types
- Document effects in JSDoc
- Use `Layer` for dependencies

### Naming

- **camelCase** for functions and variables
- **PascalCase** for types/interfaces
- Descriptive and concise names
- Avoid obscure abbreviations

### Documentation

```typescript
/**
 * Brief description of the function.
 * 
 * Additional details if necessary.
 * 
 * @param config - Parameter description
 * @returns Return value description
 * @example
 * ```typescript
 * const layer = makeLayer({ host: "localhost" })
 * ```
 * 
 * @since 1.0.0
 */
```

## Testing

### Writing Tests

- Use `describe` and `it` for structure
- Descriptive names: `it("should handle empty scan results")`
- Use `FakeRedisClient` for mocks
- Check both happy paths and edge cases

### Running Tests

```bash
# All tests
bun test

# Watch mode
bun --watch test

# Coverage (if configured)
bun test --coverage
```

## Reporting Issues

### Bugs

Include:
- Bun, effect, and this library versions
- Minimal code to reproduce
- Expected vs actual behavior
- Relevant logs/errors

### Feature Requests

Explain:
- The problem it solves
- Alternatives considered
- Impact on existing API
- Proposed usage examples

## Code Review

PRs will be reviewed considering:

1. **Correctness** - Does it work correctly?
2. **Tests** - Is it well tested?
3. **Documentation** - Is it documented?
4. **Style** - Does it follow conventions?
5. **Performance** - Is it efficient?
6. **Breaking changes** - Are they necessary?

## Release Process

(For maintainers only)

1. Update version in `package.json`
2. Commit: `chore(release): v1.2.3`
3. Tag: `git tag v1.2.3`
4. Push: `git push && git push --tags`
5. GitHub Actions will publish automatically

## Questions

If you have questions:

- Open a [Discussion](https://github.com/OWNER/effect-bun-redis/discussions)
- Check [existing issues](https://github.com/OWNER/effect-bun-redis/issues)
- Read the [documentation](README.md) and [examples](EXAMPLES.md)

For security vulnerabilities, see our [Security Policy](./SECURITY.md).

Thanks for contributing! 🚀

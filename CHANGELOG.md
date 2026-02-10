# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial project with Effect KeyValueStore support over Bun.RedisClient
- Basic operations: `get`, `set`, `remove`, `clear`, `size`
- Automatic connection management with Effect Layer
- Full configuration support (host, port, auth, TLS, timeouts, scan batch size)
- Unit tests with FakeRedisClient
- Complete README documentation
- Advanced examples in EXAMPLES.md
- CI/CD with GitHub Actions (lint, type-check, test, build, release)
- PR workflows and Dependabot
- Contributing guide

### Features
- ✅ Compatible with Effect 3.x and @effect/platform
- ✅ Uses non-blocking SCAN operations
- ✅ Robust error handling with Effect types
- ✅ Strict TypeScript with complete types
- ✅ No additional dependencies (only Effect and Bun runtime)
- ✅ Optimized build with Bun bundler

### Known Limitations
- Only basic KeyValueStore operations (no Pub/Sub, Transactions, Scripts)
- No support for Redis Cluster or Sentinel
- `clear` operation may be slow with many keys
- `size` operation counts all keys (can be expensive)

## [1.0.0] - TBD

### Added
- Initial public release

---

## Types of Changes

- **Added** - New features
- **Changed** - Changes in existing functionality
- **Deprecated** - Features that will be removed
- **Removed** - Removed features
- **Fixed** - Bug fixes
- **Security** - Security vulnerabilities

[Unreleased]: https://github.com/OWNER/effect-bun-redis/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/OWNER/effect-bun-redis/releases/tag/v1.0.0

# @vortexdd/effect-redis-bun

Effect KeyValueStore implementation using Bun's native Redis client.

> **Note**: This library provides a **simple KeyValueStore interface** for Redis. It's designed for basic key-value operations (get, set, remove, clear, size) using Effect. For advanced Redis features like Pub/Sub, Streams, Transactions, or Cluster support, consider using [ioredis](https://github.com/redis/ioredis) or [node-redis](https://github.com/redis/node-redis) instead.

## Features

- 🚀 Native Bun Redis client integration (zero Redis dependencies)
- ⚡️ Built on [Effect](https://effect.website) for type-safe, composable operations
- 🔌 Implements `@effect/platform` KeyValueStore interface
- 🛡️ Full TypeScript support with strict types
- 🔒 Proper resource management with automatic connection cleanup
- 🧪 Tested with Bun + Effect CI checks
- 🔄 Automatic reconnection with exponential backoff
- 📦 Simple key-value operations: get, set, remove, clear, size
- 🌐 TLS/SSL support for secure connections
- ⚡ Automatic command pipelining for better performance

## Requirements

- Bun >= 1.2.22
- Redis Server >= 7.2 (or Valkey)
- Effect >= 3.1.2
- @effect/platform >= 0.52.3

## Important Notes & Limitations

### Bun Redis Client Capabilities

This library wraps Bun's native Redis client, which has the following characteristics:

**Supported Features:**
- ✅ Basic Redis operations (GET, SET, DEL, EXISTS, EXPIRE, TTL)
- ✅ Automatic connection management with reconnection
- ✅ TLS/SSL connections (rediss://)
- ✅ RESP3 protocol support
- ✅ Automatic command pipelining
- ✅ Connection lifecycle events
- ✅ Redis and Valkey compatibility

**Current Limitations:**
- ⚠️ **KeyValueStore Interface Only**: This library only exposes the KeyValueStore interface (get, set, remove, clear, size)
- ⚠️ **Limited Operations**: Advanced Redis features (lists, sorted sets, streams, etc.) are not exposed through this wrapper
- ⚠️ **No Transactions**: MULTI/EXEC transactions are not supported through KeyValueStore
- ⚠️ **No Pub/Sub through KeyValueStore**: Bun supports Pub/Sub, but this library intentionally exposes only KeyValueStore
- ⚠️ **No Cluster Support**: Redis Cluster is not supported by Bun's client
- ⚠️ **No Sentinel Support**: Redis Sentinel is not supported by Bun's client

### When to Use This Library

**Good For:**
- Simple key-value caching with Effect
- Session storage with Effect's resource management
- Replacing in-memory stores with Redis
- Projects already using Effect and Bun

**Not Suitable For:**
- Complex Redis operations (use ioredis or node-redis instead)
- Pub/Sub messaging patterns
- Redis Streams
- Redis Cluster deployments
- Advanced data structures (sorted sets, HyperLogLog, etc.)

If you need advanced Redis features, consider using [ioredis](https://github.com/redis/ioredis) or [node-redis](https://github.com/redis/node-redis) with Effect wrappers instead.

## Installation

```bash
bun add @vortexdd/effect-redis-bun
```

## Usage

### Basic Setup

```typescript
import { makeLayer } from "@vortexdd/effect-redis-bun";
import { KeyValueStore } from "@effect/platform";
import { Effect } from "effect";

// Create a Layer that provides KeyValueStore
const RedisLive = makeLayer({
  host: "localhost",
  port: 6379,
  password: "your-password", // optional
  database: 0, // optional, defaults to 0
  tls: false, // optional, defaults to false
  connectTimeoutMs: 5000, // optional, defaults to 5000
  scanBatchSize: 200, // optional, defaults to 200
});

// Use the KeyValueStore
const program = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;
  
  // Set a value
  yield* store.set("user:123", JSON.stringify({ name: "Alice" }));
  
  // Get a value
  const value = yield* store.get("user:123");
  console.log(value); // Option<string>
  
  // Remove a value
  yield* store.remove("user:123");
  
  // Clear all keys
  yield* store.clear;
  
  // Get total number of keys
  const count = yield* store.size;
  console.log(count);
});

// Run with the Redis layer
Effect.runPromise(program.pipe(Effect.provide(RedisLive)));
```

### Using with Custom Client

If you need more control, you can create the client separately:

```typescript
import {
  createClient,
  fromClient,
} from "@vortexdd/effect-redis-bun";

const client = createClient({
  host: "localhost",
  port: 6379,
});

await client.connect();

const store = fromClient(client, {
  scanBatchSize: 100,
});

// Use store with Effect...
```

### Using the Full Bun Client in Effect

If you need Redis commands beyond `KeyValueStore`, the library also exposes the full Bun client as a service:

```typescript
import {
  BunRedisClient,
  makeBunRedisClientLayer,
} from "@vortexdd/effect-redis-bun";
import { Effect } from "effect";

const BunRedisLive = makeBunRedisClientLayer({
  host: "localhost",
  port: 6379,
});

const program = Effect.gen(function* () {
  const client = yield* BunRedisClient;
  const pong = yield* Effect.tryPromise(() => client.send("PING", []));
  console.log(pong);
});

Effect.runPromise(program.pipe(Effect.provide(BunRedisLive)));
```

### Connection Configuration

```typescript
interface ConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly username?: string; // optional
  readonly password?: string; // optional
  readonly database?: number; // optional, defaults to 0
  readonly tls?: boolean; // optional, defaults to false
  readonly connectTimeoutMs?: number; // optional, defaults to 5000
  readonly scanBatchSize?: number; // optional, defaults to 200 (for clear/size operations)
}
```

### TLS/SSL Connection

```typescript
const RedisLive = makeLayer({
  host: "redis.example.com",
  port: 6380,
  username: "myuser",
  password: "mypassword",
  tls: true, // Enable TLS
  database: 0,
});
```

### With Valkey

This library works seamlessly with [Valkey](https://valkey.io/) (Redis fork):

```typescript
const ValkeyLive = makeLayer({
  host: "valkey.local",
  port: 6379,
  password: "valkey-password",
});
```

## Client Behavior & Implementation Details

### Connection Management

The Bun Redis client manages connections automatically:

- **Lazy Connection**: No connection is established until the first command is executed
- **Auto-Reconnection**: Automatically reconnects with exponential backoff (50ms → 2000ms max)
- **Connection Pooling**: Reuses the same connection for multiple commands
- **Graceful Cleanup**: Effect's resource management ensures connections are properly closed

```typescript
const program = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;
  // Connection opened on first command
  yield* store.set("key", "value");
  // Same connection reused
  yield* store.get("key");
  // Connection automatically closed when Effect scope ends
});
```

### Command Pipelining

Bun's Redis client automatically pipelines commands for optimal performance:

```typescript
// These commands are automatically pipelined
const program = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;
  
  // All three operations are sent together
  yield* Effect.all([
    store.set("key1", "value1"),
    store.set("key2", "value2"),
    store.set("key3", "value3"),
  ], { concurrency: "unbounded" });
});
```

### Scan-Based Operations

The `clear` and `size` operations use Redis `SCAN` to avoid blocking:

- **Non-blocking**: Uses cursor-based iteration instead of `KEYS *`
- **Configurable Batch Size**: Control memory usage with `scanBatchSize`
- **Production Safe**: Won't block Redis on large datasets

```typescript
const store = fromClient(client, {
  scanBatchSize: 100, // Scan 100 keys at a time
});

// Safe even with millions of keys
yield* store.clear;
```

### Type Handling

The KeyValueStore interface only supports string values:

```typescript
// ✅ Correct: Store serialized data
yield* store.set("user", JSON.stringify({ name: "Alice" }));
const raw = yield* store.get("user");
const user = Option.map(raw, JSON.parse);

// ❌ Won't work: Binary data
// KeyValueStore is string-only
```

### Error Handling

All operations return Effect types with typed errors:

```typescript
const program = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;
  yield* store.get("key");
}).pipe(
  Effect.catchTag("SystemError", (error) => {
    // Handles connection errors, timeouts, etc.
    console.error("Redis error:", error);
    return Effect.succeed(Option.none());
  })
);
```

Common error scenarios:
- **Connection Closed**: Server disconnection or network issues
- **Authentication Failed**: Invalid credentials
- **Timeout**: Operation took longer than `connectTimeoutMs`

### Underlying Bun Client Options

When creating a client, Bun applies these defaults:

```typescript
{
  connectionTimeout: 5000,       // 5 second connection timeout
  enableOfflineQueue: false,     // Don't queue commands when offline
  tls: false,                    // No TLS by default
}
```

The library uses `enableOfflineQueue: false` to fail fast on connection issues rather than queueing commands indefinitely.

## API

### `makeLayer(config: ConnectionConfig)`

Creates an Effect Layer that provides a `KeyValueStore` implementation. Handles connection lifecycle automatically using Effect's resource management.

**Returns:** `Layer<KeyValueStore, PlatformError>`

### `makeKeyValueStoreLayer(config: ConnectionConfig)`

Explicit name for `makeLayer`. Creates a `KeyValueStore` layer backed by Bun Redis.

**Returns:** `Layer<KeyValueStore, PlatformError>`

### `makeBunRedisClientLayer(config: ConnectionConfig)`

Creates an Effect Layer that provides Bun's full `RedisClient`.

**Returns:** `Layer<BunRedisClient, PlatformError>`

### `layerFromBunRedisClient(options?)`

Creates a `KeyValueStore` layer from an already-provided `BunRedisClient` service.

**Returns:** `Layer<KeyValueStore, never, BunRedisClient>`

### `createClient(config: ConnectionConfig)`

Creates a raw Bun Redis client instance.

**Returns:** `BunRedisClient`

### `fromClient(client: RedisClient, options?)`

Creates a KeyValueStore from an existing Redis client.

**Options:**
- `scanBatchSize?: number` - Number of keys to scan per batch (default: 200)

**Returns:** `KeyValueStore`

### `buildUrl(config: ConnectionConfig)`

Utility function to build a Redis connection URL from config.

**Returns:** `string` (e.g., `redis://localhost:6379/0`)

## Error Handling

All operations return Effect types and use `@effect/platform`'s `PlatformError` for error handling:

```typescript
import { Effect } from "effect";

const program = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;
  const value = yield* store.get("key");
}).pipe(
  Effect.catchTag("SystemError", (error) => {
    console.error("Redis operation failed:", error);
    return Effect.succeed(null);
  })
);
```

## Practical Examples

### Caching Pattern

```typescript
import { Effect, Option } from "effect";
import { KeyValueStore } from "@effect/platform";

const getUserCached = (userId: string) =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    const cacheKey = `user:${userId}`;

    // Try cache first
    const cached = yield* store.get(cacheKey);
    if (Option.isSome(cached)) {
      return JSON.parse(cached.value);
    }

    // Cache miss - fetch from database
    const user = yield* fetchUserFromDatabase(userId);

    // Store in cache (as JSON string)
    yield* store.set(cacheKey, JSON.stringify(user));

    return user;
  });
```

### Session Storage

```typescript
interface Session {
  userId: string;
  createdAt: number;
  data: Record<string, unknown>;
}

const createSession = (userId: string, data: Record<string, unknown>) =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    const sessionId = crypto.randomUUID();
    const session: Session = {
      userId,
      createdAt: Date.now(),
      data,
    };

    yield* store.set(`session:${sessionId}`, JSON.stringify(session));
    return sessionId;
  });

const getSession = (sessionId: string) =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    const raw = yield* store.get(`session:${sessionId}`);

    return Option.map(raw, (value) => JSON.parse(value) as Session);
  });

const deleteSession = (sessionId: string) =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    yield* store.remove(`session:${sessionId}`);
  });
```

### Multiple Stores with Different Configs

```typescript
import { Context, Layer } from "effect";

// Define separate services
class CacheStore extends Context.Tag("CacheStore")<
  CacheStore,
  KeyValueStore.KeyValueStore
>() {}

class SessionStore extends Context.Tag("SessionStore")<
  SessionStore,
  KeyValueStore.KeyValueStore
>() {}

// Create separate layers with different Redis configs
const CacheLive = makeLayer({
  host: "cache.redis.local",
  port: 6379,
  database: 0,
}).pipe(Layer.provide(CacheStore));

const SessionLive = makeLayer({
  host: "sessions.redis.local",
  port: 6379,
  database: 1,
}).pipe(Layer.provide(SessionStore));

// Use both stores in your program
const program = Effect.gen(function* () {
  const cache = yield* CacheStore;
  const sessions = yield* SessionStore;

  yield* cache.set("key", "cached-value");
  yield* sessions.set("session:123", "session-data");
});
```

### Testing with Fake Store

For testing, you can use Effect's test utilities:

```typescript
import { it, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { KeyValueStore } from "@effect/platform";

it("should cache user data", async () => {
  // Use an in-memory store for testing
  const TestStore = Layer.succeed(
    KeyValueStore.KeyValueStore,
    KeyValueStore.make({
      get: (key) => Effect.succeed(Option.none()),
      set: (key, value) => Effect.void,
      remove: (key) => Effect.void,
      clear: Effect.void,
      size: Effect.succeed(0),
    })
  );

  const result = await Effect.runPromise(
    getUserCached("123").pipe(Effect.provide(TestStore))
  );

  expect(result).toBeDefined();
});
```

## Best Practices

### 1. Always Serialize Complex Data

```typescript
// ✅ Good: Serialize objects
const user = { id: 1, name: "Alice" };
yield* store.set("user:1", JSON.stringify(user));

// ❌ Bad: Don't store objects directly
yield* store.set("user:1", user.toString()); // "[object Object]"
```

### 2. Use Meaningful Key Prefixes

```typescript
// ✅ Good: Clear, hierarchical keys
yield* store.set("user:123:profile", "...");
yield* store.set("session:abc:data", "...");
yield* store.set("cache:posts:page:1", "...");

// ❌ Bad: Unclear or flat keys
yield* store.set("u123", "...");
yield* store.set("data", "...");
```

### 3. Handle Option Types Properly

```typescript
// ✅ Good: Check if value exists
const result = yield* store.get("key");
if (Option.isSome(result)) {
  console.log(result.value);
} else {
  console.log("Key not found");
}

// ✅ Good: Use Option.getOrElse
const value = pipe(
  yield* store.get("key"),
  Option.getOrElse(() => "default")
);

// ❌ Bad: Don't assume value exists
const result = yield* store.get("key");
console.log(result.value); // May be undefined
```

### 4. Be Careful with Clear Operations

```typescript
// ⚠️ Warning: clear() deletes ALL keys in the database
yield* store.clear;

// Better: Use key prefixes and manual cleanup for scoped deletion
const keys = ["user:1", "user:2", "user:3"];
yield* Effect.all(
  keys.map(key => store.remove(key)),
  { concurrency: "unbounded" }
);
```

### 5. Use Layers for Dependency Injection

```typescript
// ✅ Good: Use layers for testability
const program = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;
  yield* store.set("key", "value");
});

// Easy to swap implementations
Effect.runPromise(program.pipe(Effect.provide(RedisLive)));
Effect.runPromise(program.pipe(Effect.provide(TestStoreLive)));

// ❌ Bad: Create clients directly
const client = createClient({ ... });
await client.connect();
// Harder to test, manual cleanup required
```

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Type check
bun run check-types

# Lint
bun run lint

# Format
bun run format

# Build for production
bun run build
```

## Testing

The library includes comprehensive tests using Bun's built-in test runner:

```bash
bun test
```

## Bun Redis Client Limitations (Upstream)

These limitations come from Bun's Redis client itself, not this library:

### Not Supported

- **Redis Cluster**: Multi-node Redis clusters are not supported
- **Redis Sentinel**: High-availability setups with Sentinel are not supported
- **Transactions**: MULTI/EXEC transactions require using raw commands (not available through KeyValueStore)
- **Pub/Sub**: Redis Pub/Sub messaging (available in Bun 1.2.23+ but not exposed in this library)
- **Streams**: Redis Streams are not available
- **Modules**: Redis modules (RedisJSON, RedisGraph, etc.) are not supported

### Performance Characteristics

- **Pipelining**: Automatically enabled for most commands (improves throughput)
- **Connection Pooling**: Single connection per client (no connection pooling)
- **Offline Queue**: Disabled in this library (`enableOfflineQueue: false`) for fail-fast behavior
- **Reconnection**: Exponential backoff with max 10 retries by default

### When to Consider Alternatives

Consider using [ioredis](https://github.com/redis/ioredis) or [node-redis](https://github.com/redis/node-redis) if you need:

- Redis Cluster support
- Redis Sentinel for high availability
- Transaction support (MULTI/EXEC)
- Lua scripting
- Connection pooling
- More mature, battle-tested client
- Advanced features like Pub/Sub, Streams, or modules

For simple key-value operations with Effect, this library is perfect. For complex Redis use cases, use a more feature-complete client.

## Why Bun's Redis Client?

Bun includes a native, high-performance Redis client that:
- Has zero npm dependencies
- Is written in Zig for maximum performance
- Integrates seamlessly with Bun's runtime
- Supports Redis and Valkey out of the box
- Perfect for simple key-value storage needs

## FAQ

### Q: Can I use this with Node.js?

No, this library requires Bun's native Redis client which is not available in Node.js. For Node.js, use [ioredis](https://github.com/redis/ioredis) or [node-redis](https://github.com/redis/node-redis).

### Q: Does this support Redis Cluster?

No, Bun's Redis client does not support Redis Cluster. You'll need to use ioredis or node-redis for cluster deployments.

### Q: Can I use Redis transactions (MULTI/EXEC)?

Not through the KeyValueStore interface. Bun's client supports raw transaction commands through `.send()`, but this library only exposes the KeyValueStore interface.

### Q: How do I store binary data?

The KeyValueStore interface only supports string values. To store binary data, encode it as a base64 string first:

```typescript
const buffer = new Uint8Array([1, 2, 3, 4]);
const encoded = Buffer.from(buffer).toString("base64");
yield* store.set("binary-key", encoded);

const value = yield* store.get("binary-key");
const decoded = Option.map(value, v => Buffer.from(v, "base64"));
```

### Q: Why does `clear()` delete all keys?

Because the KeyValueStore interface doesn't support namespacing. The library uses `SCAN` to find all keys in the database and deletes them. If you need scoped deletion, use key prefixes and delete manually:

```typescript
// Instead of store.clear, manually delete keys with same prefix
const keysToDelete = ["user:1", "user:2", "user:3"];
yield* Effect.all(
  keysToDelete.map(key => store.remove(key)),
  { concurrency: "unbounded" }
);
```

### Q: Is this production-ready?

Yes, for simple key-value use cases. This library is well-tested and uses Effect's resource management for proper cleanup. However, for mission-critical production systems with complex Redis needs, consider more mature clients like ioredis.

### Q: What's the performance compared to ioredis?

Bun's native client is generally faster for simple operations due to being written in Zig. However, ioredis has more optimizations for complex scenarios and better connection pooling. For most use cases, the difference is negligible.

### Q: Can I use multiple Redis databases?

Yes, specify the `database` number in the config:

```typescript
const db0 = makeLayer({ host: "localhost", port: 6379, database: 0 });
const db1 = makeLayer({ host: "localhost", port: 6379, database: 1 });
```

### Q: How do I handle connection errors?

All operations return Effect types. Use Effect's error handling:

```typescript
const program = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;
  yield* store.get("key");
}).pipe(
  Effect.catchTag("SystemError", (error) => {
    console.error("Redis error:", error);
    return Effect.succeed(Option.none());
  }),
  Effect.catchAll((error) => {
    console.error("Unexpected error:", error);
    return Effect.succeed(Option.none());
  })
);
```

## License

MIT

## Contributing

Contributions are welcome! Please read our [Contributing Guide](./CONTRIBUTING.md) for details on:

- Development setup and requirements
- Code standards and conventions
- Testing requirements
- Pull request process
- Commit message format (Conventional Commits)

Before contributing:
1. Read the [Code of Conduct](./CODE_OF_CONDUCT.md)
2. Check existing [issues](../../issues) and [pull requests](../../pulls)
3. Follow the coding style (Biome config included)
4. Write tests for new features
5. Update documentation as needed

For security vulnerabilities, please see our [Security Policy](./SECURITY.md).

## Project Structure

```
effect-redis-bun/
├── src/
│   ├── index.ts           # Main implementation
│   └── index.test.ts      # Test suite
├── dist/                  # Build output
├── .github/
│   ├── workflows/         # CI/CD pipelines
│   │   ├── ci.yml         # Main CI workflow
│   │   ├── pr-checks.yml  # PR validation
│   │   └── release.yml    # Release automation
│   ├── ISSUE_TEMPLATE/    # Issue templates
│   ├── dependabot.yml     # Dependency updates
│   └── FUNDING.yml        # Sponsorship config
├── .vscode/               # VSCode settings
│   ├── settings.json      # Editor config
│   ├── extensions.json    # Recommended extensions
│   └── launch.json        # Debug configurations
├── README.md              # Main documentation
├── EXAMPLES.md            # Advanced usage patterns
├── CONTRIBUTING.md        # Contribution guide
├── CODE_OF_CONDUCT.md     # Community guidelines
├── SECURITY.md            # Security policy
├── LICENSE                # MIT License
├── package.json           # Package configuration
├── tsconfig.json          # TypeScript config
├── biome.json             # Linter/formatter config
├── renovate.json          # Renovate config (alternative to Dependabot)
└── .editorconfig          # Editor consistency
```

## Links

- [Advanced Examples](./EXAMPLES.md) - More complex usage patterns
- [Effect Documentation](https://effect.website)
- [Bun Redis Documentation](https://bun.sh/docs/api/redis)
- [@effect/platform KeyValueStore](https://effect.website/docs/guides/platform/keyvaluestore)

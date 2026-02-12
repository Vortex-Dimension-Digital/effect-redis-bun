# Advanced Examples

This document provides advanced usage examples for `@vortexdd/effect-redis-bun`.

## Table of Contents

- [Rate Limiting](#rate-limiting)
- [Distributed Locking (Simple)](#distributed-locking-simple)
- [Cache-Aside Pattern](#cache-aside-pattern)
- [Multiple Environment Support](#multiple-environment-support)
- [Graceful Shutdown](#graceful-shutdown)
- [Retry Strategies](#retry-strategies)
- [Monitoring and Metrics](#monitoring-and-metrics)

## Rate Limiting

Implement a simple rate limiter using Redis counters:

```typescript
import { Effect, Option } from "effect";
import { KeyValueStore } from "@effect/platform";

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

const checkRateLimit = (
  identifier: string,
  limit: number,
  windowSeconds: number
): Effect.Effect<RateLimitResult, never, KeyValueStore.KeyValueStore> =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    const key = `ratelimit:${identifier}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;

    // Get current count
    const currentStr = yield* store.get(key);
    const current = Option.match(currentStr, {
      onNone: () => 0,
      onSome: (val) => Number.parseInt(val, 10),
    });

    const newCount = current + 1;
    const allowed = newCount <= limit;

    if (allowed) {
      // Increment counter
      yield* store.set(key, newCount.toString());
    }

    const resetAt = Math.ceil(Date.now() / 1000 / windowSeconds) * windowSeconds;

    return {
      allowed,
      remaining: Math.max(0, limit - newCount),
      resetAt,
    };
  });

// Usage
const program = Effect.gen(function* () {
  const result = yield* checkRateLimit("user:123", 100, 3600); // 100 requests per hour

  if (!result.allowed) {
    console.log(`Rate limit exceeded. Try again at ${new Date(result.resetAt * 1000)}`);
  }
});
```

## Distributed Locking (Simple)

A simple distributed lock implementation (note: not suitable for critical operations):

```typescript
import { Effect, Option } from "effect";
import { KeyValueStore } from "@effect/platform";

const acquireLock = (
  lockKey: string,
  ttlSeconds: number
): Effect.Effect<boolean, never, KeyValueStore.KeyValueStore> =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    const lockId = crypto.randomUUID();
    const key = `lock:${lockKey}`;

    // Check if lock exists
    const existing = yield* store.get(key);

    if (Option.isSome(existing)) {
      return false; // Lock already held
    }

    // Acquire lock
    yield* store.set(key, lockId);
    return true;
  });

const releaseLock = (
  lockKey: string
): Effect.Effect<void, never, KeyValueStore.KeyValueStore> =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    yield* store.remove(`lock:${lockKey}`);
  });

// Usage with automatic cleanup
const withLock = <R, E, A>(
  lockKey: string,
  ttlSeconds: number,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | { readonly _tag: "LockAcquisitionFailed" }, R | KeyValueStore.KeyValueStore> =>
  Effect.gen(function* () {
    // Try to acquire lock
    const acquired = yield* acquireLock(lockKey, ttlSeconds);

    if (!acquired) {
      return yield* Effect.fail({ _tag: "LockAcquisitionFailed" as const });
    }

    // Run effect with guaranteed lock release
    return yield* Effect.ensuring(effect, releaseLock(lockKey));
  });

// Usage
const criticalSection = Effect.gen(function* () {
  console.log("Executing critical section");
  yield* Effect.sleep("1 second");
  return "done";
});

const program = withLock("my-resource", 30, criticalSection).pipe(
  Effect.catchTag("LockAcquisitionFailed", () =>
    Effect.sync(() => console.log("Could not acquire lock"))
  )
);
```

## Cache-Aside Pattern

Implement the cache-aside pattern with TTL:

```typescript
import { Effect, Option, Duration } from "effect";
import { KeyValueStore } from "@effect/platform";

interface CacheOptions {
  readonly ttlSeconds?: number;
  readonly keyPrefix?: string;
}

const cached = <R, E, A>(
  key: string,
  fetchFn: Effect.Effect<A, E, R>,
  options: CacheOptions = {}
): Effect.Effect<A, E, R | KeyValueStore.KeyValueStore> => {
  const { ttlSeconds, keyPrefix = "cache" } = options;
  const cacheKey = `${keyPrefix}:${key}`;

  return Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;

    // Check cache
    const cached = yield* store.get(cacheKey);

    if (Option.isSome(cached)) {
      try {
        return JSON.parse(cached.value) as A;
      } catch {
        // Invalid JSON, treat as cache miss
      }
    }

    // Cache miss - fetch data
    const data = yield* fetchFn;

    // Store in cache
    yield* store.set(cacheKey, JSON.stringify(data));

    return data;
  });
};

// Usage
const getUser = (userId: string) =>
  cached(
    `user:${userId}`,
    Effect.promise(() =>
      fetch(`https://api.example.com/users/${userId}`).then((r) => r.json())
    ),
    { ttlSeconds: 300, keyPrefix: "users" }
  );
```

## Multiple Environment Support

Configure different Redis instances per environment:

```typescript
import { Config, Effect, Layer } from "effect";
import { KeyValueStore } from "@effect/platform";
import { makeLayer } from "@vortexdd/effect-redis-bun";

// Read configuration from environment
const RedisConfigLive = Layer.effect(
  Config.Config,
  Effect.gen(function* () {
    const host = yield* Config.string("REDIS_HOST").pipe(
      Config.withDefault("localhost")
    );
    const port = yield* Config.number("REDIS_PORT").pipe(
      Config.withDefault(6379)
    );
    const password = yield* Config.secret("REDIS_PASSWORD").pipe(
      Config.optional
    );
    const database = yield* Config.number("REDIS_DB").pipe(
      Config.withDefault(0)
    );
    const tls = yield* Config.boolean("REDIS_TLS").pipe(
      Config.withDefault(false)
    );

    return {
      host,
      port,
      password: password ? password.value : undefined,
      database,
      tls,
    };
  })
);

// Create Redis layer from config
const RedisLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const config = yield* Config.Config;
    return makeLayer(config);
  })
).pipe(Layer.provide(RedisConfigLive));

// Usage with environment variables
// REDIS_HOST=prod.redis.com REDIS_TLS=true bun run app.ts
const program = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;
  yield* store.set("key", "value");
});

Effect.runPromise(program.pipe(Effect.provide(RedisLive)));
```

## Graceful Shutdown

Handle cleanup on application shutdown:

```typescript
import { Effect, Exit } from "effect";
import { KeyValueStore } from "@effect/platform";
import { makeLayer } from "@vortexdd/effect-redis-bun";

const RedisLive = makeLayer({
  host: "localhost",
  port: 6379,
});

const main = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;

  // Your application logic
  yield* store.set("app:status", "running");

  // Simulate long-running process
  yield* Effect.sleep("10 seconds");

  yield* store.set("app:status", "stopped");
});

// Handle process signals
const program = main.pipe(
  Effect.ensuring(
    Effect.sync(() => console.log("Cleaning up Redis connection..."))
  ),
  Effect.provide(RedisLive)
);

// Run with cleanup
Effect.runPromiseExit(program).then((exit) => {
  if (Exit.isFailure(exit)) {
    console.error("Application failed:", exit.cause);
    process.exit(1);
  } else {
    console.log("Application exited successfully");
    process.exit(0);
  }
});

// Handle SIGINT/SIGTERM
process.on("SIGINT", () => {
  console.log("Received SIGINT, shutting down...");
  // Effect cleanup will happen automatically
});
```

## Retry Strategies

Implement retry logic for Redis operations:

```typescript
import { Effect, Schedule } from "effect";
import { KeyValueStore } from "@effect/platform";

const withRetry = <R, E, A>(
  effect: Effect.Effect<A, E, R>,
  maxRetries = 3
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.retry(
      Schedule.exponential("100 millis").pipe(
        Schedule.compose(Schedule.recurs(maxRetries))
      )
    ),
    Effect.tapError((error) =>
      Effect.sync(() => console.error("Retry failed:", error))
    )
  );

// Usage
const program = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;

  // This will retry up to 3 times with exponential backoff
  yield* withRetry(store.set("key", "value"));

  const value = yield* withRetry(store.get("key"));
  return value;
});
```

## Monitoring and Metrics

Track Redis operations for monitoring:

```typescript
import { Effect, Metric } from "effect";
import { KeyValueStore } from "@effect/platform";

// Define metrics
const redisOpsCounter = Metric.counter("redis_operations_total", {
  description: "Total number of Redis operations",
});

const redisOpsDuration = Metric.histogram("redis_operations_duration_ms", {
  description: "Duration of Redis operations in milliseconds",
});

// Wrapper for instrumented operations
const instrumentedGet = (key: string) =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    const start = Date.now();

    const result = yield* store.get(key).pipe(
      Effect.tap(() => Metric.increment(redisOpsCounter)),
      Effect.tap(() =>
        Metric.update(redisOpsDuration, Date.now() - start)
      )
    );

    return result;
  });

const instrumentedSet = (key: string, value: string) =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    const start = Date.now();

    yield* store.set(key, value).pipe(
      Effect.tap(() => Metric.increment(redisOpsCounter)),
      Effect.tap(() =>
        Metric.update(redisOpsDuration, Date.now() - start)
      )
    );
  });

// Create a service that exposes instrumented operations
class InstrumentedRedisStore extends Effect.Service<InstrumentedRedisStore>()("InstrumentedRedisStore", {
  effect: Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;

    return {
      get: (key: string) => instrumentedGet(key),
      set: (key: string, value: string) => instrumentedSet(key, value),
    };
  }),
}) {}

// Usage
const program = Effect.gen(function* () {
  const redis = yield* InstrumentedRedisStore;

  yield* redis.set("key", "value");
  const value = yield* redis.get("key");

  // Print metrics
  const metrics = yield* Metric.value(redisOpsCounter);
  console.log("Total operations:", metrics);
});
```

## Batch Operations

Efficiently process multiple keys:

```typescript
import { Effect, Chunk } from "effect";
import { KeyValueStore } from "@effect/platform";

const batchGet = (keys: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;

    // Fetch all keys in parallel
    const results = yield* Effect.all(
      keys.map((key) => store.get(key)),
      { concurrency: "unbounded" }
    );

    // Combine keys with their values
    return keys.map((key, index) => ({
      key,
      value: results[index],
    }));
  });

const batchSet = (entries: ReadonlyArray<{ key: string; value: string }>) =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;

    // Set all keys in parallel
    yield* Effect.all(
      entries.map(({ key, value }) => store.set(key, value)),
      { concurrency: "unbounded" }
    );
  });

// Usage
const program = Effect.gen(function* () {
  // Batch write
  yield* batchSet([
    { key: "user:1", value: JSON.stringify({ name: "Alice" }) },
    { key: "user:2", value: JSON.stringify({ name: "Bob" }) },
    { key: "user:3", value: JSON.stringify({ name: "Charlie" }) },
  ]);

  // Batch read
  const users = yield* batchGet(["user:1", "user:2", "user:3"]);
  console.log(users);
});
```

## Testing Patterns

Create testable Redis-dependent code:

```typescript
import { Effect, Layer, Context } from "effect";
import { KeyValueStore } from "@effect/platform";

// Define your domain service
class UserRepository extends Context.Tag("UserRepository")<
  UserRepository,
  {
    readonly saveUser: (id: string, user: User) => Effect.Effect<void>;
    readonly getUser: (id: string) => Effect.Effect<Option.Option<User>>;
  }
>() {}

// Real implementation using Redis
const UserRepositoryLive = Layer.effect(
  UserRepository,
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;

    return {
      saveUser: (id, user) =>
        store.set(`user:${id}`, JSON.stringify(user)),
      getUser: (id) =>
        Effect.map(store.get(`user:${id}`), Option.map(JSON.parse)),
    };
  })
);

// Test implementation using in-memory Map
const UserRepositoryTest = Layer.succeed(UserRepository, {
  saveUser: (id, user) =>
    Effect.sync(() => testData.set(id, user)),
  getUser: (id) =>
    Effect.sync(() => Option.fromNullable(testData.get(id))),
});

// Your business logic
const program = Effect.gen(function* () {
  const repo = yield* UserRepository;
  yield* repo.saveUser("123", { name: "Alice" });
  const user = yield* repo.getUser("123");
  return user;
});

// Run with real Redis
Effect.runPromise(program.pipe(Effect.provide(UserRepositoryLive)));

// Run with test implementation
Effect.runPromise(program.pipe(Effect.provide(UserRepositoryTest)));
```

## More Examples

For more examples and use cases, check out:

- [Effect Documentation](https://effect.website)
- [@effect/platform KeyValueStore](https://effect.website/docs/guides/platform/keyvaluestore)
- [Bun Redis Documentation](https://bun.sh/docs/api/redis)

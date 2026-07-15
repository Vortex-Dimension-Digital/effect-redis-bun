# @vortexdd/effect-redis-bun

Effect-first Redis integration for Bun.

The library exposes two layers of abstraction:

- `Redis`: an Effect service with Redis operations wrapped in `Effect`
- `KeyValueStore`: a higher-level store built on top of that service

This package is intentionally scoped to Bun's native Redis client.

## Requirements

- Bun >= 1.2.22
- Redis Server >= 7.2 or Valkey
- Effect >= 3.1.2
- `@effect/platform` >= 0.52.3

## Installation

```bash
bun add @vortexdd/effect-redis-bun
```

## What It Exposes

### `Redis`

The `Redis` service exposes Effect-wrapped operations for the minimum low-level surface:

- `connect`
- `close`
- `send`
- `get`
- `getBuffer`
- `set`
- `del`
- `scan`

### `KeyValueStore`

The `KeyValueStore` adapter is built from the `Redis` service and supports:

- `get`
- `getUint8Array`
- `set`
- `remove`
- `clear`
- `size`

## Usage

### KeyValueStore Layer

```ts
import { KeyValueStore } from "@effect/platform";
import { Effect } from "effect";
import { makeLayer } from "@vortexdd/effect-redis-bun";

const RedisStoreLive = makeLayer({
  host: "localhost",
  port: 6379,
  database: 0,
  scanBatchSize: 200,
});

const program = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;

  yield* store.set("user:123", JSON.stringify({ name: "Alice" }));
  const value = yield* store.get("user:123");
  yield* store.remove("user:123");

  return value;
});

await Effect.runPromise(program.pipe(Effect.provide(RedisStoreLive)));
```

### Redis Service Layer

```ts
import { Effect } from "effect";
import { makeRedisLayer, Redis } from "@vortexdd/effect-redis-bun";

const RedisLive = makeRedisLayer({
  host: "localhost",
  port: 6379,
});

const program = Effect.gen(function* () {
  const redis = yield* Redis;

  yield* redis.connect;
  yield* redis.set("raw:key", "value");
  const value = yield* redis.get("raw:key");
  const scan = yield* redis.scan("0", "MATCH", "raw:*", "COUNT", 50);
  yield* redis.del("raw:key");
  yield* redis.close;

  return { value, scan };
});

await Effect.runPromise(program.pipe(Effect.provide(RedisLive)));
```

### Build from an Existing Bun Client

```ts
import { RedisClient } from "bun";
import { fromClient, fromClientService } from "@vortexdd/effect-redis-bun";

const client = new RedisClient("redis://localhost:6379/0", {
  enableOfflineQueue: false,
});

const redis = fromClientService(client);
const store = fromClient(client, {
  scanBatchSize: 100,
});
```

### Build a KeyValueStore from an Existing Redis Service

```ts
import { KeyValueStore } from "@effect/platform";
import { Effect, Layer } from "effect";
import {
  fromClientService,
  layerFromRedis,
  Redis,
} from "@vortexdd/effect-redis-bun";

const program = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;
  yield* store.set("cache:key", "value");
  return yield* store.get("cache:key");
}).pipe(
  Effect.provide(
    Layer.provide(
      layerFromRedis({ scanBatchSize: 50 }),
      Layer.succeed(Redis, fromClientService(client))
    )
  )
);
```

## API

### `Redis`

Effect service tag for the low-level Redis API.

### `buildUrl(config: ConnectionConfig)`

Builds a Redis URL from `ConnectionConfig`.

### `createClient(config: ConnectionConfig)`

Creates a Bun `RedisClient` instance.

### `fromClientService(client: RedisClient)`

Builds a `Redis` service from an existing Bun client.

### `fromService(redis: RedisService, options?)`

Builds a `KeyValueStore` from an existing `Redis` service.

### `fromClient(client: RedisClient, options?)`

Builds a `KeyValueStore` directly from a Bun client.

### `makeRedisLayer(config: ConnectionConfig)`

Creates a scoped layer that provides `Redis`.

### `layerFromRedis(options?)`

Creates a `KeyValueStore` layer from an already-provided `Redis` service.

### `makeKeyValueStoreLayer(config: ConnectionConfig)`

Creates a scoped layer that provides `KeyValueStore`.

### `makeLayer(config: ConnectionConfig)`

Alias of `makeKeyValueStoreLayer(config)`.

## ConnectionConfig

```ts
interface ConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  readonly database?: number;
  readonly tls?: boolean;
  readonly connectTimeoutMs?: number;
  readonly scanBatchSize?: number;
}
```

## Error Handling

Every fallible `Redis` operation fails with a typed `RedisError`:

- **`RedisCommandError`** — the server rejected the command with an error reply. Carries `command`, the parsed reply `code` (`"ERR"`, `"WRONGTYPE"`, `"NOAUTH"`, `"MOVED"`, ...), the reply `message`, and the original error as `cause`.
- **`RedisConnectionError`** — the command never got a server reply (connection refused/closed, timeout, authentication, client-side, or transport failure). Carries `command`, the underlying client `code` when available, `message`, and `cause`. `connect` always uses this error type.

```ts
import { Effect } from "effect";
import { Redis } from "@vortexdd/effect-redis-bun";

const readString = (key: string) =>
  Effect.gen(function* () {
    const redis = yield* Redis;
    return yield* redis.get(key);
  }).pipe(
    Effect.catchTag("RedisCommandError", (error) =>
      error.code === "WRONGTYPE" ? Effect.succeed(null) : Effect.fail(error),
    ),
  );
```

The `KeyValueStore` adapter and its layer keep their platform contract and fail with `PlatformError`; the underlying `RedisError` is preserved as `cause`.

## Notes

- `makeRedisLayer` creates a ready-to-use service and closes the client when the layer scope ends.
- `clear` uses `SCAN` in batches and avoids `KEYS *`.
- `size` uses `DBSIZE` instead of scanning the full keyspace.
- `scan` falls back to `send("SCAN", ...)` if the Bun client version does not expose `scan` directly.

## Breaking Change From 2.x

Version `3.x` replaces `PlatformError` with typed errors on the `Redis` service:

- Redis commands fail with `RedisError` (`RedisCommandError | RedisConnectionError`) instead of `PlatformError.PlatformError`; `connect` and `makeRedisLayer` fail more specifically with `RedisConnectionError`.
- `KeyValueStore` and `makeKeyValueStoreLayer` are unaffected — they still fail with `PlatformError`, now carrying the `RedisError` as `cause`.
- If you matched on `SystemError` or dug through `error.cause` to read server error messages, switch to `Effect.catchTag("RedisCommandError", ...)` and the `code` field.

## Breaking Change From 1.x

Version `2.x` removes the public service that exposed the raw Bun client directly.

If you were using the old raw-client layer, migrate to one of these:

- `makeRedisLayer(config)` if you want low-level Redis commands as `Effect`
- `makeLayer(config)` or `makeKeyValueStoreLayer(config)` if you want `KeyValueStore`
- `fromClientService(client)` if you already own the Bun client instance

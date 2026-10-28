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

  yield* redis.set("raw:key", "value", "EX", 60);
  const value = yield* redis.get("raw:key");
  const scan = yield* redis.scan("0", "MATCH", "raw:*", "COUNT", 50);
  const counter = yield* redis.send("INCR", ["raw:counter"]);
  yield* redis.del("raw:key", "raw:counter");

  return { value, scan, counter };
});

await Effect.runPromise(program.pipe(Effect.provide(RedisLive)));
```

The layer connects when it is built and closes the client when its scope ends, so the
program does not call `connect` or `close` itself.

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

A client you build yourself does not get the automatic reconnection of `makeRedisLayer`.
Add it with `keepConnected` inside a scope:

```ts
import { Effect } from "effect";
import { keepConnected } from "@vortexdd/effect-redis-bun";

// `client` and `redis` from the example above
const program = Effect.scoped(
  Effect.gen(function* () {
    yield* redis.connect;
    const reconnect = yield* keepConnected(client);
    // ... use redis / store ...
    yield* reconnect.stop; // before an explicit close
    yield* redis.close;
  }),
);
```

### Build a KeyValueStore from an Existing Redis Service

```ts
import { KeyValueStore } from "@effect/platform";
import { RedisClient } from "bun";
import { Effect, Layer } from "effect";
import {
  fromClientService,
  layerFromRedis,
  Redis,
} from "@vortexdd/effect-redis-bun";

const client = new RedisClient("redis://localhost:6379/0", {
  enableOfflineQueue: false,
});
await client.connect();

const program = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;
  yield* store.set("cache:key", "value");
  return yield* store.get("cache:key");
}).pipe(
  Effect.provide(
    Layer.provide(
      layerFromRedis({ scanBatchSize: 50 }),
      Layer.succeed(Redis, fromClientService(client)),
    ),
  ),
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

Creates a scoped layer that provides `Redis`. The client reconnects on its own after an
outage longer than Bun's built-in retries (see `keepConnected`).

### `keepConnected(client, options?)`

Keeps a Bun client connected after Bun gives up reconnecting. Bun retries a dropped
connection only `maxRetries` times (about 30 seconds by default); after that the client stays
closed even once the server is back, and every command fails with
`ERR_REDIS_CONNECTION_CLOSED`. `keepConnected` hooks `onclose` and keeps calling `connect()`
with a capped exponential backoff (`initialDelayMs`, default 100; `maxDelayMs`, default 5000).

It returns `{ stop }` and runs in a fiber tied to the current scope. Bun fires `onclose` the
same way for an explicit `close()`, so run `stop` before closing the client on purpose.
`makeRedisLayer` already does this, both for the service's `close` and when the layer is
released.

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

- `makeRedisLayer` creates a ready-to-use service, reconnects it after long outages and closes the client when the layer scope ends.
- `KeyValueStore` stores `Uint8Array` values as raw bytes, and `getUint8Array` returns the stored bytes of any value (a string's UTF-8 bytes).
- `clear` uses `SCAN` in batches and avoids `KEYS *`. `clear` and `size` act on the whole selected database.
- `size` uses `DBSIZE` instead of scanning the full keyspace.
- `scan` falls back to `send("SCAN", ...)` if the Bun client version does not expose `scan` directly.

## Upgrading to 3.1

Before 3.1.0, with `@effect/platform` 0.63 or newer, the `KeyValueStore` adapter stored `Uint8Array`
values as base64 text and `getUint8Array` base64-decoded whatever it read. It now stores and reads raw
bytes, so other Redis clients see the same bytes. String values are unaffected.

Binary values written through `KeyValueStore.set` by an earlier version are still base64 text in Redis:
`getUint8Array` now returns those base64 characters. Rewrite them, or decode them once, for example with
`Encoding.decodeBase64` from `effect` on the result of `store.get(key)`.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Development uses Bun pinned with [mise](https://mise.jdx.dev),
`bun fmt`, [oxlint](https://oxc.rs/docs/guide/usage/linter) and [tsrs](https://github.com/oxc-project/tsrs).

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

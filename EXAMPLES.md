# Examples

Each example is self-contained and type-checks against the published package. They use the low-level
`Redis` service when they need Redis features (expiry, atomic scripts) and the `KeyValueStore` when a
plain key/value store is enough.

- [Configuration from the environment](#configuration-from-the-environment)
- [Typed values with a schema](#typed-values-with-a-schema)
- [Cache-aside with a TTL](#cache-aside-with-a-ttl)
- [Rate limiting](#rate-limiting)
- [Distributed lock](#distributed-lock)
- [Error handling and retries](#error-handling-and-retries)
- [Many keys at once](#many-keys-at-once)
- [Testing](#testing)
- [Graceful shutdown](#graceful-shutdown)

## Configuration from the environment

Read the connection settings with `Config` and build the layer from them:

```ts
import { KeyValueStore } from "@effect/platform";
import { makeLayer } from "@vortexdd/effect-redis-bun";
import { Config, Effect, Layer, Option, Redacted } from "effect";

const RedisConfig = Config.all({
  host: Config.string("REDIS_HOST").pipe(Config.withDefault("localhost")),
  port: Config.integer("REDIS_PORT").pipe(Config.withDefault(6379)),
  username: Config.option(Config.string("REDIS_USERNAME")),
  password: Config.option(Config.redacted("REDIS_PASSWORD")),
  database: Config.integer("REDIS_DB").pipe(Config.withDefault(0)),
  tls: Config.boolean("REDIS_TLS").pipe(Config.withDefault(false)),
});

export const KeyValueStoreLive = Layer.unwrapEffect(
  Effect.map(RedisConfig, (config) =>
    makeLayer({
      ...config,
      username: Option.getOrUndefined(config.username),
      password: Option.getOrUndefined(
        Option.map(config.password, Redacted.value),
      ),
    }),
  ),
);

// REDIS_HOST=redis.internal REDIS_TLS=true bun run app.ts
const program = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;
  yield* store.set("greeting", "hello");
});

await Effect.runPromise(program.pipe(Effect.provide(KeyValueStoreLive)));
```

Use `makeRedisLayer` the same way to get the `Redis` service instead.

## Typed values with a schema

`KeyValueStore.forSchema` stores values as JSON and decodes them on the way out. `KeyValueStore.prefix`
namespaces the keys:

```ts
import { KeyValueStore } from "@effect/platform";
import { Effect, Schema } from "effect";

class User extends Schema.Class<User>("User")({
  id: Schema.String,
  name: Schema.String,
}) {}

const program = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;
  const users = KeyValueStore.prefix(store, "users:").forSchema(User);

  yield* users.set("1", new User({ id: "1", name: "Alice" }));
  return yield* users.get("1"); // Option<User>, stored under "users:1"
});
```

## Cache-aside with a TTL

Read through a cache, and let Redis expire the entries:

```ts
import { Redis } from "@vortexdd/effect-redis-bun";
import { Effect, Option, Schema } from "effect";

export const cached = <A, I, E, R>(options: {
  readonly key: string;
  readonly schema: Schema.Schema<A, I>;
  readonly ttlSeconds: number;
  readonly load: Effect.Effect<A, E, R>;
}) =>
  Effect.gen(function* () {
    const redis = yield* Redis;
    const json = Schema.parseJson(options.schema);

    const hit = yield* redis.get(options.key);
    if (hit !== null) {
      // A value that no longer matches the schema counts as a miss.
      const decoded = yield* Effect.option(Schema.decode(json)(hit));
      if (Option.isSome(decoded)) {
        return decoded.value;
      }
    }

    const value = yield* options.load;
    const encoded = yield* Schema.encode(json)(value);
    yield* redis.set(options.key, encoded, "EX", options.ttlSeconds);
    return value;
  });

const Todo = Schema.Struct({ id: Schema.Number, title: Schema.String });

const getTodo = (id: number) =>
  cached({
    key: `todo:${id}`,
    schema: Todo,
    ttlSeconds: 300,
    load: Effect.tryPromise(() =>
      fetch(`https://jsonplaceholder.typicode.com/todos/${id}`).then(
        (response) => response.json() as Promise<typeof Todo.Type>,
      ),
    ),
  });
```

## Rate limiting

A fixed-window limiter. The Lua script increments the counter and sets its expiry in one atomic step,
so concurrent requests cannot both see a fresh window:

```ts
import { Redis } from "@vortexdd/effect-redis-bun";
import { Effect } from "effect";

const INCREMENT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return count`;

export const allowRequest = (
  id: string,
  limit: number,
  windowSeconds: number,
) =>
  Effect.gen(function* () {
    const redis = yield* Redis;
    const window = Math.floor(Date.now() / 1000 / windowSeconds);
    const key = `ratelimit:${id}:${window}`;

    const count = yield* redis.send("EVAL", [
      INCREMENT,
      "1",
      key,
      String(windowSeconds),
    ]);
    return Number(count) <= limit;
  });

const program = Effect.gen(function* () {
  if (!(yield* allowRequest("user:123", 100, 3600))) {
    yield* Effect.logWarning("Rate limit exceeded");
  }
});
```

## Distributed lock

`SET key token NX PX ttl` takes the lock only if nobody holds it, and the release script deletes it only
if it still holds our token, so an expired lock taken over by someone else is left alone:

```ts
import { Redis } from "@vortexdd/effect-redis-bun";
import { Data, Duration, Effect } from "effect";

export class LockNotAcquired extends Data.TaggedError("LockNotAcquired")<{
  readonly key: string;
}> {}

const RELEASE = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`;

export const withLock =
  (key: string, ttl: Duration.DurationInput) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const redis = yield* Redis;
      const token = crypto.randomUUID();

      return yield* Effect.acquireUseRelease(
        redis.set(key, token, "NX", "PX", Duration.toMillis(ttl)).pipe(
          Effect.filterOrFail(
            (reply) => reply === "OK",
            () => new LockNotAcquired({ key }),
          ),
        ),
        () => effect,
        () => Effect.ignore(redis.send("EVAL", [RELEASE, "1", key, token])),
      );
    });

const program = Effect.log("only one instance runs this at a time").pipe(
  withLock("lock:nightly-job", "30 seconds"),
  Effect.catchTag("LockNotAcquired", () =>
    Effect.log("another instance holds the lock"),
  ),
);
```

The lock expires after `ttl` even if the effect is still running, so pick a `ttl` longer than the
effect takes. This is a single-server lock, not Redlock.

## Error handling and retries

`Redis` operations fail with `RedisCommandError` (the server replied with an error) or
`RedisConnectionError` (no reply). Retry only what is worth retrying:

```ts
import { Redis } from "@vortexdd/effect-redis-bun";
import { Effect, Schedule } from "effect";

export const readString = (key: string) =>
  Effect.flatMap(Redis, (redis) => redis.get(key)).pipe(
    // A connection problem may go away; retry it with backoff.
    Effect.retry({
      schedule: Schedule.exponential("100 millis"),
      times: 3,
      while: (error) => error._tag === "RedisConnectionError",
    }),
    // A key holding a list or hash is not a string value.
    Effect.catchTag("RedisCommandError", (error) =>
      error.code === "WRONGTYPE" ? Effect.succeed(null) : Effect.fail(error),
    ),
  );
```

`makeRedisLayer` already reconnects after outages longer than Bun's own retries (see `keepConnected` in
the README), so retries here only have to cover the commands that failed in between.

## Many keys at once

Bun pipelines commands that are sent concurrently, so running them with concurrency costs a single round
trip rather than one per key:

```ts
import { Redis } from "@vortexdd/effect-redis-bun";
import { Effect } from "effect";

export const getMany = (keys: ReadonlyArray<string>) =>
  Effect.flatMap(Redis, (redis) =>
    Effect.forEach(keys, (key) => redis.get(key), {
      concurrency: "unbounded",
    }),
  );

// Or one MGET command:
export const mget = (keys: ReadonlyArray<string>) =>
  Effect.flatMap(Redis, (redis) => redis.send("MGET", [...keys])).pipe(
    Effect.map((values) => values as Array<string | null>),
  );
```

## Testing

Code that depends on `KeyValueStore` can run against the in-memory store from `@effect/platform`:

```ts
import { KeyValueStore } from "@effect/platform";
import { makeLayer } from "@vortexdd/effect-redis-bun";
import { Effect, Option } from "effect";

const rememberVisit = (userId: string) =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    const previous = yield* store.get(`visits:${userId}`);
    const visits = Option.match(previous, {
      onNone: () => 1,
      onSome: (value) => Number(value) + 1,
    });
    yield* store.set(`visits:${userId}`, String(visits));
    return visits;
  });

// In production
const live = rememberVisit("123").pipe(
  Effect.provide(makeLayer({ host: "localhost", port: 6379 })),
);

// In tests
const test = rememberVisit("123").pipe(
  Effect.provide(KeyValueStore.layerMemory),
);
```

For the `Redis` service, provide your own implementation with `Layer.succeed(Redis, ...)`, or wrap a Bun
client pointed at a test server with `fromClientService`.

## Graceful shutdown

The layers close the Redis client when their scope ends. With `BunRuntime.runMain` from
`@effect/platform-bun`, SIGINT and SIGTERM interrupt the program, which runs those finalizers:

```ts
import { KeyValueStore } from "@effect/platform";
import { BunRuntime } from "@effect/platform-bun";
import { makeLayer } from "@vortexdd/effect-redis-bun";
import { Effect, Schedule } from "effect";

const heartbeat = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;
  yield* store.set("worker:heartbeat", new Date().toISOString());
}).pipe(Effect.repeat(Schedule.spaced("5 seconds")));

heartbeat.pipe(
  Effect.provide(makeLayer({ host: "localhost", port: 6379 })),
  BunRuntime.runMain,
);
```

## More

- [Effect documentation](https://effect.website)
- [Bun Redis client](https://bun.com/docs/api/redis)

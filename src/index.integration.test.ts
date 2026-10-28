import { afterEach, describe, expect, it } from "bun:test";
import { RedisClient, type RedisOptions, type Socket } from "bun";
import { Effect, Option } from "effect";
import { fromClient, fromClientService, keepConnected } from "./index";

const { REDIS_URL: redisUrl = "", REDIS_ALLOW_DESTRUCTIVE } = Bun.env;
const integrationDescribe = redisUrl ? describe : describe.skip;
// size and clear act on the whole database, so they only run when allowed.
const destructiveIt = REDIS_ALLOW_DESTRUCTIVE === "1" ? it : it.skip;

const uniqueKey = (prefix: string) =>
  `${prefix}:${Date.now()}:${Math.random().toString(16).slice(2)}`;

const clients = new Set<RedisClient>();

afterEach(() => {
  for (const client of clients) {
    client.close();
  }
  clients.clear();
});

// A client that is closed after the test.
const newClient = (url = redisUrl, options?: RedisOptions) => {
  const client = new RedisClient(url, {
    enableOfflineQueue: false,
    ...options,
  });
  clients.add(client);
  return client;
};

const connectedClient = async () => {
  const client = newClient();
  await client.connect();
  return client;
};

integrationDescribe("fromClientService integration (real redis)", () => {
  it("supports connect, set, get, getBuffer and del", async () => {
    const redis = fromClientService(newClient());
    const key = uniqueKey("svc");
    const binaryKey = `${key}:bin`;
    const input = new Uint8Array([1, 2, 3, 255]);

    await Effect.runPromise(redis.connect);
    await Effect.runPromise(redis.set(key, "value-1"));
    expect(await Effect.runPromise(redis.get(key))).toBe("value-1");

    await Effect.runPromise(redis.set(binaryKey, input));
    const found = await Effect.runPromise(redis.getBuffer(binaryKey));
    expect(Array.from(found ?? [])).toEqual(Array.from(input));

    expect(await Effect.runPromise(redis.del(key, binaryKey))).toBe(2);
    expect(await Effect.runPromise(redis.get(key))).toBeNull();
  });

  it("supports send and scan", async () => {
    const redis = fromClientService(newClient());
    const prefix = uniqueKey("scan");
    const keys = [`${prefix}:1`, `${prefix}:2`, `${prefix}:3`];

    await Effect.runPromise(redis.connect);
    for (const key of keys) {
      await Effect.runPromise(redis.send("SET", [key, key]));
    }

    const [, found] = await Effect.runPromise(
      redis.scan("0", "MATCH", `${prefix}:*`, "COUNT", 20),
    );
    expect(found.sort()).toEqual(keys.sort());

    await Effect.runPromise(redis.del(...keys));
  });

  it("classifies a real server error reply", async () => {
    const redis = fromClientService(newClient());

    await Effect.runPromise(redis.connect);
    const error = await Effect.runPromise(Effect.flip(redis.send("GET", [])));

    expect(error._tag).toBe("RedisCommandError");
    if (error._tag === "RedisCommandError") {
      expect(error.command).toBe("GET");
      expect(error.code).toBe("ERR");
      expect(error.message).toContain("wrong number of arguments");
      // ERR_REDIS_SERVER_ERROR on Bun 1.4+, ERR_REDIS_INVALID_RESPONSE before.
      expect([
        "ERR_REDIS_SERVER_ERROR",
        "ERR_REDIS_INVALID_RESPONSE",
      ]).toContain(String((error.cause as { code?: string }).code));
    }
  });
});

integrationDescribe("fromClient integration (real redis)", () => {
  it("supports set/get/remove against real redis", async () => {
    const store = fromClient(await connectedClient(), { scanBatchSize: 20 });
    const key = uniqueKey("itest");

    await Effect.runPromise(store.set(key, "value-1"));
    expect(await Effect.runPromise(store.get(key))).toEqual(
      Option.some("value-1"),
    );

    await Effect.runPromise(store.remove(key));
    expect(await Effect.runPromise(store.get(key))).toEqual(Option.none());
  });

  it("remove is idempotent for missing keys", async () => {
    const store = fromClient(await connectedClient(), { scanBatchSize: 20 });
    const missingKey = uniqueKey("itest:missing");

    await Effect.runPromise(store.remove(missingKey));
    expect(await Effect.runPromise(store.get(missingKey))).toEqual(
      Option.none(),
    );
  });

  it("stores binary values as raw bytes", async () => {
    const client = await connectedClient();
    const store = fromClient(client, { scanBatchSize: 20 });
    const key = uniqueKey("itest:bin");
    const input = new Uint8Array([1, 2, 3, 255]);

    await Effect.runPromise(store.set(key, input));
    const found = await Effect.runPromise(store.getUint8Array(key));
    const raw = await client.getBuffer(key);

    expect(Option.map(found, (bytes) => Array.from(bytes))).toEqual(
      Option.some(Array.from(input)),
    );
    expect(Array.from(raw ?? [])).toEqual(Array.from(input));

    await Effect.runPromise(store.remove(key));
  });

  destructiveIt("supports size and clear in isolated redis db", async () => {
    const client = await connectedClient();
    const store = fromClient(client, { scanBatchSize: 2 });

    await client.send("FLUSHDB", []);

    await Effect.runPromise(store.set("k1", "1"));
    await Effect.runPromise(store.set("k2", "2"));
    await Effect.runPromise(store.set("k3", "3"));

    expect(await Effect.runPromise(store.size)).toBe(3);

    await Effect.runPromise(store.clear);
    expect(Number(await client.send("DBSIZE", []))).toBe(0);
  });

  destructiveIt("supports repeated clear in isolated redis db", async () => {
    const client = await connectedClient();
    const store = fromClient(client, { scanBatchSize: 2 });

    await client.send("FLUSHDB", []);

    await Effect.runPromise(store.set("k1", "1"));
    await Effect.runPromise(store.set("k2", "2"));

    await Effect.runPromise(store.clear);
    await Effect.runPromise(store.clear);

    expect(Number(await client.send("DBSIZE", []))).toBe(0);
  });
});

type ProxyData = {
  upstream?: Socket<unknown>;
  pending: Array<Uint8Array>;
};

// TCP proxy in front of the real server, so a test can make it unreachable
// and bring it back on the same port.
const startProxy = (target: URL, port = 0) => {
  const sockets = new Set<{ end: () => void }>();
  const server = Bun.listen<ProxyData>({
    hostname: "127.0.0.1",
    port,
    socket: {
      open(client) {
        client.data = { pending: [] };
        sockets.add(client);
        Bun.connect({
          hostname: target.hostname,
          port: Number(target.port || 6379),
          socket: {
            data(_upstream, chunk) {
              client.write(chunk);
            },
            close() {
              client.end();
            },
            error() {
              client.end();
            },
          },
        }).then(
          (upstream) => {
            sockets.add(upstream);
            client.data.upstream = upstream;
            for (const chunk of client.data.pending) {
              upstream.write(chunk);
            }
            client.data.pending = [];
          },
          () => client.end(),
        );
      },
      data(client, chunk) {
        if (client.data.upstream) {
          client.data.upstream.write(chunk);
        } else {
          client.data.pending.push(new Uint8Array(chunk));
        }
      },
      close(client) {
        client.data.upstream?.end();
        sockets.delete(client);
      },
    },
  });
  return {
    port: server.port,
    stop: () => {
      server.stop(true);
      for (const socket of sockets) {
        socket.end();
      }
      sockets.clear();
    },
  };
};

integrationDescribe("keepConnected integration (real redis)", () => {
  it(
    "recovers a client after Bun gives up reconnecting",
    async () => {
      const target = new URL(redisUrl);
      let proxy = startProxy(target);
      const port = proxy.port;
      const via = new URL(redisUrl);
      via.hostname = "127.0.0.1";
      via.port = String(port);

      // maxRetries: 1 makes Bun give up in milliseconds instead of ~30s.
      const client = newClient(via.toString(), { maxRetries: 1 });
      const redis = fromClientService(client);
      const key = uniqueKey("reconnect");

      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              yield* redis.connect;
              yield* keepConnected(client, {
                initialDelayMs: 20,
                maxDelayMs: 100,
              });
              yield* redis.set(key, "before");

              proxy.stop();
              for (let i = 0; i < 100 && client.connected; i += 1) {
                yield* Effect.sleep("20 millis");
              }
              expect(client.connected).toBe(false);
              // Let Bun exhaust its own retries while the server is down.
              yield* Effect.sleep("500 millis");
              const whileDown = yield* Effect.either(redis.get(key));
              expect(whileDown._tag).toBe("Left");

              proxy = startProxy(target, port);
              for (let i = 0; i < 200 && !client.connected; i += 1) {
                yield* Effect.sleep("20 millis");
              }
              expect(client.connected).toBe(true);
              expect(yield* redis.get(key)).toBe("before");
              yield* redis.del(key);
            }),
          ),
        );
      } finally {
        proxy.stop();
      }
    },
    { timeout: 20_000 },
  );
});

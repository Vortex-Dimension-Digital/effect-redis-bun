import { afterEach, describe, expect, it } from "bun:test";
import { RedisClient } from "bun";
import { Effect, Option } from "effect";
import { fromClient, fromClientService, keepConnected } from "./index";

const { REDIS_URL: redisUrl, REDIS_ALLOW_DESTRUCTIVE: destructiveFlag } =
	Bun.env;
const allowDestructive = destructiveFlag === "1";

const integrationDescribe = redisUrl ? describe : describe.skip;

integrationDescribe("fromClientService integration (real redis)", () => {
	let client: RedisClient | undefined;

	afterEach(() => {
		client?.close();
		client = undefined;
	});

	it("supports connect, set, get, getBuffer and del", async () => {
		if (!redisUrl) {
			return;
		}

		client = new RedisClient(redisUrl, {
			enableOfflineQueue: false,
		});
		const redis = fromClientService(client);
		const key = `svc:${Date.now()}:${Math.random().toString(16).slice(2)}`;
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
		if (!redisUrl) {
			return;
		}

		client = new RedisClient(redisUrl, {
			enableOfflineQueue: false,
		});
		const redis = fromClientService(client);
		const prefix = `scan:${Date.now()}:${Math.random().toString(16).slice(2)}`;
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
		await Effect.runPromise(redis.close);
	});

	it("classifies a real server error reply", async () => {
		if (!redisUrl) {
			return;
		}

		client = new RedisClient(redisUrl, {
			enableOfflineQueue: false,
		});
		const redis = fromClientService(client);

		await Effect.runPromise(redis.connect);
		const error = await Effect.runPromise(Effect.flip(redis.send("GET", [])));

		expect(error._tag).toBe("RedisCommandError");
		if (error._tag === "RedisCommandError") {
			expect(error.command).toBe("GET");
			expect(error.code).toBe("ERR");
			expect(error.message).toContain("wrong number of arguments");
			expect((error.cause as { code?: string }).code).toBe(
				"ERR_REDIS_INVALID_RESPONSE",
			);
		}
	});
});

integrationDescribe("fromClient integration (real redis)", () => {
	let client: RedisClient | undefined;
	let store: ReturnType<typeof fromClient> | undefined;

	afterEach(() => {
		client?.close();
		client = undefined;
		store = undefined;
	});

	it("supports set/get/remove against real redis", async () => {
		if (!redisUrl) {
			return;
		}

		client = new RedisClient(redisUrl, {
			enableOfflineQueue: false,
		});
		await client.connect();
		store = fromClient(client, { scanBatchSize: 20 });

		const key = `itest:${Date.now()}:${Math.random().toString(16).slice(2)}`;

		await Effect.runPromise(store.set(key, "value-1"));
		const found = await Effect.runPromise(store.get(key));
		expect(Option.isSome(found)).toBe(true);
		if (Option.isSome(found)) {
			expect(found.value).toBe("value-1");
		}

		await Effect.runPromise(store.remove(key));
		const removed = await Effect.runPromise(store.get(key));
		expect(Option.isNone(removed)).toBe(true);
	});

	it("remove is idempotent for missing keys", async () => {
		if (!redisUrl) {
			return;
		}

		client = new RedisClient(redisUrl, {
			enableOfflineQueue: false,
		});
		await client.connect();
		store = fromClient(client, { scanBatchSize: 20 });

		const missingKey = `itest:missing:${Date.now()}:${Math.random().toString(16).slice(2)}`;

		await Effect.runPromise(store.remove(missingKey));
		const found = await Effect.runPromise(store.get(missingKey));
		expect(Option.isNone(found)).toBe(true);
	});

	it("supports binary values through getUint8Array", async () => {
		if (!redisUrl) {
			return;
		}

		client = new RedisClient(redisUrl, {
			enableOfflineQueue: false,
		});
		await client.connect();
		store = fromClient(client, { scanBatchSize: 20 });

		const key = `itest:bin:${Date.now()}:${Math.random().toString(16).slice(2)}`;
		const input = new Uint8Array([1, 2, 3, 255]);

		await Effect.runPromise(store.set(key, input));
		const found = await Effect.runPromise(store.getUint8Array(key));
		expect(Option.isSome(found)).toBe(true);
		if (Option.isSome(found)) {
			expect(Array.from(found.value)).toEqual(Array.from(input));
		}

		await Effect.runPromise(store.remove(key));
	});

	(allowDestructive ? it : it.skip)(
		"supports size and clear in isolated redis db",
		async () => {
			if (!redisUrl) {
				return;
			}

			client = new RedisClient(redisUrl, {
				enableOfflineQueue: false,
			});
			await client.connect();
			store = fromClient(client, { scanBatchSize: 2 });

			await client.send("FLUSHDB", []);

			await Effect.runPromise(store.set("k1", "1"));
			await Effect.runPromise(store.set("k2", "2"));
			await Effect.runPromise(store.set("k3", "3"));

			const size = await Effect.runPromise(store.size);
			expect(size).toBe(3);

			await Effect.runPromise(store.clear);
			const dbSize = await client.send("DBSIZE", []);
			expect(Number(dbSize)).toBe(0);
		},
	);

	(allowDestructive ? it : it.skip)(
		"supports repeated clear in isolated redis db",
		async () => {
			if (!redisUrl) {
				return;
			}

			client = new RedisClient(redisUrl, {
				enableOfflineQueue: false,
			});
			await client.connect();
			store = fromClient(client, { scanBatchSize: 2 });

			await client.send("FLUSHDB", []);

			await Effect.runPromise(store.set("k1", "1"));
			await Effect.runPromise(store.set("k2", "2"));

			await Effect.runPromise(store.clear);
			await Effect.runPromise(store.clear);

			const dbSize = await client.send("DBSIZE", []);
			expect(Number(dbSize)).toBe(0);
		},
	);
});

type ProxySocket = import("bun").Socket<{
	upstream?: import("bun").Socket<unknown>;
	pending: Array<Uint8Array>;
}>;

// TCP proxy in front of the real server, so a test can make it unreachable
// and bring it back on the same port.
const startProxy = (target: URL, port = 0) => {
	const sockets = new Set<{ end: () => void }>();
	const server = Bun.listen<{
		upstream?: import("bun").Socket<unknown>;
		pending: Array<Uint8Array>;
	}>({
		hostname: "127.0.0.1",
		port,
		socket: {
			open(client: ProxySocket) {
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
			data(client: ProxySocket, chunk) {
				if (client.data.upstream) {
					client.data.upstream.write(chunk);
				} else {
					client.data.pending.push(new Uint8Array(chunk));
				}
			},
			close(client: ProxySocket) {
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
			if (!redisUrl) {
				return;
			}
			const target = new URL(redisUrl);
			let proxy = startProxy(target);
			const port = proxy.port;
			const via = new URL(redisUrl);
			via.hostname = "127.0.0.1";
			via.port = String(port);

			// maxRetries: 1 makes Bun give up in milliseconds instead of ~30s.
			const client = new RedisClient(via.toString(), {
				enableOfflineQueue: false,
				maxRetries: 1,
			});
			const redis = fromClientService(client);
			const key = `reconnect:${Date.now()}:${Math.random().toString(16).slice(2)}`;

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
				client.close();
				proxy.stop();
			}
		},
		{ timeout: 20_000 },
	);
});

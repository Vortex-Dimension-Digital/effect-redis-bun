import { afterEach, describe, expect, it } from "bun:test";
import { RedisClient } from "bun";
import { Effect, Option } from "effect";
import { fromClient, fromClientService } from "./index";

const redisUrl = process.env.REDIS_URL;
const allowDestructive = process.env.REDIS_ALLOW_DESTRUCTIVE === "1";

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

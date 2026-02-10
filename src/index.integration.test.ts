import { afterEach, describe, expect, it } from "bun:test";
import { RedisClient } from "bun";
import { Effect, Option } from "effect";
import { fromClient } from "./index";

const redisUrl = process.env.REDIS_URL;
const allowDestructive = process.env.REDIS_ALLOW_DESTRUCTIVE === "1";

const integrationDescribe = redisUrl ? describe : describe.skip;

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
});

import { describe, expect, it } from "bun:test";
import { KeyValueStore } from "@effect/platform";
import { Effect, Layer, Option } from "effect";
import {
	buildUrl,
	fromClient,
	fromClientService,
	layerFromRedis,
	Redis,
	type RedisClient,
} from "./index";

class FakeRedisClient implements RedisClient {
	private readonly store = new Map<string, string>();
	private readonly encoder = new TextEncoder();
	private readonly decoder = new TextDecoder();

	readonly delCalls: Array<ReadonlyArray<string>> = [];
	readonly sendCommands: Array<string> = [];
	scanCallCount = 0;
	connected = false;

	private getSortedKeys = () => Array.from(this.store.keys()).sort();

	connect = async (): Promise<void> => {
		this.connected = true;
	};

	close = (): void => {
		this.connected = false;
	};

	get = async (key: string): Promise<string | null> =>
		this.store.get(key) ?? null;

	getBuffer = async (key: string): Promise<Uint8Array | null> => {
		const value = this.store.get(key);
		return value === undefined ? null : this.encoder.encode(value);
	};

	set = async (
		key: string,
		value: string | Uint8Array,
	): Promise<"OK" | null | string> => {
		this.store.set(
			key,
			typeof value === "string" ? value : this.decoder.decode(value),
		);
		return "OK";
	};

	del = async (...keys: Array<string>): Promise<number> => {
		this.delCalls.push(keys);
		let deleted = 0;
		for (const key of keys) {
			if (this.store.delete(key)) {
				deleted += 1;
			}
		}
		return deleted;
	};

	scan = async (
		cursor: string | number,
		...args: Array<string | number>
	): Promise<[string, Array<string>]> => {
		this.scanCallCount += 1;
		const currentCursor = String(cursor);
		const countIndex = args.indexOf("COUNT");
		const count =
			countIndex >= 0 && countIndex + 1 < args.length
				? Number.parseInt(String(args[countIndex + 1] ?? "10"), 10)
				: 10;
		const allKeys = this.getSortedKeys();

		if (currentCursor === "0" || allKeys.length === 0) {
			const batch = allKeys.slice(0, count);
			const nextCursor =
				batch.length >= count && batch.length < allKeys.length
					? (batch[batch.length - 1] ?? "0")
					: "0";
			return [nextCursor, batch];
		}

		const cursorIndex = allKeys.indexOf(currentCursor);
		if (cursorIndex === -1) {
			const batch = allKeys.slice(0, count);
			const nextCursor =
				batch.length >= count && batch.length < allKeys.length
					? (batch[batch.length - 1] ?? "0")
					: "0";
			return [nextCursor, batch];
		}

		const startIndex = cursorIndex + 1;
		const batch = allKeys.slice(startIndex, startIndex + count);
		const nextCursor =
			batch.length >= count && startIndex + count < allKeys.length
				? (batch[batch.length - 1] ?? "0")
				: "0";

		return [nextCursor, batch];
	};

	send = async (
		command: string,
		args: ReadonlyArray<string>,
	): Promise<unknown> => {
		const normalized = command.toUpperCase();
		this.sendCommands.push(normalized);

		switch (normalized) {
			case "GET": {
				const key = args[0];
				return key ? this.get(key) : null;
			}
			case "SET": {
				const key = args[0];
				const value = args[1];
				if (!key || value === undefined) {
					throw new Error("SET requires key and value");
				}
				await this.set(key, value);
				return "OK";
			}
			case "DEL": {
				return this.del(...args);
			}
			case "SCAN": {
				const cursor = args[0] ?? "0";
				return this.scan(cursor, ...args.slice(1));
			}
			case "DBSIZE": {
				return this.store.size;
			}
			default:
				throw new Error(`Unsupported command in fake client: ${command}`);
		}
	};
}

const withoutScan = (redis: FakeRedisClient): RedisClient => ({
	connect: redis.connect,
	close: redis.close,
	send: redis.send,
	get: redis.get,
	getBuffer: redis.getBuffer,
	set: redis.set,
	del: redis.del,
});

describe("buildUrl", () => {
	it("builds url with user, password, database and tls", () => {
		const url = buildUrl({
			host: "valkey.local",
			port: 6380,
			username: "agent",
			password: "pa:ss@word",
			database: 2,
			tls: true,
		});

		expect(url).toBe("rediss://agent:pa%3Ass%40word@valkey.local:6380/2");
	});

	it("builds url with password only", () => {
		const url = buildUrl({
			host: "127.0.0.1",
			port: 6379,
			password: "secret",
		});

		expect(url).toBe("redis://:secret@127.0.0.1:6379/0");
	});

	it("builds url with username only", () => {
		const url = buildUrl({
			host: "127.0.0.1",
			port: 6379,
			username: "agent",
		});

		expect(url).toBe("redis://agent@127.0.0.1:6379/0");
	});
});

describe("fromClientService", () => {
	it("wraps connect and close in Effect", async () => {
		const client = new FakeRedisClient();
		const redis = fromClientService(client);

		expect(client.connected).toBe(false);
		await Effect.runPromise(redis.connect);
		expect(client.connected).toBe(true);
		await Effect.runPromise(redis.close);
		expect(client.connected).toBe(false);
	});

	it("wraps get, getBuffer, set and del", async () => {
		const client = new FakeRedisClient();
		const redis = fromClientService(client);
		const input = new Uint8Array([97, 98, 99]);

		await Effect.runPromise(redis.set("session:1", "value-1"));
		expect(await Effect.runPromise(redis.get("session:1"))).toBe("value-1");

		await Effect.runPromise(redis.set("bin:1", input));
		const binary = await Effect.runPromise(redis.getBuffer("bin:1"));
		expect(Array.from(binary ?? [])).toEqual(Array.from(input));

		expect(await Effect.runPromise(redis.del("session:1", "bin:1"))).toBe(2);
		expect(await Effect.runPromise(redis.get("session:1"))).toBeNull();
	});

	it("wraps send", async () => {
		const client = new FakeRedisClient();
		const redis = fromClientService(client);

		await Effect.runPromise(redis.send("SET", ["raw:key", "value"]));
		const value = await Effect.runPromise(redis.send("GET", ["raw:key"]));

		expect(value).toBe("value");
		expect(client.sendCommands).toEqual(["SET", "GET"]);
	});

	it("uses client.scan when available", async () => {
		const client = new FakeRedisClient();
		const redis = fromClientService(client);

		await Effect.runPromise(redis.set("user:1", "a"));
		await Effect.runPromise(redis.set("user:2", "b"));

		const [cursor, keys] = await Effect.runPromise(
			redis.scan("0", "MATCH", "user:*", "COUNT", 10),
		);

		expect(cursor).toBe("0");
		expect(keys).toEqual(["user:1", "user:2"]);
		expect(client.scanCallCount).toBe(1);
		expect(client.sendCommands).not.toContain("SCAN");
	});

	it("falls back to send for scan when the client does not expose scan", async () => {
		const client = new FakeRedisClient();
		const redis = fromClientService(withoutScan(client));

		await Effect.runPromise(redis.set("user:1", "a"));
		await Effect.runPromise(redis.set("user:2", "b"));

		const [cursor, keys] = await Effect.runPromise(
			redis.scan("0", "MATCH", "user:*", "COUNT", 10),
		);

		expect(cursor).toBe("0");
		expect(keys).toEqual(["user:1", "user:2"]);
		expect(client.sendCommands).toContain("SCAN");
	});
});

describe("fromClient", () => {
	it("supports set/get/remove", async () => {
		const redis = new FakeRedisClient();
		const store = fromClient(redis);

		await Effect.runPromise(store.set("session:1", "value-1"));
		const found = await Effect.runPromise(store.get("session:1"));
		expect(Option.isSome(found)).toBe(true);
		if (Option.isSome(found)) {
			expect(found.value).toBe("value-1");
		}

		await Effect.runPromise(store.remove("session:1"));
		const notFound = await Effect.runPromise(store.get("session:1"));
		expect(Option.isNone(notFound)).toBe(true);
	});

	it("supports getUint8Array for binary values", async () => {
		const redis = new FakeRedisClient();
		const store = fromClient(redis);
		const input = new Uint8Array([97, 98, 99]);

		await Effect.runPromise(store.set("bin:1", input));
		const found = await Effect.runPromise(store.getUint8Array("bin:1"));
		expect(Option.isSome(found)).toBe(true);
		if (Option.isSome(found)) {
			expect(Array.from(found.value)).toEqual(Array.from(input));
		}
	});

	it("clear deletes all keys using scan batches", async () => {
		const redis = new FakeRedisClient();
		const store = fromClient(redis, {
			scanBatchSize: 2,
		});

		await Effect.runPromise(store.set("k1", "1"));
		await Effect.runPromise(store.set("k2", "2"));
		await Effect.runPromise(store.set("k3", "3"));
		await Effect.runPromise(store.set("k4", "4"));

		await Effect.runPromise(store.clear);

		const size = await Effect.runPromise(store.size);
		expect(size).toBe(0);
		expect(redis.delCalls.length).toBeGreaterThan(1);
	});

	it("size uses DBSIZE instead of scanning", async () => {
		const redis = new FakeRedisClient();
		const store = fromClient(redis, {
			scanBatchSize: 2,
		});

		await Effect.runPromise(store.set("a", "1"));
		await Effect.runPromise(store.set("b", "2"));
		await Effect.runPromise(store.set("c", "3"));
		await Effect.runPromise(store.set("d", "4"));
		await Effect.runPromise(store.set("e", "5"));

		const size = await Effect.runPromise(store.size);
		expect(size).toBe(5);
		expect(redis.sendCommands).toContain("DBSIZE");
		expect(redis.scanCallCount).toBe(0);
	});

	it("builds KeyValueStore from a provided Redis service layer", async () => {
		const client = new FakeRedisClient();
		const redis = fromClientService(client);

		const program = Effect.gen(function* () {
			const store = yield* KeyValueStore.KeyValueStore;
			yield* store.set("layer:key", "value");
			return yield* store.get("layer:key");
		}).pipe(
			Effect.provide(
				Layer.provide(
					layerFromRedis({
						scanBatchSize: 2,
					}),
					Layer.succeed(Redis, redis),
				),
			),
		);

		const found = await Effect.runPromise(program);
		expect(Option.isSome(found)).toBe(true);
		if (Option.isSome(found)) {
			expect(found.value).toBe("value");
		}
	});
});

import { describe, expect, it } from "bun:test";
import { KeyValueStore } from "@effect/platform";
import type { RedisClient as BunRedisClient } from "bun";
import { Effect, Layer, Option } from "effect";
import {
	BunRedisClient as BunRedisClientTag,
	buildUrl,
	fromClient,
	layerFromBunRedisClient,
	type RedisClient,
} from "./index";

class FakeRedisClient implements RedisClient {
	private readonly store = new Map<string, string>();
	private getSortedKeys = () => Array.from(this.store.keys()).sort();
	private readonly encoder = new TextEncoder();
	private readonly decoder = new TextDecoder();

	readonly delCalls: Array<ReadonlyArray<string>> = [];
	readonly sendCommands: Array<string> = [];
	scanCallCount = 0;
	connected = false;

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

		// Start from the beginning if cursor is "0" or if empty
		if (currentCursor === "0" || allKeys.length === 0) {
			const batch = allKeys.slice(0, count);
			// Use last key as cursor, or "0" if done
			const nextCursor =
				batch.length >= count && batch.length < allKeys.length
					? (batch[batch.length - 1] ?? "0")
					: "0";
			return [nextCursor, batch];
		}

		// Find position after the cursor key
		const cursorIndex = allKeys.indexOf(currentCursor);

		// If cursor key not found, might have been deleted - start from beginning
		if (cursorIndex === -1) {
			const batch = allKeys.slice(0, count);
			const nextCursor =
				batch.length >= count && batch.length < allKeys.length
					? (batch[batch.length - 1] ?? "0")
					: "0";
			return [nextCursor, batch];
		}

		// Get next batch starting after the cursor
		const startIdx = cursorIndex + 1;
		const batch = allKeys.slice(startIdx, startIdx + count);

		// Use last key in batch as next cursor, or "0" if we're done
		const nextCursor =
			batch.length >= count && startIdx + count < allKeys.length
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
				if (!key) {
					return null;
				}
				return this.get(key);
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
		const input = new Uint8Array([97, 98, 99]); // "abc"

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

	it("size counts keys across scan pages", async () => {
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

	it("builds KeyValueStore from a provided BunRedisClient layer", async () => {
		const redis = new FakeRedisClient();

		const program = Effect.gen(function* () {
			const store = yield* KeyValueStore.KeyValueStore;
			yield* store.set("layer:key", "value");
			return yield* store.get("layer:key");
		}).pipe(
			Effect.provide(
				Layer.provide(
					layerFromBunRedisClient({
						scanBatchSize: 2,
					}),
					Layer.succeed(BunRedisClientTag, redis as BunRedisClient),
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

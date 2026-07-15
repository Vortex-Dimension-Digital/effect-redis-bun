import { describe, expect, it } from "bun:test";
import { KeyValueStore, Error as PlatformError } from "@effect/platform";
import { Effect, Layer, Option } from "effect";
import {
	buildUrl,
	fromClient,
	fromClientService,
	layerFromRedis,
	Redis,
	type RedisClient,
} from "./index";

type RedisKey = Parameters<RedisClient["get"]>[0];

class FakeRedisClient implements RedisClient {
	private readonly store = new Map<string, string>();
	private readonly encoder = new TextEncoder();
	private readonly decoder = new TextDecoder();

	readonly delCalls: Array<ReadonlyArray<string>> = [];
	readonly sendCommands: Array<string> = [];
	scanCallCount = 0;
	connected = false;

	private getSortedKeys = () => Array.from(this.store.keys()).sort();
	private toString = async (value: RedisKey): Promise<string> => {
		if (typeof value === "string") {
			return value;
		}
		if (value instanceof Blob) {
			return value.text();
		}
		return this.decoder.decode(value);
	};

	connect = async (): Promise<void> => {
		this.connected = true;
	};

	close = (): void => {
		this.connected = false;
	};

	get: RedisClient["get"] = async (key) =>
		this.store.get(await this.toString(key)) ?? null;

	getBuffer: RedisClient["getBuffer"] = async (key) => {
		const value = this.store.get(await this.toString(key));
		return value === undefined ? null : this.encoder.encode(value);
	};

	set: RedisClient["set"] = async (key, value) => {
		this.store.set(await this.toString(key), await this.toString(value));
		return "OK";
	};

	del: RedisClient["del"] = async (...keys) => {
		const normalizedKeys = await Promise.all(keys.map(this.toString));
		this.delCalls.push(normalizedKeys);
		let deleted = 0;
		for (const key of normalizedKeys) {
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

const failingClient = (error: unknown): RedisClient => ({
	connect: async () => {
		throw error;
	},
	close: () => {},
	send: async () => {
		throw error;
	},
	get: async () => {
		throw error;
	},
	getBuffer: async () => {
		throw error;
	},
	set: async () => {
		throw error;
	},
	del: async () => {
		throw error;
	},
});

const codedError = (message: string, code: string): Error & { code: string } =>
	Object.assign(new Error(message), { code });

describe("error classification", () => {
	it("maps Bun server replies to RedisCommandError with the parsed reply code", async () => {
		const cause = codedError(
			"ERR value is not an integer or out of range",
			"ERR_REDIS_INVALID_RESPONSE",
		);
		const redis = fromClientService(failingClient(cause));

		const error = await Effect.runPromise(
			Effect.flip(redis.send("INCR", ["key"])),
		);

		expect(error._tag).toBe("RedisCommandError");
		if (error._tag === "RedisCommandError") {
			expect(error.command).toBe("INCR");
			expect(error.code).toBe("ERR");
			expect(error.message).toBe("value is not an integer or out of range");
			expect(error.cause).toBe(cause);
		}
	});

	it("parses non-ERR reply codes like WRONGTYPE", async () => {
		const cause = codedError(
			"WRONGTYPE Operation against a key holding the wrong kind of value",
			"ERR_REDIS_INVALID_RESPONSE",
		);
		const redis = fromClientService(failingClient(cause));

		const error = await Effect.runPromise(Effect.flip(redis.get("key")));

		expect(error._tag).toBe("RedisCommandError");
		if (error._tag === "RedisCommandError") {
			expect(error.command).toBe("GET");
			expect(error.code).toBe("WRONGTYPE");
		}
	});

	it("supports clients that do not expose an error code", async () => {
		const redis = fromClientService(
			failingClient(new Error("NOAUTH Authentication required.")),
		);

		const error = await Effect.runPromise(Effect.flip(redis.get("key")));

		expect(error._tag).toBe("RedisCommandError");
		if (error._tag === "RedisCommandError") {
			expect(error.code).toBe("NOAUTH");
			expect(error.message).toBe("Authentication required.");
		}
	});

	it("maps Bun transport failures to RedisConnectionError", async () => {
		const cause = codedError(
			"Connection closed",
			"ERR_REDIS_CONNECTION_CLOSED",
		);
		const redis = fromClientService(failingClient(cause));

		const error = await Effect.runPromise(
			Effect.flip(redis.set("key", "value")),
		);

		expect(error._tag).toBe("RedisConnectionError");
		if (error._tag === "RedisConnectionError") {
			expect(error.command).toBe("SET");
			expect(error.code).toBe("ERR_REDIS_CONNECTION_CLOSED");
			expect(error.message).toBe("Connection closed");
			expect(error.cause).toBe(cause);
		}
	});

	it("uses the client error code to reject reply-looking transport errors", async () => {
		const cause = codedError("ECONNREFUSED Connection refused", "ECONNREFUSED");
		const redis = fromClientService(failingClient(cause));

		const error = await Effect.runPromise(Effect.flip(redis.get("key")));

		expect(error._tag).toBe("RedisConnectionError");
		if (error._tag === "RedisConnectionError") {
			expect(error.code).toBe("ECONNREFUSED");
			expect(error.message).toBe("ECONNREFUSED Connection refused");
		}
	});

	it("accepts code-only replies when the client code confirms them", async () => {
		const cause = codedError("TIMEOUT", "ERR_REDIS_INVALID_RESPONSE");
		const redis = fromClientService(failingClient(cause));

		const error = await Effect.runPromise(Effect.flip(redis.get("key")));

		expect(error._tag).toBe("RedisCommandError");
		if (error._tag === "RedisCommandError") {
			expect(error.code).toBe("TIMEOUT");
			expect(error.message).toBe("");
		}
	});

	it("treats code-less bare-token errors as connection failures", async () => {
		for (const message of ["TIMEOUT", "TIMEOUT "]) {
			const redis = fromClientService(failingClient(new Error(message)));

			const error = await Effect.runPromise(Effect.flip(redis.get("key")));

			expect(error._tag).toBe("RedisConnectionError");
			if (error._tag === "RedisConnectionError") {
				expect(error.code).toBeUndefined();
				expect(error.message).toBe(message);
			}
		}
	});

	it("always maps connect failures to RedisConnectionError", async () => {
		const redis = fromClientService(
			failingClient(
				codedError(
					"ERR invalid username-password pair",
					"ERR_REDIS_AUTHENTICATION_FAILED",
				),
			),
		);

		const error = await Effect.runPromise(Effect.flip(redis.connect));

		expect(error._tag).toBe("RedisConnectionError");
		if (error._tag === "RedisConnectionError") {
			expect(error.command).toBe("CONNECT");
			expect(error.code).toBe("ERR_REDIS_AUTHENTICATION_FAILED");
		}
	});

	it("keeps the KeyValueStore contract on PlatformError with the RedisError as cause", async () => {
		const store = fromClient(
			failingClient(new Error("ERR something went wrong")),
		);

		const error = await Effect.runPromise(Effect.flip(store.get("key")));

		expect(PlatformError.isPlatformError(error)).toBe(true);
		expect(error._tag).toBe("SystemError");
		if (error._tag === "SystemError") {
			expect(error.method).toBe("get");
		}
		expect((error.cause as { _tag?: string } | undefined)?._tag).toBe(
			"RedisCommandError",
		);
	});

	it("attributes clear and size failures to the KeyValueStore method", async () => {
		const store = fromClient(
			failingClient(new Error("ERR something went wrong")),
		);

		const clearError = await Effect.runPromise(Effect.flip(store.clear));
		const sizeError = await Effect.runPromise(Effect.flip(store.size));

		expect(clearError._tag).toBe("SystemError");
		if (clearError._tag === "SystemError") {
			expect(clearError.method).toBe("clear");
		}
		expect(sizeError._tag).toBe("SystemError");
		if (sizeError._tag === "SystemError") {
			expect(sizeError.method).toBe("size");
		}
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

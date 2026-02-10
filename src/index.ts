import { KeyValueStore, Error as PlatformError } from "@effect/platform";
import type { RedisClient as BunRedisClient } from "bun";
import { Effect, Layer, Option } from "effect";

/**
 * Configuration for connecting to a Redis or Valkey server.
 *
 * @example
 * ```typescript
 * const config: ConnectionConfig = {
 *   host: "localhost",
 *   port: 6379,
 *   password: "secret",
 *   database: 0,
 *   tls: false,
 * };
 * ```
 */
export interface ConnectionConfig {
	readonly host: string;
	readonly port: number;
	readonly username?: string;
	readonly password?: string;
	readonly database?: number;
	readonly tls?: boolean;
	readonly connectTimeoutMs?: number;
	readonly scanBatchSize?: number;
}

/**
 * Subset of Bun's Redis client used by this library.
 * `scan` is optional because some Bun versions expose it only via `send("SCAN", ...)`.
 */
export type RedisClient = Pick<
	BunRedisClient,
	"connect" | "close" | "send" | "get" | "getBuffer" | "set" | "del"
> & {
	readonly scan?: BunRedisClient["scan"];
};

const DEFAULT_SCAN_BATCH_SIZE = 200;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toPlatformError = (
	method: string,
	cause: unknown,
): PlatformError.PlatformError =>
	new PlatformError.SystemError({
		module: "KeyValueStore",
		method,
		reason: "Unknown",
		cause,
	});

const readOptional = (value: string | undefined): string | undefined => {
	if (!value) {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

type StringStoreImpl = {
	readonly get: (
		key: string,
	) => Effect.Effect<Option.Option<string>, PlatformError.PlatformError>;
	readonly getUint8Array: (
		key: string,
	) => Effect.Effect<Option.Option<Uint8Array>, PlatformError.PlatformError>;
	readonly set: (
		key: string,
		value: string | Uint8Array,
	) => Effect.Effect<void, PlatformError.PlatformError>;
	readonly remove: (
		key: string,
	) => Effect.Effect<void, PlatformError.PlatformError>;
	readonly clear: Effect.Effect<void, PlatformError.PlatformError>;
	readonly size: Effect.Effect<number, PlatformError.PlatformError>;
};

const readString = (value: unknown): string | null => {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === "string") {
		return value;
	}
	return String(value);
};

const readNumber = (value: unknown): number => {
	if (typeof value === "number") {
		return value;
	}
	const parsed = Number(value);
	return Number.isNaN(parsed) ? 0 : parsed;
};

const readScan = (value: unknown): [string, Array<string>] => {
	if (!Array.isArray(value) || value.length < 2) {
		return ["0", []];
	}
	const cursor = String(value[0] ?? "0");
	const keysRaw = value[1];
	const keys = Array.isArray(keysRaw) ? keysRaw.map((key) => String(key)) : [];
	return [cursor, keys];
};

const toStoredString = (value: string | Uint8Array): string =>
	typeof value === "string" ? value : textDecoder.decode(value);

/**
 * Builds a Redis connection URL from configuration.
 *
 * @param config - Connection configuration
 * @returns Redis connection URL (e.g., "redis://localhost:6379/0" or "rediss://user:pass@host:6380/1")
 *
 * @example
 * ```typescript
 * const url = buildUrl({
 *   host: "localhost",
 *   port: 6379,
 *   password: "secret",
 *   database: 1,
 *   tls: true,
 * });
 * // => "rediss://:secret@localhost:6379/1"
 * ```
 */
export const buildUrl = (config: ConnectionConfig): string => {
	const username = readOptional(config.username);
	const password = readOptional(config.password);
	const database = config.database ?? 0;
	const protocol = config.tls ? "rediss" : "redis";

	const auth =
		username && password
			? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
			: password
				? `:${encodeURIComponent(password)}@`
				: "";

	return `${protocol}://${auth}${config.host}:${config.port}/${database}`;
};

/**
 * Creates a Bun Redis client instance.
 *
 * @param config - Connection configuration
 * @returns Bun Redis client instance (not yet connected)
 *
 * @example
 * ```typescript
 * const client = createClient({
 *   host: "localhost",
 *   port: 6379,
 *   password: "secret",
 * });
 * await client.connect();
 * ```
 */
export const createClient = (config: ConnectionConfig): RedisClient =>
	new Bun.RedisClient(buildUrl(config), {
		connectionTimeout: config.connectTimeoutMs ?? 5000,
		enableOfflineQueue: false,
		tls: config.tls ?? false,
	});

/**
 * Creates a KeyValueStore implementation from a Redis client.
 *
 * @param client - Bun Redis client (should already be connected)
 * @param options - Optional configuration for scan operations
 * @returns KeyValueStore implementation
 *
 * @example
 * ```typescript
 * const client = createClient({ host: "localhost", port: 6379 });
 * await client.connect();
 * const store = fromClient(client, {
 *   scanBatchSize: 100,
 * });
 * ```
 */
export const fromClient = (
	client: RedisClient,
	options?: { readonly scanBatchSize?: number },
): KeyValueStore.KeyValueStore => {
	const scanBatchSize = options?.scanBatchSize ?? DEFAULT_SCAN_BATCH_SIZE;
	const count = scanBatchSize > 0 ? scanBatchSize : DEFAULT_SCAN_BATCH_SIZE;
	const getString = (key: string): Promise<string | null> =>
		client.get ? client.get(key) : client.send("GET", [key]).then(readString);
	const getBinary = (key: string): Promise<Uint8Array | null> =>
		client.getBuffer
			? client.getBuffer(key)
			: getString(key).then((value) =>
					value === null ? null : textEncoder.encode(value),
				);
	const setValue = (
		key: string,
		value: string | Uint8Array,
	): Promise<unknown> =>
		client.set
			? client.set(key, value)
			: client.send("SET", [key, toStoredString(value)]);
	const delKeys = (keys: Array<string>): Promise<number> =>
		client.del
			? client.del(...keys)
			: client.send("DEL", keys).then(readNumber);
	const scanKeys = (cursor: string): Promise<[string, Array<string>]> =>
		client.scan
			? client.scan(cursor, "MATCH", "*", "COUNT", count).then(readScan)
			: client
					.send("SCAN", [cursor, "MATCH", "*", "COUNT", count.toString()])
					.then(readScan);
	const impl: StringStoreImpl = {
		get: (key) =>
			Effect.tryPromise({
				try: () => getString(key),
				catch: (error) => toPlatformError("get", error),
			}).pipe(Effect.map((value) => Option.fromNullable(value))),
		getUint8Array: (key) =>
			Effect.tryPromise({
				try: () => getBinary(key),
				catch: (error) => toPlatformError("getUint8Array", error),
			}).pipe(Effect.map((value) => Option.fromNullable(value))),
		set: (key, value) =>
			Effect.tryPromise({
				try: () => setValue(key, value),
				catch: (error) => toPlatformError("set", error),
			}).pipe(Effect.asVoid),
		remove: (key) =>
			Effect.tryPromise({
				try: () => delKeys([key]),
				catch: (error) => toPlatformError("remove", error),
			}).pipe(Effect.asVoid),
		clear: Effect.gen(function* () {
			let cursor = "0";
			do {
				const [nextCursor, keys] = yield* Effect.tryPromise({
					try: () => scanKeys(cursor),
					catch: (error) => toPlatformError("clear.scan", error),
				});
				cursor = nextCursor;
				if (keys.length > 0) {
					yield* Effect.tryPromise({
						try: () => delKeys(keys),
						catch: (error) => toPlatformError("clear.del", error),
					});
				}
			} while (cursor !== "0");
		}),
		size: Effect.gen(function* () {
			let cursor = "0";
			let total = 0;
			do {
				const [nextCursor, keys] = yield* Effect.tryPromise({
					try: () => scanKeys(cursor),
					catch: (error) => toPlatformError("size", error),
				});
				cursor = nextCursor;
				total += keys.length;
			} while (cursor !== "0");
			return total;
		}),
	};

	const maybeMakeStringOnly = (
		KeyValueStore as unknown as {
			readonly makeStringOnly?: (
				impl: StringStoreImpl,
			) => KeyValueStore.KeyValueStore;
		}
	).makeStringOnly;

	if (maybeMakeStringOnly) {
		return maybeMakeStringOnly(impl);
	}

	return KeyValueStore.make(impl);
};

/**
 * Creates an Effect Layer that provides a KeyValueStore implementation using Bun's Redis client.
 * Handles connection lifecycle automatically - the connection is established when the layer is built
 * and closed when the scope is finalized.
 *
 * @param config - Redis connection configuration
 * @returns Effect Layer providing KeyValueStore
 *
 * @example
 * ```typescript
 * import { Effect } from "effect";
 * import { KeyValueStore } from "@effect/platform";
 * import { makeLayer } from "@vortexdd/effect-bun-redis";
 *
 * const RedisLive = makeLayer({
 *   host: "localhost",
 *   port: 6379,
 *   password: "secret",
 * });
 *
 * const program = Effect.gen(function* () {
 *   const store = yield* KeyValueStore.KeyValueStore;
 *   yield* store.set("key", "value");
 * });
 *
 * Effect.runPromise(program.pipe(Effect.provide(RedisLive)));
 * ```
 */
export const makeLayer = (
	config: ConnectionConfig,
): Layer.Layer<KeyValueStore.KeyValueStore, PlatformError.PlatformError> =>
	Layer.scoped(
		KeyValueStore.KeyValueStore,
		Effect.gen(function* () {
			const client = yield* Effect.acquireRelease(
				Effect.gen(function* () {
					const redis = createClient(config);
					yield* Effect.tryPromise({
						try: () => redis.connect(),
						catch: (error) => toPlatformError("connect", error),
					});
					return redis;
				}),
				(redis) =>
					Effect.sync(() => {
						redis.close();
					}),
			);

			return fromClient(client, {
				scanBatchSize: config.scanBatchSize,
			});
		}),
	);

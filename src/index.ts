import { KeyValueStore, Error as PlatformError } from "@effect/platform";
import type { RedisClient as BunRedisClientType } from "bun";
import { Context, Effect, Layer, Option } from "effect";

export type BunRedisClient = BunRedisClientType;

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

type RedisKey = Parameters<RedisClient["get"]>[0];
type RedisValue = Parameters<RedisClient["set"]>[1];

export interface RedisService {
	readonly connect: Effect.Effect<void, PlatformError.PlatformError>;
	readonly close: Effect.Effect<void>;
	readonly send: (
		command: string,
		args: Array<string>,
	) => Effect.Effect<unknown, PlatformError.PlatformError>;
	readonly get: (
		key: RedisKey,
	) => Effect.Effect<string | null, PlatformError.PlatformError>;
	readonly getBuffer: (
		key: RedisKey,
	) => Effect.Effect<Uint8Array | null, PlatformError.PlatformError>;
	readonly set: (
		key: RedisKey,
		value: RedisValue,
		...options: Array<string | number>
	) => Effect.Effect<"OK" | string | null, PlatformError.PlatformError>;
	readonly del: (
		...keys: Array<RedisKey>
	) => Effect.Effect<number, PlatformError.PlatformError>;
	readonly scan: (
		cursor: string | number,
		...options: Array<string | number>
	) => Effect.Effect<[string, Array<string>], PlatformError.PlatformError>;
}

export class Redis extends Context.Tag("@vortexdd/effect-redis-bun/Redis")<
	Redis,
	RedisService
>() {}

const DEFAULT_SCAN_BATCH_SIZE = 200;
const MAX_CLEAR_SWEEPS = 16;
const PLATFORM_MODULE = "KeyValueStore";

const toPlatformError = (
	method: string,
	cause: unknown,
): PlatformError.PlatformError =>
	new PlatformError.SystemError({
		module: PLATFORM_MODULE,
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

const readScan = (value: unknown): [string, Array<string>] => {
	if (!Array.isArray(value) || value.length < 2) {
		return ["0", []];
	}
	const cursor = String(value[0] ?? "0");
	const keysRaw = value[1];
	const keys = Array.isArray(keysRaw) ? keysRaw.map((key) => String(key)) : [];
	return [cursor, keys];
};

const wrapPromise = <A>(
	method: string,
	tryFn: () => Promise<A>,
): Effect.Effect<A, PlatformError.PlatformError> =>
	Effect.tryPromise({
		try: tryFn,
		catch: (error) => toPlatformError(method, error),
	});

/**
 * Builds a Redis connection URL from configuration.
 *
 * @param config - Connection configuration
 * @returns Redis connection URL (e.g., "redis://localhost:6379/0" or "rediss://user:pass@host:6380/1")
 */
export const buildUrl = (config: ConnectionConfig): string => {
	const username = readOptional(config.username);
	const password = readOptional(config.password);
	const database = config.database ?? 0;
	const protocol = config.tls ? "rediss" : "redis";

	const auth = username
		? password
			? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
			: `${encodeURIComponent(username)}@`
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
 */
export const createClient = (config: ConnectionConfig): BunRedisClient =>
	new Bun.RedisClient(buildUrl(config), {
		connectionTimeout: config.connectTimeoutMs ?? 5000,
		enableOfflineQueue: false,
		tls: config.tls ?? false,
	});

/**
 * Creates an Effect-based Redis service from a client.
 *
 * @param client - Bun Redis client
 * @returns Effect-based Redis service
 */
export const fromClientService = (client: RedisClient): RedisService => ({
	connect: wrapPromise("connect", () => client.connect()),
	close: Effect.sync(() => {
		client.close();
	}),
	send: (command, args) =>
		wrapPromise("send", () => client.send(command, args)),
	get: (key) => wrapPromise("get", () => client.get(key)),
	getBuffer: (key) => wrapPromise("getBuffer", () => client.getBuffer(key)),
	set: (key, value, ...options) =>
		wrapPromise(
			"set",
			async () =>
				Reflect.apply(client.set, client, [key, value, ...options]) as Promise<
					"OK" | string | null
				>,
		),
	del: (...keys) => wrapPromise("del", () => client.del(...keys)),
	scan: (cursor, ...options) => {
		const scan = client.scan;
		return scan
			? wrapPromise(
					"scan",
					async () =>
						Reflect.apply(scan, client, [cursor, ...options]) as Promise<
							[string, Array<string>]
						>,
				)
			: wrapPromise("scan", () =>
					client
						.send("SCAN", [
							String(cursor),
							...options.map((option) => String(option)),
						])
						.then(readScan),
				);
	},
});

/**
 * Creates a KeyValueStore implementation from an Effect-based Redis service.
 *
 * @param redis - Effect-based Redis service
 * @param options - Optional configuration for scan operations
 * @returns KeyValueStore implementation
 */
export const fromService = (
	redis: RedisService,
	options?: { readonly scanBatchSize?: number },
): KeyValueStore.KeyValueStore => {
	const scanBatchSize = options?.scanBatchSize ?? DEFAULT_SCAN_BATCH_SIZE;
	const count = scanBatchSize > 0 ? scanBatchSize : DEFAULT_SCAN_BATCH_SIZE;
	const getDbSize = (): Effect.Effect<number, PlatformError.PlatformError> =>
		redis.send("DBSIZE", []).pipe(
			Effect.flatMap((value) => {
				const parsed = typeof value === "number" ? value : Number(value);
				if (!Number.isInteger(parsed) || parsed < 0) {
					return Effect.fail(
						toPlatformError(
							"dbsize",
							new TypeError(`Invalid DBSIZE response: ${String(value)}`),
						),
					);
				}
				return Effect.succeed(parsed);
			}),
		);

	const impl: StringStoreImpl = {
		get: (key) =>
			redis.get(key).pipe(Effect.map((value) => Option.fromNullable(value))),
		getUint8Array: (key) =>
			redis
				.getBuffer(key)
				.pipe(Effect.map((value) => Option.fromNullable(value ?? null))),
		set: (key, value) => redis.set(key, value).pipe(Effect.asVoid),
		remove: (key) => redis.del(key).pipe(Effect.asVoid),
		clear: Effect.gen(function* () {
			for (let sweep = 0; sweep < MAX_CLEAR_SWEEPS; sweep += 1) {
				let cursor = "0";
				do {
					const [nextCursor, keys] = yield* redis.scan(
						cursor,
						"MATCH",
						"*",
						"COUNT",
						count,
					);
					cursor = nextCursor;
					if (keys.length > 0) {
						yield* redis.del(...keys);
					}
				} while (cursor !== "0");

				const remaining = yield* getDbSize();
				if (remaining === 0) {
					return;
				}
			}

			return yield* Effect.fail(
				toPlatformError(
					"clear",
					new Error(
						`Unable to clear Redis keys after ${MAX_CLEAR_SWEEPS} sweeps. Concurrent writes may still be in progress.`,
					),
				),
			);
		}),
		size: getDbSize(),
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
 * Creates a KeyValueStore implementation from a Redis client.
 *
 * @param client - Bun Redis client
 * @param options - Optional configuration for scan operations
 * @returns KeyValueStore implementation
 */
export const fromClient = (
	client: RedisClient,
	options?: { readonly scanBatchSize?: number },
): KeyValueStore.KeyValueStore =>
	fromService(fromClientService(client), options);

const acquireClient = (config: ConnectionConfig) =>
	Effect.acquireRelease(
		Effect.gen(function* () {
			const redis = createClient(config);
			yield* wrapPromise("connect", () => redis.connect());
			return redis as RedisClient;
		}),
		(redis) =>
			Effect.sync(() => {
				redis.close();
			}),
	);

/**
 * Creates an Effect Layer that provides the Effect-based Redis service.
 *
 * @param config - Redis connection configuration
 * @returns Effect Layer providing Redis
 */
export const makeRedisLayer = (
	config: ConnectionConfig,
): Layer.Layer<Redis, PlatformError.PlatformError> =>
	Layer.scoped(Redis, Effect.map(acquireClient(config), fromClientService));

/**
 * Creates an Effect Layer that derives a KeyValueStore from an already-provided Redis service.
 *
 * @param options - Optional configuration for scan operations
 * @returns Effect Layer providing KeyValueStore, requiring Redis
 */
export const layerFromRedis = (options?: {
	readonly scanBatchSize?: number;
}): Layer.Layer<KeyValueStore.KeyValueStore, never, Redis> =>
	Layer.effect(
		KeyValueStore.KeyValueStore,
		Effect.map(Redis, (redis) => fromService(redis, options)),
	);

/**
 * Creates an Effect Layer that provides a KeyValueStore backed by Redis.
 *
 * @param config - Redis connection configuration
 * @returns Effect Layer providing KeyValueStore
 */
export const makeKeyValueStoreLayer = (
	config: ConnectionConfig,
): Layer.Layer<KeyValueStore.KeyValueStore, PlatformError.PlatformError> =>
	Layer.provide(
		layerFromRedis({
			scanBatchSize: config.scanBatchSize,
		}),
		makeRedisLayer(config),
	);

export const makeLayer = makeKeyValueStoreLayer;

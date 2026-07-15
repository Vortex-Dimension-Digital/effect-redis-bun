import { KeyValueStore, Error as PlatformError } from "@effect/platform";
import type { RedisClient as BunRedisClientType } from "bun";
import { Context, Data, Effect, Layer, Option } from "effect";

export type BunRedisClient = BunRedisClientType;

/**
 * The server rejected a command with an error reply.
 *
 * `code` is the reply's error code — the leading uppercase token of the
 * message (e.g. `"ERR"`, `"WRONGTYPE"`, `"NOAUTH"`, `"MOVED"`), and
 * `message` is the remainder of the reply.
 *
 * @example
 * ```typescript
 * redis.get("possibly-a-list").pipe(
 *   Effect.catchTag("RedisCommandError", (error) =>
 *     error.code === "WRONGTYPE" ? Effect.succeed(null) : Effect.fail(error),
 *   ),
 * )
 * ```
 */
export class RedisCommandError extends Data.TaggedError("RedisCommandError")<{
	readonly command: string;
	readonly code: string;
	readonly message: string;
	readonly cause: unknown;
}> {}

/**
 * The operation never produced a server reply: connection refused/closed,
 * timeout, authentication, client-side, or transport failure. `code` retains
 * the underlying client error code when one is available.
 */
export class RedisConnectionError extends Data.TaggedError(
	"RedisConnectionError",
)<{
	readonly command: string;
	/** The error code reported by Bun or the underlying client, when available. */
	readonly code: string | undefined;
	readonly message: string;
	readonly cause: unknown;
}> {}

export type RedisError = RedisCommandError | RedisConnectionError;

// Bun currently reports RESP error replies with ERR_REDIS_INVALID_RESPONSE
// while preserving the server's raw reply in `message`. Older Bun versions
// and compatible clients may omit the client code, so parsing the reply is
// still required as a fallback.
const BUN_REPLY_ERROR_CODES = new Set([
	"ERR_REDIS_AUTHENTICATION_FAILED",
	"ERR_REDIS_INVALID_COMMAND",
	"ERR_REDIS_INVALID_RESPONSE",
]);
const ERROR_REPLY = /^([A-Z][A-Z0-9_-]*)(?:[ \t]+([\s\S]*))?$/;

const readStringProperty = (
	value: unknown,
	property: "code" | "message",
): string | undefined => {
	if (
		value === null ||
		(typeof value !== "object" && typeof value !== "function")
	) {
		return undefined;
	}
	try {
		const field = Reflect.get(value, property);
		return typeof field === "string" && field.length > 0 ? field : undefined;
	} catch {
		return undefined;
	}
};

const errorMessage = (cause: unknown): string => {
	const message = readStringProperty(cause, "message");
	if (message !== undefined) {
		return message;
	}
	try {
		return String(cause ?? "Unknown error");
	} catch {
		return "Unknown error";
	}
};

const connectionError = (
	command: string,
	cause: unknown,
): RedisConnectionError =>
	new RedisConnectionError({
		command,
		code: readStringProperty(cause, "code"),
		message: errorMessage(cause),
		cause,
	});

const classifyCommandError = (command: string, cause: unknown): RedisError => {
	const message = errorMessage(cause);
	const clientCode = readStringProperty(cause, "code");
	const reply = ERROR_REPLY.exec(message);
	const replyCode = reply?.[1];
	// RESP allows code-only error replies (no text after the prefix), so a
	// bare token counts as a reply only when the client code confirms it came
	// from the server; without a client code we additionally require reply
	// text to avoid mistaking terse transport errors ("TIMEOUT") for replies.
	const hasReplyMessage = (reply?.[2]?.length ?? 0) > 0;
	if (
		replyCode !== undefined &&
		(BUN_REPLY_ERROR_CODES.has(clientCode ?? "") ||
			(clientCode === undefined && hasReplyMessage))
	) {
		return new RedisCommandError({
			command,
			code: replyCode,
			message: reply?.[2] ?? "",
			cause,
		});
	}
	return connectionError(command, cause);
};

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
	readonly connect: Effect.Effect<void, RedisConnectionError>;
	readonly close: Effect.Effect<void>;
	readonly send: (
		command: string,
		args: Array<string>,
	) => Effect.Effect<unknown, RedisError>;
	readonly get: (key: RedisKey) => Effect.Effect<string | null, RedisError>;
	readonly getBuffer: (
		key: RedisKey,
	) => Effect.Effect<Uint8Array | null, RedisError>;
	readonly set: (
		key: RedisKey,
		value: RedisValue,
		...options: Array<string | number>
	) => Effect.Effect<"OK" | string | null, RedisError>;
	readonly del: (...keys: Array<RedisKey>) => Effect.Effect<number, RedisError>;
	readonly scan: (
		cursor: string | number,
		...options: Array<string | number>
	) => Effect.Effect<[string, Array<string>], RedisError>;
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

const wrapCommand = <A>(
	command: string,
	tryFn: () => Promise<A>,
): Effect.Effect<A, RedisError> =>
	Effect.tryPromise({
		try: tryFn,
		catch: (error) => classifyCommandError(command, error),
	});

const wrapConnection = <A>(
	command: string,
	tryFn: () => Promise<A>,
): Effect.Effect<A, RedisConnectionError> =>
	Effect.tryPromise({
		try: tryFn,
		catch: (error) => connectionError(command, error),
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
	connect: wrapConnection("CONNECT", () => client.connect()),
	close: Effect.sync(() => {
		client.close();
	}),
	send: (command, args) =>
		wrapCommand(command.toUpperCase(), () => client.send(command, args)),
	get: (key) => wrapCommand("GET", () => client.get(key)),
	getBuffer: (key) => wrapCommand("GET", () => client.getBuffer(key)),
	set: (key, value, ...options) =>
		wrapCommand(
			"SET",
			async () =>
				Reflect.apply(client.set, client, [key, value, ...options]) as Promise<
					"OK" | string | null
				>,
		),
	del: (...keys) => wrapCommand("DEL", () => client.del(...keys)),
	scan: (cursor, ...options) => {
		const scan = client.scan;
		return scan
			? wrapCommand(
					"SCAN",
					async () =>
						Reflect.apply(scan, client, [cursor, ...options]) as Promise<
							[string, Array<string>]
						>,
				)
			: wrapCommand("SCAN", () =>
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
	// The KeyValueStore contract fails with PlatformError; the typed RedisError
	// is preserved as its cause.
	const asKvsError =
		(method: string) =>
		(error: RedisError): PlatformError.PlatformError =>
			toPlatformError(method, error);
	const getDbSize = (
		method: "clear" | "size",
	): Effect.Effect<number, PlatformError.PlatformError> =>
		redis.send("DBSIZE", []).pipe(
			Effect.mapError(asKvsError(method)),
			Effect.flatMap((value) => {
				const parsed = typeof value === "number" ? value : Number(value);
				if (!Number.isInteger(parsed) || parsed < 0) {
					return Effect.fail(
						toPlatformError(
							method,
							new TypeError(`Invalid DBSIZE response: ${String(value)}`),
						),
					);
				}
				return Effect.succeed(parsed);
			}),
		);

	const impl: StringStoreImpl = {
		get: (key) =>
			redis.get(key).pipe(
				Effect.mapError(asKvsError("get")),
				Effect.map((value) => Option.fromNullable(value)),
			),
		getUint8Array: (key) =>
			redis.getBuffer(key).pipe(
				Effect.mapError(asKvsError("getUint8Array")),
				Effect.map((value) => Option.fromNullable(value ?? null)),
			),
		set: (key, value) =>
			redis
				.set(key, value)
				.pipe(Effect.mapError(asKvsError("set")), Effect.asVoid),
		remove: (key) =>
			redis.del(key).pipe(Effect.mapError(asKvsError("remove")), Effect.asVoid),
		clear: Effect.gen(function* () {
			for (let sweep = 0; sweep < MAX_CLEAR_SWEEPS; sweep += 1) {
				let cursor = "0";
				do {
					const [nextCursor, keys] = yield* redis
						.scan(cursor, "MATCH", "*", "COUNT", count)
						.pipe(Effect.mapError(asKvsError("clear")));
					cursor = nextCursor;
					if (keys.length > 0) {
						yield* redis
							.del(...keys)
							.pipe(Effect.mapError(asKvsError("clear")));
					}
				} while (cursor !== "0");

				const remaining = yield* getDbSize("clear");
				if (remaining === 0) {
					return;
				}
			}

			return yield* toPlatformError(
				"clear",
				new Error(
					`Unable to clear Redis keys after ${MAX_CLEAR_SWEEPS} sweeps. Concurrent writes may still be in progress.`,
				),
			);
		}),
		size: getDbSize("size"),
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
			yield* wrapConnection("CONNECT", () => redis.connect());
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
): Layer.Layer<Redis, RedisConnectionError> =>
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
		Layer.mapError(makeRedisLayer(config), (error) =>
			toPlatformError("connect", error),
		),
	);

export const makeLayer = makeKeyValueStoreLayer;

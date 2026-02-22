/**
 * Prefix a key with a namespace to avoid collisions between abstractions.
 *
 * @example
 * prefixKey("rl", "api:login") // => "rl:api:login"
 * prefixKey("cache", "user:42") // => "cache:user:42"
 */
export function prefixKey(prefix: string, key: string): string {
	return `${prefix}:${key}`;
}

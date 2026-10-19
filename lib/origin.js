/**
 * Public-origin and shared-secret helpers for the remote-access row.
 *
 * These are pure functions so the plugin's decisions (what counts as a valid
 * public origin, whether a request carries the proxy's secret, which origin a
 * login redirect should use) are testable without binding a socket or
 * assembling a DSH context.
 * @module @local/dsh-remote-access/lib/origin
 */
import { timingSafeEqual } from 'node:crypto';

/** Read one request header, tolerating Node's string-array form. */
export function headerValue(headers, name) {
	const value = headers === undefined ? undefined : headers[name];
	if (typeof value === 'string') return value;
	if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
	return undefined;
}

/**
 * Canonicalize the configured public origin.
 *
 * Only a bare `http(s)://host[:port]` is accepted: DSH exchanges a launch token
 * at the root path only, so an origin carrying a path, query, or hash would
 * redirect to a URL that can never mint a browser session. Anything parsable
 * but non-canonical is refused instead of silently rewritten.
 * @param {string} value - configured `publicOrigin`, possibly empty.
 * @returns {string} the canonical origin, or `''` when unset.
 * @throws {Error} when the value is not an absolute http(s) origin.
 */
export function normalizePublicOrigin(value) {
	if (typeof value !== 'string') throw new Error(`remote-access: publicOrigin must be a string, got ${typeof value}`);
	if (value === '') return '';
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`remote-access: publicOrigin ${JSON.stringify(value)} is not an absolute URL such as https://dsh.example.com`);
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new Error(`remote-access: publicOrigin ${JSON.stringify(value)} must use http or https, not ${parsed.protocol}`);
	}
	if (parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
		throw new Error(`remote-access: publicOrigin ${JSON.stringify(value)} must be a bare origin without credentials, path, query, or hash`);
	}
	return parsed.origin;
}

/**
 * Constant-time comparison of the proxy's injected secret with the configured
 * one. A mismatch in length is a mismatch, not a throw.
 * @param {unknown} actual - value the request carried.
 * @param {string} expected - configured secret.
 * @returns {boolean} true only for an exact byte match.
 */
export function sameSecret(actual, expected) {
	if (typeof actual !== 'string' || actual === '') return false;
	const left = Buffer.from(actual, 'utf8');
	const right = Buffer.from(expected, 'utf8');
	return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

/**
 * The origin a browser talks to when it reaches this host through the proxy.
 *
 * The configured origin wins. Otherwise the request's own `Host` is used with
 * `X-Forwarded-Proto` when the proxy reported http or https, and https
 * otherwise: a login redirect must not silently downgrade to plain http.
 * @param {Record<string, unknown>} headers - request headers.
 * @param {string} publicOrigin - normalized configured origin, or `''`.
 * @returns {string | undefined} the origin, or undefined when the input cannot form one.
 */
export function loginOrigin(headers, publicOrigin) {
	if (publicOrigin !== '') return publicOrigin;
	const host = headerValue(headers, 'host');
	if (host === undefined || host === '') return undefined;
	const forwarded = headerValue(headers, 'x-forwarded-proto');
	const scheme = forwarded === 'http' || forwarded === 'https' ? forwarded : 'https';
	let parsed;
	try {
		parsed = new URL(`${scheme}://${host}`);
	} catch {
		return undefined;
	}
	if (parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') return undefined;
	return parsed.origin;
}

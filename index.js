/**
 * Remote access for a DSH Web surface that a reverse proxy on another machine
 * forwards to browsers.
 *
 * The row is inert unless the run declares a remote authority: the launcher's
 * `--trusted-host` is its switch. Without it, nothing is mounted and nothing is
 * logged, so a plain local `dsh web` behaves as if the bundle were absent.
 *
 * With the switch on, the row adds two things to a Web profile that binds a
 * concrete LAN address (`dsh web --host <address>`; the launcher rejects
 * wildcard addresses):
 *
 * 1. Startup diagnostics — whether the bind is reachable from another machine
 *    and whether the configured public authority is accepted by the `/api`
 *    fence.
 * 2. A session handoff — the reverse proxy presents an operator-chosen `token`
 *    on one dedicated path; the row mints the DSH browser session in-process
 *    through the host's own exchange, so the per-process launch token never
 *    reaches the proxy, the browser, or a log.
 *
 * The module deliberately imports nothing outside its own directory: a bundle
 * installed from a local path is linked into the profile, and package
 * specifiers such as `@deepseek-ai/*` do not resolve from that location.
 * @module @local/dsh-remote-access
 */
import { headerValue, loginOrigin, normalizePublicOrigin, sameSecret } from './lib/origin.js';

/** Stable Cordis plugin name. */
export const name = 'remote-access';

/** Services required before the row can report anything. */
export const inject = ['webServer', 'webStartup'];

/** Exact path the reverse proxy calls to obtain a browser session. */
export const LOGIN_PATH = '/__dsh/remote/login';

/** Shortest accepted token. Longer is better: this value alone gates this host. */
export const MIN_TOKEN_BYTES = 8;

/** Row-config fields and their defaults. */
const CONFIG_DEFAULTS = Object.freeze({
	publicOrigin: '',
	token: '',
	tokenHeader: 'X-DSH-Remote-Token',
});

/**
 * Apply defaults and type checks to the row config.
 *
 * The row declares no schema: a schema needs `@deepseek-ai/schemastery`, which
 * a linked bundle cannot resolve at runtime, and a silent no-op row is worse
 * than a loud failure here.
 * @param {unknown} config - raw row config from the composition.
 * @returns {{ publicOrigin: string, token: string, tokenHeader: string }} resolved config.
 * @throws {Error} when a supplied field is not a string.
 */
function resolveConfig(config) {
	const supplied = config ?? {};
	if (typeof supplied !== 'object') throw new Error('remote-access: row config must be a mapping');
	const resolved = { ...CONFIG_DEFAULTS };
	for (const key of Object.keys(CONFIG_DEFAULTS)) {
		const value = supplied[key];
		if (value === undefined) continue;
		if (typeof value !== 'string') throw new Error(`remote-access: ${key} must be a string, got ${typeof value}`);
		resolved[key] = value;
	}
	return resolved;
}

/**
 * Whether a bind address only accepts connections from this machine.
 * @param {string} host - the Web server's configured bind address.
 * @returns {boolean} true for IPv6 loopback and any 127/8 IPv4 address.
 */
function isLoopbackBind(host) {
	if (typeof host !== 'string') return false;
	if (host === '::1') return true;
	const parts = host.split('.');
	return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

/**
 * Whether a configured origin is already an authority this host serves.
 * Connection answers 403 for an untrusted authority and 401 for a trusted one
 * without a session, so the fence itself is the check; nothing is re-derived.
 * @param connection - the Host `connection` service.
 * @param origin - normalized public origin.
 * @returns {boolean} true when the fence accepts the authority.
 */
function trustedOrigin(connection, origin) {
	const authority = new URL(origin).host;
	try {
		return connection.requestRejection({ headers: { host: authority } }) !== 403;
	} catch {
		return false;
	}
}

/**
 * Mint the browser session through the host's own token exchange, in process.
 *
 * `authorizeIndex` exchanges the process launch token for a signed cookie and
 * writes it through the supplied response. Calling it with a synthetic request
 * therefore yields the exact `Set-Cookie` value the browser needs, without the
 * launch token ever being sent over a socket or shown to an operator.
 * @param connection - the Host `connection` service.
 * @param authority - request authority the cookie must be bound to.
 * @param launchToken - this process's launch token.
 * @returns {{ ok: true, cookie?: string } | { ok: false }} the cookie to relay,
 *   `ok: true` with no cookie when the request was already authenticated, or
 *   `ok: false` when the host refused to mint one.
 */
function mintSession(connection, authority, launchToken) {
	const captured = [];
	const response = {
		writeHead(_status, headers) {
			const value = headers === undefined ? undefined : headers['set-cookie'];
			if (typeof value === 'string') captured.push(value);
			else if (Array.isArray(value)) for (const entry of value) if (typeof entry === 'string') captured.push(entry);
			return response;
		},
		end() {},
	};
	let admitted;
	try {
		admitted = connection.authorizeIndex(
			{ method: 'GET', url: `/?token=${encodeURIComponent(launchToken)}`, headers: { host: authority } },
			response,
		);
	} catch {
		return { ok: false };
	}
	if (admitted === true) return { ok: true };
	return captured.length === 0 ? { ok: false } : { ok: true, cookie: captured[0] };
}

/**
 * Mount the capability.
 * @param ctx - Cordis context carrying `webServer` and `webStartup`.
 * @param config - raw row config.
 */
export function apply(ctx, config) {
	const settings = resolveConfig(config);
	const publicOrigin = normalizePublicOrigin(settings.publicOrigin);
	const token = settings.token;
	const headerName = settings.tokenHeader.toLowerCase();
	const host = ctx.webServer.host;
	const port = ctx.webServer.port;
	const trustedHosts = Array.isArray(ctx.webStartup?.trustedHosts) ? ctx.webStartup.trustedHosts : [];

	if (token !== '') {
		const bytes = Buffer.byteLength(token, 'utf8');
		if (bytes < MIN_TOKEN_BYTES) {
			throw new Error(`remote-access: token must be at least ${MIN_TOKEN_BYTES} bytes, got ${bytes}`);
		}
	}

	// The launcher's `--trusted-host` is the switch. A run that declares no
	// remote authority gets nothing mounted and no log line, so a plain local
	// `dsh web` behaves exactly as it does without the bundle.
	if (trustedHosts.length === 0) {
		if (token !== '' || publicOrigin !== '') {
			ctx.logger.warn('remote-access: row configured, but this run declared no --trusted-host, so remote access stays off; add --trusted-host <authority> to enable it');
		}
		return;
	}

	if (isLoopbackBind(host)) {
		ctx.logger.warn(`remote-access: the Web server is bound to ${host}, so only a proxy on this same machine can reach it; for a proxy on another machine start dsh with --host <this machine's LAN address> (wildcard addresses are rejected)`);
	} else {
		ctx.logger.info(`remote-access: listening on ${host}:${port}; a reverse proxy on another machine can reach it`);
	}

	ctx.inject(['connection'], (connectionCtx) => {
		const connection = connectionCtx.connection;
		if (publicOrigin !== '') {
			const authority = new URL(publicOrigin).host;
			if (trustedOrigin(connection, publicOrigin)) {
				connectionCtx.logger.info(`remote-access: public entry ${publicOrigin}/ — the proxy's session exchange is ${token === '' ? 'off' : 'enabled'}`);
			} else {
				connectionCtx.logger.warn(`remote-access: ${authority} is not a trusted authority, so the browser's /api calls would be rejected with 403; start dsh with --trusted-host ${authority}`);
			}
		}
		if (token === '') return;

		connectionCtx.effect(
			() =>
				connectionCtx.webServer.register({
					kind: 'exact',
					path: LOGIN_PATH,
					handler: async (req, res) => {
						// Every failure is a bare 404: the route stays indistinguishable
						// from an absent one, so it cannot be probed for existence.
						const refuse = () => {
							res.writeHead(404);
							res.end();
						};
						if (req.method !== 'GET') {
							refuse();
							return;
						}
						if (!sameSecret(headerValue(req.headers, headerName), token)) {
							refuse();
							return;
						}
						const origin = loginOrigin(req.headers, publicOrigin);
						if (origin === undefined) {
							refuse();
							return;
						}
						// The cookie is bound to the authority the host itself sees.
						// That is the public origin in the ordinary case; a local proxy
						// that rewrites `Host` makes them differ, and this is the one DSH
						// will check on every later request.
						const hostHeader = headerValue(req.headers, 'host');
						if (hostHeader === undefined || hostHeader === '') {
							refuse();
							return;
						}
						let exchangeAuthority;
						try {
							exchangeAuthority = new URL(`http://${hostHeader}`).host;
						} catch {
							refuse();
							return;
						}
						let launchToken;
						try {
							launchToken = new URL(connection.authenticatedUrl(`${origin}/`)).searchParams.get('token');
						} catch {
							refuse();
							return;
						}
						if (launchToken === null || launchToken === '') {
							refuse();
							return;
						}
						const minted = mintSession(connection, exchangeAuthority, launchToken);
						if (!minted.ok) {
							refuse();
							return;
						}
						const headers = {
							'cache-control': 'no-store',
							location: '/',
							'referrer-policy': 'no-referrer',
						};
						if (minted.cookie !== undefined) headers['set-cookie'] = minted.cookie;
						connectionCtx.logger.info(`remote-access: minted a browser session for ${origin}`);
						res.writeHead(303, headers);
						res.end();
					},
				}),
			'remote-access: login route',
		);
	});
}

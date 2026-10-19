import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { apply, LOGIN_PATH, MIN_TOKEN_BYTES } from '../index.js';

const TOKEN = 't'.repeat(MIN_TOKEN_BYTES);
const LAUNCH = 'launch-token';

function rowConfig(overrides = {}) {
	return {
		publicOrigin: '',
		token: '',
		tokenHeader: 'X-DSH-Remote-Token',
		...overrides,
	};
}

/**
 * A minimal stand-in for the Cordis context `apply` needs: the Web server, an
 * optional Connection (whose token exchange is reproduced faithfully enough to
 * capture the cookie), a logger, effect scoping, and `inject` delivering the
 * same context as if Connection were present.
 */
function createHarness(options = {}) {
	const state = { routes: [], warnings: [], infos: [], exchanges: [] };
	const trusted = options.trusted ?? [];
	const connection = {
		requestRejection({ headers }) {
			return trusted.includes(headers.host) ? 401 : 403;
		},
		authenticatedUrl(baseUrl) {
			return `${baseUrl}?token=${LAUNCH}`;
		},
		authorizeIndex(request, response) {
			state.exchanges.push(request);
			if (options.mintFails === true) throw new Error('mint refused');
			if (options.admitted === true) return true;
			const launch = new URL(request.url, 'http://x').searchParams.get('token');
			if (launch !== LAUNCH) {
				response.writeHead(401, {});
				response.end();
				return false;
			}
			response.writeHead(303, {
				'set-cookie': `dsh-auth-${request.headers.host}=session; Path=/; HttpOnly; SameSite=Strict`,
				location: './',
			});
			response.end();
			return false;
		},
	};
	const ctx = {
		webServer: {
			host: options.host ?? '192.168.0.32',
			port: options.port ?? 3080,
			register(route) {
				state.routes.push(route);
				return () => {};
			},
		},
		webStartup: {
			trustedHosts: options.trustedHosts ?? ['dsh.example.com'],
		},
		connection,
		logger: {
			info: (message) => state.infos.push(message),
			warn: (message) => state.warnings.push(message),
		},
		effect(factory) {
			return factory();
		},
		inject(_services, callback) {
			callback(ctx);
		},
	};
	return { ctx, state };
}

/** Drive one captured route handler with a synthetic request. */
async function call(route, { method = 'GET', headers = {} } = {}) {
	const seen = { status: undefined, headers: undefined, ended: false };
	const res = {
		writeHead(status, responseHeaders) {
			seen.status = status;
			seen.headers = responseHeaders;
		},
		end() {
			seen.ended = true;
		},
	};
	await route.handler({ method, headers, url: route.path }, res);
	return seen;
}

describe('startup diagnostics', () => {
	it('warns when the bind only accepts this machine', () => {
		const { ctx, state } = createHarness({ host: '127.0.0.1' });
		apply(ctx, rowConfig());
		assert.equal(state.warnings.length, 1);
		assert.match(state.warnings[0], /only a proxy on this same machine/u);
		assert.match(state.warnings[0], /--host/u);
	});

	it('reports a concrete interface bind as reachable', () => {
		const { ctx, state } = createHarness({ host: '192.168.0.32', port: 4000 });
		apply(ctx, rowConfig());
		assert.deepEqual(state.warnings, []);
		assert.match(state.infos[0], /listening on 192\.168\.0\.32:4000/u);
	});

	it('warns when the public origin is not a trusted authority', () => {
		const { ctx, state } = createHarness({ trusted: [] });
		apply(ctx, rowConfig({ publicOrigin: 'https://dsh.example.com' }));
		assert.equal(state.warnings.length, 1);
		assert.match(state.warnings[0], /not a trusted authority/u);
		assert.match(state.warnings[0], /--trusted-host dsh\.example\.com/u);
	});

	it('reports the public entry when the authority is trusted', () => {
		const { ctx, state } = createHarness({ trusted: ['dsh.example.com'] });
		apply(ctx, rowConfig({ publicOrigin: 'https://dsh.example.com', token: TOKEN }));
		assert.deepEqual(state.warnings, []);
		assert.match(state.infos.at(-1), /public entry https:\/\/dsh\.example\.com\//u);
		assert.match(state.infos.at(-1), /enabled/u);
	});
});

describe('config validation', () => {
	it('refuses a short token at load time', () => {
		const { ctx } = createHarness();
		assert.throws(() => apply(ctx, rowConfig({ token: 'short' })), /at least 8 bytes/u);
	});

	it('refuses a public origin carrying a path', () => {
		const { ctx } = createHarness();
		assert.throws(() => apply(ctx, rowConfig({ publicOrigin: 'https://dsh.example.com/app' })), /bare origin/u);
	});

	it('refuses a non-string field', () => {
		const { ctx } = createHarness();
		assert.throws(() => apply(ctx, rowConfig({ token: 42 })), /token must be a string/u);
	});

	it('applies defaults for a missing config', () => {
		const { ctx, state } = createHarness();
		apply(ctx);
		assert.deepEqual(state.routes, []);
		assert.equal(state.warnings.at(-1), undefined);
	});
});

describe('--trusted-host switch', () => {
	it('stays inert when the run declares no remote authority', () => {
		const { ctx, state } = createHarness({ trustedHosts: [] });
		apply(ctx, rowConfig({ token: TOKEN, publicOrigin: 'https://dsh.example.com' }));
		assert.deepEqual(state.routes, []);
		assert.deepEqual(state.infos, []);
		assert.equal(state.warnings.length, 1);
		assert.match(state.warnings[0], /no --trusted-host/u);
	});

	it('says nothing when nothing is configured either', () => {
		const { ctx, state } = createHarness({ trustedHosts: [] });
		apply(ctx, rowConfig());
		assert.deepEqual(state.routes, []);
		assert.deepEqual(state.infos, []);
		assert.deepEqual(state.warnings, []);
	});

	it('enables the handoff once a trusted host is declared', () => {
		const { ctx, state } = createHarness({ trusted: ['dsh.example.com'] });
		apply(ctx, rowConfig({ token: TOKEN, publicOrigin: 'https://dsh.example.com' }));
		assert.equal(state.routes.length, 1);
		assert.equal(state.warnings.length, 0);
	});
});

describe('session exchange', () => {
	it('mounts nothing without a token', () => {
		const { ctx, state } = createHarness();
		apply(ctx, rowConfig());
		assert.deepEqual(state.routes, []);
		assert.deepEqual(state.exchanges, []);
	});

	it('mounts one exact route when a token is set', () => {
		const { ctx, state } = createHarness();
		apply(ctx, rowConfig({ token: TOKEN }));
		assert.equal(state.routes.length, 1);
		assert.equal(state.routes[0].kind, 'exact');
		assert.equal(state.routes[0].path, LOGIN_PATH);
	});

	it('answers 404 for a missing, wrong, or non-GET request', async () => {
		const { ctx, state } = createHarness();
		apply(ctx, rowConfig({ token: TOKEN, publicOrigin: 'https://dsh.example.com' }));
		const route = state.routes[0];
		for (const request of [
			{},
			{ headers: { 'x-dsh-remote-token': `x${TOKEN}` } },
			{ headers: { 'x-dsh-remote-token': TOKEN.slice(1) } },
			{ method: 'POST', headers: { 'x-dsh-remote-token': TOKEN } },
		]) {
			const seen = await call(route, request);
			assert.equal(seen.status, 404);
			assert.equal(seen.ended, true);
		}
		assert.deepEqual(state.exchanges, []);
	});

	it('mints a session for the configured origin and sends the browser home', async () => {
		const { ctx, state } = createHarness();
		apply(ctx, rowConfig({ token: TOKEN, publicOrigin: 'https://dsh.example.com' }));
		const seen = await call(state.routes[0], {
			headers: { 'x-dsh-remote-token': TOKEN, host: 'dsh.example.com' },
		});

		assert.equal(seen.status, 303);
		assert.equal(seen.headers.location, '/');
		assert.equal(seen.headers['cache-control'], 'no-store');
		assert.match(seen.headers['set-cookie'], /^dsh-auth-dsh\.example\.com=session;/u);

		// The exchange is performed in process, against the browser's authority,
		// with this process's launch token — nothing is sent over a socket.
		assert.equal(state.exchanges.length, 1);
		assert.equal(state.exchanges[0].method, 'GET');
		assert.equal(state.exchanges[0].headers.host, 'dsh.example.com');
		assert.equal(state.exchanges[0].url, '/?token=launch-token');
	});

	it('binds the session to the authority the host sees, not the public origin', async () => {
		// A local proxy in front of a loopback-bound host rewrites `Host`; the
		// cookie must then be minted for the rewritten authority, or every later
		// request would fail the name check.
		const { ctx, state } = createHarness();
		apply(ctx, rowConfig({ token: TOKEN, publicOrigin: 'https://dsh.example.com' }));
		const seen = await call(state.routes[0], {
			headers: { 'x-dsh-remote-token': TOKEN, host: '127.0.0.1:3081' },
		});
		assert.equal(seen.status, 303);
		assert.match(seen.headers['set-cookie'], /^dsh-auth-127\.0\.0\.1:3081=session;/u);
		assert.equal(state.exchanges[0].headers.host, '127.0.0.1:3081');
	});

	it('derives the authority from the forwarded request when none is configured', async () => {
		const { ctx, state } = createHarness();
		apply(ctx, rowConfig({ token: TOKEN }));
		const seen = await call(state.routes[0], {
			headers: { 'x-dsh-remote-token': TOKEN, host: 'dsh.example.com', 'x-forwarded-proto': 'https' },
		});
		assert.equal(seen.status, 303);
		assert.equal(state.exchanges[0].headers.host, 'dsh.example.com');
	});

	it('sends a browser that already has a session home without a second cookie', async () => {
		const { ctx, state } = createHarness({ admitted: true });
		apply(ctx, rowConfig({ token: TOKEN, publicOrigin: 'https://dsh.example.com' }));
		const seen = await call(state.routes[0], {
			headers: { 'x-dsh-remote-token': TOKEN, host: 'dsh.example.com' },
		});
		assert.equal(seen.status, 303);
		assert.equal(seen.headers.location, '/');
		assert.equal(seen.headers['set-cookie'], undefined);
	});

	it('answers 404 when no origin can be formed', async () => {
		const { ctx, state } = createHarness();
		apply(ctx, rowConfig({ token: TOKEN }));
		const seen = await call(state.routes[0], { headers: { 'x-dsh-remote-token': TOKEN } });
		assert.equal(seen.status, 404);
	});

	it('answers 404 when the host refuses to mint a session', async () => {
		const { ctx, state } = createHarness({ mintFails: true });
		apply(ctx, rowConfig({ token: TOKEN, publicOrigin: 'https://dsh.example.com' }));
		const seen = await call(state.routes[0], {
			headers: { 'x-dsh-remote-token': TOKEN, host: 'dsh.example.com' },
		});
		assert.equal(seen.status, 404);
	});

	it('honours a renamed header', async () => {
		const { ctx, state } = createHarness();
		apply(ctx, rowConfig({ token: TOKEN, tokenHeader: 'X-Proxy-Token', publicOrigin: 'https://dsh.example.com' }));
		const refused = await call(state.routes[0], { headers: { 'x-dsh-remote-token': TOKEN } });
		const accepted = await call(state.routes[0], {
			headers: { 'x-proxy-token': TOKEN, host: 'dsh.example.com' },
		});
		assert.equal(refused.status, 404);
		assert.equal(accepted.status, 303);
	});
});

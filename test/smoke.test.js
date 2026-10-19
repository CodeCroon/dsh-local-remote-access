import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';

it('loads as a Loader plugin against the DSH installation', async () => {
	const plugin = await import('../index.js');
	assert.equal(plugin.name, 'remote-access');
	assert.deepEqual(plugin.inject, ['webServer', 'webStartup']);
	assert.equal(typeof plugin.apply, 'function');
	assert.equal(plugin.LOGIN_PATH, '/__dsh/remote/login');
	assert.equal(plugin.MIN_TOKEN_BYTES, 8);
});

it('imports nothing outside its own directory', async () => {
	// A bundle installed from a local path is linked into the profile, and
	// package specifiers such as `@deepseek-ai/*` do not resolve from there.
	// The row therefore has to stay dependency-free, or the profile fails to
	// load it with ERR_MODULE_NOT_FOUND.
	for (const file of ['../index.js', '../lib/origin.js']) {
		const source = await readFile(new URL(file, import.meta.url), 'utf8');
		const bare = [...source.matchAll(/from\s+['"]([^'"]+)['"]/gu)]
			.map((match) => match[1])
			.filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:'));
		assert.deepEqual(bare, [], `${file} must not import ${bare.join(', ')}`);
	}
});

it('adds its row without displacing the shipped remote-access row', async () => {
	const { composeEntries, loadOverlayPatches } = await import('@deepseek-ai/dsh-app-boot');
	const basePatch = fileURLToPath(new URL('../cordis.patch.yml', import.meta.resolve('@deepseek-ai/dsh-base')));
	const webAppPatch = fileURLToPath(new URL('../cordis.patch.yml', import.meta.resolve('@deepseek-ai/dsh-web-app')));
	const ownPatch = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url));

	const entries = composeEntries([
		loadOverlayPatches('dsh', basePatch),
		loadOverlayPatches('dsh', webAppPatch),
		loadOverlayPatches('dsh', ownPatch),
	]);

	// `dsh-base` owns `remote-access`: the Gateway requires its service.
	const shipped = entries.find((entry) => entry.id === 'remote-access');
	assert.equal(shipped.name, '@deepseek-ai/dsh-api-remote-access');

	const ours = entries.find((entry) => entry.id === 'local-remote-access');
	assert.equal(ours.name, '@local/dsh-remote-access');
	assert.deepEqual(ours.config, {
		publicOrigin: '',
		token: '',
		tokenHeader: 'X-DSH-Remote-Token',
	});

	// The Web server row still belongs to the shipped web bundle, so the
	// launcher's `--host` keeps deciding the bind.
	const webserver = entries.find((entry) => entry.id === 'webserver');
	assert.equal(webserver.name, '@deepseek-ai/dsh-host-webserver');
	assert.equal(webserver.config.host.__jsExpr, "ctx.webStartup.host ?? '127.0.0.1'");
});

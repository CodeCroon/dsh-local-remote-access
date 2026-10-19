/**
 * Dev-only module resolution for the smoke test.
 *
 * The package ships with no dependencies: at runtime DSH's profile resolution
 * supplies `@deepseek-ai/*` from the installation. This hook reproduces that
 * mapping outside DSH so the modules can be imported and asserted locally.
 * @module @local/dsh-remote-workspace/tools/dev-resolver
 */
const MODULES = (
	process.env.DSH_DEV_MODULES ?? 'C:/Users/Exascend/scoop/persist/nodejs/cache/_npx/1e7f6d9597241db0/node_modules'
).replaceAll('\\', '/');

const MODULES_URL = `file:///${MODULES.replace(/^\/+/u, '')}/`;

/**
 * Redirect `@deepseek-ai/*` specifiers into the installation's node_modules.
 * @param {string} specifier - requested module.
 * @param {{ parentURL?: string }} context - importing module.
 * @param {(specifier: string, context: object) => object} nextResolve - default resolver.
 * @returns {object} the resolved module.
 */
export function resolve(specifier, context, nextResolve) {
	if (specifier.startsWith('@deepseek-ai/') && !context.parentURL?.startsWith(MODULES_URL)) {
		return nextResolve(specifier, { ...context, parentURL: `${MODULES_URL}dev-resolver-base.mjs` });
	}
	return nextResolve(specifier, context);
}

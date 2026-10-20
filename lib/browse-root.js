/**
 * Browse-mode start directory for the remote-access row.
 *
 * DSH's in-app directory picker is deliberately rootless: its breadcrumbs walk
 * to the filesystem root and an absent `list()` path means the host account's
 * home directory. A remote deployment often wants the dialog to open at one
 * known directory instead, so this module wraps the composed `browse`
 * capability without changing DSH's own composition: the default path and the
 * listing's `home` anchor become the configured root, while navigation itself
 * stays unrestricted.
 *
 * The wrapper is applied and removed as one effect, so unloading the row
 * restores whatever `list` the picker had before it.
 * @module @local/dsh-remote-access/lib/browse-root
 */
import { posix, win32 } from 'node:path';

/** Marks a browse capability this module already wrapped, across module reloads. */
const WRAPPED = Symbol.for('@local/dsh-remote-access/browse-root');

/**
 * Assert and normalize the configured start directory.
 *
 * The browse backend refuses paths that are not fully qualified on the host
 * platform (Windows needs a drive letter or a complete UNC share; a rooted
 * drive-less path would resolve against the process's current drive), so the
 * same fence is applied here at load time instead of letting every dialog fail.
 * @param {unknown} value - configured `browseRoot`, possibly empty.
 * @param {NodeJS.Platform} platform - host platform, injectable for tests.
 * @returns {string} the normalized absolute path, or `''` when disabled.
 * @throws {Error} when the value is not a fully qualified absolute path.
 */
export function normalizeBrowseRoot(value, platform = process.platform) {
	if (typeof value !== 'string') throw new Error(`remote-access: browseRoot must be a string, got ${typeof value}`);
	if (value === '') return '';
	const fullyQualified = platform === 'win32'
		? win32.isAbsolute(value) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/u.test(value)
		: posix.isAbsolute(value);
	if (!fullyQualified) {
		throw new Error(`remote-access: browseRoot ${JSON.stringify(value)} must be a fully qualified absolute path (Windows: drive-qualified or complete UNC; POSIX: starting with /)`);
	}
	return platform === 'win32' ? win32.resolve(value) : posix.resolve(value);
}

/**
 * Point one browse capability's default listing at `root`.
 *
 * The controller reads `list` on every call, and the capability object is the
 * seam's stable handle, so replacing that one method changes the default
 * without recomposing DSH. The returned disposer restores the previous `list`;
 * a second live wrap updates the shared root and keeps the wrapper installed
 * until the last of its owners disposes.
 * @param {{ list: (path?: string, signal?: AbortSignal) => Promise<object> }} capability - composed `browse` capability.
 * @param {string} root - normalized absolute start directory.
 * @returns {() => void} restores the previous `list` once every owner is gone.
 */
export function applyBrowseRoot(capability, root) {
	let state = capability[WRAPPED];
	if (state === undefined) {
		state = { original: capability.list, root, owners: 0 };
		capability[WRAPPED] = state;
		capability.list = async (path, signal) => {
			const listing = await state.original.call(capability, path ?? state.root, signal);
			return { ...listing, home: state.root };
		};
	} else {
		state.root = root;
	}
	state.owners += 1;
	return () => {
		state.owners -= 1;
		if (state.owners > 0) return;
		if (capability[WRAPPED] !== state) return;
		delete capability[WRAPPED];
		capability.list = state.original;
	};
}

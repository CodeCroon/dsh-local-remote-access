import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyBrowseRoot, normalizeBrowseRoot } from '../lib/browse-root.js';

describe('normalizeBrowseRoot', () => {
	it('treats an empty value as disabled', () => {
		assert.equal(normalizeBrowseRoot('', 'win32'), '');
		assert.equal(normalizeBrowseRoot('', 'linux'), '');
	});

	it('accepts and normalizes fully qualified paths', () => {
		assert.equal(normalizeBrowseRoot('D:\\MyWorkSpace\\', 'win32'), 'D:\\MyWorkSpace');
		assert.equal(normalizeBrowseRoot('/srv/work/', 'linux'), '/srv/work');
		assert.ok(normalizeBrowseRoot('\\\\server\\share\\work', 'win32').startsWith('\\\\server\\share'));
	});

	it('refuses relative and drive-less forms', () => {
		assert.throws(() => normalizeBrowseRoot('relative', 'win32'), /fully qualified/u);
		assert.throws(() => normalizeBrowseRoot('\\foo', 'win32'), /fully qualified/u);
		assert.throws(() => normalizeBrowseRoot('C:foo', 'win32'), /fully qualified/u);
		assert.throws(() => normalizeBrowseRoot('relative', 'linux'), /fully qualified/u);
	});

	it('refuses a non-string value', () => {
		assert.throws(() => normalizeBrowseRoot(42), /must be a string/u);
	});
});

describe('applyBrowseRoot', () => {
	/** A browse capability whose listing records the path it was asked for. */
	function createCapability() {
		const calls = [];
		const capability = {
			async list(path) {
				calls.push(path);
				return { path: path ?? 'HOME', home: 'HOME', crumbs: [], entries: [], truncated: false };
			},
		};
		return { capability, calls };
	}

	it('defaults the listing path and home anchor to the root', async () => {
		const { capability, calls } = createCapability();
		const restore = applyBrowseRoot(capability, 'D:\\MyWorkSpace');

		const listing = await capability.list(undefined);
		assert.deepEqual(calls, ['D:\\MyWorkSpace']);
		assert.equal(listing.path, 'D:\\MyWorkSpace');
		assert.equal(listing.home, 'D:\\MyWorkSpace');
		restore();
	});

	it('keeps an explicit path while re-anchoring home', async () => {
		const { capability } = createCapability();
		const restore = applyBrowseRoot(capability, 'D:\\MyWorkSpace');

		const listing = await capability.list('E:\\other');
		assert.equal(listing.path, 'E:\\other');
		assert.equal(listing.home, 'D:\\MyWorkSpace');
		restore();
	});

	it('restores the original list once every owner is gone', async () => {
		const { capability } = createCapability();
		const original = capability.list;
		const restore = applyBrowseRoot(capability, 'D:\\MyWorkSpace');

		assert.notEqual(capability.list, original);
		restore();
		assert.equal(capability.list, original);

		const listing = await capability.list(undefined);
		assert.equal(listing.path, 'HOME');
		assert.equal(listing.home, 'HOME');
	});

	it('keeps the wrapper while another owner is still active', async () => {
		const { capability } = createCapability();
		const restoreOne = applyBrowseRoot(capability, 'D:\\one');
		const restoreTwo = applyBrowseRoot(capability, 'D:\\two');

		const listing = await capability.list(undefined);
		assert.equal(listing.path, 'D:\\two');

		restoreOne();
		const stillWrapped = await capability.list(undefined);
		assert.equal(stillWrapped.path, 'D:\\two');

		restoreTwo();
		const restored = await capability.list(undefined);
		assert.equal(restored.path, 'HOME');
	});
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { headerValue, loginOrigin, normalizePublicOrigin, sameSecret } from '../lib/origin.js';

describe('normalizePublicOrigin', () => {
	it('keeps an empty value empty', () => {
		assert.equal(normalizePublicOrigin(''), '');
	});

	it('canonicalizes scheme, host case, and a default port', () => {
		assert.equal(normalizePublicOrigin('https://DSH.Example.com/'), 'https://dsh.example.com');
		assert.equal(normalizePublicOrigin('https://dsh.example.com:443'), 'https://dsh.example.com');
		assert.equal(normalizePublicOrigin('http://10.0.0.5:8080'), 'http://10.0.0.5:8080');
	});

	it('rejects a value carrying anything beyond an origin', () => {
		assert.throws(() => normalizePublicOrigin('https://dsh.example.com/app'), /bare origin/u);
		assert.throws(() => normalizePublicOrigin('https://dsh.example.com/?token=x'), /bare origin/u);
		assert.throws(() => normalizePublicOrigin('https://dsh.example.com/#x'), /bare origin/u);
		assert.throws(() => normalizePublicOrigin('https://ops@dsh.example.com'), /bare origin/u);
	});

	it('rejects a non-http scheme and a non-URL value', () => {
		assert.throws(() => normalizePublicOrigin('ftp://dsh.example.com'), /http or https/u);
		assert.throws(() => normalizePublicOrigin('dsh.example.com'), /absolute URL/u);
	});
});

describe('sameSecret', () => {
	it('accepts only an exact byte match', () => {
		const secret = 'a'.repeat(32);
		assert.equal(sameSecret(secret, secret), true);
		assert.equal(sameSecret(`${secret}b`, secret), false);
		assert.equal(sameSecret(secret.slice(1), secret), false);
		assert.equal(sameSecret('', secret), false);
		assert.equal(sameSecret(undefined, secret), false);
	});
});

describe('loginOrigin', () => {
	it('prefers the configured origin', () => {
		assert.equal(loginOrigin({ host: 'internal:3080' }, 'https://dsh.example.com'), 'https://dsh.example.com');
	});

	it('derives the origin from the forwarded request', () => {
		assert.equal(loginOrigin({ host: 'dsh.example.com', 'x-forwarded-proto': 'https' }, ''), 'https://dsh.example.com');
		assert.equal(loginOrigin({ host: 'dsh.example.com', 'x-forwarded-proto': 'http' }, ''), 'http://dsh.example.com');
	});

	it('never downgrades to http without the proxy saying so', () => {
		assert.equal(loginOrigin({ host: 'dsh.example.com' }, ''), 'https://dsh.example.com');
		assert.equal(loginOrigin({ host: 'dsh.example.com', 'x-forwarded-proto': 'ftp' }, ''), 'https://dsh.example.com');
	});

	it('returns undefined when the host is missing or unusable', () => {
		assert.equal(loginOrigin({}, ''), undefined);
		assert.equal(loginOrigin({ host: '' }, ''), undefined);
		assert.equal(loginOrigin({ host: 'evil/x' }, ''), undefined);
	});
});

describe('headerValue', () => {
	it('reads the string form and the first array entry', () => {
		assert.equal(headerValue({ a: 'x' }, 'a'), 'x');
		assert.equal(headerValue({ a: ['x', 'y'] }, 'a'), 'x');
		assert.equal(headerValue({}, 'a'), undefined);
		assert.equal(headerValue(undefined, 'a'), undefined);
	});
});

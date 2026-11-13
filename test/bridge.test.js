/**
 * The bridge against a real Human Review server (the npm package, the same
 * version the plugin installs), in throwaway state folders: open a review
 * from Wheelhouse, the captain comments and sends with no worker listening,
 * the plugin sees the batch waiting with its feedback list, forwards it, and
 * a worker's poll takes it.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { targetKey as theirKey } from 'human-review/src/paths.js';
import { canonicalTarget, readServer, targetKey } from '../bridge/hr.mjs';
import { readTargets } from '../bridge/records.mjs';
import { serve } from '../bridge/serve.mjs';
import { status } from '../bridge/status.mjs';

const require = createRequire(import.meta.url);
const PKG = path.dirname(require.resolve('human-review/package.json'));
/** A file target: this test file itself. */
const THIS_FILE = new URL(import.meta.url).pathname;
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version;

const dir = fs.mkdtempSync(path.join(tmpdir(), 'hr-wheelhouse-'));
const state = path.join(dir, 'state');
const hrState = path.join(dir, 'hr-state');
let app;
let appUrl;
let bridge;
let base;
let key;

const listen = (server) =>
	new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/** A request with a chosen Host, which fetch does not allow. */
function get(url, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = http.get(url, { headers }, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (c) => (body += c));
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
		});
		req.on('error', reject);
	});
}

/** Human Review's own API, as the captain's tab uses it. */
async function hr(method, p, body) {
	const s = readServer(hrState);
	const r = await fetch(`http://127.0.0.1:${s.port}${p}`, {
		method,
		headers: { 'x-human-review-token': s.token, 'content-type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined
	});
	return r.json();
}

before(async () => {
	app = http.createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY' });
		res.end('<!doctype html><title>App</title><h1>Pricing</h1><p>Start your free trial</p>');
	});
	appUrl = `http://localhost:${await listen(app)}/pricing`;
	bridge = await serve({
		port: 0,
		state,
		hrState,
		pkg: PKG,
		version: VERSION,
		pluginVersion: '0.1.0'
	});
	base = `http://127.0.0.1:${bridge.address().port}`;
	key = fs.readFileSync(path.join(state, 'key'), 'utf8').trim();
});

after(() => {
	bridge?.close();
	app?.close();
	const s = readServer(hrState);
	if (s?.pid) {
		try {
			process.kill(s.pid, 'SIGTERM');
		} catch {
			// already gone
		}
	}
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('the bridge with Human Review', () => {
	it('keys targets exactly as Human Review does', () => {
		for (const t of [appUrl, `${appUrl}#top`, 'http://127.0.0.1:9/x?y=1', THIS_FILE]) {
			assert.equal(targetKey(t), theirKey(canonicalTarget(t).value));
		}
	});

	it('answers its health check as itself, and only on loopback', async () => {
		const h = await (await fetch(`${base}/health`)).json();
		assert.equal(h.service, 'wheelhouse-human-review-bridge');
		assert.equal(h.humanReview, VERSION);
		const foreign = await get(`${base}/health`, { host: 'review.example.com' });
		assert.equal(foreign.status, 403);
	});

	it('opens nothing without the key', async () => {
		const r = await get(`${base}/open?target=${encodeURIComponent(appUrl)}&key=nope`);
		assert.equal(r.status, 403);
		assert.equal(readServer(hrState), null, 'Human Review was not started');
	});

	it('asks for a page when none is named', async () => {
		const r = await get(`${base}/open?target=%20&key=${key}`);
		assert.equal(r.status, 400);
		assert.match(r.body, /Name a page to review/);
		assert.equal(readServer(hrState), null, 'Human Review was not started');
	});

	it('refuses an address Human Review cannot review', async () => {
		const r = await get(
			`${base}/open?target=${encodeURIComponent('https://example.com/')}&key=${key}`
		);
		assert.equal(r.status, 400);
		assert.match(r.body, /this computer only/);
	});

	let session;
	it('starts Human Review and sends the tab to a new review of the preview', async () => {
		const r = await get(
			`${base}/open?target=${encodeURIComponent(appUrl)}&task=lumen-pricing&key=${key}`
		);
		assert.equal(r.status, 302, r.body);
		const s = readServer(hrState);
		const loc = new URL(r.headers.location);
		assert.equal(loc.origin, `http://127.0.0.1:${s.port}`);
		assert.match(loc.pathname, /^\/s\/s_[a-f0-9]+$/);
		session = loc.pathname.slice(3);
		const page = await get(loc.href);
		assert.equal(page.status, 200);
		assert.equal(page.headers['x-frame-options'], undefined);
	});

	it('shows the review open for the task, with nothing waiting yet', async () => {
		const v = await status({
			state,
			hrState,
			version: VERSION,
			task: { id: 'lumen-pricing', preview: appUrl }
		});
		assert.equal(v.humanReview.running, true);
		assert.ok(v.bridge);
		assert.equal(v.targets.length, 1);
		const [t] = v.targets;
		assert.equal(t.target, appUrl);
		assert.equal(t.task, 'lumen-pricing');
		assert.equal(t.reviewOpen, true);
		assert.equal(t.waiting, false);
		assert.equal(t.feedback, null);
	});

	it('sees the captain’s Send waiting, with the list to forward', async () => {
		const k = targetKey(appUrl);
		await hr('POST', `/api/page/${k}/comment`, {
			kind: 'selection',
			quote: 'Start your free trial',
			anchor: { prefix: 'Pricing', quote: 'Start your free trial', suffix: '' },
			feedback: 'Say how long the trial is'
		});
		const sent = await hr('POST', `/api/page/${k}/send`, { sessionId: session, note: '' });
		assert.equal(sent.ok, true);
		const v = await status({ state, hrState, version: VERSION, task: { id: 'lumen-pricing' } });
		const [t] = v.targets;
		assert.equal(t.waiting, true);
		assert.equal(t.listening, false);
		assert.deepEqual(t.counts, { comments: 1, edits: 0, note: false });
		assert.equal(t.pollCommand, `npx -y human-review@${VERSION} poll ${appUrl}`);
		assert.deepEqual(t.feedback.items.slice(1), [
			{ text: 'Say how long the trial is', points: '“Start your free trial”' }
		]);
	});

	it('notes the forward, with the key in a header only', async () => {
		const body = JSON.stringify({ target: appUrl, sentAt: '2999-01-01T00:00:00.000Z' });
		const no = await fetch(`${base}/forwarded`, { method: 'POST', body });
		assert.equal(no.status, 403);
		const blank = await fetch(`${base}/forwarded`, {
			method: 'POST',
			headers: { 'x-human-review-bridge-key': key, 'content-type': 'application/json' },
			body: JSON.stringify({ sentAt: '2999-01-01T00:00:00.000Z' })
		});
		assert.equal(blank.status, 400);
		assert.deepEqual(Object.keys(readTargets(state)), [targetKey(appUrl)]);
		const v0 = await status({ state, hrState, version: VERSION, task: { id: 'lumen-pricing' } });
		const r = await fetch(`${base}/forwarded`, {
			method: 'POST',
			headers: { 'x-human-review-bridge-key': key, 'content-type': 'application/json' },
			body: JSON.stringify({ target: appUrl, sentAt: v0.targets[0].sentAt })
		});
		assert.equal(r.status, 200);
		const v = await status({ state, hrState, version: VERSION, task: { id: 'lumen-pricing' } });
		assert.equal(v.targets[0].forwardedAt, v0.targets[0].sentAt);
	});

	it('shows the batch in the worker’s hands once its poll takes it', async () => {
		const batch = await hr('GET', `/api/poll?target=${encodeURIComponent(appUrl)}`);
		assert.equal(batch.status, 'feedback');
		assert.equal(batch.pages[0].comments[0].feedback, 'Say how long the trial is');
		const v = await status({ state, hrState, version: VERSION, task: { id: 'lumen-pricing' } });
		assert.equal(v.targets[0].waiting, false);
		assert.equal(v.targets[0].working, true);
	});
});

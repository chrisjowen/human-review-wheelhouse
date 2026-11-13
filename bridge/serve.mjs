/**
 * The bridge: the plugin's companion service, on loopback. Wheelhouse starts
 * it when the captain clicks (Launch, or Edit with Human Review while it is
 * down). It starts Human Review's own server when none is running (the same
 * one a worker's `npx -y human-review poll` talks to), opens a review session
 * for the captain and sends the new tab there, and notes which task a target
 * belongs to and when its feedback was forwarded.
 *
 *   GET  /health                       who it is (Wheelhouse's health check)
 *   GET  /open?target=&task=&key=      open a review and redirect the tab to it
 *   POST /forwarded {target, sentAt}   the captain forwarded that batch to the worker
 *
 * Every request must name this computer's loopback as its Host, and `/open`
 * and `/forwarded` must carry the plugin's key (in the query for `/open`,
 * which a new tab opens; in a header for the rest).
 */

import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { canonicalTarget, ensureServer, openSession, targetKey } from './hr.mjs';
import { BRIDGE_SERVICE } from './paths.mjs';
import { bridgeKey, recordTarget, writeBridge } from './records.mjs';

export const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_BODY = 16 * 1024;

const same = (a, b) => {
	const x = Buffer.from(String(a ?? ''));
	const y = Buffer.from(String(b ?? ''));
	return x.length === y.length && timingSafeEqual(x, y);
};

const escape = (s) =>
	String(s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
	);

/** A plain page with one message, for the tab the captain opened. */
function page(res, code, title, message) {
	res.writeHead(code, {
		'content-type': 'text/html; charset=utf-8',
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
		'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'"
	});
	res.end(
		`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>` +
			`<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;color:#222}@media (prefers-color-scheme:dark){body{background:#111;color:#ddd}}</style>` +
			`<h1 style="font-size:1.2rem">${escape(title)}</h1><p>${escape(message)}</p>`
	);
}

function json(res, code, v, headers = {}) {
	res.writeHead(code, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		...headers
	});
	res.end(JSON.stringify(v));
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', (c) => {
			size += c.length;
			if (size > MAX_BODY) {
				reject(new Error('too large'));
				req.destroy();
			} else chunks.push(c);
		});
		req.on('end', () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
			} catch {
				reject(new Error('not JSON'));
			}
		});
		req.on('error', reject);
	});
}

/**
 * @param {{ port: number, state: string, hrState: string, pkg: string, version: string, pluginVersion: string }} o
 * @returns {Promise<http.Server>}
 */
export function serve({ port, state, hrState, pkg, version, pluginVersion }) {
	const key = bridgeKey(state);
	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const local = server.address()?.port;
		const host = String(req.headers.host ?? '');
		if (host !== `127.0.0.1:${local}` && host !== `localhost:${local}`) {
			res.writeHead(403, { 'content-type': 'text/plain' });
			return res.end('Forbidden');
		}
		// Wheelhouse's page (on its own origin) posts here with the key in a header.
		const cors = {
			'access-control-allow-origin': String(req.headers.origin ?? '*'),
			'access-control-allow-methods': 'POST, GET',
			'access-control-allow-headers': 'content-type, x-human-review-bridge-key',
			vary: 'origin'
		};
		try {
			if (url.pathname === '/health')
				return json(res, 200, {
					service: BRIDGE_SERVICE,
					version: pluginVersion,
					humanReview: version,
					pid: process.pid
				});

			if (url.pathname === '/' && req.method === 'GET')
				return page(
					res,
					200,
					'Human Review is ready',
					'Open a review with Edit with Human Review on a live preview, or from a task’s Human Review section in Wheelhouse.'
				);

			if (url.pathname === '/open' && req.method === 'GET') {
				if (!same(url.searchParams.get('key'), key))
					return page(res, 403, 'Not allowed', 'Open reviews from Wheelhouse.');
				const task = url.searchParams.get('task') || null;
				if (task && !TASK_ID.test(task))
					return page(res, 400, 'Cannot open this review', 'That is not a task id.');
				let target;
				try {
					target = canonicalTarget(url.searchParams.get('target') ?? '');
				} catch (e) {
					return page(res, 400, 'Cannot open this review', e.message);
				}
				if (!target.value)
					return page(res, 400, 'Cannot open this review', 'Name a page to review.');
				try {
					const hr = await ensureServer(hrState, pkg);
					const opened = await openSession(hr, target.value);
					const title = (url.searchParams.get('title') ?? '').slice(0, 200) || null;
					recordTarget(state, targetKey(target.value), {
						target: target.value,
						kind: target.kind,
						...(task ? { task } : {}),
						...(title ? { title } : {}),
						openedAt: new Date().toISOString()
					});
					res.writeHead(302, { location: opened.url, 'cache-control': 'no-store' });
					return res.end();
				} catch (e) {
					return page(res, 502, 'Human Review could not open it', e.message);
				}
			}

			if (url.pathname === '/forwarded') {
				if (req.method === 'OPTIONS') {
					res.writeHead(204, cors);
					return res.end();
				}
				if (req.method !== 'POST') return json(res, 405, { error: 'POST only' }, cors);
				if (!same(req.headers['x-human-review-bridge-key'], key))
					return json(res, 403, { error: 'missing or wrong key' }, cors);
				const body = await readBody(req);
				const target = canonicalTarget(body.target ?? '');
				const sentAt = typeof body.sentAt === 'string' ? body.sentAt.slice(0, 40) : null;
				if (!target.value || !sentAt)
					return json(res, 400, { error: 'name the target and its sentAt' }, cors);
				recordTarget(state, targetKey(target.value), {
					target: target.value,
					kind: target.kind,
					forwardedAt: sentAt
				});
				return json(res, 200, { ok: true }, cors);
			}

			res.writeHead(404, { 'content-type': 'text/plain' });
			return res.end('Not found');
		} catch (e) {
			return json(res, 500, { error: String(e?.message ?? e) }, cors);
		}
	});
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', () => {
			const actual = server.address().port;
			writeBridge(state, {
				port: actual,
				pid: process.pid,
				url: `http://127.0.0.1:${actual}/`,
				version
			});
			resolve(server);
		});
	});
}

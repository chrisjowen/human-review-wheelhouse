/**
 * A client for Human Review's local server (github.com/petergyang/human-review),
 * through the same files and HTTP API its own CLI uses: `server.json` (port,
 * pid, per-run token, protocol) and `state.json` (pages and pending batches)
 * in its state folder, and the token-guarded `/api/*` routes. The token is
 * read from that file (private to this user) and never printed.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A loopback URL as Human Review keys it (no fragment), or null when the
 * target is not an http(s) URL. Throws for a URL Human Review cannot review.
 */
export function localUrl(target) {
	const value = String(target ?? '');
	if (!/^https?:\/\//i.test(value)) return null;
	let u;
	try {
		u = new URL(value);
	} catch {
		throw new Error(`${value} is not a web address.`);
	}
	if (!LOOPBACK_HOSTS.has(u.hostname))
		throw new Error(
			'Human Review reviews pages on this computer only (localhost, 127.0.0.1 or [::1]).'
		);
	if (u.username || u.password) throw new Error('A review address cannot carry a sign-in.');
	u.hash = '';
	return u.href;
}

/** A file's real path, as Human Review keys it. */
export function realFile(file) {
	const resolved = path.resolve(String(file));
	try {
		return fs.realpathSync(resolved);
	} catch {
		return resolved;
	}
}

/** `{ kind: 'url' | 'file', value }`: the exact target a worker's poll must name. */
export function canonicalTarget(target) {
	const url = localUrl(target);
	return url ? { kind: 'url', value: url } : { kind: 'file', value: realFile(target) };
}

/** Human Review's key for a target: the page and its pending batch in state.json. */
export function targetKey(target) {
	const t = canonicalTarget(target);
	const input = t.kind === 'url' ? `url:${t.value}` : t.value;
	return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

const readJson = (file) => {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
};

/** The running server's record, or null. Holds the token: never print it. */
export function readServer(hrState) {
	const s = readJson(path.join(hrState, 'server.json'));
	return s && Number.isInteger(s.port) && s.port > 0 ? s : null;
}

/** Human Review's saved pages and batches (empty when it has none yet). */
export function readState(hrState) {
	const s = readJson(path.join(hrState, 'state.json'));
	return {
		pages: s && typeof s.pages === 'object' && s.pages ? s.pages : {},
		batches: s && typeof s.batches === 'object' && s.batches ? s.batches : {}
	};
}

async function call(server, method, p, { body, timeoutMs = 4000 } = {}) {
	const r = await fetch(`http://127.0.0.1:${server.port}${p}`, {
		method,
		headers: {
			'x-human-review-token': server.token ?? '',
			...(body ? { 'content-type': 'application/json' } : {})
		},
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(timeoutMs)
	});
	const text = await r.text();
	let v = null;
	try {
		v = JSON.parse(text);
	} catch {
		// not JSON
	}
	return { status: r.status, body: v };
}

/** The server's /health answer when it is up (`{ ok, pid, protocol }`), else null. */
export async function health(server) {
	if (!server) return null;
	try {
		const r = await call(server, 'GET', '/health', { timeoutMs: 1500 });
		return r.status === 200 && r.body?.ok ? r.body : null;
	} catch {
		return null;
	}
}

/** The live server, or null when none answers. */
export async function liveServer(hrState) {
	const server = readServer(hrState);
	const h = await health(server);
	return h && h.pid === server.pid ? { ...server, protocol: h.protocol } : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The live server, starting Human Review's own server (detached, as its CLI
 * does) from the installed package when none answers. A server already
 * running, of any version, is used as it is: a worker's newer CLI may have
 * started it, and replacing it would cut that worker's poll.
 */
export async function ensureServer(hrState, pkg, { waitMs = 8000 } = {}) {
	const up = await liveServer(hrState);
	if (up) return up;
	const entry = path.join(pkg, 'src', 'server-entry.js');
	if (!fs.existsSync(entry))
		throw new Error(`Human Review is not installed at ${pkg}; launch the service again.`);
	fs.mkdirSync(hrState, { recursive: true, mode: 0o700 });
	const child = spawn(process.execPath, [entry], {
		detached: true,
		stdio: 'ignore',
		env: { ...process.env, HUMAN_REVIEW_STATE_DIR: hrState }
	});
	child.on('error', () => {});
	child.unref();
	for (const until = Date.now() + waitMs; Date.now() < until;) {
		await sleep(150);
		const s = await liveServer(hrState);
		if (s) return s;
	}
	throw new Error('The Human Review server did not start.');
}

/**
 * Open a review of `target` for the captain: a new session, its address on
 * this computer, and whether feedback from an earlier review was left unsent.
 */
export async function openSession(server, target) {
	const r = await call(server, 'POST', '/api/session', {
		body: { target },
		timeoutMs: 40_000
	});
	if (r.status !== 200 || !r.body?.path)
		throw new Error(r.body?.error ?? `Human Review answered ${r.status}.`);
	return {
		url: `http://127.0.0.1:${server.port}${r.body.path}`,
		sessionId: r.body.sessionId,
		leftover: r.body.leftover ?? null
	};
}

/**
 * The live state of one target: `{ status, feedback_waiting, agent_listening,
 * review_open, unsent }`, or null when the server cannot say.
 */
export async function targetStatus(server, target) {
	try {
		const r = await call(
			server,
			'GET',
			`/api/status?target=${encodeURIComponent(canonicalTarget(target).value)}`
		);
		return r.status === 200 ? r.body : null;
	} catch {
		return null;
	}
}

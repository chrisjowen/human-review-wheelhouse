/**
 * The plugin's own small records, in its state folder (private to this user):
 *
 * - `key`: the bridge's key, made once. Wheelhouse's elements send it with
 *   every request to the bridge, so another web page cannot open reviews.
 * - `bridge.json`: where the running bridge listens, and its pid.
 * - `targets.json`: which task each review target belongs to (opened from a
 *   task's preview or section), and when its waiting feedback was last forwarded to that task's worker.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_TARGETS = 300;

function writeAtomic(file, text) {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
	fs.writeFileSync(tmp, text, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

const readJson = (file) => {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
};

/** The bridge's key, made the first time it is asked for. */
export function bridgeKey(state) {
	const file = path.join(state, 'key');
	try {
		const k = fs.readFileSync(file, 'utf8').trim();
		if (/^[a-f0-9]{32,}$/.test(k)) return k;
	} catch {
		// none yet
	}
	const k = randomBytes(24).toString('hex');
	writeAtomic(file, `${k}\n`);
	return k;
}

export function writeBridge(state, record) {
	writeAtomic(path.join(state, 'bridge.json'), JSON.stringify(record));
}

/** The bridge's record (`{ port, pid, url, version }`), or null. */
export function readBridge(state) {
	const b = readJson(path.join(state, 'bridge.json'));
	return b && Number.isInteger(b.port) ? b : null;
}

/** Every target the plugin knows a task for, by Human Review's key. */
export function readTargets(state) {
	const v = readJson(path.join(state, 'targets.json'));
	return v && typeof v.targets === 'object' && v.targets ? v.targets : {};
}

/**
 * Record (or update) one target: `patch` is merged into its record. Older
 * records past the cap are dropped, oldest first.
 */
export function recordTarget(state, key, patch) {
	const all = readTargets(state);
	all[key] = { ...(all[key] ?? {}), ...patch, updatedAt: new Date().toISOString() };
	const keys = Object.keys(all);
	if (keys.length > MAX_TARGETS) {
		keys
			.sort((a, b) => String(all[a].updatedAt).localeCompare(String(all[b].updatedAt)))
			.slice(0, keys.length - MAX_TARGETS)
			.forEach((k) => delete all[k]);
	}
	writeAtomic(path.join(state, 'targets.json'), JSON.stringify({ targets: all }, null, '\t'));
	return all[key];
}

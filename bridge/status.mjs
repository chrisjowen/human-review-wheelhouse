/**
 * What Wheelhouse's plugin reads (`main.mjs status --json`): whether the
 * bridge and Human Review's server are up, and the state of each review
 * target that belongs to a task, with the feedback list ready to forward
 * when the captain's Send is waiting with no worker listening.
 */

import fs from 'node:fs';
import path from 'node:path';
import { batchCounts, feedbackList, pageLabel, pollCommand } from './feedback.mjs';
import { canonicalTarget, liveServer, readState, targetKey, targetStatus } from './hr.mjs';
import { BRIDGE_SERVICE, packageDir } from './paths.mjs';
import { bridgeKey, readBridge, readTargets } from './records.mjs';

/** The bridge's record when it answers as itself, else null. */
export async function liveBridge(state) {
	const b = readBridge(state);
	if (!b) return null;
	try {
		const r = await fetch(`http://127.0.0.1:${b.port}/health`, {
			signal: AbortSignal.timeout(1500)
		});
		const v = await r.json();
		return r.ok && v?.service === BRIDGE_SERVICE
			? { ...b, version: v.humanReview ?? b.version }
			: null;
	} catch {
		return null;
	}
}

const inside = (file, dir) => {
	if (!file || !dir) return false;
	const rel = path.relative(dir, file);
	return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
};

const safeCanonical = (t) => {
	try {
		return canonicalTarget(t);
	} catch {
		return null;
	}
};

/** The task a Human Review page belongs to, from the plugin's records and where the file is. */
function taskOf(page, record, { task, worktree }) {
	if (record?.task) return record.task;
	if (!task) return null;
	if (page?.kind === 'file' && page.file) {
		if (worktree && inside(page.file, worktree)) return task.id;
		// Firstmate keeps a task's own material under <home>/data/<task>/.
		if (page.file.split(path.sep).join('/').includes(`/data/${task.id}/`)) return task.id;
	}
	return null;
}

/**
 * One target's view. `live` is Human Review's own status answer when its
 * server is up; the saved state stands in when it is not.
 */
function view({ key, target, kind, page, record, batch, live, version }) {
	const pending = batch?.batch ?? null;
	const delivered = !!batch?.delivered;
	const counts = pending ? batchCounts(pending) : null;
	const unsent = live?.unsent ?? {
		comments: Array.isArray(page?.comments) ? page.comments.length : 0,
		edits: Array.isArray(page?.edits) ? page.edits.length : 0
	};
	const sentAt = pending?.sent_at ?? null;
	const forwardedAt =
		record?.forwardedAt && sentAt && record.forwardedAt >= sentAt ? record.forwardedAt : null;
	return {
		key,
		target,
		kind,
		label: pageLabel(kind === 'url' ? { kind, url: target } : { kind, file: target }),
		task: record?.task ?? null,
		title: record?.title ?? null,
		reviewOpen: !!live?.review_open,
		listening: !!live?.agent_listening,
		// Sent by the captain and not yet taken by anyone: what "Send to the worker" forwards.
		waiting: !!pending && !delivered,
		// Taken by a worker's poll and not yet acknowledged.
		working: !!pending && delivered,
		sentAt,
		forwardedAt,
		counts,
		unsent,
		pollCommand: pollCommand(target, version),
		feedback: pending ? feedbackList(pending, { target, version }) : null
	};
}

/**
 * @param {{ state: string, hrState: string, version: string, task?: { id: string, preview?: string | null } | null, worktree?: string | null }} o
 */
export async function status({ state, hrState, version, task = null, worktree = null }) {
	const key = bridgeKey(state);
	const [bridge, server] = await Promise.all([liveBridge(state), liveServer(hrState)]);
	const saved = readState(hrState);
	const records = readTargets(state);

	/** @type {Map<string, { target: string, kind: string }>} */
	const chosen = new Map();
	const add = (t) => {
		const c = safeCanonical(t);
		if (!c) return;
		const k = targetKey(c.value);
		if (!chosen.has(k)) chosen.set(k, { target: c.value, kind: c.kind });
	};
	if (task) {
		if (task.preview) add(task.preview);
		for (const [k, r] of Object.entries(records)) if (r.task === task.id) add(r.target ?? k);
		for (const page of Object.values(saved.pages)) {
			if (taskOf(page, null, { task, worktree }) === task.id) add(page.url ?? page.file);
		}
	} else {
		// The fleet: everything with a record, feedback waiting or in hand, or a localhost page.
		for (const r of Object.values(records)) if (r.target) add(r.target);
		for (const [k, b] of Object.entries(saved.batches)) {
			const page = saved.pages[k];
			if (b?.batch && page) add(page.url ?? page.file);
		}
		for (const page of Object.values(saved.pages)) if (page.kind === 'url') add(page.url);
	}

	const targets = [];
	for (const [k, { target, kind }] of [...chosen.entries()].slice(0, 100)) {
		const page = saved.pages[k] ?? null;
		const record = records[k] ?? null;
		const live = server ? await targetStatus(server, target) : null;
		const v = view({
			key: k,
			target,
			kind,
			page,
			record:
				task && !record?.task
					? { ...record, task: taskOf(page, record, { task, worktree }) }
					: record,
			batch: saved.batches[k] ?? null,
			live,
			version
		});
		targets.push(v);
	}
	// Feedback waiting first, then in hand, then the rest by name.
	const rank = (t) => (t.waiting ? 0 : t.working ? 1 : t.reviewOpen ? 2 : 3);
	targets.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));

	return {
		bridge: bridge ? { url: `http://127.0.0.1:${bridge.port}/`, key } : null,
		key,
		humanReview: {
			version,
			installed: fs.existsSync(path.join(packageDir(state, version), 'package.json')),
			running: !!server,
			port: server?.port ?? null,
			protocol: server?.protocol ?? null
		},
		targets
	};
}

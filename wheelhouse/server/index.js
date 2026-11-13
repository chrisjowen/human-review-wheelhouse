/**
 * Human Review for Wheelhouse: **Edit with Human Review** on every live
 * preview (a preview.action, the primary button while this plugin is the
 * captain's review surface) and a **Human Review** section on each task with
 * something to review, both drawn by this plugin's elements
 * (wheelhouse/ui/index.js).
 *
 * The plugin itself only reads. Its one companion service, the bridge
 * (bridge/main.mjs serve), runs on this computer on loopback: it installs and
 * starts Human Review's own server (github.com/petergyang/human-review) when
 * none is running, opens a review session in a new tab on the captain's
 * click, and notes which task a review belongs to. The providers read the
 * state by running `bridge/main.mjs status --json`, which reads Human
 * Review's files and asks its server. Feedback the captain sends with no
 * worker listening reaches the task's worker through Wheelhouse's feedback
 * capability, on the captain's click, as a note about the task that names the
 * exact `npx -y human-review poll` command that hands the worker the batch.
 *
 * @typedef {import('@chrisjowen/wheelhouse-plugin-sdk').ProviderContext} ProviderContext
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	BRIDGE_SERVICE,
	DEFAULT_VERSION,
	VERSION_RE,
	humanReviewStateDir,
	stateDir
} from '../../bridge/paths.mjs';

/** The bridge's CLI, beside this entry in the plugin folder. */
export const MAIN = fileURLToPath(new URL('../../bridge/main.mjs', import.meta.url));
/** The port the bridge asks Wheelhouse for first. */
export const BRIDGE_PORT = 4323;
const SOURCE = 'Human Review';

const available = (value) => ({
	available: true,
	value,
	source: SOURCE,
	observedAt: new Date().toISOString()
});
const unavailable = (reason) => ({ available: false, reason });

/**
 * The plugin's settings, checked.
 * @param {Record<string, unknown>} s
 */
export function readSettings(s = {}) {
	const problems = [];
	let version = typeof s.version === 'string' && s.version.trim() ? s.version.trim() : null;
	if (version && !VERSION_RE.test(version)) {
		problems.push(`${version} is not a Human Review version (x.y.z); using ${DEFAULT_VERSION}.`);
		version = null;
	}
	return { version: version ?? DEFAULT_VERSION, problems };
}

/** The arguments every bridge command takes: where things live, and the version. */
function common(set, env = process.env) {
	return [
		'--version',
		set.version,
		'--state',
		stateDir(env),
		'--hr-state',
		humanReviewStateDir(env)
	];
}

/**
 * Ask the bridge's CLI for the state. In a task, run it in the task's
 * worktree when there is one, so files there count as the task's.
 * @param {ProviderContext} ctx
 */
async function read(ctx, set, task) {
	const argv = [
		process.execPath,
		MAIN,
		'status',
		'--json',
		...common(set),
		...(task ? ['--task', task.id] : []),
		...(task?.preview?.url ? ['--preview', task.preview.url] : [])
	];
	const run = (cwd, extra = []) =>
		ctx.exec({ argv: [...argv, ...extra], cwd, timeoutMs: 8_000, maxBytes: 4 * 1024 * 1024 });
	let r = task ? await run('task', ['--in-worktree']) : await run('home');
	if (!r.ok && task) r = await run('home');
	if (!r.ok) return { problem: `Human Review's state could not be read: ${r.reason}` };
	try {
		return { value: JSON.parse(r.stdout) };
	} catch {
		return { problem: 'The bridge answered with something other than JSON.' };
	}
}

function shape(set, v) {
	return {
		bridge: v.bridge ?? null,
		key: v.key,
		service: 'bridge',
		humanReview: v.humanReview,
		version: set.version,
		problems: set.problems,
		cli: MAIN,
		targets: Array.isArray(v.targets) ? v.targets : [],
		readAt: Date.now()
	};
}

/** @param {ProviderContext} ctx */
async function fleetState(ctx) {
	const set = readSettings(ctx.settings);
	const r = await read(ctx, set, null);
	if (r.problem) return unavailable(r.problem);
	return available(shape(set, r.value));
}

/** @param {ProviderContext} ctx */
async function taskState(ctx) {
	const t = ctx.task;
	if (!t) return unavailable('No task.');
	const set = readSettings(ctx.settings);
	const r = await read(ctx, set, t);
	if (r.problem) return unavailable(r.problem);
	const v = shape(set, r.value);
	if (!t.preview?.url && !v.targets.length)
		return unavailable('This task has no preview or page to review with Human Review.');
	return available({
		...v,
		task: { id: t.id, title: t.title, project: t.projectId, preview: t.preview?.url ?? null }
	});
}

/** A shell word, quoted only when it needs to be. */
const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export default {
	providers: [
		{ id: 'state', scope: 'fleet', ttlMs: 4_000, timeoutMs: 10_000, fetch: fleetState },
		{ id: 'task-state', scope: 'task', ttlMs: 4_000, timeoutMs: 10_000, fetch: taskState }
	],
	contributions: [
		{
			// On every live preview: the chat's boxes and a task's Live preview tab.
			slot: 'preview.action',
			id: 'edit',
			title: 'Edit with Human Review',
			provider: 'state',
			render: { element: 'human-review-edit' }
		},
		{
			slot: 'task.section',
			id: 'session',
			title: 'Human Review',
			provider: 'task-state',
			when: 'provider-available',
			placement: { order: 35 },
			render: { element: 'human-review-task' }
		}
	],
	services: [
		{
			id: 'bridge',
			title: 'Human Review',
			scope: 'fleet',
			/** @param {import('@chrisjowen/wheelhouse-plugin-sdk').ServiceContext} ctx */
			async resolve(ctx) {
				const set = readSettings(ctx.settings);
				const port = await ctx.servicePort(BRIDGE_PORT);
				const args = common(set);
				const base = `http://127.0.0.1:${port}`;
				return {
					available: true,
					spec: {
						url: `${base}/`,
						health: `${base}/health`,
						identity: { url: `${base}/health`, path: ['service'], value: BRIDGE_SERVICE },
						argv: [process.execPath, MAIN, 'serve', '--port', String(port), ...args],
						cwd: path.dirname(MAIN),
						binds: 'loopback',
						setup: [
							{
								label: `Install Human Review ${set.version}`,
								argv: [process.execPath, MAIN, 'install', ...args],
								timeoutMs: 5 * 60_000
							}
						]
					},
					hint: `node ${q(MAIN)} install --version ${set.version} && node ${q(MAIN)} serve --port ${port} --version ${set.version}`,
					note: set.problems.length ? set.problems.join(' ') : null
				};
			}
		}
	]
};

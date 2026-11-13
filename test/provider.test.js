/**
 * The server entry as Wheelhouse calls it: its providers (through a context
 * whose `exec` runs commands as Wheelhouse does) and its companion service.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import plugin, { BRIDGE_PORT, MAIN, readSettings } from '../wheelhouse/server/index.js';

const dir = fs.mkdtempSync(path.join(tmpdir(), 'hr-provider-'));
const home = path.join(dir, 'home');
const worktree = path.join(dir, 'worktree');
const saved = { ...process.env };

before(() => {
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(worktree, { recursive: true });
	process.env.WH_HUMAN_REVIEW_STATE = path.join(dir, 'state');
	process.env.HUMAN_REVIEW_STATE_DIR = path.join(dir, 'hr-state');
});
after(() => {
	process.env = saved;
	fs.rmSync(dir, { recursive: true, force: true });
});

/** A provider context; `roots` says which of home and task exist. */
function context({ task = null, settings = {}, roots = { home, task: worktree } } = {}) {
	const calls = [];
	const exec = (r) => {
		calls.push({ argv: r.argv, cwd: r.cwd });
		const cwd = roots[r.cwd];
		if (!cwd)
			return Promise.resolve({
				ok: false,
				reason: `there is no ${r.cwd} directory to run in`,
				stdout: '',
				stderr: ''
			});
		return new Promise((resolve) =>
			execFile(
				r.argv[0],
				r.argv.slice(1),
				{
					cwd,
					timeout: r.timeoutMs,
					maxBuffer: r.maxBytes,
					env: { PATH: process.env.PATH, HOME: home }
				},
				(err, stdout, stderr) =>
					resolve(err ? { ok: false, reason: err.message, stdout, stderr } : { ok: true, stdout })
			)
		);
	};
	return {
		calls,
		ctx: {
			project: null,
			task,
			projects: [],
			tasks: task ? [task] : [],
			exec,
			settings,
			servicePort: async (preferred) => preferred
		}
	};
}

const provider = (id) => plugin.providers.find((p) => p.id === id);
const task = (preview = null) => ({
	id: 'lumen-pricing',
	title: 'Pricing page',
	projectId: 'lumen',
	preview: preview ? { url: preview, reportedAt: '2026-11-13T10:00:00Z' } : null
});

describe('settings', () => {
	it('takes a Human Review version, or the tested one', () => {
		assert.deepEqual(readSettings({}), { version: '0.8.2', problems: [] });
		assert.deepEqual(readSettings({ version: ' 0.9.0 ' }), { version: '0.9.0', problems: [] });
		const bad = readSettings({ version: 'latest; rm -rf /' });
		assert.equal(bad.version, '0.8.2');
		assert.match(bad.problems[0], /not a Human Review version/);
	});
});

describe('the providers', () => {
	it('give the fleet the bridge’s key, Human Review’s state and the targets', async () => {
		const { ctx, calls } = context();
		const r = await provider('state').fetch(ctx);
		assert.equal(r.available, true, r.reason);
		assert.equal(r.value.bridge, null);
		assert.match(r.value.key, /^[a-f0-9]{48}$/);
		assert.equal(r.value.humanReview.running, false);
		assert.equal(r.value.service, 'bridge');
		assert.equal(r.value.cli, MAIN);
		assert.deepEqual(r.value.targets, []);
		assert.equal(calls[0].cwd, 'home');
		assert.deepEqual(calls[0].argv.slice(0, 3), [process.execPath, MAIN, 'status']);
		// Where things live comes from Wheelhouse's own environment, not the minimal one commands get.
		assert.ok(calls[0].argv.includes(process.env.WH_HUMAN_REVIEW_STATE));
		assert.ok(calls[0].argv.includes(process.env.HUMAN_REVIEW_STATE_DIR));
	});

	it('show a task with a preview, run in its worktree', async () => {
		const { ctx, calls } = context({ task: task('http://localhost:5173/') });
		const r = await provider('task-state').fetch(ctx);
		assert.equal(r.available, true, r.reason);
		assert.deepEqual(r.value.task, {
			id: 'lumen-pricing',
			title: 'Pricing page',
			project: 'lumen',
			preview: 'http://localhost:5173/'
		});
		assert.deepEqual(
			r.value.targets.map((t) => t.target),
			['http://localhost:5173/']
		);
		assert.equal(calls[0].cwd, 'task');
		assert.ok(calls[0].argv.includes('--in-worktree'));
	});

	it('fall back to the home for a task with no worktree', async () => {
		const { ctx, calls } = context({ task: task('http://localhost:5173/'), roots: { home } });
		const r = await provider('task-state').fetch(ctx);
		assert.equal(r.available, true);
		assert.deepEqual(
			calls.map((c) => c.cwd),
			['task', 'home']
		);
		assert.ok(!calls[1].argv.includes('--in-worktree'));
	});

	it('hide the section of a task with nothing to review', async () => {
		const { ctx } = context({ task: task() });
		const r = await provider('task-state').fetch(ctx);
		assert.equal(r.available, false);
		assert.match(r.reason, /no preview or page/);
	});

	it('say why when the state cannot be read', async () => {
		const { ctx } = context({ roots: {} });
		const r = await provider('state').fetch(ctx);
		assert.equal(r.available, false);
		assert.match(r.reason, /could not be read/);
	});
});

describe('the bridge service', () => {
	it('runs the bridge on loopback, installing Human Review first', async () => {
		const { ctx } = context({ settings: { version: '0.9.1' } });
		const r = await plugin.services[0].resolve(ctx);
		assert.equal(r.available, true);
		const { spec } = r;
		const base = `http://127.0.0.1:${BRIDGE_PORT}`;
		assert.equal(spec.url, `${base}/`);
		assert.equal(spec.health, `${base}/health`);
		assert.deepEqual(spec.identity, {
			url: `${base}/health`,
			path: ['service'],
			value: 'wheelhouse-human-review-bridge'
		});
		assert.equal(spec.binds, 'loopback');
		assert.deepEqual(spec.argv.slice(0, 5), [process.execPath, MAIN, 'serve', '--port', '4323']);
		assert.deepEqual(spec.argv.slice(5, 7), ['--version', '0.9.1']);
		assert.equal(spec.setup.length, 1);
		assert.equal(spec.setup[0].label, 'Install Human Review 0.9.1');
		assert.deepEqual(spec.setup[0].argv.slice(1, 3), [MAIN, 'install']);
		assert.ok(spec.setup[0].timeoutMs <= 10 * 60_000);
		assert.match(
			r.hint,
			/main\.mjs install --version 0\.9\.1 .*serve --port 4323 --version 0\.9\.1/
		);
	});
});

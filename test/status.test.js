/**
 * Which review targets belong to a task, and their state from Human Review's
 * saved files while its server is not running.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { targetKey } from '../bridge/hr.mjs';
import { main } from '../bridge/main.mjs';
import { recordTarget } from '../bridge/records.mjs';
import { status } from '../bridge/status.mjs';

const dir = fs.mkdtempSync(path.join(tmpdir(), 'hr-status-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const home = path.join(dir, 'home');
const worktree = path.join(dir, 'worktrees', 'lumen-pricing');
const state = path.join(dir, 'state');
const hrState = path.join(dir, 'hr-state');
for (const d of [path.join(home, 'data', 'lumen-pricing'), path.join(worktree, 'docs'), hrState])
	fs.mkdirSync(d, { recursive: true });

const plan = path.join(worktree, 'docs', 'plan.md');
const brief = path.join(home, 'data', 'lumen-pricing', 'brief.html');
const elsewhere = path.join(home, 'data', 'other-task', 'notes.html');
fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
for (const f of [plan, brief, elsewhere]) fs.writeFileSync(f, '# x\n');
const preview = 'http://localhost:5173/pricing';
const offered = 'http://127.0.0.1:4000/admin';

const filePage = (file, comments = 0) => ({
	key: targetKey(file),
	kind: 'file',
	file,
	comments: Array.from({ length: comments }, (_, i) => ({ id: `c_${i}`, feedback: 'x' })),
	edits: []
});
const batch = {
	batch: {
		status: 'feedback',
		pages: [
			{
				kind: 'file',
				file: plan,
				comments: [{ id: 'c_1', kind: 'selection', quote: 'Phase 2', feedback: 'Drop it' }],
				edits: []
			}
		],
		overall_note: '',
		sent_at: '2026-11-13T10:00:00.000Z'
	},
	cleanup: [],
	delivered: false
};
fs.writeFileSync(
	path.join(hrState, 'state.json'),
	JSON.stringify({
		pages: {
			[targetKey(plan)]: filePage(plan),
			[targetKey(brief)]: filePage(brief, 2),
			[targetKey(elsewhere)]: filePage(elsewhere),
			[targetKey(preview)]: {
				key: targetKey(preview),
				kind: 'url',
				url: preview,
				comments: [],
				edits: []
			}
		},
		batches: { [targetKey(plan)]: batch }
	})
);
recordTarget(state, targetKey(offered), { target: offered, kind: 'url', task: 'lumen-pricing' });

describe('status', () => {
	it('finds a task’s preview, its worktree’s files, its data folder and what was offered to it', async () => {
		const v = await status({
			state,
			hrState,
			version: '0.8.2',
			task: { id: 'lumen-pricing', preview },
			worktree
		});
		assert.equal(v.bridge, null);
		assert.equal(v.humanReview.running, false);
		assert.match(v.key, /^[a-f0-9]{48}$/);
		assert.deepEqual(
			v.targets.map((t) => t.target),
			// Feedback waiting first, then by name.
			[plan, brief, 'http://127.0.0.1:4000/admin', 'http://localhost:5173/pricing']
		);
		const [p] = v.targets;
		assert.equal(p.task, 'lumen-pricing');
		assert.equal(p.waiting, true);
		assert.equal(p.reviewOpen, false);
		assert.equal(p.label, 'plan.md');
		assert.match(p.feedback.items[0].text, /human-review@0\.8\.2 poll .*plan\.md/);
		assert.deepEqual(v.targets[1].unsent, { comments: 2, edits: 0 });
	});

	it('leaves out worktree files when not run in the worktree', async () => {
		const v = await status({ state, hrState, version: '0.8.2', task: { id: 'lumen-pricing' } });
		assert.ok(!v.targets.some((t) => t.target === plan));
		assert.ok(v.targets.some((t) => t.target === brief));
	});

	it('lists the fleet’s localhost pages and every target with a batch or a record', async () => {
		const v = await status({ state, hrState, version: '0.8.2' });
		assert.deepEqual(v.targets.map((t) => t.target).sort(), [plan, offered, preview].sort());
	});

	it('offers a page to a task from the command line', async () => {
		let out = '';
		const write = process.stdout.write;
		process.stdout.write = (s) => ((out += s), true);
		try {
			await main(['offer', elsewhere, '--task', 'other-task', '--state', state]);
		} finally {
			process.stdout.write = write;
		}
		assert.match(out, /Offered .*notes\.html to other-task/);
		assert.match(out, /npx -y human-review@0\.8\.2 poll /);
		const v = await status({ state, hrState, version: '0.8.2', task: { id: 'other-task' } });
		assert.deepEqual(
			v.targets.map((t) => [t.target, t.task]),
			[[elsewhere, 'other-task']]
		);
		await assert.rejects(
			main(['offer', elsewhere, '--task', 'bad id', '--state', state]),
			/task id/
		);
		await assert.rejects(
			main(['offer', 'https://example.com/', '--task', 'x', '--state', state]),
			/this computer only/
		);
	});
});

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
for (const f of [plan, brief]) fs.writeFileSync(f, '# x\n');
const preview = 'http://localhost:5173/pricing';
const opened = 'http://127.0.0.1:4000/admin';

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
			[targetKey(plan)]: filePage(plan, 2),
			[targetKey(brief)]: filePage(brief),
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
// A review the captain opened from the task.
recordTarget(state, targetKey(opened), { target: opened, kind: 'url', task: 'lumen-pricing' });

describe('status', () => {
	it('finds a task’s preview, its worktree’s files and the reviews opened from it', async () => {
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
			[plan, 'http://127.0.0.1:4000/admin', 'http://localhost:5173/pricing']
		);
		const [p] = v.targets;
		assert.equal(p.task, 'lumen-pricing');
		assert.equal(p.waiting, true);
		assert.equal(p.reviewOpen, false);
		assert.equal(p.label, 'plan.md');
		assert.match(p.feedback.items[0].text, /human-review@0\.8\.2 poll .*plan\.md/);
		assert.deepEqual(p.unsent, { comments: 2, edits: 0 });
		assert.ok(!v.targets.some((t) => t.target === brief), 'a data/<task>/ file is not the task’s');
	});

	it('leaves out worktree files when not run in the worktree', async () => {
		const v = await status({ state, hrState, version: '0.8.2', task: { id: 'lumen-pricing' } });
		assert.ok(!v.targets.some((t) => t.target === plan));
		assert.ok(v.targets.some((t) => t.target === opened));
	});

	it('lists the fleet’s localhost pages and every target with a batch or a record', async () => {
		const v = await status({ state, hrState, version: '0.8.2' });
		assert.deepEqual(v.targets.map((t) => t.target).sort(), [plan, opened, preview].sort());
	});

	it('keeps a batch and the newest page in the fleet’s list past its cap of 40', async () => {
		const many = path.join(dir, 'many');
		const manyHr = path.join(dir, 'many-hr');
		fs.mkdirSync(many, { recursive: true });
		fs.mkdirSync(manyHr, { recursive: true });
		const old = {};
		for (let i = 0; i < 45; i++) {
			const t = `http://localhost:${6000 + i}/`;
			old[targetKey(t)] = { target: t, kind: 'url', updatedAt: '2026-01-01T00:00:00.000Z' };
		}
		fs.writeFileSync(path.join(many, 'targets.json'), JSON.stringify({ targets: old }));
		const fresh = 'http://localhost:7000/new';
		const sent = 'http://localhost:7001/sent';
		const urlPage = (url) => ({ key: targetKey(url), kind: 'url', url, comments: [], edits: [] });
		fs.writeFileSync(
			path.join(manyHr, 'state.json'),
			JSON.stringify({
				pages: {
					[targetKey(fresh)]: { ...urlPage(fresh), updatedAt: Date.parse('2026-11-13T09:00:00Z') },
					[targetKey(sent)]: { ...urlPage(sent), updatedAt: Date.parse('2025-01-01T00:00:00Z') }
				},
				batches: { [targetKey(sent)]: { ...batch, batch: { ...batch.batch, pages: [] } } }
			})
		);
		const v = await status({ state: many, hrState: manyHr, version: '0.8.2' });
		assert.equal(v.targets.length, 40);
		const listed = v.targets.map((t) => t.target);
		assert.equal(listed[0], sent);
		assert.ok(listed.includes(fresh));
	});

	it('has no offer command', async () => {
		await assert.rejects(
			main(['offer', plan, '--task', 'lumen-pricing', '--state', state]),
			/Unknown command offer/
		);
	});
});

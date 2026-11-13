import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	LIMITS,
	batchCounts,
	clip,
	feedbackList,
	pollCommand,
	shellQuote
} from '../bridge/feedback.mjs';

const page = (over = {}) => ({
	kind: 'url',
	file: 'http://localhost:5173/pricing',
	url: 'http://localhost:5173/pricing',
	edits_saved: false,
	comments: [
		{
			id: 'c_1',
			kind: 'selection',
			quote: 'Start your free trial',
			anchor: { prefix: '', quote: 'Start your free trial', suffix: '' },
			feedback: 'Say how long the trial is'
		},
		{ id: 'c_2', kind: 'element', quote: 'Pricing table', feedback: 'Too dense on a phone' }
	],
	edits: [
		{ label: 'Hero title', kind: 'edited', before: 'Pricing', after: 'Simple pricing' },
		{ label: 'Footer note', kind: 'deleted', before: 'Prices may change.', after: '' },
		{
			label: 'FAQ',
			kind: 'moved',
			before: 'Can I cancel?',
			after: 'Can I cancel?',
			moved_after: 'How do I pay?',
			moved_before: ''
		}
	],
	...over
});

/** The note's size as Wheelhouse writes it, roughly: each item's line and its "Points at". */
const noteBytes = (l) =>
	Buffer.byteLength(
		[
			l.subject,
			...l.items.map((i, n) => `${n + 1}. ${i.text}\n   Points at: ${i.points ?? ''}`)
		].join('\n')
	);

describe('feedbackList', () => {
	it('starts with the command that hands the worker the full batch', () => {
		const l = feedbackList(
			{ pages: [page()], overall_note: '' },
			{ target: 'http://localhost:5173/pricing', version: '0.8.2' }
		);
		assert.equal(l.subject, 'Human Review of http://localhost:5173/pricing');
		assert.match(
			l.items[0].text,
			/`npx -y human-review@0\.8\.2 poll http:\/\/localhost:5173\/pricing`.*--ack/
		);
	});

	it('has a line per comment, edit and note, each pointing at what it is about', () => {
		const l = feedbackList(
			{ pages: [page()], overall_note: 'Ship it after these' },
			{ target: 'http://localhost:5173/pricing', version: '0.8.2' }
		);
		assert.deepEqual(
			l.items.slice(1).map((i) => [i.text, i.points]),
			[
				['Say how long the trial is', '“Start your free trial”'],
				['Too dense on a phone', 'the Pricing table block'],
				['Now reads “Simple pricing”', 'Edited Hero title, was “Pricing”'],
				['Deleted “Prices may change.”', 'Edit to Footer note'],
				['Moved “FAQ” to after “How do I pay?”', 'Edit to FAQ'],
				['Ship it after these', 'Overall note']
			]
		);
	});

	it('names the page of each line when the batch covers several', () => {
		const other = page({
			kind: 'file',
			file: '/work/docs/plan.md',
			url: undefined,
			comments: [{ id: 'c_9', kind: 'selection', quote: 'Phase 2', feedback: 'Drop it' }],
			edits: []
		});
		const l = feedbackList(
			{ pages: [page({ edits: [] }), other] },
			{ target: 'http://localhost:5173/pricing', version: '0.8.2' }
		);
		assert.equal(l.items.at(-1).points, '“Phase 2” on plan.md');
		assert.equal(l.items[1].points, '“Start your free trial” on http://localhost:5173/pricing');
	});

	it('keeps within Wheelhouse’s limits however long the batch is', () => {
		const long = 'word '.repeat(400);
		const comments = Array.from({ length: 60 }, (_, i) => ({
			id: `c_${i}`,
			kind: 'selection',
			quote: long,
			feedback: long
		}));
		const l = feedbackList(
			{ pages: [page({ comments })], overall_note: long },
			{ target: `http://localhost:5173/${'x'.repeat(300)}`, version: '0.8.2' }
		);
		assert.equal(l.items.length, LIMITS.items);
		assert.match(l.items.at(-1).text, /^…and \d+ more in the full batch\.$/);
		assert.ok(l.subject.length <= LIMITS.subject);
		for (const i of l.items) {
			assert.ok(i.text.length <= LIMITS.text, i.text.length);
			assert.ok((i.points ?? '').length <= LIMITS.points);
		}
		assert.ok(noteBytes(l) < LIMITS.bytes - 1024, noteBytes(l));
	});

	it('quotes a target the shell would split', () => {
		assert.equal(shellQuote('/work/my plan.md'), `'/work/my plan.md'`);
		assert.equal(shellQuote(`/work/it's.md`), `'/work/it'\\''s.md'`);
		assert.equal(
			pollCommand('http://localhost:3000/a?b=1&c=2', '0.8.2'),
			`npx -y human-review@0.8.2 poll 'http://localhost:3000/a?b=1&c=2'`
		);
	});

	it('clips with an ellipsis and folds whitespace', () => {
		assert.equal(clip('a  b\n c', 10), 'a b c');
		assert.equal(clip('abcdefghij', 5), 'abcd…');
	});

	it('counts a batch', () => {
		assert.deepEqual(batchCounts({ pages: [page()], overall_note: ' ' }), {
			comments: 2,
			edits: 3,
			note: false
		});
		assert.deepEqual(batchCounts(null), { comments: 0, edits: 0, note: false });
	});
});

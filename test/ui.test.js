import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://127.0.0.1:4310/tasks/lumen-pricing' });
let ui;

before(async () => {
	for (const k of [
		'window',
		'document',
		'HTMLElement',
		'customElements',
		'Node',
		'Event',
		'location'
	]) {
		globalThis[k] = k === 'window' ? window : window[k];
	}
	ui = await import('../wheelhouse/ui/index.js');
});
after(() => window.happyDOM.close());

const KEY = 'a'.repeat(48);
const BRIDGE = 'http://127.0.0.1:4323/';
const PREVIEW = 'http://localhost:5173/pricing';
const tick = () => new Promise((r) => setTimeout(r, 0));

const feedback = {
	subject: `Human Review of ${PREVIEW}`,
	items: [
		{ text: 'Run `npx -y human-review@0.8.2 poll …`', points: null },
		{ text: 'Say how long the trial is', points: '“Start your free trial”' }
	]
};
const target = (over = {}) => ({
	key: 'k1',
	target: PREVIEW,
	kind: 'url',
	label: PREVIEW,
	task: 'lumen-pricing',
	reviewOpen: true,
	listening: false,
	waiting: false,
	working: false,
	sentAt: null,
	forwardedAt: null,
	counts: null,
	unsent: { comments: 0, edits: 0 },
	pollCommand: `npx -y human-review@0.8.2 poll ${PREVIEW}`,
	feedback: null,
	...over
});
/** Each test's Send has its own time: a forward noted on the page outlives the test. */
let sent = 0;
let SENT_AT;
const waiting = (over = {}) =>
	target({
		waiting: true,
		sentAt: SENT_AT,
		counts: { comments: 1, edits: 2, note: false },
		feedback,
		...over
	});
const data = (over = {}) => ({
	bridge: { url: BRIDGE, key: KEY },
	key: KEY,
	service: 'bridge',
	humanReview: { version: '0.8.2', installed: true, running: true, port: 40000, protocol: 9 },
	version: '0.8.2',
	problems: [],
	cli: '/plugins/human-review/bridge/main.mjs',
	targets: [],
	readAt: Date.now(),
	...over
});

/** A host API that records what the element asks of it. */
function fakeHost({ feedbackResult = { ok: true, pending: false } } = {}) {
	const calls = [];
	return {
		calls,
		pluginId: 'human-review',
		service: async (id) => {
			calls.push(['service', id]);
			return { state: 'stopped', url: BRIDGE, launchable: true, reason: null, hint: null };
		},
		launch: async (id, o) => {
			calls.push(['launch', id, o]);
			return { state: 'running', url: BRIDGE, launchable: true, reason: null, hint: null };
		},
		sendFeedback: (list) => {
			calls.push(['sendFeedback', list]);
			return Promise.resolve(feedbackResult);
		}
	};
}

function mount(tag, { host = fakeHost(), d = data(), preview = null, entry = {} } = {}) {
	const el = document.createElement(tag);
	document.body.append(el);
	el.host = host;
	if (preview) el.preview = preview;
	el.entry = entry;
	el.data = d;
	return el;
}

const $ = (el, sel) => el.shadowRoot.querySelector(sel);
const $$ = (el, sel) => [...el.shadowRoot.querySelectorAll(sel)];

let opened;
beforeEach(() => {
	SENT_AT = new Date(Date.UTC(2026, 10, 13, 10, 0, sent++)).toISOString();
	document.body.replaceChildren();
	opened = [];
	window.open = (...a) => {
		opened.push(a);
		return null;
	};
	globalThis.fetch = async (url, init) => {
		opened.push(['fetch', String(url), init]);
		return { ok: true, json: async () => ({ ok: true }) };
	};
});

describe('helpers', () => {
	it('builds the bridge address that opens a review', () => {
		const href = new URL(ui.openHref(BRIDGE, { key: KEY, target: PREVIEW, task: 'lumen-pricing' }));
		assert.equal(href.origin + href.pathname, `${BRIDGE}open`);
		assert.equal(href.searchParams.get('target'), PREVIEW);
		assert.equal(href.searchParams.get('task'), 'lumen-pricing');
		assert.equal(href.searchParams.get('key'), KEY);
	});

	it('knows what Human Review can review, and where', () => {
		assert.equal(ui.reviewable('http://localhost:5173/'), true);
		assert.equal(ui.reviewable('http://[::1]:8080/a'), true);
		assert.equal(ui.reviewable('https://preview.example.com/'), false);
		assert.equal(ui.reviewable('javascript:alert(1)'), false);
		assert.equal(ui.onThisComputer({ hostname: '127.0.0.1' }), true);
		assert.equal(ui.onThisComputer({ hostname: 'wheelhouse.example.com' }), false);
		assert.equal(ui.sameTarget(`${PREVIEW}#top`, PREVIEW), true);
		assert.equal(
			ui.countWords({ comments: 1, edits: 2, note: true }),
			'1 comment, 2 edits, a note'
		);
	});
});

describe('<human-review-edit>', () => {
	const preview = (over = {}) => ({
		url: PREVIEW,
		taskId: 'lumen-pricing',
		title: 'Pricing page',
		projectId: 'lumen',
		board: false,
		...over
	});

	it('is the primary button while Human Review is the review surface', () => {
		const plain = mount('human-review-edit', { preview: preview() });
		const b = $(plain, '[data-human-review-edit]');
		assert.equal(b.textContent, 'Edit with Human Review');
		assert.equal(b.className, '');
		const primary = mount('human-review-edit', { preview: preview({ primary: true }) });
		assert.equal($(primary, '[data-human-review-edit]').className, 'primary');
	});

	it('opens the review in a new tab through the bridge', () => {
		const el = mount('human-review-edit', { preview: preview() });
		$(el, '[data-human-review-edit]').click();
		assert.equal(opened.length, 1);
		const [href, name] = opened[0];
		assert.equal(name, '_blank');
		const u = new URL(href);
		assert.equal(u.searchParams.get('target'), PREVIEW);
		assert.equal(u.searchParams.get('task'), 'lumen-pricing');
		assert.equal(u.searchParams.get('key'), KEY);
	});

	it('launches the bridge first when it is down, and opens the review once it answers', async () => {
		const host = fakeHost();
		const el = mount('human-review-edit', { host, preview: preview(), d: data({ bridge: null }) });
		await tick();
		$(el, '[data-human-review-edit]').click();
		const launch = host.calls.find((c) => c[0] === 'launch');
		assert.ok(launch, 'launched');
		assert.equal(launch[1], 'bridge');
		assert.equal(new URL(launch[2].open).searchParams.get('target'), PREVIEW);
		assert.equal(opened.length, 0);
		await tick();
		await tick();
		assert.match($(el, '[role=status]').textContent, /opening in a new tab/);
	});

	it('cannot review an address off this computer', () => {
		const el = mount('human-review-edit', { preview: preview({ url: 'https://x.example.com/' }) });
		const b = $(el, '[data-human-review-edit]');
		assert.equal(b.disabled, true);
		assert.match(b.title, /this computer only/);
	});

	it('says where to use it when Wheelhouse is open from elsewhere', () => {
		const real = globalThis.location;
		globalThis.location = { hostname: 'wheelhouse.example.com' };
		try {
			const el = mount('human-review-edit', { preview: preview() });
			$(el, '[data-human-review-edit]').click();
			assert.equal(opened.length, 0);
			assert.match($(el, '[role=alert]').textContent, /Shared review/);
		} finally {
			globalThis.location = real;
		}
	});

	it('forwards a waiting Send to the task’s worker on the captain’s click', async () => {
		const host = fakeHost();
		const el = mount('human-review-edit', {
			host,
			preview: preview(),
			d: data({ targets: [waiting()] })
		});
		const f = $(el, '[data-human-review-forward]');
		assert.equal(f.textContent, 'Send to the worker (1 comment, 2 edits)');
		f.click();
		// Sent within the click itself, before anything awaited.
		assert.deepEqual(host.calls.at(-1), [
			'sendFeedback',
			{ task: 'lumen-pricing', subject: feedback.subject, items: feedback.items }
		]);
		await tick();
		await tick();
		const note = opened.find((o) => o[0] === 'fetch');
		assert.equal(note[1], `${BRIDGE}forwarded`);
		assert.equal(note[2].headers['x-human-review-bridge-key'], KEY);
		assert.equal(JSON.parse(note[2].body).sentAt, SENT_AT);
		assert.equal($(el, '[data-human-review-forward]'), null);
		assert.ok($$(el, '.chip').some((c) => c.textContent === 'Sent to the worker'));
	});

	it('shows why a forward failed', async () => {
		const host = fakeHost({ feedbackResult: { ok: false, error: 'Firstmate is not reachable.' } });
		const el = mount('human-review-edit', {
			host,
			preview: preview(),
			d: data({ targets: [waiting()] })
		});
		$(el, '[data-human-review-forward]').click();
		await tick();
		await tick();
		assert.equal($(el, '[role=alert]').textContent, 'Firstmate is not reachable.');
		assert.ok($(el, '[data-human-review-forward]'));
	});

	it('sends to the task the review was opened for, not the preview’s', () => {
		const host = fakeHost();
		const el = mount('human-review-edit', {
			host,
			preview: preview({ taskId: 'lumen-hero' }),
			d: data({ targets: [waiting({ task: 'lumen-pricing' })] })
		});
		$(el, '[data-human-review-forward]').click();
		assert.equal(host.calls.at(-1)[0], 'sendFeedback');
		assert.equal(host.calls.at(-1)[1].task, 'lumen-pricing');
	});

	it('turns Send off and says why while the bridge is down', async () => {
		const host = fakeHost();
		const el = mount('human-review-edit', {
			host,
			preview: preview(),
			d: data({ bridge: null, targets: [waiting()] })
		});
		const f = $(el, '[data-human-review-forward]');
		assert.equal(f.disabled, true);
		assert.match(el.shadowRoot.textContent, /bridge to the worker is not running/);
		el.forward(waiting(), 'lumen-pricing');
		await tick();
		assert.ok(!host.calls.some((c) => c[0] === 'sendFeedback'));
	});

	it('does not count a forward the bridge refused, and says so', async () => {
		globalThis.fetch = async (url, init) => {
			opened.push(['fetch', String(url), init]);
			return { ok: false, status: 500, json: async () => ({ error: 'disk full' }) };
		};
		const el = mount('human-review-edit', {
			preview: preview(),
			d: data({ targets: [waiting()] })
		});
		$(el, '[data-human-review-forward]').click();
		await tick();
		await tick();
		await tick();
		assert.match($(el, '[role=alert]').textContent, /bridge could not note it \(it answered 500\)/);
		assert.ok($(el, '[data-human-review-forward]'), 'still offered');
		assert.ok(!$$(el, '.chip').some((c) => c.textContent === 'Sent to the worker'));
	});

	it('has no forward for a preview no task reported', () => {
		const el = mount('human-review-edit', {
			preview: preview({ taskId: null }),
			d: data({ targets: [waiting()] })
		});
		assert.equal($(el, '[data-human-review-forward]'), null);
	});
});

describe('<human-review-task>', () => {
	const t = { id: 'lumen-pricing', title: 'Pricing page', project: 'lumen', preview: PREVIEW };

	it('shows each target’s state, waiting feedback first with what it sends', () => {
		const el = mount('human-review-task', {
			d: data({
				task: t,
				targets: [
					waiting(),
					target({
						key: 'k2',
						target: '/work/docs/plan.md',
						kind: 'file',
						label: 'plan.md',
						reviewOpen: false,
						working: true,
						counts: { comments: 3, edits: 0, note: false },
						feedback
					}),
					target({ key: 'k3', target: 'http://localhost:5173/', label: 'http://localhost:5173/' })
				]
			})
		});
		const cards = $$(el, '.card');
		assert.equal(cards.length, 3);
		assert.match(
			cards[0].textContent,
			/Feedback waiting.*1 comment, 2 edits, sent with no worker listening/
		);
		assert.ok(cards[0].querySelector('[data-human-review-forward]'));
		assert.match(
			cards[0].querySelector('details').textContent,
			/What it sends.*Say how long the trial is/
		);
		assert.match(cards[1].textContent, /plan\.md.*File.*Worker has it.*3 comments, being applied/);
		assert.match(cards[2].textContent, /Review open/);
		assert.equal(
			cards[2].querySelector('[data-human-review-edit]').textContent,
			'Edit with Human Review'
		);
		assert.match(el.shadowRoot.textContent, /bridge\/main\.mjs status --task lumen-pricing/);
	});

	it('forwards from the section with the task’s own id', () => {
		const host = fakeHost();
		const el = mount('human-review-task', { host, d: data({ task: t, targets: [waiting()] }) });
		$(el, '[data-human-review-forward]').click();
		assert.equal(host.calls.at(-1)[0], 'sendFeedback');
		assert.equal(host.calls.at(-1)[1].task, 'lumen-pricing');
	});

	it('forwards a target another task opened to that task’s worker', () => {
		const host = fakeHost();
		const el = mount('human-review-task', {
			host,
			d: data({ task: t, targets: [waiting({ task: 'lumen-hero' })] })
		});
		$(el, '[data-human-review-forward]').click();
		assert.equal(host.calls.at(-1)[1].task, 'lumen-hero');
	});

	it('stops offering Send on the same preview once the section forwards it', async () => {
		const host = fakeHost();
		const edit = mount('human-review-edit', {
			host,
			preview: { url: PREVIEW, taskId: 'lumen-pricing' },
			d: data({ targets: [waiting()] })
		});
		const section = mount('human-review-task', {
			host,
			d: data({ task: t, targets: [waiting()] })
		});
		assert.ok($(edit, '[data-human-review-forward]'));
		$(section, '[data-human-review-forward]').click();
		await tick();
		await tick();
		await tick();
		assert.match($(section, '[role=status]').textContent, /lumen-pricing’s worker/);
		assert.equal($(edit, '[data-human-review-forward]'), null);
		assert.ok($$(edit, '.chip').some((c) => c.textContent === 'Sent to the worker'));
		assert.equal(host.calls.filter((c) => c[0] === 'sendFeedback').length, 1);
	});

	it('turns Send off in the section while the bridge is down', () => {
		const el = mount('human-review-task', {
			d: data({ task: t, bridge: null, targets: [waiting()] })
		});
		assert.equal($(el, '[data-human-review-forward]').disabled, true);
		assert.match($(el, '.card').textContent, /bridge to the worker is not running/);
	});

	it('opens a file review for the task', () => {
		const el = mount('human-review-task', {
			d: data({
				task: t,
				targets: [target({ target: '/work/docs/plan.md', kind: 'file', reviewOpen: false })]
			})
		});
		$(el, '[data-human-review-edit]').click();
		const u = new URL(opened[0][0]);
		assert.equal(u.searchParams.get('target'), '/work/docs/plan.md');
		assert.equal(u.searchParams.get('task'), 'lumen-pricing');
	});

	it('marks a forwarded batch as sent', () => {
		const el = mount('human-review-task', {
			d: data({ task: t, targets: [waiting({ forwardedAt: SENT_AT })] })
		});
		assert.equal($(el, '[data-human-review-forward]'), null);
		assert.match($(el, '.card').textContent, /Sent to the worker/);
	});

	it('says Human Review starts on demand and shows setting problems', () => {
		const el = mount('human-review-task', {
			d: data({
				task: t,
				humanReview: { version: '0.8.2', installed: false, running: false },
				problems: ['nope is not a Human Review version (x.y.z); using 0.8.2.'],
				targets: [target({ reviewOpen: false })]
			})
		});
		assert.match(el.shadowRoot.textContent, /It starts when you open a review/);
		assert.match($(el, '.error').textContent, /not a Human Review version/);
	});
});

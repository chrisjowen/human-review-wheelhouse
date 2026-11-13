/**
 * Human Review's elements: <human-review-edit> (Edit with Human Review on a
 * live preview) and <human-review-task> (the Human Review section on a task).
 * Wheelhouse sets `host`, `entry` and `data` (the provider's value: the
 * bridge's address and key, Human Review's state and each review target's),
 * and a preview.action element also gets `preview`.
 *
 * Edit with Human Review opens the review in a new tab, through the bridge,
 * which starts Human Review when it is not running and redirects the tab to a
 * new session; while the bridge is down, the click launches it first
 * (`host.launch`). Human Review only works where the browser is on the
 * computer running it, so on a phone or a remote Wheelhouse page the button
 * says so instead.
 *
 * Send to the worker forwards feedback the captain sent with no worker
 * listening, to the task the review was opened for, with `host.sendFeedback`
 * called first thing in the click, so it is the captain's own click that sends
 * it. The bridge notes the forward, so Send is off while the bridge is down.
 *
 * Every value from a review is set as text, never as HTML.
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Whether this page is open on the computer Wheelhouse (and Human Review) runs on. */
export const onThisComputer = (loc = globalThis.location) => LOOPBACK.has(loc?.hostname ?? '');

/** Whether Human Review can review this address: http(s) on this computer's loopback. */
export function reviewable(url) {
	try {
		const u = new URL(url);
		return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK.has(u.hostname);
	} catch {
		return false;
	}
}

/** The bridge address that opens a review of `target` and sends the tab there. */
export function openHref(base, { key, target, task }) {
	const u = new URL('open', base);
	u.searchParams.set('target', target);
	if (task) u.searchParams.set('task', task);
	u.searchParams.set('key', key);
	return u.href;
}

/** A URL without its fragment, as Human Review keys it. */
export function sameTarget(a, b) {
	try {
		const x = new URL(a);
		const y = new URL(b);
		x.hash = '';
		y.hash = '';
		return x.href === y.href;
	} catch {
		return a === b;
	}
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a batch holds, in a few words. */
export function countWords(c) {
	if (!c) return '';
	const parts = [];
	if (c.comments) parts.push(plural(c.comments, 'comment'));
	if (c.edits) parts.push(plural(c.edits, 'edit'));
	if (c.note) parts.push('a note');
	return parts.join(', ') || 'a Send';
}

function h(tag, cls, text) {
	const el = document.createElement(tag);
	if (cls) el.className = cls;
	if (text !== undefined && text !== null) el.textContent = String(text);
	return el;
}

function button(text, cls, onClick) {
	const b = h('button', cls, text);
	b.type = 'button';
	b.addEventListener('click', onClick);
	return b;
}

const NO_BRIDGE = 'The bridge to the worker is not running; Edit with Human Review starts it.';

const REMOTE =
	'Human Review opens on the computer that runs Wheelhouse. Open Wheelhouse there to edit with it; to review from another device, use Shared review.';

/**
 * What both elements share: the provider's value, the bridge's service view
 * (fetched ahead, so a click can open the tab at once), opening a review and
 * forwarding feedback.
 */
class HumanReviewElement extends HTMLElement {
	#data = null;
	#host = null;
	/** The bridge as `host.service` last said. */
	service = null;
	busy = false;
	message = null;
	/** Batches whose forward the bridge noted from this element, until the provider reads it back. */
	noted = new Set();
	/** What the last render drew: Wheelhouse sets `data` again often, and a redraw would swallow a click. */
	drawn = null;

	constructor() {
		super();
		this.attachShadow({ mode: 'open' });
	}

	set host(v) {
		this.#host = v;
		this.refreshService();
	}

	get host() {
		return this.#host;
	}

	set data(v) {
		const wasUp = !!this.#data?.bridge;
		this.#data = v;
		if (v?.bridge && !wasUp) {
			if (this.message?.launched) this.message = null;
		}
		if (!v?.bridge) this.refreshService();
		this.render();
	}

	get data() {
		return this.#data;
	}

	connectedCallback() {
		this.render();
	}

	refreshService() {
		const host = this.#host;
		if (!host?.service) return;
		host
			.service('bridge')
			.then((v) => {
				this.service = v;
				this.render();
			})
			.catch(() => {});
	}

	/**
	 * Open a review of `target` in a new tab. Call from a click: with the
	 * bridge up the tab opens at once; with it down, Wheelhouse launches it and
	 * then opens the tab.
	 */
	openReview({ target, task }) {
		const d = this.#data;
		if (!d) return;
		if (!onThisComputer()) {
			this.message = { text: REMOTE, error: true };
			this.render();
			return;
		}
		if (d.bridge) {
			window.open(openHref(d.bridge.url, { key: d.key, target, task }), '_blank', 'noopener');
			this.message = null;
			this.render();
			return;
		}
		const base = this.service?.url;
		const open = base ? openHref(base, { key: d.key, target, task }) : undefined;
		this.busy = true;
		this.message = { text: `Starting Human Review ${d.version}…`, launched: true };
		this.render();
		Promise.resolve(this.#host?.launch('bridge', { open }))
			.then((v) => {
				if (!v) throw new Error('This Wheelhouse cannot start Human Review.');
				if (v.state !== 'running') throw new Error(v.reason ?? `It did not start (${v.state}).`);
				this.message = open
					? { text: 'Human Review is opening in a new tab.', launched: true }
					: { text: 'Human Review is running; click again to open the review.', launched: true };
			})
			.catch((e) => {
				this.message = { text: e instanceof Error ? e.message : String(e), error: true };
			})
			.finally(() => {
				this.busy = false;
				this.render();
			});
	}

	/**
	 * Send a waiting batch to the worker of the task it was opened for (else
	 * `task`), through Firstmate, and have the bridge note it. The send is the
	 * first thing the click does, so the browser still counts the click.
	 */
	forward(t, task) {
		const d = this.#data;
		const host = this.#host;
		if (!host?.sendFeedback || !t.feedback || !d?.bridge) return;
		const sending = host.sendFeedback({
			task: t.task ?? task,
			subject: t.feedback.subject,
			items: t.feedback.items
		});
		this.busy = true;
		this.message = null;
		this.render();
		Promise.resolve(sending)
			.then(async (r) => {
				if (!r?.ok) throw new Error(r?.error ?? 'Wheelhouse did not send it.');
				const noted = await fetch(new URL('forwarded', d.bridge.url), {
					method: 'POST',
					headers: { 'content-type': 'application/json', 'x-human-review-bridge-key': d.key },
					body: JSON.stringify({ target: t.target, sentAt: t.sentAt })
				}).catch((e) => ({ ok: false, error: e }));
				if (!noted.ok) {
					const why = noted.error?.message ?? `it answered ${noted.status}`;
					throw new Error(`Sent to Firstmate, but the bridge could not note it (${why}).`);
				}
				this.noted.add(`${t.target}\n${t.sentAt}`);
				this.message = {
					text: r.pending
						? 'Sent to Firstmate for the worker; Wheelhouse is still confirming it.'
						: 'Sent to Firstmate, to pass to this task’s worker.'
				};
			})
			.catch((e) => {
				this.message = { text: e instanceof Error ? e.message : String(e), error: true };
			})
			.finally(() => {
				this.busy = false;
				this.render();
			});
	}

	isForwarded(t) {
		return !!t.forwardedAt || this.noted.has(`${t.target}\n${t.sentAt}`);
	}

	messageEl() {
		if (!this.message) return null;
		const m = h('span', this.message.error ? 'error' : 'muted', this.message.text);
		m.setAttribute('role', this.message.error ? 'alert' : 'status');
		return m;
	}

	render() {}
}

/** Edit with Human Review, on a live preview. */
class EditButton extends HumanReviewElement {
	#preview = null;

	set preview(v) {
		this.#preview = v;
		this.render();
	}

	get preview() {
		return this.#preview;
	}

	/** This preview's review target, as the provider last read it. */
	get target() {
		const p = this.#preview;
		const list = this.data?.targets ?? [];
		return p ? (list.find((t) => t.kind === 'url' && sameTarget(t.target, p.url)) ?? null) : null;
	}

	render() {
		const root = this.shadowRoot;
		if (!root) return;
		const style = h('style');
		style.textContent = EDIT_STYLE;
		const d = this.data;
		const p = this.#preview;
		if (!d || !p) {
			this.drawn = null;
			root.replaceChildren(style);
			return;
		}
		const t = this.target;
		const forwarded = t ? this.isForwarded(t) : false;
		const drawn = JSON.stringify([
			p.url,
			p.taskId,
			!!p.primary,
			!!d.bridge,
			this.service?.url ?? null,
			t && [t.task, t.waiting, t.working, t.sentAt, forwarded, t.counts],
			this.busy,
			this.message
		]);
		if (drawn === this.drawn) return;
		this.drawn = drawn;
		const wrap = h('span', 'edit');
		const ok = reviewable(p.url);
		const b = button('Edit with Human Review', p.primary ? 'primary' : '', () =>
			this.openReview({ target: p.url, task: p.taskId ?? null })
		);
		b.dataset.humanReviewEdit = '';
		b.disabled = this.busy || !ok;
		b.title = !ok
			? 'Human Review reviews pages on this computer only (localhost).'
			: !onThisComputer()
				? REMOTE
				: `Edit and comment on ${p.url} in Human Review, in a new tab; send your changes back to the ${p.taskId ? 'task’s worker' : 'crew'}.`;
		wrap.append(b);
		if (t?.waiting && p.taskId && !forwarded) {
			const f = button(`Send to the worker (${countWords(t.counts)})`, '', () =>
				this.forward(t, p.taskId)
			);
			f.dataset.humanReviewForward = '';
			f.disabled = this.busy || !d.bridge;
			f.title = d.bridge
				? `Your Send in Human Review is waiting: send it to ${t.task ?? p.taskId}’s worker, through Firstmate.`
				: NO_BRIDGE;
			wrap.append(f);
			if (!d.bridge) wrap.append(h('span', 'muted', NO_BRIDGE));
		} else if (t?.waiting && forwarded) {
			wrap.append(h('span', 'chip', 'Sent to the worker'));
		} else if (t?.working) {
			wrap.append(h('span', 'chip', 'Worker has your feedback'));
		}
		const m = this.messageEl();
		if (m) wrap.append(m);
		root.replaceChildren(style, wrap);
	}
}

/** The Human Review section on a task. */
class TaskSection extends HumanReviewElement {
	render() {
		const root = this.shadowRoot;
		if (!root) return;
		const style = h('style');
		style.textContent = TASK_STYLE;
		const d = this.data;
		if (!d?.task) {
			this.drawn = null;
			root.replaceChildren(style);
			return;
		}
		const drawn = JSON.stringify([
			d.task,
			!!d.bridge,
			d.humanReview,
			d.problems,
			d.targets.map((t) => [
				t.target,
				t.waiting,
				t.working,
				t.reviewOpen,
				t.listening,
				t.sentAt,
				this.isForwarded(t),
				t.unsent,
				t.counts
			]),
			this.busy,
			this.message
		]);
		if (drawn === this.drawn) return;
		this.drawn = drawn;

		const wrap = h('div', 'stack');
		const head = h('div', 'row');
		const hr = d.humanReview ?? {};
		head.append(
			h(
				'span',
				`chip ${hr.running ? 'ok' : ''}`,
				hr.running
					? `Human Review ${hr.version} running`
					: `Human Review ${hr.version ?? ''}`.trim()
			),
			h(
				'span',
				'muted',
				hr.running
					? 'Edits and comments go back to this task’s worker.'
					: 'It starts when you open a review.'
			)
		);
		wrap.append(head);
		for (const p of d.problems ?? []) wrap.append(h('p', 'error', p));
		if (!onThisComputer()) wrap.append(h('p', 'note', REMOTE));

		const list = h('div', 'stack');
		for (const t of d.targets) list.append(this.card(t, d.task));
		if (!d.targets.length) list.append(h('p', 'muted', 'Nothing to review yet.'));
		wrap.append(list);

		const m = this.messageEl();
		if (m) wrap.append(m);

		const more = h('details');
		more.append(h('summary', null, 'For Firstmate and workers'));
		const check = h('p');
		check.append(
			'This task’s reviews: ',
			h('code', null, `node ${d.cli} status --task ${d.task.id}`)
		);
		more.append(
			check,
			h(
				'p',
				'muted',
				'The captain’s Send comes back as a note about this task naming the command that takes the batch; after applying it, running that command again with --ack (in the background) receives the next Send directly.'
			)
		);
		wrap.append(more);
		root.replaceChildren(style, wrap);
	}

	card(t, task) {
		const bridge = !!this.data?.bridge;
		const card = h('div', 'card');
		const top = h('div', 'head');
		const name = h('span', 'name', t.label);
		name.title = t.target;
		top.append(name, h('span', 'chip', t.kind === 'url' ? 'Live app' : 'File'));
		card.append(top);

		const forwarded = this.isForwarded(t);
		const unsent = (t.unsent?.comments ?? 0) + (t.unsent?.edits ?? 0);
		const state = h('div', 'row');
		if (t.waiting) {
			state.append(
				h(
					'span',
					`chip ${forwarded ? '' : 'warn'}`,
					forwarded ? 'Sent to the worker' : 'Feedback waiting'
				),
				h(
					'span',
					'muted',
					forwarded
						? `${countWords(t.counts)}; the worker takes it with the command in the note.`
						: `${countWords(t.counts)}, sent with no worker listening.`
				)
			);
		} else if (t.working) {
			state.append(
				h('span', 'chip ok', 'Worker has it'),
				h('span', 'muted', `${countWords(t.counts)}, being applied.`)
			);
		} else if (t.reviewOpen) {
			state.append(
				h('span', 'chip ok', 'Review open'),
				h(
					'span',
					'muted',
					t.listening ? 'The worker is listening for your Send.' : 'In another tab.'
				)
			);
		} else {
			state.append(h('span', 'muted', 'No review open.'));
		}
		if (unsent) state.append(h('span', 'muted', `${plural(unsent, 'change')} not sent yet.`));
		card.append(state);

		const actions = h('div', 'row');
		const ok = t.kind === 'file' || reviewable(t.target);
		const edit = button('Edit with Human Review', t.waiting && !forwarded ? '' : 'primary', () =>
			this.openReview({ target: t.target, task: task.id })
		);
		edit.disabled = this.busy || !ok;
		edit.dataset.humanReviewEdit = '';
		actions.append(edit);
		if (t.waiting && !forwarded) {
			const f = button('Send to the worker', 'primary', () => this.forward(t, task.id));
			f.disabled = this.busy || !t.feedback || !bridge;
			f.dataset.humanReviewForward = '';
			if (!bridge) f.title = NO_BRIDGE;
			actions.append(f);
		}
		card.append(actions);
		if (t.waiting && !forwarded && !bridge) card.append(h('span', 'muted small', NO_BRIDGE));

		if ((t.waiting || t.working) && t.feedback) {
			const what = h('details');
			what.append(h('summary', null, t.waiting && !forwarded ? 'What it sends' : 'What was sent'));
			const ol = h('ol', 'items');
			for (const it of t.feedback.items) {
				const li = h('li');
				li.append(h('span', 'body', it.text));
				if (it.points) li.append(h('span', 'muted small', it.points));
				ol.append(li);
			}
			what.append(ol);
			card.append(what);
		}
		return card;
	}
}

const BASE = `
:host { color: var(--foreground); font-family: var(--font-sans, inherit); }
* { box-sizing: border-box; }
button { font: inherit; cursor: pointer; color: var(--foreground); background: transparent; }
button.primary { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); }
button:disabled { opacity: 0.55; cursor: default; }
button:focus-visible, summary:focus-visible { outline: 2px solid var(--ring, var(--sea)); outline-offset: 2px; }
.chip { display: inline-block; border-radius: 999px; padding: 0 0.5rem; border: 1px solid var(--border); color: var(--muted-foreground); white-space: nowrap; }
.chip.ok { color: var(--success, #1b7a43); border-color: color-mix(in srgb, var(--success, #1b7a43) 45%, transparent); }
.chip.warn { color: var(--warning, #a15c00); border-color: color-mix(in srgb, var(--warning, #a15c00) 45%, transparent); }
.muted { color: var(--muted-foreground); }
.error { color: var(--danger, #b42318); }
`;

const EDIT_STYLE = `${BASE}
:host { display: inline-flex; font-size: 0.75rem; }
.edit { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.4rem; }
button { font-weight: 500; border-radius: 4px; padding: 0.125rem 0.375rem; border: 0; }
button:not(.primary):hover { background: var(--accent); }
/* On a touch screen each control is a thumb's size. */
@media (pointer: coarse) {
	:host { font-size: 0.875rem; }
	button { display: inline-flex; align-items: center; min-height: 2.75rem; padding: 0 0.75rem; border-radius: 0.75rem; white-space: nowrap; }
	button:not(.primary) { border: 1px solid var(--border); }
}
`;

const TASK_STYLE = `${BASE}
:host { display: block; font-size: 0.875rem; }
p { margin: 0; }
code { font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.8rem; background: var(--muted); padding: 0.1rem 0.3rem; border-radius: 4px; overflow-wrap: anywhere; }
.stack { display: grid; gap: 0.6rem; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.6rem; }
.head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 0.25rem 0.75rem; }
.card { border: 1px solid var(--border); background: var(--card); color: var(--card-foreground, inherit); border-radius: var(--radius, 10px); padding: 0.75rem 0.9rem; display: grid; gap: 0.45rem; min-width: 0; }
.name { font-weight: 600; overflow-wrap: anywhere; }
.small { font-size: 0.75rem; }
.target { overflow-wrap: anywhere; }
.note { border-radius: 8px; padding: 0.5rem 0.7rem; background: var(--muted); }
.chip { font-size: 0.75rem; }
button { font-size: 0.8rem; border-radius: 999px; padding: 0.3rem 0.8rem; border: 1px solid var(--border); }
details summary { cursor: pointer; color: var(--muted-foreground); }
details > p { margin-top: 0.4rem; }
.items { margin: 0.4rem 0 0; padding-left: 1.25rem; display: grid; gap: 0.3rem; max-height: 20rem; overflow: auto; }
.items li { display: grid; gap: 0.05rem; }
.items .body { overflow-wrap: anywhere; }
@media (pointer: coarse) {
	button { min-height: 2.75rem; padding: 0 0.9rem; }
}
`;

if (!customElements.get('human-review-edit'))
	customElements.define('human-review-edit', EditButton);
if (!customElements.get('human-review-task'))
	customElements.define('human-review-task', TaskSection);

/**
 * A Human Review batch as the feedback list Wheelhouse sends Firstmate
 * (`host.sendFeedback`): a first line telling the worker the exact command
 * that hands it the full batch, then one line per comment, edit and the
 * overall note, within Wheelhouse's limits. The list is the gist; the worker
 * applies the batch itself, which keeps every exact wording and its HTML.
 */

/** Wheelhouse's limits on a feedback list (docs/plugins.md, Sending feedback to Firstmate). */
export const LIMITS = { items: 30, text: 500, points: 200, subject: 200, bytes: 16 * 1024 };

/** Leave room for Wheelhouse's own lines around the list (task, plugin, closing request). */
const BUDGET = 13 * 1024;

/** A shell word, quoted only when it needs to be. */
export const shellQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

const fold = (s) =>
	String(s ?? '')
		.replace(/\s+/g, ' ')
		.trim();

/** At most `n` characters, cut with an ellipsis. */
export const clip = (s, n) => {
	const t = fold(s);
	return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1)).trimEnd()}…`;
};

const quoted = (s, n) => `“${clip(s, n - 2)}”`;

/** The command a worker runs to take the batch (and, with --ack, clear it and wait for the next). */
export function pollCommand(target, version) {
	return `npx -y human-review@${version} poll ${shellQuote(target)}`;
}

/** A short name for a reviewed page: a URL as it is, a file by its name. */
export function pageLabel(page) {
	if (page.kind === 'url') return page.url ?? page.file ?? '';
	const f = String(page.file ?? '');
	return f.split(/[\\/]/).pop() || f;
}

function editLine(e, cap) {
	if (e.kind === 'deleted') return `Deleted ${quoted(e.before || e.label, cap - 8)}`;
	if (e.kind === 'moved')
		return `Moved ${quoted(e.label || e.before, cap / 2)} ${e.moved_after ? `to after ${quoted(e.moved_after, cap / 2 - 20)}` : 'to the top of its section'}`;
	return `Now reads ${quoted(e.after, cap - 10)}`;
}

/**
 * The list for one batch: `{ subject, items }`.
 * @param {{ pages?: any[], overall_note?: string }} batch
 * @param {{ target: string, version: string }} o the target the review was opened on (what the worker polls)
 */
export function feedbackList(batch, { target, version }) {
	const pages = Array.isArray(batch?.pages) ? batch.pages : [];
	const many = pages.length > 1;
	const content = [];
	for (const page of pages) {
		const where = many ? ` on ${clip(pageLabel(page), 60)}` : '';
		for (const c of Array.isArray(page.comments) ? page.comments : []) {
			const about = c.kind === 'element' ? `the ${clip(c.quote, 80)} block` : quoted(c.quote, 120);
			content.push({ text: c.feedback, points: `${about}${where}`, kind: 'comment' });
		}
		for (const e of Array.isArray(page.edits) ? page.edits : []) {
			content.push({
				text: e,
				points: `${e.kind === 'edited' ? `Edited ${clip(e.label, 60)}, was ${quoted(e.before, 90)}` : `Edit to ${clip(e.label, 80)}`}${where}`,
				kind: 'edit'
			});
		}
	}
	if (fold(batch?.overall_note))
		content.push({ text: batch.overall_note, points: 'Overall note', kind: 'note' });

	const first = {
		text: `Human Review feedback is waiting for this task. Run \`${pollCommand(target, version)}\` in the worktree to take the full batch (exact wording and formatting, every page), apply it as Human Review's next_step says, then run the same command with --ack (in the background) to clear it and receive the captain's next Send directly.`,
		points: null
	};
	let shown = content;
	let more = 0;
	if (content.length > LIMITS.items - 1) {
		shown = content.slice(0, LIMITS.items - 2);
		more = content.length - shown.length;
	}

	const build = (cap) => {
		const items = shown.map((x) => ({
			text: x.kind === 'edit' ? editLine(x.text, cap) : clip(x.text, cap),
			points: clip(x.points, Math.min(LIMITS.points, Math.max(60, cap / 2)))
		}));
		if (more) items.push({ text: `…and ${more} more in the full batch.`, points: null });
		return [{ ...first, text: clip(first.text, LIMITS.text) }, ...items];
	};
	const size = (items) =>
		Buffer.byteLength(items.map((i) => `${i.text}\n${i.points ?? ''}\n`).join(''), 'utf8') +
		items.length * 24;
	let items = build(LIMITS.text);
	for (const cap of [300, 200, 120, 80]) {
		if (size(items) <= BUDGET) break;
		items = build(cap);
	}
	const label = pages.length === 1 ? pageLabel(pages[0]) : pageLabel({ kind: 'url', url: target });
	return {
		subject: clip(`Human Review of ${label || 'a page'}`, LIMITS.subject),
		items: items.map((i) => (i.text ? i : { ...i, text: '(empty)' }))
	};
}

/** Counts for a batch: comments, edits and whether it has an overall note. */
export function batchCounts(batch) {
	const pages = Array.isArray(batch?.pages) ? batch.pages : [];
	let comments = 0;
	let edits = 0;
	for (const p of pages) {
		comments += Array.isArray(p.comments) ? p.comments.length : 0;
		edits += Array.isArray(p.edits) ? p.edits.length : 0;
	}
	return { comments, edits, note: !!fold(batch?.overall_note) };
}

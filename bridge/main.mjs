#!/usr/bin/env node
/**
 * The Human Review plugin's bridge and the commands Firstmate and workers use.
 * One file to run, no dependencies (Node 20 or later).
 *
 *   node main.mjs serve --port <n>                 the bridge (Wheelhouse launches it)
 *   node main.mjs install                           install the Human Review version the bridge runs
 *   node main.mjs status [--task <id>] [--json]     review targets, their state and waiting feedback
 *                       [--preview <url>] [--in-worktree]   (the task's preview; files under this folder count as the task's)
 *
 * Options every command takes: --version <x.y.z> (the Human Review version,
 * default the one the plugin was tested with), --state <dir> (the plugin's
 * state folder) and --hr-state <dir> (Human Review's, default ~/.human-review).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	DEFAULT_VERSION,
	VERSION_RE,
	humanReviewStateDir,
	installDir,
	packageDir,
	stateDir
} from './paths.mjs';
import { serve } from './serve.mjs';
import { status } from './status.mjs';

const FLAGS = new Set(['json', 'help', 'in-worktree']);

/** `--name value` and `--flag` options, and the rest in order. */
export function parseArgs(argv) {
	const opts = {};
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith('--')) {
			rest.push(a);
			continue;
		}
		const eq = a.indexOf('=');
		const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
		if (eq > 0) opts[name] = a.slice(eq + 1);
		else if (FLAGS.has(name)) opts[name] = true;
		else {
			if (i + 1 >= argv.length) throw new Usage(`--${name} needs a value`);
			opts[name] = argv[++i];
		}
	}
	return { opts, rest };
}

export class Usage extends Error {}

const HELP = fs
	.readFileSync(fileURLToPath(import.meta.url), 'utf8')
	.split('\n')
	.slice(2, 15)
	.map((l) => l.replace(/^ \*\/?\s?/, ''))
	.join('\n')
	.trim();

function pluginVersion() {
	try {
		const m = JSON.parse(
			fs.readFileSync(new URL('../.wheelhouse-plugin/plugin.json', import.meta.url), 'utf8')
		);
		return m.version ?? null;
	} catch {
		return null;
	}
}

const print = (s = '') => process.stdout.write(`${s}\n`);

/** Install Human Review at a version, unless it already is. */
export function install(state, version, { run = spawnSync } = {}) {
	if (fs.existsSync(path.join(packageDir(state, version), 'package.json')))
		return `Human Review ${version} is installed.`;
	const dir = installDir(state, version);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
	const r = run(
		npm,
		[
			'install',
			'--prefix',
			dir,
			'--no-audit',
			'--no-fund',
			'--omit=dev',
			'--no-package-lock',
			`human-review@${version}`
		],
		{ stdio: 'inherit' }
	);
	if (r.error) throw new Usage(`npm could not run: ${r.error.message}`);
	if (r.status !== 0)
		throw new Usage(`npm install human-review@${version} failed (exit ${r.status}).`);
	return `Installed Human Review ${version}.`;
}

const n = (k, one) => `${k} ${one}${k === 1 ? '' : 's'}`;

function describe(t) {
	const state = t.waiting
		? `feedback waiting (${n(t.counts.comments, 'comment')}, ${n(t.counts.edits, 'edit')})${t.forwardedAt ? ', forwarded to the worker' : ''}`
		: t.working
			? 'feedback taken by a worker, not yet acknowledged'
			: t.reviewOpen
				? `review open${t.listening ? ', a worker is listening' : ''}`
				: 'no review open';
	const unsent = t.unsent.comments + t.unsent.edits;
	return [
		`${t.label}${t.task ? `  task ${t.task}` : ''}`,
		`  ${state}${unsent ? `; ${unsent} unsent in the browser` : ''}`,
		`  target: ${t.target}`,
		...(t.waiting || t.working ? [`  take it: ${t.pollCommand}`] : [])
	].join('\n');
}

export async function main(argv, env = process.env) {
	const { opts, rest } = parseArgs(argv);
	const cmd = rest.shift();
	if (!cmd || opts.help || cmd === 'help') return print(HELP);
	const version = opts.version ?? DEFAULT_VERSION;
	if (!VERSION_RE.test(version))
		throw new Usage(`${version} is not a Human Review version (x.y.z).`);
	const state = opts.state ? path.resolve(opts.state) : stateDir(env);
	const hrState = opts['hr-state'] ? path.resolve(opts['hr-state']) : humanReviewStateDir(env);

	if (cmd === 'serve') {
		const port = Number(opts.port ?? 0);
		if (!Number.isInteger(port) || port < 0 || port > 65535)
			throw new Usage('--port needs a port.');
		const pkg = packageDir(state, version);
		const server = await serve({
			port,
			state,
			hrState,
			pkg,
			version,
			pluginVersion: pluginVersion()
		});
		print(
			`Human Review bridge on http://127.0.0.1:${server.address().port}/ (Human Review ${version})`
		);
		const stop = () => server.close(() => process.exit(0));
		process.on('SIGTERM', stop);
		process.on('SIGINT', stop);
		return;
	}

	if (cmd === 'install') return print(install(state, version));

	if (cmd === 'status') {
		const task = opts.task ? { id: opts.task, preview: opts.preview ?? null } : null;
		const v = await status({
			state,
			hrState,
			version,
			task,
			// The provider runs this in the task's worktree when it has one, and says so.
			worktree: opts['in-worktree'] ? process.cwd() : null
		});
		if (opts.json) return print(JSON.stringify({ ...v, cwd: process.cwd() }));
		print(
			`Human Review ${v.humanReview.running ? `running on port ${v.humanReview.port}` : 'not running'}; bridge ${v.bridge ? `at ${v.bridge.url}` : 'not running'}.`
		);
		if (!v.targets.length) return print('No review targets.');
		for (const t of v.targets) print(`\n${describe(t)}`);
		return;
	}

	throw new Usage(`Unknown command ${cmd}. Run with --help.`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch((e) => {
		process.stderr.write(`${e instanceof Usage ? e.message : (e?.stack ?? e)}\n`);
		process.exit(e instanceof Usage ? 2 : 1);
	});
}

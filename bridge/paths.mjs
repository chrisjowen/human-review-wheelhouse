/**
 * Where things live, worked out the same way by the bridge, its CLI and the
 * plugin's server entry (which runs inside Wheelhouse and passes them on,
 * since a provider's commands run with a minimal environment). No
 * dependencies, so the server entry can import it alone.
 */

import path from 'node:path';

/**
 * The plugin's own state: the bridge's key and address, and which task each
 * review target belongs to. $WH_HUMAN_REVIEW_STATE, else Wheelhouse's state
 * folder (as Wheelhouse works it out) with plugins/human-review under it.
 */
export function stateDir(env = process.env) {
	if (env.WH_HUMAN_REVIEW_STATE) return path.resolve(env.WH_HUMAN_REVIEW_STATE);
	const base = env.WHEELHOUSE_STATE_DIR
		? path.resolve(env.WHEELHOUSE_STATE_DIR)
		: env.XDG_STATE_HOME
			? path.join(path.resolve(env.XDG_STATE_HOME), 'wheelhouse')
			: path.join(env.HOME ?? '', '.local', 'state', 'wheelhouse');
	return path.join(base, 'plugins', 'human-review');
}

/**
 * Human Review's own state folder, as its CLI works it out: the one server
 * per folder that the captain's tab and a worker's `npx -y human-review poll`
 * both talk to.
 */
export function humanReviewStateDir(env = process.env) {
	return env.HUMAN_REVIEW_STATE_DIR
		? path.resolve(env.HUMAN_REVIEW_STATE_DIR)
		: path.join(env.HOME ?? '', '.human-review');
}

/** Where the bridge installs a given Human Review version (npm --prefix). */
export function installDir(state, version) {
	return path.join(state, 'human-review', version);
}

/** The installed package's folder for that prefix. */
export function packageDir(state, version) {
	return path.join(installDir(state, version), 'node_modules', 'human-review');
}

/** What the bridge's health check names itself, so Wheelhouse tells it from anything else on its port. */
export const BRIDGE_SERVICE = 'wheelhouse-human-review-bridge';

/** The Human Review version the plugin was tested with, and installs unless its settings say otherwise. */
export const DEFAULT_VERSION = '0.8.2';

/** A version npm can install exactly: x.y.z with an optional pre-release. */
export const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

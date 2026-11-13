import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import plugin from '../wheelhouse/server/index.js';
import { DEFAULT_VERSION } from '../bridge/paths.mjs';

const manifest = JSON.parse(
	readFileSync(new URL('../.wheelhouse-plugin/plugin.json', import.meta.url), 'utf8')
);
// A copy of Wheelhouse's packages/plugin-sdk/plugin.schema.json.
const schema = JSON.parse(readFileSync(new URL('./plugin.schema.json', import.meta.url), 'utf8'));

describe('the manifest', () => {
	it('follows the Wheelhouse plugin schema', () => {
		const validate = new Ajv2020({ strict: false }).compile(schema);
		assert.ok(validate(manifest), JSON.stringify(validate.errors));
	});

	it('is the registry’s human-review entry', () => {
		assert.equal(manifest.name, 'human-review');
		assert.equal(manifest.displayName, 'Human Review');
		assert.equal(manifest.repository, 'https://github.com/chrisjowen/human-review-wheelhouse');
	});

	it('is off until turned on, and names entries that exist', () => {
		assert.equal(manifest.wheelhouse.enabledByDefault, false);
		assert.ok(existsSync(new URL(`../${manifest.wheelhouse.server}`, import.meta.url)));
		assert.ok(existsSync(new URL(`../${manifest.wheelhouse.ui}`, import.meta.url)));
		const icon = readFileSync(new URL('../wheelhouse/icon.svg', import.meta.url), 'utf8');
		assert.match(icon, /^<svg [^>]*viewBox="0 0 24 24"/);
	});

	it('offers to be the review surface, and sends feedback lists', () => {
		assert.deepEqual(manifest.wheelhouse.provides, [{ role: 'review.surface' }]);
		assert.deepEqual(manifest.wheelhouse.capabilities, ['feedback']);
	});

	it('lists exactly what the server entry contributes and runs', () => {
		assert.deepEqual(
			plugin.contributions.map((c) => ({ id: c.id, slot: c.slot })),
			manifest.wheelhouse.contributions
		);
		assert.deepEqual(
			plugin.services.map((s) => ({ id: s.id, scope: s.scope })),
			manifest.wheelhouse.services
		);
		for (const c of plugin.contributions) {
			assert.ok(plugin.providers.some((p) => p.id === c.provider));
			// An installed plugin's element tag starts with its id and a dash.
			assert.ok(c.render.element.startsWith(`${manifest.name}-`));
		}
		assert.deepEqual(manifest.wheelhouse.contributions, [
			{ id: 'edit', slot: 'preview.action' },
			{ id: 'session', slot: 'task.section' }
		]);
	});

	it('stays within the provider limits Wheelhouse allows', () => {
		const scope = Object.fromEntries(plugin.providers.map((p) => [p.id, p.scope]));
		for (const p of plugin.providers) assert.ok(p.timeoutMs <= 10_000);
		// A preview.action is fleet-wide; a task.section is about one task.
		const by = Object.fromEntries(plugin.contributions.map((c) => [c.slot, c.provider]));
		assert.equal(scope[by['preview.action']], 'fleet');
		assert.equal(scope[by['task.section']], 'task');
	});

	it('offers the Human Review version the code falls back to', () => {
		assert.equal(manifest.wheelhouse.settings.version.default, DEFAULT_VERSION);
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		// The tests run against that same version.
		assert.equal(pkg.devDependencies['human-review'], DEFAULT_VERSION);
	});

	it('agrees with package.json on the version', () => {
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		assert.equal(pkg.version, manifest.version);
		assert.equal(manifest.version, '0.1.0');
	});
});

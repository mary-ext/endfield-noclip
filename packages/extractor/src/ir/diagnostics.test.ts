import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DiagnosticCollector } from './diagnostics.ts';

describe('DiagnosticCollector', () => {
	it('groups diagnostics deterministically by severity, domain, and reason with deduplicated samples', () => {
		const collector = new DiagnosticCollector();
		collector.add({
			severity: 'gap',
			domain: 'particle',
			source: 'a.prefab',
			name: 'leaves',
			reason: 'dropped NoiseModule',
		});
		collector.add({
			severity: 'gap',
			domain: 'particle',
			source: 'a.prefab',
			name: 'leaves',
			reason: 'dropped NoiseModule',
		});
		collector.add({
			severity: 'gap',
			domain: 'interactive',
			source: 'int_gas',
			name: 'int_gas',
			reason: 'untested view-state key IsVisible',
		});
		collector.add({
			severity: 'stand-in',
			domain: 'prefab',
			source: 'b.prefab',
			name: 'trail',
			reason: 'unhandled renderer TrailRenderer',
		});

		const all = collector.summary();
		assert.equal(all.length, 3);
		assert.deepEqual(all[0], {
			severity: 'gap',
			domain: 'particle',
			reason: 'dropped NoiseModule',
			count: 2,
			samples: ['a.prefab :: leaves'],
		});
		assert.deepEqual(
			collector.summary((d) => d.severity === 'gap').map((g) => g.reason),
			['dropped NoiseModule', 'untested view-state key IsVisible'],
		);
	});
});

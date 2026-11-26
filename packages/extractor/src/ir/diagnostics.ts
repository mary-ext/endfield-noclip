import { compareStrings } from '../compare.ts';

/** how severe a diagnostic is */
export type DiagnosticSeverity = 'stand-in' | 'gap' | 'unsupported' | 'skipped';

/** which subsystem produced a diagnostic */
export type DiagnosticDomain =
	| 'prefab'
	| 'particle'
	| 'interactive'
	| 'material'
	| 'entity'
	| 'environment'
	| 'water'
	| 'terrain';

/** a structured record of something the extractor could not represent faithfully */
export interface Diagnostic {
	severity: DiagnosticSeverity;
	domain: DiagnosticDomain;
	/** asset path, template id, chunk file, or LevelData source */
	source: string;
	/** GameObject, entity, or interactive name */
	name: string;
	/** why it stood in, was degraded, or was skipped */
	reason: string;
	/** world position rounded to metres, when placed */
	position?: [number, number, number] | null;
	/** optional domain-specific context */
	meta?: Record<string, unknown>;
}

/** grouped diagnostic summary row written to `debug/gaps.json` */
export interface DiagnosticGroup {
	severity: DiagnosticSeverity;
	domain: DiagnosticDomain;
	reason: string;
	count: number;
	/** representative `source :: name` entries */
	samples: string[];
}

const MAX_SAMPLES = 5;

/** collects diagnostics from any extraction stage and produces deterministic grouped summaries */
export class DiagnosticCollector {
	readonly #entries: Diagnostic[] = [];

	/** records a diagnostic */
	add(diagnostic: Diagnostic): void {
		this.#entries.push(diagnostic);
	}

	/** appends all diagnostics from another collector or iterable */
	merge(diagnostics: Iterable<Diagnostic>): void {
		for (const diagnostic of diagnostics) {
			this.#entries.push(diagnostic);
		}
	}

	/** @returns all recorded diagnostics in insertion order */
	entries(): readonly Diagnostic[] {
		return this.#entries;
	}

	/**
	 * groups diagnostics by `(severity, domain, reason)`, sorted by descending count then domain/reason
	 *
	 * @param filter optional predicate to select a subset (e.g. only `'gap'` diagnostics)
	 * @returns grouped rows with sample names
	 */
	summary(filter?: (diagnostic: Diagnostic) => boolean): DiagnosticGroup[] {
		const groups = new Map<string, DiagnosticGroup & { seenSamples: Set<string> }>();
		for (const entry of this.#entries) {
			if (filter !== undefined && !filter(entry)) {
				continue;
			}
			const key = `${entry.severity}\0${entry.domain}\0${entry.reason}`;
			let group = groups.get(key);
			if (group === undefined) {
				group = {
					severity: entry.severity,
					domain: entry.domain,
					reason: entry.reason,
					count: 0,
					samples: [],
					seenSamples: new Set(),
				};
				groups.set(key, group);
			}
			group.count++;
			const sample =
				entry.name === '' || entry.name === entry.source ? entry.source : `${entry.source} :: ${entry.name}`;
			if (group.samples.length < MAX_SAMPLES && !group.seenSamples.has(sample)) {
				group.seenSamples.add(sample);
				group.samples.push(sample);
			}
		}
		return [...groups.values()]
			.map(({ severity, domain, reason, count, samples }): DiagnosticGroup => ({
				severity,
				domain,
				reason,
				count,
				samples,
			}))
			.toSorted(
				(a, b) =>
					b.count - a.count ||
					compareStrings(a.severity, b.severity) ||
					compareStrings(a.domain, b.domain) ||
					compareStrings(a.reason, b.reason),
			);
	}
}

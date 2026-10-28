/** times consecutive phases of a job, logging each as it ends */
export class PhaseTimer {
	/** milliseconds per phase name, in completion order */
	readonly timings: Record<string, number> = {};
	readonly #log: (line: string) => void;
	#start = performance.now();

	/** @param log receives one line per finished phase */
	constructor(log: (line: string) => void) {
		this.#log = log;
	}

	/**
	 * ends the current phase; the next one starts now
	 *
	 * @param name the phase that just finished
	 */
	end(name: string): void {
		const now = performance.now();
		this.timings[name] = Math.round(now - this.#start);
		this.#start = now;
		this.#log(`  ${name}: ${(this.timings[name] / 1000).toFixed(1)} s`);
	}

	/**
	 * adopts phases another timer measured (and logged) in the meantime; the next phase starts now
	 *
	 * @param timings the other timer's phases
	 */
	adopt(timings: Readonly<Record<string, number>>): void {
		Object.assign(this.timings, timings);
		this.#start = performance.now();
	}
}

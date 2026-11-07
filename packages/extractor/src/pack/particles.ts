import { createHash } from 'node:crypto';

import type { ParticleSystemInfo, ParticlesTable } from '@endfield-noclip/package-format/particles';

/** the particles table, with equal systems sharing one entry */
export class ParticleTable {
	readonly #systems: ParticleSystemInfo[] = [];
	readonly #keys: string[] = [];
	readonly #ids = new Map<string, number>();

	/**
	 * @param system a particle system
	 * @returns its id; equal systems return equal ids
	 */
	intern(system: ParticleSystemInfo): number {
		return this.#ids.getOrInsertComputed(JSON.stringify(system), (json) => {
			this.#keys.push(createHash('sha256').update(json).digest('hex').slice(0, 32));
			return this.#systems.push(system) - 1;
		});
	}

	/**
	 * @param id a system's id
	 * @returns a key naming the system by its content rather than by when it was first met
	 */
	keyOf(id: number): string {
		return this.#keys[id];
	}

	/** @returns the table as the package stores it */
	table(): ParticlesTable {
		return { systems: this.#systems };
	}
}

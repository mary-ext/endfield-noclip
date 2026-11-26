import { hash as cryptoHash } from 'node:crypto';

import {
	computeShapeMeshCdf,
	type LutsTable,
	type ParticleShapeMeshLut,
} from '@endfield-noclip/package-format/luts';
import {
	ParticleShapeKind,
	type ParticleSystemInfo,
	type ParticlesTable,
} from '@endfield-noclip/package-format/particles';

const fnv1a32 = (text: string): number => {
	let hash = 0x81_1c_9d_c5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01_00_01_93);
	}
	return hash >>> 0;
};

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
			this.#keys.push(cryptoHash('sha256', json, 'hex').slice(0, 32));
			const seedSalt =
				system.seedSalt ??
				fnv1a32(JSON.stringify({ ...system, mesh: 0, pivot: null, trail: null, seedSalt: undefined }));
			return this.#systems.push({ ...system, seedSalt }) - 1;
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

	/**
	 * extracts particle shape-mesh vertex/primitive arrays into deduplicated binary LUTs
	 * (`tables/luts.bin.zst`) with precomputed cumulative area CDFs, replacing inline arrays in
	 * `tables/particles.json.zst` with `lut` indices
	 *
	 * @returns the lean particles table and its companion LUT table
	 */
	finish(): { particles: ParticlesTable; luts: LutsTable } {
		const shapeMeshes: ParticleShapeMeshLut[] = [];
		const meshIds = new Map<string, number>();
		const extractSystem = (system: ParticleSystemInfo): ParticleSystemInfo => {
			let next = system;
			if (next.shape?.kind === ParticleShapeKind.Mesh) {
				const { mesh } = next.shape;
				const key = JSON.stringify([
					mesh.corners,
					mesh.positions,
					mesh.normals,
					mesh.colors,
					mesh.primitives,
				]);
				const lut = meshIds.getOrInsertComputed(key, () => {
					const positions =
						mesh.positions instanceof Float32Array ? mesh.positions : Float32Array.from(mesh.positions);
					const normals =
						mesh.normals === null
							? null
							: mesh.normals instanceof Float32Array
								? mesh.normals
								: Float32Array.from(mesh.normals);
					const colors =
						mesh.colors === null
							? null
							: mesh.colors instanceof Uint8Array
								? mesh.colors
								: Uint8Array.from(mesh.colors);
					const primitives =
						mesh.primitives instanceof Uint32Array ? mesh.primitives : Uint32Array.from(mesh.primitives);
					const areaCdf = computeShapeMeshCdf(positions, primitives, mesh.corners);
					return (
						shapeMeshes.push({
							primSize: mesh.corners,
							hasColor: colors !== null,
							positions,
							normals,
							colors,
							primitives,
							areaCdf,
						}) - 1
					);
				});
				next = {
					...next,
					shape: {
						...next.shape,
						mesh: {
							placement: mesh.placement,
							spawn: mesh.spawn,
							spread: mesh.spread,
							normalOffset: mesh.normalOffset,
							lut,
							positions: [],
							normals: null,
							colors: null,
							corners: mesh.corners,
							primitives: [],
						},
					},
				};
			}
			if (next.subEmitter != null) {
				const parent = extractSystem(next.subEmitter.parent);
				if (parent !== next.subEmitter.parent) {
					next = { ...next, subEmitter: { ...next.subEmitter, parent } };
				}
			}
			return next;
		};
		const systems = this.#systems.map(extractSystem);
		return {
			particles: { systems },
			luts: { curves: [], gradients: [], shapeMeshes },
		};
	}
}

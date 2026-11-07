/**
 * the current fill of each gameplay water volume, moving towards a picked level at that level's speed as the
 * game's scripts move it, and the instance rows of the interactives floating on each volume, kept at the same
 * height above its surface as packed (see docs/viewer/water.md "water volumes").
 *
 * @module
 */

import type { Vec3 } from '@endfield-noclip/package-format/values';
import type {
	WaterSurfaceEntry,
	WaterVolumeEntry,
	WaterVolumeSurface,
} from '@endfield-noclip/package-format/water';

import { ROW_WORDS } from '../content/instance-rows.ts';
import type { ResidentInstances } from '../streaming/resident.ts';

/** a floating row of a resident block */
interface FloatingRow {
	resident: ResidentInstances;
	row: number;
	volume: number;
	/** the row's packed translation y and bounds centre y, relative to its block origin */
	ty: number;
	cy: number;
	/** the offset last written */
	applied: number;
}

/** what a volume shows: its fill now and the fill it's moving to */
export interface WaterVolumeState {
	entry: WaterVolumeEntry;
	/** 0–1 of `heightMax` */
	current: number;
	target: number;
}

/**
 * @param entry a gameplay water volume
 * @param fraction a fill, 0–1 of its `heightMax`
 * @returns the volume's surface height at that fill, world y
 */
export const waterHeight = (entry: WaterVolumeEntry, fraction: number): number =>
	entry.base + entry.heightMax * fraction;

/**
 * @param surfaces the package's water surfaces
 * @param volume index into the package's water volumes
 * @returns the volume's surface, or `undefined` if none was packed
 */
export const volumeSurface = (
	surfaces: readonly WaterSurfaceEntry[],
	volume: number,
): WaterVolumeSurface | undefined =>
	surfaces.find((entry): entry is WaterVolumeSurface => entry.kind === 'volume' && entry.volume === volume);

/**
 * @param state a volume's fill
 * @param surface its surface
 * @returns where the surface is now: its bounds' centre at the current height, and its wider horizontal
 *   extent
 */
export const surfaceView = (
	{ entry, current }: WaterVolumeState,
	surface: WaterVolumeSurface,
): { center: Vec3; size: number } => {
	const { min, max } = surface.bounds;
	return {
		center: [(min[0] + max[0]) / 2, waterHeight(entry, current), (min[2] + max[2]) / 2],
		size: Math.max(max[0] - min[0], max[2] - min[2]),
	};
};

/** water volume fills and the rows floating on them */
export class WaterLevels {
	#volumes: WaterVolumeEntry[] = [];
	#current = new Float64Array(0);
	#target = new Float64Array(0);
	/** metres per second towards {@link #target} */
	#speed = new Float64Array(0);
	/** per volume, the index of the volume whose surface it follows, or -1 */
	#parents = new Int32Array(0);
	/** metres above the packed surface, per volume, for the water renderer */
	#offsets = new Float32Array(0);
	/** by instance-block blob, its floating rows and their volumes */
	#floaters = new Map<number, { row: number; volume: number }[]>();
	#rows = new Map<ResidentInstances, FloatingRow[]>();

	/** @param volumes the package's water volumes, all at their authored fill */
	setVolumes(volumes: readonly WaterVolumeEntry[]): void {
		this.#volumes = [...volumes];
		this.#current = Float64Array.from(volumes, (volume) => volume.initial);
		this.#target = Float64Array.from(this.#current);
		this.#speed = Float64Array.from(volumes, (volume) => volume.fillSpeed);
		this.#parents = Int32Array.from(volumes, (volume) => volume.parent ?? -1);
		this.#offsets = new Float32Array(volumes.length);
		this.#floaters.clear();
		for (const [i, volume] of volumes.entries()) {
			for (const { blob, row } of volume.floaters) {
				this.#floaters.getOrInsertComputed(blob, () => []).push({ row, volume: i });
			}
		}
		this.#rows.clear();
	}

	/** @returns every volume's fill and target */
	get states(): WaterVolumeState[] {
		return this.#volumes.map((entry, i) => ({ entry, current: this.#current[i], target: this.#target[i] }));
	}

	/** @returns per volume, metres its surface sits above where it was packed */
	get offsets(): Float32Array {
		return this.#offsets;
	}

	/**
	 * starts moving each volume towards the level its `waterLevel` control picks, at that level's speed, from
	 * the next {@link update}
	 *
	 * @param values every scene control's value
	 */
	follow(values: Readonly<Record<string, number>>): void {
		for (const [i, volume] of this.#volumes.entries()) {
			const level = volume.control === null ? undefined : volume.levels[values[volume.control] ?? -1];
			if (level === undefined || level.fraction === this.#target[i]) {
				continue;
			}
			this.#target[i] = level.fraction;
			this.#speed[i] = level.speed;
		}
	}

	/**
	 * puts every volume at the fill it's moving to, without the move: for a package's defaults (a pool a
	 * finished story drained starts drained) and after a reset
	 */
	settle(): void {
		this.#current.set(this.#target);
	}

	/**
	 * moves the volumes by a frame, linearly at their speed (the game eases the last metres in); a volume
	 * following another sits at its parent's surface, within its own depth
	 *
	 * @param dt seconds
	 * @param rate how many times faster than the game to move; `Infinity` jumps to the targets
	 * @returns whether any surface moved
	 */
	update(dt: number, rate: number): boolean {
		let moved = false;
		const offsets = this.#offsets;
		const volumes = this.#volumes;
		for (const [i, volume] of volumes.entries()) {
			const parent = this.#parents[i];
			if (parent !== -1) {
				const height = waterHeight(volumes[parent], this.#current[parent]);
				const fraction = volume.heightMax > 0 ? (height - volume.base) / volume.heightMax : 0;
				this.#current[i] = Math.min(Math.max(fraction, 0), 1);
				this.#target[i] = this.#current[i];
			}
			const current = this.#current[i];
			const target = this.#target[i];
			if (current !== target) {
				// a whole fill's step jumps (and keeps `0 · Infinity` from making it NaN)
				const step =
					volume.heightMax > 0 && rate !== Infinity ? (this.#speed[i] * dt * rate) / volume.heightMax : 1;
				this.#current[i] =
					target > current ? Math.min(target, current + step) : Math.max(target, current - step);
			}
			const offset = (this.#current[i] - volume.initial) * volume.heightMax;
			if (offset !== offsets[i]) {
				offsets[i] = offset;
				moved = true;
			}
		}
		return moved;
	}

	/**
	 * remembers a block's floating rows, if any
	 *
	 * @param resident a block just uploaded
	 * @param blob its blob-table index
	 */
	track(resident: ResidentInstances, blob: number): void {
		const floaters = this.#floaters.get(blob);
		if (floaters === undefined) {
			return;
		}
		const f32 = resident.rowsF32;
		this.#rows.set(
			resident,
			floaters.map(({ row, volume }) => {
				const at = row * ROW_WORDS;
				return { resident, row, volume, ty: f32[at + 7], cy: f32[at + 13], applied: 0 };
			}),
		);
	}

	/** @param resident a block being released */
	untrack(resident: ResidentInstances): void {
		this.#rows.delete(resident);
	}

	/**
	 * moves floating rows to their volume's surface, in the CPU copy the selection culls with and on the GPU
	 *
	 * @param write uploads one row of a resident block
	 */
	applyFloaters(write: (resident: ResidentInstances, row: number) => void): void {
		const offsets = this.#offsets;
		for (const rows of this.#rows.values()) {
			for (const floating of rows) {
				const offset = offsets[floating.volume];
				if (offset === floating.applied) {
					continue;
				}
				const at = floating.row * ROW_WORDS;
				const f32 = floating.resident.rowsF32;
				f32[at + 7] = floating.ty + offset;
				f32[at + 13] = floating.cy + offset;
				floating.applied = offset;
				write(floating.resident, floating.row);
			}
		}
	}
}

import { type LightEntry, LightKind } from '@endfield-noclip/package-format/lights';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { cross, normalize } from '../../math/vec3.ts';
import { MAX_LIGHT_CASTERS } from '../../streaming/gpu-cull-work.ts';

// the local lights' shadow maps, as the game keeps them (docs/game-data/lighting.md#local-light-shadows): a
// square atlas of cached tiles in three sizes, handed to the nearest shadow-casting lights and drawn one a
// frame. this module decides which light holds which tile and which tile is drawn; light-shadows.ts owns the
// atlas. how the viewer departs from the game is in docs/viewer/lighting.md#local-light-shadows.

/** the atlas edge, texels: four of the largest tiles */
export const ATLAS_SIZE = 4096;
/** tiles per level but the last, which takes the four cells the others leave for the next level too */
const LEVEL_SLOTS = 12;
const LEVELS = 3;
const SLOTS = LEVELS * LEVEL_SLOTS + 4;
/** a level's cells in its 4 × 4 grid; the last four are the quadrant the next level sits in */
const CELLS: readonly (readonly [number, number])[] = [
	[0, 0],
	[1, 0],
	[2, 0],
	[3, 0],
	[0, 1],
	[1, 1],
	[2, 1],
	[3, 1],
	[0, 2],
	[1, 2],
	[0, 3],
	[1, 3],
	[2, 2],
	[3, 2],
	[2, 3],
	[3, 3],
];
/** no light casts a shadow from farther than this from the camera, m */
const FORCE_CULL_DISTANCE = 200;
/** a point light's faces are this wide, degrees */
const FACE_FOV = 92;
/** the game's scale on a light's normal bias: 1.5 in the record, 5 in the lookup */
const NORMAL_BIAS_SCALE = 7.5;
/**
 * a tile drawn from this many times farther than the camera is now is drawn again, with the nearer view's
 * LODs
 */
const REFINE_RATIO = 2;
/** vec4s per shadow record in the light buffer: the matrix, the atlas rect, the parameters */
export const SHADOW_RECORD_VEC4S = 6;
/** records the light buffer holds: every slot a point light's, with all six faces */
export const MAX_SHADOW_RECORDS = SLOTS * 6;

/** each cube face's forward axis, in face bit order: +X −X +Y −Y +Z −Z */
const FACE_FORWARD: readonly Vec3[] = [
	[1, 0, 0],
	[-1, 0, 0],
	[0, 1, 0],
	[0, -1, 0],
	[0, 0, 1],
	[0, 0, -1],
];

/**
 * @param slot an atlas slot
 * @returns its level: 0 for the largest tiles
 */
export const slotLevel = (slot: number): number => Math.min(Math.floor(slot / LEVEL_SLOTS), LEVELS - 1);

/**
 * each level is a 4 × 4 grid of tiles a quarter of its square's edge, and the next level's square is its
 * bottom-right quadrant
 *
 * @param slot an atlas slot
 * @returns its tile in the atlas: the origin and edge, texels
 */
export const slotRect = (slot: number): { x: number; y: number; size: number } => {
	const level = slotLevel(slot);
	const size = ATLAS_SIZE >> (level + 2);
	const origin = ATLAS_SIZE - (ATLAS_SIZE >> level);
	const [cx, cy] = CELLS[slot - level * LEVEL_SLOTS];
	return { x: origin + cx * size, y: origin + cy * size, size };
};

/** a light the frame draws, nearest first */
export interface ShadowCandidate {
	entry: LightEntry;
	/** the light's camera-relative position */
	rel: Vec3;
	/** squared distance from the camera */
	distance2: number;
}

/** one shadow map: a spot's, or one cube face of a point light's */
interface Tile {
	entry: LightEntry;
	/** the cube face, 0 for a spot */
	face: number;
	/** its atlas slot, -1 while it has none */
	slot: number;
	/** the frame it was last among the targets */
	targeted: number;
	/** the level its rank asked for that frame */
	level: number;
	/** the content version it was last drawn at, -1 before its first draw */
	version: number;
	/** whether it was drawn with every caster it asked for resident */
	settled: boolean;
	/** the camera's distance to the light when it was drawn, m */
	distance: number;
}

/** the tile to draw this frame */
export interface TileRequest {
	/** camera-relative position → clip space of the tile's pass */
	render: Float32Array;
	/** the tile's viewport in the atlas, texels */
	x: number;
	y: number;
	size: number;
}

/** what {@link LightShadows.update} needs of the frame */
export interface ShadowFrame {
	/** whether the lights cast shadows: the sun's shadow passes, whose casters the tiles draw, are on */
	enabled: boolean;
	/** whether pipelines are still compiling, which would leave casters out of a tile drawn now */
	compiling: boolean;
	/** counts up whenever streamed content arrives */
	contentVersion: number;
	/** whether nothing is streaming in */
	streamIdle: boolean;
}

/** hands the atlas's tiles to the frame's shadow-casting lights and decides which tile to draw */
export class ShadowTiles {
	/** the tile to draw this frame, or `null`; set by {@link update} */
	request: TileRequest | null = null;
	readonly #tiles = new Map<LightEntry, (Tile | undefined)[]>();
	/** by slot, the tile holding it */
	readonly #slots: (Tile | null)[] = Array.from({ length: SLOTS }, () => null);
	/** this frame's targets, in rank order */
	readonly #targets: Tile[] = [];
	#frame = 0;
	#pending = false;
	/** whether the last {@link update} had shadows on */
	#enabled = false;
	/** the lights whose casters the last selection was asked for */
	#covered = new Set<LightEntry>();
	/** the lights to ask the next selection for, as world-space spheres (x, y, z, radius) */
	#casters = new Float64Array(0);
	#casterLights: LightEntry[] = [];
	readonly #request: TileRequest = { render: new Float32Array(16), x: 0, y: 0, size: 0 };
	readonly #matrix = new Float64Array(16);

	/** @returns whether a tile still waits to be drawn, so frames should keep rendering */
	get pending(): boolean {
		return this.#pending;
	}

	/** forgets every tile: the lights or what shows of them changed */
	reset(): void {
		this.#tiles.clear();
		this.#slots.fill(null);
		this.#targets.length = 0;
		this.#covered.clear();
		this.#casters = new Float64Array(0);
		this.#casterLights = [];
		this.#pending = false;
		this.request = null;
	}

	/**
	 * the lights whose tiles wait for casters, for the next selection to pick instances by. call once per
	 * selection: the lights handed out count as covered by it
	 *
	 * @returns world-space spheres (x, y, z, radius), at most {@link MAX_LIGHT_CASTERS}
	 */
	casterSpheres(): Float64Array {
		this.#covered = new Set(this.#casterLights);
		return this.#casters;
	}

	/**
	 * ranks this frame's shadow casters, frees the tiles of lights past their cull distance and picks the tile
	 * to draw. call once a frame, before packing the lights
	 *
	 * @param selected the frame's lights, nearest first
	 * @param frame whether tiles can be drawn, and the streamed content's state
	 */
	update(selected: readonly ShadowCandidate[], frame: ShadowFrame): void {
		this.#frame++;
		this.request = null;
		const targets = this.#targets;
		targets.length = 0;
		this.#pending = false;
		this.#enabled = frame.enabled;
		if (!frame.enabled) {
			this.#casters = new Float64Array(0);
			this.#casterLights = [];
			return;
		}
		// the n-th caster of the frame, nearest light first, asks for the level of slot n
		for (const { entry, distance2 } of selected) {
			const shadow = entry.shadow;
			if (shadow === null || targets.length >= SLOTS) {
				continue;
			}
			const distance = Math.sqrt(distance2);
			if (distance >= Math.min(shadow.cullDistance, FORCE_CULL_DISTANCE)) {
				this.#drop(entry);
				continue;
			}
			const faces = entry.kind === LightKind.Spot ? 1 : shadow.faces;
			const tiles = this.#tiles.getOrInsertComputed(entry, () => []);
			for (let face = 0; face < 6 && targets.length < SLOTS; face++) {
				if ((faces & (1 << face)) === 0) {
					continue;
				}
				const tile = (tiles[face] ??= {
					entry,
					face,
					slot: -1,
					targeted: 0,
					level: 0,
					version: -1,
					settled: false,
					distance: Infinity,
				});
				tile.targeted = this.#frame;
				tile.level = slotLevel(targets.length);
				if (distance * REFINE_RATIO < tile.distance) {
					tile.settled = false;
				}
				targets.push(tile);
			}
		}

		// one tile a frame: one whose level changed first (shrinking before growing), then a new one, then the
		// stalest of those still missing casters. a tile settles once it's drawn with the stream idle and its
		// light's casters asked for; until its light is among those, it's drawn with what the view holds
		let best: Tile | null = null;
		let bestScore = 0;
		const casterLights: LightEntry[] = [];
		for (const tile of targets) {
			if (tile.slot >= 0 && slotLevel(tile.slot) === tile.level && tile.settled) {
				continue;
			}
			this.#pending = true;
			if (casterLights.length < MAX_LIGHT_CASTERS && !casterLights.includes(tile.entry)) {
				casterLights.push(tile.entry);
			}
			let score = 0;
			if (tile.slot < 0) {
				score = 1e9;
			} else if (slotLevel(tile.slot) < tile.level) {
				score = 3e9;
			} else if (slotLevel(tile.slot) > tile.level) {
				score = 2e9;
			} else if (tile.version !== frame.contentVersion) {
				score = 1 + frame.contentVersion - tile.version;
			} else if (frame.streamIdle && this.#covered.has(tile.entry)) {
				score = 1;
			}
			if (score > bestScore) {
				best = tile;
				bestScore = score;
			}
		}
		this.#casterLights = casterLights;
		this.#casters = new Float64Array(casterLights.length * 4);
		for (const [i, entry] of casterLights.entries()) {
			this.#casters.set(casterSphere(entry), i * 4);
		}
		if (best === null || frame.compiling) {
			return;
		}
		if (best.slot < 0 || slotLevel(best.slot) !== best.level) {
			const slot = this.#allocate(best.level);
			if (slot < 0) {
				return;
			}
			if (best.slot >= 0) {
				this.#slots[best.slot] = null;
			}
			best.slot = slot;
			this.#slots[slot] = best;
		}
		const candidate = selected.find(({ entry }) => entry === best.entry);
		if (candidate === undefined) {
			return;
		}
		best.version = frame.contentVersion;
		best.settled = frame.streamIdle && this.#covered.has(best.entry);
		best.distance = Math.sqrt(candidate.distance2);
		const request = this.#request;
		const rect = slotRect(best.slot);
		request.x = rect.x;
		request.y = rect.y;
		request.size = rect.size;
		request.render.set(tileMatrix(this.#matrix, best.entry, best.face, candidate.rel));
		this.request = request;
	}

	/**
	 * writes a light's shadow records: one for a spot, six in face order for a point light
	 *
	 * @param out the light buffer's floats
	 * @param at where the records go, floats
	 * @param candidate the light, as this frame draws it
	 * @returns records written, or 0 when no tile of the light's is drawn yet
	 */
	writeRecords(out: Float32Array, at: number, candidate: ShadowCandidate): number {
		const tiles = this.#tiles.get(candidate.entry);
		const shadow = candidate.entry.shadow;
		if (
			!this.#enabled ||
			tiles === undefined ||
			shadow === null ||
			!tiles.some((tile) => tile !== undefined && tile.version >= 0)
		) {
			return 0;
		}
		const count = candidate.entry.kind === LightKind.Spot ? 1 : 6;
		const matrix = this.#matrix;
		for (let face = 0; face < count; face++) {
			const o = at + face * SHADOW_RECORD_VEC4S * 4;
			const tile = tiles[face];
			out.fill(0, o, o + SHADOW_RECORD_VEC4S * 4);
			if (tile === undefined || tile.slot < 0 || tile.version < 0) {
				continue;
			}
			const rect = slotRect(tile.slot);
			const m = tileMatrix(matrix, tile.entry, face, candidate.rel);
			// clip → the tile's uv (v down), depth and view depth
			for (let c = 0; c < 4; c++) {
				out[o + c * 4] = 0.5 * m[c * 4] + 0.5 * m[c * 4 + 3];
				out[o + c * 4 + 1] = -0.5 * m[c * 4 + 1] + 0.5 * m[c * 4 + 3];
				out[o + c * 4 + 2] = m[c * 4 + 2];
				out[o + c * 4 + 3] = m[c * 4 + 3];
			}
			out[o + 16] = rect.x / ATLAS_SIZE;
			out[o + 17] = rect.y / ATLAS_SIZE;
			out[o + 18] = rect.size / ATLAS_SIZE;
			out[o + 19] = rect.size / ATLAS_SIZE;
			// a texel's world size at 1 m, and the game's constant offset along the normal
			const texel = (2 * tanHalfFov(tile.entry)) / rect.size;
			out[o + 20] = texel;
			out[o + 21] = texel * shadow.normalBias * NORMAL_BIAS_SCALE;
			out[o + 22] = shadow.farPlane;
			out[o + 23] = 1;
		}
		return count;
	}

	/**
	 * @param entry a light with a shadow
	 * @param distance2 its squared distance from the camera
	 * @returns its shadow's strength from there: fading out towards its cull distance
	 */
	strength(entry: LightEntry, distance2: number): number {
		const shadow = entry.shadow;
		if (shadow === null) {
			return 0;
		}
		const cull = Math.min(shadow.cullDistance, FORCE_CULL_DISTANCE);
		const span = cull - shadow.fadeRatio * cull;
		const t = span > 0 ? (cull - Math.sqrt(distance2)) / span : 1;
		return shadow.strength * Math.min(Math.max(t, 0), 1);
	}

	/** frees a light's tiles: it's past its cull distance */
	#drop(entry: LightEntry): void {
		const tiles = this.#tiles.get(entry);
		if (tiles === undefined) {
			return;
		}
		for (const tile of tiles) {
			if (tile !== undefined && tile.slot >= 0) {
				this.#slots[tile.slot] = null;
			}
		}
		this.#tiles.delete(entry);
	}

	/**
	 * @param level the level wanted
	 * @returns a free slot of the level, or the slot of its tile targeted longest ago once that's freed; -1
	 *   when every tile of the level is a target of this frame
	 */
	#allocate(level: number): number {
		const first = level * LEVEL_SLOTS;
		const end = level === LEVELS - 1 ? SLOTS : first + LEVEL_SLOTS;
		let oldest = -1;
		for (let slot = first; slot < end; slot++) {
			const tile = this.#slots[slot];
			if (tile === null) {
				return slot;
			}
			if (
				tile.targeted < this.#frame &&
				(oldest < 0 || tile.targeted < (this.#slots[oldest]?.targeted ?? 0))
			) {
				oldest = slot;
			}
		}
		const evicted = oldest < 0 ? null : this.#slots[oldest];
		if (evicted !== null) {
			evicted.slot = -1;
			evicted.version = -1;
			evicted.settled = false;
			this.#slots[oldest] = null;
			// a light left without tiles is forgotten, until it's a target again
			const tiles = this.#tiles.get(evicted.entry);
			if (
				tiles !== undefined &&
				tiles.every((tile) => tile === undefined || (tile.slot < 0 && tile.targeted < this.#frame))
			) {
				this.#tiles.delete(evicted.entry);
			}
		}
		return oldest;
	}
}

/** @returns the tangent of half a light's shadow projection angle */
const tanHalfFov = (entry: LightEntry): number => {
	const degrees =
		entry.kind === LightKind.Spot
			? Math.min(Math.max(entry.spotAngle + (entry.shadow?.guardAngle ?? 0), 0), 179.9)
			: FACE_FOV;
	return Math.tan((degrees * Math.PI) / 360);
};

/** @returns a world-space sphere (x, y, z, radius) holding everything that can cast into a light's maps */
const casterSphere = (entry: LightEntry): [number, number, number, number] => {
	const far = entry.shadow?.farPlane ?? entry.range;
	const [x, y, z] = entry.position;
	if (entry.kind !== LightKind.Spot) {
		return [x, y, z, far];
	}
	// the cone's far cap, a disc `far · tan` wide at `far` along the axis, and the apex
	const tan = Math.min(tanHalfFov(entry), 4);
	const d = entry.direction;
	const along = tan >= 1 ? far : (far * (1 + tan * tan)) / 2;
	const radius = tan >= 1 ? far * tan : along;
	return [x + d[0] * along, y + d[1] * along, z + d[2] * along, radius];
};

/**
 * @param out 16 floats, written and returned
 * @param entry the light
 * @param face the cube face of a point light, 0 for a spot
 * @param rel the light's camera-relative position
 * @returns camera-relative position → the tile's clip space (column-major): depth 0 at the near plane and 1
 *   at the far plane, w the distance along the projection's axis
 */
const tileMatrix = (out: Float64Array, entry: LightEntry, face: number, rel: Vec3): Float64Array => {
	const shadow = entry.shadow;
	const near = Math.max(shadow?.nearPlane ?? 0.1, 1e-4);
	const far = Math.max(shadow?.farPlane ?? entry.range, near * 1.001);
	const scale = 1 / tanHalfFov(entry);
	// the light's frame, built as the sun's layers are so the passes wind triangles alike
	const z = entry.kind === LightKind.Spot ? entry.direction : FACE_FORWARD[face];
	const reference: Vec3 = Math.abs(z[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
	const x = normalize(cross(reference, z));
	const y = cross(z, x);
	const a = far / (far - near);
	const dot = (v: Vec3): number => v[0] * rel[0] + v[1] * rel[1] + v[2] * rel[2];
	for (let k = 0; k < 3; k++) {
		out[k * 4] = x[k] * scale;
		out[k * 4 + 1] = y[k] * scale;
		out[k * 4 + 2] = z[k] * a;
		out[k * 4 + 3] = z[k];
	}
	out[12] = -dot(x) * scale;
	out[13] = -dot(y) * scale;
	out[14] = -dot(z) * a - near * a;
	out[15] = -dot(z);
	return out;
};

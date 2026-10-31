/**
 * per-instance selection for packages with geometry: frustum and small-feature culling, then LOD selection
 * with the game's LODGroup thresholds, bucketing visible instances by (geometry, submesh, material, mirrored)
 * for instanced draws; mirrored instances flip their winding, so they cull the opposite face. instances whose
 * chosen LOD isn't resident yet request its geometry and draw the nearest resident LOD meanwhile, or their
 * box if none is. instances outside the view whose shadows can reach it go to cast-only buckets, which only
 * the shadow passes draw.
 *
 * this is the CPU version of the planned GPU cull pass: the output (an instance list plus per-bucket ranges)
 * is what a compute shader would write next to indirect draw arguments.
 *
 * @module
 */

import type { GeometryEntry } from '@endfield-noclip/package-format/geometry';
import { type Chain, DrawRole } from '@endfield-noclip/package-format/instances';
import type { ReadyTexture } from '@endfield-noclip/package-format/textures';

import { CULL_FLOATS, ROW_WORDS } from '../render/instance-rows.ts';
import { type MaterialLook, alphaTextureOf } from '../render/materials.ts';
import type { TextureBinding, TextureStore } from '../render/texture-store.ts';
import type { Plane, Vec3 } from '../scene/camera.ts';

import type { CasterVolume, InstanceRange } from './selection.ts';
import type { ContentItem, StreamManager } from './stream-manager.ts';

/** instances sharing one geometry submesh, material and handedness */
export interface MeshBucket {
	geometry: ContentItem;
	submesh: number;
	material: number;
	look: MaterialLook;
	/** whether the instances' transforms mirror them (negative determinant) */
	mirrored: boolean;
	/** whether the instances are outside the view and only draw into the shadow map */
	castOnly: boolean;
	/** global row indices; reset every frame */
	rows: number[];
	/** largest projected size of an instance this frame, px */
	pixels: number;
	/** offset and count of the rows in this frame's visible list, set by `InstanceRenderer.prepareList` */
	first: number;
	count: number;
	/** last frame the bucket had rows */
	frame: number;
}

/** this frame's mesh selection, reused across frames */
export interface MeshSelection {
	buckets: MeshBucket[];
	/** rows drawn as boxes (geometry pending or not converted) */
	boxes: number[];
}

/** camera inputs */
export interface MeshView {
	eye: Vec3;
	planes: readonly Plane[];
	pixelFactor: number;
	viewportHeight: number;
	/** cull instances smaller than this, px */
	minPixels: number;
	/** mip levels coarser than needed to stream material textures at (0 for full detail; each halves them) */
	textureBias: number;
	/** instances outside the view but in this volume are selected as shadow casters; `null` for none */
	casters: CasterVolume | null;
}

/** what the selector reads */
export interface MeshSelectorInit {
	/** LOD-chain templates */
	chains: readonly Chain[];
	/** the geometry table */
	geometries: readonly GeometryEntry[];
	/** by material id, from `materialLooks` */
	looks: readonly MaterialLook[];
	stream: StreamManager;
	textures: TextureStore;
}

/** a drawn (non-shadow, visible-material) draw of a chain */
interface ChainSlot {
	lod: number;
	minSquared: number;
	maxSquared: number;
	geometry: number;
	submesh: number;
	material: number;
	castsShadows: boolean;
	/** the slot's buckets, once they had rows, by {@link bucketIndex} */
	buckets: (MeshBucket | null)[];
}

/** @returns the index of a slot's bucket for mirrored (1) or unmirrored (0), cast-only or drawn instances */
const bucketIndex = (mirrored: 0 | 1, castOnly: boolean): number => mirrored + (castOnly ? 2 : 0);

/** buckets without rows for this many frames are dropped */
const BUCKET_LIFETIME = 600;
/** priority multiplier for shadow casters outside the view */
const CASTER_PRIORITY = 0.1;
/** shadow casters outside the view smaller than this are culled, px (as if on screen) */
const CASTER_MIN_PIXELS = 16;

/**
 * @param runs (chain, first, count) triples in row order
 * @param row a row
 * @returns the word offset of the run containing `row`, or of the first run after it
 */
const firstRunAt = (runs: Uint32Array, row: number): number => {
	let lo = 0;
	let hi = runs.length / 3;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (runs[mid * 3 + 1] + runs[mid * 3 + 2] <= row) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo * 3;
};

/** @returns whether a camera-relative sphere is at least partly inside the first `floats / 4` planes */
const sphereInPlanes = (
	planes: Float64Array,
	floats: number,
	x: number,
	y: number,
	z: number,
	radius: number,
): boolean => {
	for (let p = 0; p < floats; p += 4) {
		if (planes[p] * x + planes[p + 1] * y + planes[p + 2] * z + planes[p + 3] < -radius) {
			return false;
		}
	}
	return true;
};

/** selects LODs and buckets instances */
export class MeshSelector {
	readonly selection: MeshSelection = { buckets: [], boxes: [] };
	#chains: readonly Chain[];
	#geometries: readonly GeometryEntry[];
	#looks: readonly MaterialLook[];
	#stream: StreamManager;
	#textures: TextureStore;
	#buckets = new Map<number, MeshBucket>();
	/** drawn draws per chain, built on first use */
	#slots: (ChainSlot[] | undefined)[] = [];
	#frame = 0;
	/** per geometry: the frame {@link #geometryReady} last looked it up */
	#checkedFrame: Int32Array;
	/** per geometry: whether it was resident that frame */
	#ready: Uint8Array;
	/** per geometry: the highest priority it was wanted with that frame */
	#wanted: Float64Array;
	#planes = new Float64Array(4 * 5);
	#casterPlanes = new Float64Array(4 * 5);
	#pending: ChainSlot[] = [];

	/** @param init tables and residency */
	constructor(init: MeshSelectorInit) {
		this.#chains = init.chains;
		this.#geometries = init.geometries;
		this.#looks = init.looks;
		this.#stream = init.stream;
		this.#textures = init.textures;
		const count = init.geometries.length;
		this.#checkedFrame = new Int32Array(count).fill(-1);
		this.#ready = new Uint8Array(count);
		this.#wanted = new Float64Array(count);
	}

	/**
	 * @param ranges the instance ranges the tree traversal selected
	 * @param view camera inputs
	 * @returns buckets and box fallbacks (the same object every frame)
	 */
	run(ranges: readonly InstanceRange[], view: MeshView): MeshSelection {
		const frame = ++this.#frame;
		const selection = this.selection;
		const buckets = selection.buckets;
		const boxes = selection.boxes;
		buckets.length = 0;
		boxes.length = 0;
		const { eye, pixelFactor, viewportHeight, minPixels, casters } = view;
		const planes = this.#planes;
		const planeFloats = Math.min(view.planes.length * 4, planes.length);
		for (let p = 0; p < planeFloats; p++) {
			planes[p] = view.planes[p >> 2][p & 3];
		}
		const casterPlanes = this.#casterPlanes;
		let casterFloats = 0;
		let casterDistance = 0;
		if (casters !== null) {
			casterFloats = Math.min(casters.planes.length * 4, casterPlanes.length);
			for (let p = 0; p < casterFloats; p++) {
				casterPlanes[p] = casters.planes[p >> 2][p & 3];
			}
			casterDistance = casters.distance;
		}
		const pending = this.#pending;

		for (const { item, first, count } of ranges) {
			const instances = item.resident;
			if (instances?.kind !== 'instances') {
				continue;
			}
			const f32 = instances.rowsF32;
			const cull = instances.cull;
			const ox = instances.origin[0] - eye[0];
			const oy = instances.origin[1] - eye[1];
			const oz = instances.origin[2] - eye[2];
			const runs = instances.runs;
			const end = first + count;
			for (let r = firstRunAt(runs, first); r < runs.length; r += 3) {
				const runFirst = runs[r + 1];
				const runEnd = runFirst + runs[r + 2];
				if (runFirst >= end) {
					break;
				}
				if (runEnd <= first) {
					continue;
				}
				const slots = this.#chainSlots(runs[r]);
				const last = Math.min(end, runEnd);
				for (let i = Math.max(first, runFirst); i < last; i++) {
					const at = i * ROW_WORDS;
					const x = ox + f32[at + 12];
					const y = oy + f32[at + 13];
					const z = oz + f32[at + 14];
					const radius = cull[i * CULL_FLOATS];
					const distance = Math.max(Math.sqrt(x * x + y * y + z * z), 0.1);
					if ((radius * pixelFactor) / distance < minPixels) {
						continue;
					}
					let castOnly = false;
					if (!sphereInPlanes(planes, planeFloats, x, y, z, radius)) {
						if (
							casterFloats === 0 ||
							(radius * pixelFactor) / distance < CASTER_MIN_PIXELS ||
							distance - radius > casterDistance ||
							!sphereInPlanes(casterPlanes, casterFloats, x, y, z, radius)
						) {
							continue;
						}
						castOnly = true;
					}
					// Unity's LODGroup metric: the object's size relative to the screen height
					const relative = (2 * cull[i * CULL_FLOATS + 1] * pixelFactor) / (distance * viewportHeight);
					const squared = relative * relative;
					const priority = relative * viewportHeight * (castOnly ? CASTER_PRIORITY : 1);

					let pendingCount = 0;
					let ready = true;
					let lod = -1;
					for (let s = 0; s < slots.length; s++) {
						const slot = slots[s];
						if (!(squared > slot.minSquared && squared <= slot.maxSquared)) {
							continue;
						}
						lod = slot.lod;
						if (castOnly && !slot.castsShadows) {
							continue;
						}
						if (this.#geometryReady(slot.geometry, priority, frame)) {
							pending[pendingCount++] = slot;
						} else {
							ready = false;
						}
					}
					if (lod < 0) {
						// culled by the LOD chain's smallest threshold
						continue;
					}
					const row = instances.alloc.start + i;
					if (!ready) {
						pendingCount = this.#residentLod(slots, lod, castOnly);
						if (pendingCount === 0) {
							if (!castOnly) {
								boxes.push(row);
							}
							continue;
						}
					}
					// the sign of the transform's determinant (its rows are the matrix rows)
					const mirrored =
						f32[at] * (f32[at + 5] * f32[at + 10] - f32[at + 6] * f32[at + 9]) -
							f32[at + 1] * (f32[at + 4] * f32[at + 10] - f32[at + 6] * f32[at + 8]) +
							f32[at + 2] * (f32[at + 4] * f32[at + 9] - f32[at + 5] * f32[at + 8]) <
						0
							? 1
							: 0;
					for (let p = 0; p < pendingCount; p++) {
						const slot = pending[p];
						const bucket =
							slot.buckets[bucketIndex(mirrored, castOnly)] ?? this.#bucketOf(slot, mirrored, castOnly);
						if (bucket.frame !== frame) {
							bucket.frame = frame;
							bucket.rows.length = 0;
							bucket.pixels = 0;
							buckets.push(bucket);
						}
						bucket.rows.push(row);
						if (priority > bucket.pixels) {
							bucket.pixels = priority;
						}
					}
				}
			}
		}

		const texturePixels = 2 ** -view.textureBias;
		for (const bucket of buckets) {
			const look = bucket.look;
			if (bucket.castOnly) {
				// a shadow needs only the texture holding the alpha it's cut out by
				const alpha = look.cutout ? alphaTextureOf(look) : -1;
				if (alpha >= 0) {
					this.#streamTexture(
						alpha,
						bucket.pixels * texturePixels,
						look.uvScales[look.textures.indexOf(alpha)],
					);
				}
				continue;
			}
			for (let i = 0; i < look.textures.length; i++) {
				if (look.textures[i] >= 0) {
					this.#streamTexture(look.textures[i], bucket.pixels * texturePixels, look.uvScales[i]);
				}
			}
		}
		if (frame % BUCKET_LIFETIME === 0) {
			this.#prune(frame);
		}
		return selection;
	}

	/**
	 * wants a geometry at `priority` and reports whether it's resident. residency can't change before the
	 * stream update, so each geometry is asked about at most once per frame and priority increase.
	 */
	#geometryReady(geometry: number, priority: number, frame: number): boolean {
		if (this.#checkedFrame[geometry] !== frame) {
			this.#checkedFrame[geometry] = frame;
			this.#wanted[geometry] = -Infinity;
			this.#ready[geometry] = 0;
		}
		if (priority > this.#wanted[geometry]) {
			this.#wanted[geometry] = priority;
			const entry = this.#geometries[geometry];
			this.#ready[geometry] =
				entry?.status === 'ready' && this.#stream.want(entry.blob, priority) !== null ? 1 : 0;
		}
		return this.#ready[geometry] === 1;
	}

	/**
	 * finds a stand-in for an instance whose wanted LOD is still streaming: the nearest LOD whose geometry is
	 * all resident, coarser first on ties because far LODs are smaller and more often loaded. usually that's
	 * the LOD drawn before the switch, so the instance keeps its shape instead of dropping to its box.
	 * stand-ins are kept in use but not requested, so they don't add to the streaming queue.
	 *
	 * @param castOnly whether only the shadow-casting slots are wanted
	 * @returns how many of the stand-in's slots were written to `#pending` (0 when no LOD is resident)
	 */
	#residentLod(slots: readonly ChainSlot[], wanted: number, castOnly: boolean): number {
		let maxLod = 0;
		for (const slot of slots) {
			maxLod = Math.max(maxLod, slot.lod);
		}
		const pending = this.#pending;
		for (let step = 1; step <= Math.max(wanted, maxLod - wanted); step++) {
			for (let side = 0; side < 2; side++) {
				const lod = side === 0 ? wanted + step : wanted - step;
				if (lod < 0 || lod > maxLod) {
					continue;
				}
				let count = 0;
				let resident = true;
				for (const slot of slots) {
					if (slot.lod !== lod || (castOnly && !slot.castsShadows)) {
						continue;
					}
					if (!this.#geometryResident(slot.geometry)) {
						resident = false;
						break;
					}
					pending[count++] = slot;
				}
				if (resident && count > 0) {
					for (let p = 0; p < count; p++) {
						this.#keepGeometry(pending[p].geometry);
					}
					return count;
				}
			}
		}
		return 0;
	}

	/** whether a geometry is resident, without requesting it or marking it used */
	#geometryResident(geometry: number): boolean {
		const entry = this.#geometries[geometry];
		return entry?.status === 'ready' && this.#stream.isReady(entry.blob);
	}

	/** marks a resident geometry used this frame, so it isn't evicted */
	#keepGeometry(geometry: number): void {
		const entry = this.#geometries[geometry];
		if (entry?.status === 'ready') {
			this.#stream.markUsed(entry.blob);
		}
	}

	#chainSlots(chain: number): ChainSlot[] {
		let slots = this.#slots[chain];
		if (slots === undefined) {
			slots = [];
			for (const draw of this.#chains[chain].draws) {
				const look = draw.material < this.#looks.length ? this.#looks[draw.material] : undefined;
				if (draw.role === DrawRole.ShadowOnly || look?.drawn !== true) {
					continue;
				}
				slots.push({
					lod: draw.lod,
					minSquared: draw.minSquared,
					maxSquared: draw.maxSquared,
					geometry: draw.geometry,
					submesh: draw.submesh,
					material: draw.material,
					castsShadows: look.castsShadows,
					buckets: [null, null, null, null],
				});
			}
			this.#slots[chain] = slots;
		}
		return slots;
	}

	#bucketOf(slot: ChainSlot, mirrored: 0 | 1, castOnly: boolean): MeshBucket {
		const { geometry, submesh, material } = slot;
		const index = bucketIndex(mirrored, castOnly);
		const key = ((geometry * 256 + submesh) * 65_536 + material) * 4 + index;
		let bucket = this.#buckets.get(key);
		if (bucket === undefined) {
			const entry = this.#geometries[geometry];
			const item = entry.status === 'ready' ? this.#stream.get(entry.blob) : undefined;
			if (item === undefined) {
				throw new Error(`geometry ${geometry} has no stream item`);
			}
			bucket = {
				geometry: item,
				submesh,
				material,
				look: this.#looks[material],
				mirrored: mirrored === 1,
				castOnly,
				rows: [],
				pixels: 0,
				first: 0,
				count: 0,
				frame: -1,
			};
			this.#buckets.set(key, bucket);
		}
		slot.buckets[index] = bucket;
		return bucket;
	}

	/** drops buckets unused for a while, and the slots' references to them */
	#prune(frame: number): void {
		let pruned = false;
		for (const [key, bucket] of this.#buckets) {
			if (bucket.frame < frame - BUCKET_LIFETIME) {
				this.#buckets.delete(key);
				pruned = true;
			}
		}
		if (pruned) {
			for (const slots of this.#slots) {
				for (const slot of slots ?? []) {
					slot.buckets.fill(null);
				}
			}
		}
	}

	/**
	 * requests a texture's pieces coarse to fine, up to the level its largest on-screen use needs: about one
	 * texel per pixel across the object, scaled by how often the UVs tile
	 */
	#streamTexture(id: number, pixels: number, uvScale: number): void {
		const entry = this.#textures.streamable(id, '2d');
		if (entry === null) {
			return;
		}
		const texels = Math.max(entry.width, entry.height) * uvScale;
		const level = Math.min(
			entry.mipCount - 1,
			Math.max(0, Math.floor(Math.log2(texels / Math.max(pixels, 1)))),
		);
		requestTexturePieces({ stream: this.#stream, textures: this.#textures, entry, level, priority: pixels });
	}
}

/**
 * requests a texture's pieces coarse to fine, down to the piece holding `level`, and keeps the integrated
 * ones in use.
 *
 * @param request the stream, the texture store, the texture, the finest level wanted and the priority
 */
const requestTexturePieces = (request: {
	stream: StreamManager;
	textures: TextureStore;
	entry: ReadyTexture;
	level: number;
	priority: number;
}): void => {
	const { stream, textures, entry, level, priority } = request;
	const pieces = entry.pieces;
	const integrated = textures.integrated(entry.id);
	for (let i = 0; i < pieces.length; i++) {
		const piece = pieces[i];
		const blob = piece.blob;
		if (i < integrated) {
			stream.markUsed(blob);
		} else if (i === integrated) {
			// a piece left over from before a coarser one was evicted can't be integrated: fetch it again
			if (stream.isReady(blob)) {
				stream.discard(blob);
			}
			// coarse pieces first; the tail always, then each level the view needs
			if (i === 0 || piece.firstLevel + piece.levelCount - 1 >= level) {
				stream.want(blob, priority / (1 + i));
			}
		} else {
			// decoded ahead of a coarser piece: keep it from looking unused until it's integrated
			stream.markUsed(blob);
		}
		if (piece.firstLevel <= level) {
			break;
		}
	}
};

/** a texture streamed whole by {@link streamWholeTexture} */
export interface StreamedTexture {
	entry: ReadyTexture;
	/** `null` until its tail arrives */
	binding: TextureBinding | null;
}

/**
 * requests every level of a texture (sky and water textures, which aren't picked by screen size).
 *
 * @param request the stream, the texture store, the texture id (or `null` for none), the kind it's bound as
 *   and the priority
 * @returns the texture and its current binding, or `null` without a texture streamable as that kind
 */
export const streamWholeTexture = (request: {
	stream: StreamManager;
	textures: TextureStore;
	id: number | null;
	kind: '2d' | 'cube' | '2d-array';
	priority: number;
}): StreamedTexture | null => {
	const { stream, textures, id, kind, priority } = request;
	const entry = id === null ? null : textures.streamable(id, kind);
	if (entry === null) {
		return null;
	}
	requestTexturePieces({ stream, textures, entry, level: 0, priority });
	return { entry, binding: textures.binding(entry.id) };
};

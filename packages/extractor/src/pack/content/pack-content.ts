import type { ChunkLight } from '@endfield-noclip/formats/endfield/chunk-lights';
import {
	DrawFlags,
	type RectDecal,
	type RendererDraw,
} from '@endfield-noclip/formats/endfield/init-chunk-data';
import { transformBounds } from '@endfield-noclip/formats/unity/transform';
import type { Aabb } from '@endfield-noclip/formats/unity/values';
import { type ChainDraw, DrawRole } from '@endfield-noclip/package-format/instances';
import { tileAt } from '@endfield-noclip/package-format/tiles';
import type { Rect } from '@endfield-noclip/package-format/values';

import type { Visibility } from '../../game/state/scene-control.ts';
import type { WorldIndex } from '../../game/world/world-index.ts';
import { ControlRegistry } from '../control-registry.ts';
import { AssetIds } from '../convert/asset-ids.ts';
import { AssetPlacement } from '../convert/asset-placement.ts';
import type { MaterialOverrides } from '../convert/assets.ts';
import type { StandInReport, UnsupportedInput } from '../debug.ts';
import { CASTS_EVERYWHERE, ChainTable, chainDrawFlagsOf } from '../instances/chains.ts';
import { Collector } from '../instances/collector.ts';
import { type InstanceInput, rowReach } from '../instances/instances.ts';
import type { SceneIndex } from '../scene-index.ts';
import { SkippedEntities } from '../skipped-entities.ts';
import { LightCollector } from '../tables/lights.ts';
import { ParticleTable } from '../tables/particles.ts';

// what the entity phase builds up. every content source (static chunks, dynamic structures, interactives,
// cabins, placed prefabs) writes through this one object: it interns draws, files rows, registers controls and
// lights, and reports what it left out here.

/** the largest f32: a draw's LOD range without an upper bound */
export const FLT_MAX = 3.4028234663852886e38;

/**
 * the unit box the game's VFXDecal prefabs draw; rect decals have no mesh of their own (the game draws a
 * box), so they take this one
 */
const DECAL_CUBE_PATH =
	'assets/beyond/arts/effects/commonassets/arts/s_model/s_fx_particle_decal_cube.fbx##decalmesh';

/** the synthetic stand-in cube's bounds */
export const UNIT_CUBE_BOUNDS: Aabb = { center: [0, 0, 0], extents: [0.5, 0.5, 0.5] };

/** the top of the 27-bit per-level id space, for ids the game doesn't assign */
const SYNTHETIC_ID_TOP = 0x7ffffff;

/** who owns a row of placed content, and when it loads */
export interface RowOwner {
	/** the owning level's tag */
	tag: number;
	/** entity or renderer name, for the debug index */
	name: string;
	visibility: Visibility;
	/** where the streaming centre draws the row, or `null` to draw it within the detail distance */
	loadReach: Rect | null;
}

/**
 * @param fields a draw's geometry and material, and whatever else differs from a plain lit draw
 * @returns the draw: by default lit, LOD 0 of submesh 0, never culled by distance, casting everywhere
 */
export const chainDraw = (
	fields: Pick<ChainDraw, 'geometry' | 'material'> & Partial<ChainDraw>,
): ChainDraw => ({
	particles: null,
	submesh: 0,
	lod: 0,
	role: DrawRole.Lit,
	minSquared: -1,
	maxSquared: FLT_MAX,
	flags: CASTS_EVERYWHERE,
	sortingLayer: 0,
	sortingOrder: 0,
	...fields,
});

/**
 * @param decal a rect decal
 * @returns its row's placement (`DECAL_PLACEMENT_FLOATS`): its colour with RGB times its intensity, then its
 *   UV scale and offset
 */
export const decalPlacement = (decal: RectDecal): number[] => [
	decal.color[0] * decal.intensity,
	decal.color[1] * decal.intensity,
	decal.color[2] * decal.intensity,
	decal.color[3],
	...decal.uvScale,
	...decal.uvOffset,
];

/** the tables, rows, controls and diagnostics the entity phase fills */
export class PackContent {
	readonly scene: SceneIndex;
	readonly chains = new ChainTable();
	readonly particles = new ParticleTable();
	readonly geometries = new AssetIds();
	readonly materials = new AssetIds();
	/** by material id, what a material variant changes (the material values a pose's clips set) */
	readonly materialOverrides = new Map<number, MaterialOverrides>();
	/** where each chain and geometry is drawn, which decides the archive holding it */
	readonly uses: AssetPlacement;
	/** the scene controls, conditional sets and visibility groups the content names */
	readonly controls = new ControlRegistry();
	readonly collector: Collector;
	readonly lights = new LightCollector();
	/** the report's entity counts */
	readonly counts: Record<string, number> = {};
	/** entities that became no instance row, for `debug/skipped-entities.json` */
	readonly skipped = new SkippedEntities();
	/** content drawn as stand-ins; prefab renderers repeat once per placement until {@link standInReports} */
	readonly standIns: StandInReport[] = [];
	/** prefabs that couldn't be read, by path once each */
	readonly unsupportedPrefabs: UnsupportedInput[] = [];
	/** ids of entities already filed or left out; an entity repeats in every file that loads it */
	readonly seen = new Set<number>();
	/** the decal cube's path hash, or `undefined` if the install doesn't have it */
	readonly #decalCube: bigint | undefined;
	#syntheticIds = 0;

	/** progress output */
	readonly log: (line: string) => void;

	private constructor(scene: SceneIndex, decalCube: bigint | undefined, log: (line: string) => void) {
		this.scene = scene;
		this.#decalCube = decalCube;
		this.log = log;
		this.uses = new AssetPlacement(scene.grid.shardLevel);
		this.collector = new Collector(this.controls);
	}

	/**
	 * @param world the world index, to find the decal cube
	 * @param scene the scene being packed
	 * @param log progress output
	 * @returns empty tables for the scene
	 */
	static async create(
		world: WorldIndex,
		scene: SceneIndex,
		log: (line: string) => void,
	): Promise<PackContent> {
		const [decalCube] = await world.hashesOf(DECAL_CUBE_PATH);
		return new PackContent(scene, decalCube, log);
	}

	/** adds to one of the report's entity counts */
	count(key: string, by = 1): void {
		this.counts[key] = (this.counts[key] ?? 0) + by;
	}

	/**
	 * @param levelTag the owning level's tag
	 * @returns an entity id for content the game gives none (prefab renderers, lights, stand-ins): the level's
	 *   tag, as every entity id carries, over an index counted down from the top of the level's id space, away
	 *   from the game's ids. one sequence serves every caller, in call order
	 * @throws {Error} once the id space is exhausted
	 */
	nextSyntheticId(levelTag: number): number {
		const index = this.#syntheticIds++;
		if (index > SYNTHETIC_ID_TOP) {
			throw new Error(`more than ${SYNTHETIC_ID_TOP + 1} synthetic entities`);
		}
		return ((levelTag << 27) | (SYNTHETIC_ID_TOP - index)) >>> 0;
	}

	// #region draws

	/** @returns the chain draw of a static renderer's draw */
	rendererDraw(draw: RendererDraw): ChainDraw {
		return chainDraw({
			geometry: this.geometries.intern(draw.meshHash, this.scene.pathOf),
			material: this.materials.intern(draw.materialHash, this.scene.pathOf),
			submesh: draw.submesh,
			lod: draw.lod,
			role: (draw.flags & DrawFlags.ShadowOnly) === 0 ? DrawRole.Lit : DrawRole.ShadowOnly,
			minSquared: draw.lodMinSquared,
			maxSquared: draw.lodMaxSquared,
			flags: chainDrawFlagsOf(draw.flags),
		});
	}

	/**
	 * rect decals draw the decal cube with their material, their row carrying their placement's colour and UV
	 * transform (docs/package-format.md#instance-block-inst-efin; the game's decals:
	 * docs/game-data/materials.md#decals)
	 *
	 * @param material the decal's material path hash
	 * @returns its draw, or `null` without a decal cube in the install
	 */
	decalDraw(material: bigint): ChainDraw | null {
		if (this.#decalCube === undefined) {
			return null;
		}
		return chainDraw({
			geometry: this.geometries.intern(this.#decalCube, this.scene.pathOf),
			material: this.materials.intern(material, this.scene.pathOf),
			minSquared: 0,
		});
	}

	// #endregion

	// #region rows

	/**
	 * files a row of placed content (dynamic structures, interactives, prefabs) under the leaf at the middle of
	 * where it reaches; no HLOD stands in for it
	 */
	addStructure(row: InstanceInput, { tag, name, visibility, loadReach }: RowOwner): void {
		const { grid } = this.scene;
		const reach = rowReach(row);
		const key = tileAt(grid, grid.leafLevel, reach.center[0], reach.center[2]);
		this.collector.addConditional({ tag, key, row, name, file: -1, visibility, reach: loadReach });
		this.collector.noteOwner(tag, reach);
		this.uses.note(row.chain, key);
		this.count('dynamicRenderers');
	}

	/**
	 * places a unit cube stand-in (`DrawRole.Unsupported`), transformed by `matrix`, for content without a mesh
	 * of its own to show. it takes a synthetic id whether or not the subset keeps it
	 *
	 * @param report what it stands in for and why, for `debug/stand-ins.json`
	 */
	addStandInCube(
		{ matrix, ...owner }: Omit<RowOwner, 'name'> & { matrix: Float32Array },
		report: Omit<StandInReport, 'position'>,
	): void {
		const entityId = this.nextSyntheticId(owner.tag);
		const bounds = transformBounds(UNIT_CUBE_BOUNDS, matrix);
		if (!this.scene.subset.includesPoint(owner.tag, bounds.center)) {
			return;
		}
		const draw = chainDraw({
			geometry: this.geometries.internSynthetic('cube'),
			material: null,
			role: DrawRole.Unsupported,
		});
		this.addStructure(
			{ chain: this.chains.intern([draw]), matrix, bounds, entityId },
			{ ...owner, name: report.name },
		);
		this.standIns.push({ ...report, position: bounds.center.map((value) => Math.round(value)) });
	}

	/** adds a light that loads with placed content, if the subset keeps it */
	addLight(light: ChunkLight, visibility: Visibility): boolean {
		if (!this.scene.subset.includesPoint(light.levelTag, light.position)) {
			return false;
		}
		this.lights.addConditional(light, visibility);
		return true;
	}

	// #endregion

	// #region diagnostics

	/** records a prefab that couldn't be read, unless it already is */
	unsupportedPrefab(failure: UnsupportedInput): void {
		if (!this.unsupportedPrefabs.some(({ path }) => path === failure.path)) {
			this.unsupportedPrefabs.push(failure);
		}
	}

	/** @returns the stand-ins once each: placements repeat their prefab's */
	standInReports(): StandInReport[] {
		return [...new Map(this.standIns.map((report) => [JSON.stringify(report), report])).values()];
	}

	// #endregion
}

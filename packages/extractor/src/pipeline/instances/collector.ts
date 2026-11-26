import type { Aabb } from '@endfield-noclip/formats/unity/values';
import { type TileKey, tileId } from '@endfield-noclip/package-format/tiles';
import { type Bounds, type Rect, unionBounds } from '@endfield-noclip/package-format/values';

import type { Visibility } from '../../game/state/scene-control.ts';
import type { ControlRegistry } from '../control-registry.ts';

import { aabbBounds, growBounds } from './bounds.ts';
import { type InstanceInput, InstanceBlockBuilder, rowReach } from './instances.ts';

/** a run of instances with debug metadata */
export interface Group {
	rows: InstanceBlockBuilder;
	/** per row: entity name and chunk-file index, for the debug index */
	names: string[];
	files: number[];
	/** world bounds of the rows; owned, grown in place */
	bounds: Bounds | null;
}

/** a block of detail rows: one leaf, one visibility group, one reach */
export interface DetailGroup extends Group {
	key: TileKey;
	/** index into the visibility groups */
	visibility: number;
	/** whether HLODs don't stand in for the rows (scene-state and dynamic content) */
	conditional: boolean;
	/** where the streaming centre draws the rows, or `null` for rows drawn within the detail distance */
	reach: Rect | null;
}

/** one foliage cluster queued for packing into a `.fol` blob */
export interface CollectedFoliageCluster {
	chain: number;
	bounds: Aabb;
	rendererHalfSize: number;
	/** grass density multiplier (`GrassRendererInfo.sparsity`) */
	sparsity: number;
	/** packed column-major 4×4 matrices, 16 floats per instance */
	instances: Float32Array;
}

/** a tile's foliage clusters sharing one visibility group */
export interface FoliageGroup {
	key: TileKey;
	/** index into the visibility groups */
	visibility: number;
	/** whether HLODs don't stand in for these clusters */
	conditional: boolean;
	clusters: CollectedFoliageCluster[];
	instanceCount: number;
	/** world bounds of the clusters; owned, grown in place */
	bounds: Bounds | null;
}

/** an instance row and where it came from */
export interface CollectedRow {
	/** the owning level's tag */
	tag: number;
	row: InstanceInput;
	/** entity name, for the debug index */
	name: string;
	/** chunk-file index, −1 for content of no chunk file */
	file: number;
}

/** gathers instances by destination while the entity pass runs */
export class Collector {
	/** detail rows by `tileId/visibility/reach` */
	readonly detail = new Map<string, DetailGroup>();
	/** grass foliage clusters by `tileId/visibility/conditional`, packed as `.fol` blobs */
	readonly foliage = new Map<string, FoliageGroup>();
	/** HLOD rows by visibility group */
	readonly hlod = new Map<number, Group>();
	/** HLOD nodes by sort key */
	readonly hlodNodes = new Map<number, { key: TileKey; tier: number; bounds: Bounds }>();
	/** rows of the Global chunk files by visibility group */
	readonly global = new Map<number, Group>();
	/** packed instance count by level tag, without HLOD clusters */
	readonly tagInstances = new Map<number, number>();
	/** world bounds of packed instances by level tag */
	readonly tagBounds = new Map<number, Bounds>();
	readonly #controls: ControlRegistry;

	/** @param controls interns the visibility groups rows name */
	constructor(controls: ControlRegistry) {
		this.#controls = controls;
	}

	/**
	 * adds a row HLODs stand in for
	 *
	 * @param entry.condition a conditional set index for rows of a stream area, else `null`
	 * @param entry.key the leaf it's filed under
	 */
	addDetail({ condition, key, ...entry }: CollectedRow & { condition: number | null; key: TileKey }): void {
		this.#addDetail(
			{ visibility: this.#controls.group(entry.tag, condition), conditional: false, reach: null },
			key,
			entry,
		);
		this.#countInstance(entry.tag);
	}

	/**
	 * adds a row no HLOD stands in for
	 *
	 * @param entry.key the leaf it's filed under
	 * @param entry.visibility when it loads
	 * @param entry.reach where the streaming centre draws the row, or `null` to draw it within the detail
	 *   distance
	 */
	addConditional({
		key,
		visibility,
		reach,
		...entry
	}: CollectedRow & { key: TileKey; visibility: Visibility; reach: Rect | null }): void {
		this.#addDetail(
			{ visibility: this.#controls.groupOf(entry.tag, visibility), conditional: true, reach },
			key,
			entry,
		);
		this.#countInstance(entry.tag);
	}

	/**
	 * adds a grass foliage cluster to be packed as a compact `.fol` blob
	 *
	 * @param entry.tag owning level tag
	 * @param entry.key leaf tile it's filed under
	 * @param entry.cluster cluster metadata and instance matrices
	 * @param entry.visibility when it loads, or `null` for always
	 * @param entry.conditional whether a scene state gates it
	 */
	addFoliage(entry: {
		tag: number;
		key: TileKey;
		cluster: CollectedFoliageCluster;
		visibility: Visibility | null;
		conditional: boolean;
	}): void {
		const count = entry.cluster.instances.length / 16;
		if (count === 0) {
			return;
		}
		let visibility: number;
		if (entry.conditional && entry.visibility !== null) {
			visibility = this.#controls.groupOf(entry.tag, entry.visibility);
		} else {
			const condition = entry.visibility === null ? null : this.#controls.condition(entry.visibility);
			visibility = this.#controls.group(entry.tag, condition);
		}
		const mapKey = `${tileId(entry.key)}/${visibility}/${entry.conditional ? 'c' : 'd'}`;
		const group = this.foliage.getOrInsertComputed(mapKey, () => ({
			key: entry.key,
			visibility,
			conditional: entry.conditional,
			clusters: [],
			instanceCount: 0,
			bounds: null,
		}));
		group.clusters.push(entry.cluster);
		group.instanceCount += count;
		if (group.bounds === null) {
			group.bounds = aabbBounds(entry.cluster.bounds);
		} else {
			growBounds(group.bounds, entry.cluster.bounds);
		}
		this.#countInstance(entry.tag, count);
	}

	#addDetail(
		{ visibility, conditional, reach }: Pick<DetailGroup, 'visibility' | 'conditional' | 'reach'>,
		key: TileKey,
		entry: CollectedRow,
	): void {
		const reachKey = reach === null ? '' : `${reach.minX},${reach.minZ},${reach.maxX},${reach.maxZ}`;
		const group = this.detail.getOrInsertComputed(`${tileId(key)}/${visibility}/${reachKey}`, () => ({
			...newGroup(),
			key,
			visibility,
			conditional,
			reach,
		}));
		push(group, entry, 0);
	}

	/**
	 * adds an HLOD cluster
	 *
	 * @param entry.condition a conditional set index for clusters of a stream area, else `null`
	 * @param entry.tier its HLOD tier
	 * @param entry.key the tile it stands in for
	 */
	addHlod({
		condition,
		tier,
		key,
		...entry
	}: CollectedRow & { condition: number | null; tier: number; key: TileKey }): void {
		const group = this.hlod.getOrInsertComputed(this.#controls.group(entry.tag, condition), newGroup);
		const sortKey = nodeSortKey(key);
		push(group, entry, sortKey);
		const node = this.hlodNodes.get(sortKey);
		if (node === undefined) {
			this.hlodNodes.set(sortKey, { key, tier, bounds: aabbBounds(entry.row.bounds) });
		} else {
			growBounds(node.bounds, entry.row.bounds);
		}
	}

	/**
	 * adds a row of a Global chunk file
	 *
	 * @param entry.condition a conditional set index for Global chunks of scene states, else `null`
	 */
	addGlobal({ condition, ...entry }: CollectedRow & { condition: number | null }): void {
		push(this.global.getOrInsertComputed(this.#controls.group(entry.tag, condition), newGroup), entry, 0);
		this.#countInstance(entry.tag);
	}

	// HLOD clusters stand in for instances that are counted already
	#countInstance(level: number, delta = 1): void {
		this.tagInstances.set(level, (this.tagInstances.get(level) ?? 0) + delta);
	}

	/** @returns by visibility group index, a box around the instances it shows */
	groupBounds(): Map<number, Bounds> {
		const bounds = new Map<number, Bounds>();
		const add = (group: number, rows: Bounds | null): void => {
			if (rows === null) {
				return;
			}
			const current = bounds.get(group);
			bounds.set(group, current === undefined ? structuredClone(rows) : unionBounds(current, rows));
		};
		for (const group of this.detail.values()) {
			add(group.visibility, group.bounds);
		}
		for (const group of this.foliage.values()) {
			add(group.visibility, group.bounds);
		}
		for (const map of [this.hlod, this.global]) {
			for (const [visibility, group] of map) {
				add(visibility, group.bounds);
			}
		}
		return bounds;
	}

	/**
	 * empties every group's rows and debug names, keeping bounds and counts, so they're freed once their blocks
	 * are stored (a few hundred MB on map02)
	 */
	releaseRows(): void {
		for (const map of [this.detail, this.hlod, this.global]) {
			for (const group of map.values()) {
				group.rows = new InstanceBlockBuilder();
				group.names = [];
				group.files = [];
			}
		}
		for (const group of this.foliage.values()) {
			group.clusters = [];
		}
	}

	/** grows the bounds of a packed instance's level */
	noteOwner(tag: number, bounds: Aabb): void {
		const current = this.tagBounds.get(tag);
		if (current === undefined) {
			this.tagBounds.set(tag, aabbBounds(bounds));
		} else {
			growBounds(current, bounds);
		}
	}
}

/** sorts HLOD rows by tree order: level, then z, then x */
const nodeSortKey = (key: TileKey): number =>
	key.level * 2 ** 40 + (key.z + 2 ** 19) * 2 ** 20 + (key.x + 2 ** 19);

const newGroup = (): Group => ({ rows: new InstanceBlockBuilder(), names: [], files: [], bounds: null });

const push = (group: Group, { row, name, file }: CollectedRow, sortKey: number): void => {
	group.rows.add(row, sortKey);
	group.names.push(name);
	group.files.push(file);
	const reach = rowReach(row);
	if (group.bounds === null) {
		group.bounds = aabbBounds(reach);
	} else {
		growBounds(group.bounds, reach);
	}
};

/** @returns how many rows the groups hold */
export const countRows = (groups: Iterable<Group>): number => {
	let count = 0;
	for (const group of groups) {
		count += group.rows.length;
	}
	return count;
};

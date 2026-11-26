import { levelTagOf } from '@endfield-noclip/formats/endfield/level-partition';
import {
	type ChunkReflectionProbe,
	ReflectionProbeShapeType,
} from '@endfield-noclip/formats/endfield/reflection-probe';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import {
	type ReflectionProbeEntry,
	ReflectionProbeShape,
	type ReflectionProbesTable,
} from '@endfield-noclip/package-format/reflection-probes';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { type AssetResolver, objectKey, type ObjectRef } from '../../game/assets/assets.ts';
import type { ChunkSource } from '../../game/world/world-index.ts';
import { mapPool } from '../../util/pool.ts';
import type { Place } from '../compile/asset-placement.ts';
import type { PlacedTexture } from '../compile/assets.ts';

// local reflection probes for `tables/reflection-probes.bin.zst`. probes repeat in every cell chunk they
// overlap, so they're deduplicated by entity id and load with the files holding them, like local lights.

/** concurrent cubemap resolutions against the bundle manifest */
const RESOLVE_CONCURRENCY = 16;

/** collects a scene's local reflection probes across its chunk files */
export class ReflectionProbeCollector {
	readonly #probes = new Map<number, { probe: ChunkReflectionProbe; sources: ChunkSource[] }>();

	/**
	 * @param probe a reflection probe from a chunk file
	 * @param source the file's scene state and stream area
	 */
	add(probe: ChunkReflectionProbe, source: ChunkSource): void {
		const { sceneState, area } = source;
		const known = this.#probes.get(probe.id);
		if (known === undefined) {
			this.#probes.set(probe.id, { probe, sources: [{ sceneState, area }] });
		} else {
			known.sources.push({ sceneState, area });
		}
	}

	/** @returns collected probes and their chunk sources, in entity-id order */
	entries(): { probe: ChunkReflectionProbe; sources: ChunkSource[] }[] {
		return [...this.#probes.values()].toSorted((a, b) => a.probe.id - b.probe.id);
	}
}

/** a reflection probe entry whose `texture` indexes {@link PlannedReflectionProbes.textures} */
export interface PlannedReflectionProbes {
	entries: ReflectionProbeEntry[];
	textures: PlacedTexture[];
	skipped: Record<string, number>;
}

/**
 * resolves the collected reflection probes' cubemaps and prepares their table entries before asset conversion
 *
 * @param collector collected chunk reflection probes
 * @param options resolver, visibility-group builder, and spatial placement helper
 * @returns planned probe entries and their deduplicated cubemap textures
 */
export const planReflectionProbes = async (
	collector: ReflectionProbeCollector,
	options: {
		resolver: AssetResolver;
		groupOf: (levelTag: number, sources: readonly ChunkSource[]) => number;
		placeAt: (x: number, z: number) => Place;
	},
): Promise<PlannedReflectionProbes> => {
	const { resolver, groupOf, placeAt } = options;
	const collected = collector.entries();
	const skipped: Record<string, number> = {};
	const skip = (reason: string): void => {
		skipped[reason] = (skipped[reason] ?? 0) + 1;
	};

	const resolved = await mapPool(collected, RESOLVE_CONCURRENCY, async ({ probe, sources }) => {
		if (probe.texturePath === null || probe.textureHash === null) {
			return { probe, sources, ref: null, reason: 'no cubemap' as const };
		}
		if (probe.intensity <= 0) {
			return { probe, sources, ref: null, reason: 'zero intensity' as const };
		}
		const refs = await resolver.findAsset(probe.texturePath, probe.textureHash, UnityClass.Cubemap);
		if (refs.length !== 1) {
			return { probe, sources, ref: null, reason: 'missing cubemap' as const };
		}
		return { probe, sources, ref: refs[0], reason: null };
	});

	const textureIndex = new Map<string, number>();
	const textures: PlacedTexture[] = [];
	const internTexture = (ref: ObjectRef, place: Place): number => {
		const key = objectKey(ref);
		const existing = textureIndex.get(key);
		if (existing !== undefined) {
			const entry = textures[existing];
			if (entry.place !== null && place !== null && entry.place !== place) {
				entry.place = null;
			}
			return existing;
		}
		const id = textures.length;
		textureIndex.set(key, id);
		textures.push({ ref, place });
		return id;
	};

	const entries: ReflectionProbeEntry[] = [];
	for (const { probe, sources, ref, reason } of resolved) {
		if (ref === null) {
			skip(reason ?? 'missing cubemap');
			continue;
		}
		const shape =
			probe.shape === ReflectionProbeShapeType.Sphere
				? ReflectionProbeShape.Sphere
				: ReflectionProbeShape.Box;
		const halfExtents: Vec3 = [probe.size[0] * 0.5, probe.size[1] * 0.5, probe.size[2] * 0.5];
		const invBlendDistance: Vec3 = [
			1 / Math.max((1 - probe.influenceScale[0]) * halfExtents[0], 1e-4),
			1 / Math.max((1 - probe.influenceScale[1]) * halfExtents[1], 1e-4),
			1 / Math.max((1 - probe.influenceScale[2]) * halfExtents[2], 1e-4),
		];
		const place = placeAt(probe.center[0], probe.center[2]);
		const texture = internTexture(ref, place);
		const group = groupOf(levelTagOf(probe.id), sources);
		entries.push({
			entityId: probe.id,
			group,
			texture,
			shape,
			boxProjection: probe.boxProjection,
			importance: probe.importance,
			intensity: probe.intensity,
			center: probe.center,
			boundsExtents: probe.boundsExtents,
			halfExtents,
			invBlendDistance,
			worldToLocal: probe.worldToLocal,
			lumaSh: probe.sh === null ? [0, 0, 0, 1] : reflectionProbeLumaSh(probe.sh),
		});
	}

	return { entries, textures, skipped };
};

/**
 * fills in converted texture ids after asset conversion, dropping any probe whose cubemap failed conversion
 *
 * @param planned planned reflection probes
 * @param textureIds converted texture ids parallel to {@link PlannedReflectionProbes.textures}
 * @returns final reflection probes table
 */
export const finishReflectionProbes = (
	planned: PlannedReflectionProbes,
	textureIds: readonly (number | null)[],
): ReflectionProbesTable => {
	const probes: ReflectionProbeEntry[] = [];
	for (const entry of planned.entries) {
		const id = textureIds[entry.texture];
		if (id == null) {
			continue;
		}
		probes.push({ ...entry, texture: id });
	}
	return { probes };
};

/**
 * packs Rec. 709 luminance of pure L1 SH (`[luma(u3), luma(u2), luma(u1), luma(u0)]`), matching the game's
 * `_ReflectionProbeGlobalDatas[i]._m0` and `_ReflectionProbeGlobalParam3`
 */
const reflectionProbeLumaSh = (sh: readonly number[]): [number, number, number, number] => {
	const luma = (i: number): number =>
		0.2126729 * (sh[i] ?? 0) + 0.7151522 * (sh[9 + i] ?? 0) + 0.072175 * (sh[18 + i] ?? 0);
	return [luma(3), luma(2), luma(1), luma(0)];
};

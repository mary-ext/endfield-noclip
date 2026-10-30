import { type ChunkLight, LightType } from '@endfield-noclip/formats/endfield/chunk-lights';
import { unityEulerQuaternion } from '@endfield-noclip/formats/unity/transform';
import { type LightEntry, LightKind, type LightsTable } from '@endfield-noclip/package-format/format';

// local lights for `tables/lights.json`. lights repeat in every cell chunk they overlap and in stream areas, so
// they're deduplicated by id; files arrive always-loaded first, so a light any always-loaded file holds stays
// unconditional, and the rest load with the scene states of the files holding them, like instances.

/** collects a scene's lights across its chunk files */
export class LightCollector {
	readonly #lights = new Map<number, { light: ChunkLight; states: Set<number> | null }>();
	/** lights left out, by reason */
	readonly skipped: Record<string, number> = {};

	/**
	 * @param light a light from a chunk file
	 * @param sceneState the file's scene-state suffix: 0 always loaded, `n` with MapConfig scene state `n − 1`
	 */
	add(light: ChunkLight, sceneState: number): void {
		const known = this.#lights.get(light.id);
		if (known !== undefined) {
			known.states?.add(sceneState);
			return;
		}
		this.#lights.set(light.id, { light, states: sceneState === 0 ? null : new Set([sceneState]) });
	}

	/**
	 * @param conditionOf the conditional set of content that loads with any of these MapConfig scene states
	 * @returns the table, lights in id order
	 */
	finish(conditionOf: (states: number[]) => number | null): LightsTable {
		const lights: LightEntry[] = [];
		for (const { light, states } of [...this.#lights.values()].toSorted((a, b) => a.light.id - b.light.id)) {
			const reason = skipReason(light);
			if (reason !== null) {
				this.skipped[reason] = (this.skipped[reason] ?? 0) + 1;
				continue;
			}
			const condition =
				states === null ? null : conditionOf([...states].map((id) => id - 1).toSorted((a, b) => a - b));
			lights.push(lightEntry(light, condition));
		}
		return { lights };
	}
}

/** @returns why the viewer has no use for a light, or `null` */
const skipReason = (light: ChunkLight): string | null => {
	if (light.type !== LightType.Spot && light.type !== LightType.Point) {
		return `type ${light.type}`;
	}
	if (light.shadowOnly) {
		// they only darken other local lights through their shadow maps, which aren't drawn
		return 'shadow only';
	}
	if (light.characterOnly) {
		return 'character only';
	}
	if (!(light.range > 0)) {
		return 'no range';
	}
	return null;
};

/**
 * @param light a spot or point light
 * @param condition its conditional set, or `null`
 * @returns its table entry
 */
export const lightEntry = (light: ChunkLight, condition: number | null): LightEntry => {
	const spot = light.type === LightType.Spot;
	const box = light.cullingBox;
	return {
		kind: spot ? LightKind.Spot : LightKind.Point,
		id: light.id,
		level: light.levelTag,
		condition,
		position: light.position,
		direction: light.direction,
		colour: light.colour,
		range: light.range,
		spotAngle: spot ? light.spotAngle : 0,
		innerSpotAngle: spot ? light.innerSpotAngle : 0,
		// a spot's own length field means nothing to the shading
		tubeLength: spot ? 0 : light.tubeLength,
		softSourceRadius: light.softSourceRadius,
		falloffExponent: light.falloffExponent,
		specularIntensity: light.specularIntensity,
		volumetricIntensity: light.volumetricIntensity,
		priority: light.priority,
		distanceFade: light.distanceFade,
		cullingBox:
			box === null
				? null
				: {
						matrix: inverseBox(box.offset, box.rotation, box.halfExtents),
						falloffThreshold: box.falloffThreshold,
					},
	};
};

/** @returns rows3x4 of the inverse of `TRS(offset, Euler(rotation), halfExtents)`: `S⁻¹ Rᵀ (v − offset)` */
const inverseBox = (
	offset: readonly number[],
	rotation: readonly number[],
	halfExtents: readonly number[],
): number[] => {
	const [x, y, z, w] = unityEulerQuaternion(rotation);
	// the rotation's columns, i.e. the box's axes in world space
	const axes = [
		[1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
		[2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
		[2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)],
	];
	const rows: number[] = [];
	for (const [i, axis] of axes.entries()) {
		// a degenerate box confines the light to nothing; a huge scale keeps the matrix finite
		const inverse = halfExtents[i] > 0 ? 1 / halfExtents[i] : 1e6;
		const dot = axis[0] * offset[0] + axis[1] * offset[1] + axis[2] * offset[2];
		rows.push(axis[0] * inverse, axis[1] * inverse, axis[2] * inverse, -dot * inverse);
	}
	return rows;
};

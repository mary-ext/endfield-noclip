import type { DynamicModel } from '@endfield-noclip/formats/endfield/dynamic-resources';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { multiplyMatrices, quaternionUnityEuler } from '@endfield-noclip/formats/unity/transform';

import type { StructureModel } from '../dynamic/dynamic-structures.ts';
import { isOneShotEffect } from '../effects/view-state-effects.ts';
import { prefabNodeMatrices } from '../prefabs/prefab-nodes.ts';
import type { PrefabPose } from '../prefabs/prefab.ts';
import type { Visibility } from '../state/scene-control.ts';

import type { FacilitySources, PrefabHashes } from './facility-sources.ts';
import type { RestingEffect } from './view-state-poses.ts';

/** an effect an interactive leaves playing, placed once every row is read */
export interface PendingEffect {
	effect: string;
	source: string;
	levelTag: number;
	visibility: Visibility;
	/** the world matrix the effect is placed relative to: its model's placement, or its own */
	frame: Float32Array;
	/** the model and pose whose GameObject the effect plays on, `null` when placed at {@link frame} itself */
	on: { prefab: string; pose: PrefabPose; rest: RestingEffect } | null;
	followRotation: boolean;
}

/**
 * @param name an effect's name
 * @returns the bundle path of its prefab, where the game's effect manager loads it from
 */
const effectPrefab = (name: string): string =>
	`assets/beyond/dynamicassets/gameplay/effects/prefabs/${name.toLowerCase()}.prefab`;

/**
 * @param m a rotation's matrix by row and column
 * @returns the rotation as an xyzw quaternion
 */
const matrixQuaternion = (m: readonly (readonly number[])[]): [number, number, number, number] => {
	const trace = m[0][0] + m[1][1] + m[2][2];
	if (trace > 0) {
		const s = 0.5 / Math.sqrt(trace + 1);
		return [(m[2][1] - m[1][2]) * s, (m[0][2] - m[2][0]) * s, (m[1][0] - m[0][1]) * s, 0.25 / s];
	}
	if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
		const s = 2 * Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]);
		return [0.25 * s, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s, (m[2][1] - m[1][2]) / s];
	}
	if (m[1][1] > m[2][2]) {
		const s = 2 * Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]);
		return [(m[0][1] + m[1][0]) / s, 0.25 * s, (m[1][2] + m[2][1]) / s, (m[0][2] - m[2][0]) / s];
	}
	const s = 2 * Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]);
	return [(m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, 0.25 * s, (m[1][0] - m[0][1]) / s];
};

/**
 * @param matrix an affine column-major matrix without shear or mirroring
 * @param followRotation whether to keep its rotation; without, the placement keeps the world's axes
 * @returns its position, Unity Euler angles (degrees) and axis scales
 */
const matrixPlacement = (
	matrix: Float32Array,
	followRotation: boolean,
): Pick<DynamicModel, 'position' | 'rotation' | 'scale'> => {
	const columns = [0, 1, 2].map((c) => [matrix[c * 4], matrix[c * 4 + 1], matrix[c * 4 + 2]]);
	const scale = columns.map((column) => Math.hypot(...column));
	let rotation: [number, number, number] = [0, 0, 0];
	if (followRotation) {
		const rows = [0, 1, 2].map((r) => [0, 1, 2].map((c) => columns[c][r] / (scale[c] || 1)));
		rotation = quaternionUnityEuler(matrixQuaternion(rows));
	}
	return { position: [matrix[12], matrix[13], matrix[14]], rotation, scale: [scale[0], scale[1], scale[2]] };
};

/**
 * the effects interactives leave playing: looks' resting effects and the effects some kinds place at
 * themselves, queued while rows are placed and placed together once their prefabs' hashes are found
 */
export class RestingEffects {
	readonly #sources: FacilitySources;
	readonly #prefabs: PrefabHashes;
	readonly #pending: PendingEffect[] = [];

	/**
	 * @param sources where unreadable effects are reported
	 * @param prefabs the prefab hash lookup, which the effects' prefabs join
	 */
	constructor(sources: FacilitySources, prefabs: PrefabHashes) {
		this.#sources = sources;
		this.#prefabs = prefabs;
	}

	/** @param effect an effect to place, in the order it's met */
	queue(effect: PendingEffect): void {
		this.#pending.push(effect);
	}

	/**
	 * places every queued effect that keeps playing at rest as a model of its own, in queue order. an effect
	 * whose prefab is missing or unreadable, or whose model can't be walked, is reported and left out
	 *
	 * @param models where the effects' models go
	 */
	async place(models: StructureModel[]): Promise<void> {
		const pending = this.#pending;
		if (pending.length === 0) {
			return;
		}
		const sources = this.#sources;
		const prefabs = this.#prefabs;
		prefabs.find(new Set(pending.map(({ effect }) => effectPrefab(effect))));
		const resolver = await sources.context.resolver();
		/** by effect prefab, whether it keeps playing at rest; `null` when it's missing or unreadable */
		const looping = new Map<string, Promise<boolean | null>>();
		const loops = (prefab: string): Promise<boolean | null> =>
			looping.getOrInsertComputed(prefab, async () => {
				const hash = prefabs.get(prefab);
				if (hash === undefined) {
					sources.report(prefab, 'effect prefab not in the bundle manifest');
					return null;
				}
				return sources.attempt(
					prefab,
					async () => {
						const root = await resolver.findUnique({ hash, path: prefab }, UnityClass.GameObject);
						// an effect that doesn't loop has run out by the time its state rests
						return !(await isOneShotEffect(resolver, root));
					},
					null,
				);
			});
		/** by model prefab and pose, its GameObjects' matrices; `null` when unreadable */
		const nodeMatrices = new Map<string, Promise<Map<string, Float32Array> | null>>();
		const nodesOf = (prefab: string, pose: PrefabPose): Promise<Map<string, Float32Array> | null> =>
			nodeMatrices.getOrInsertComputed(`${prefab}:${pose.key}`, () =>
				sources.attempt(
					prefab,
					async () => prefabNodeMatrices(resolver, await prefabs.root(prefab), pose),
					null,
				),
			);
		for (const effect of pending) {
			const prefab = effectPrefab(effect.effect);
			// oxlint-disable-next-line no-await-in-loop -- one read per effect prefab
			if ((await loops(prefab)) !== true) {
				continue;
			}
			let matrix = effect.frame;
			if (effect.on !== null) {
				const { rest } = effect.on;
				// oxlint-disable-next-line no-await-in-loop -- one walk per model prefab and pose
				const nodes = await nodesOf(effect.on.prefab, effect.on.pose);
				if (nodes === null) {
					continue;
				}
				// a GameObject the model lacks falls back to the animator's, as in the game
				const node =
					(rest.node === null ? undefined : nodes.get(rest.node)) ??
					(rest.fallback === null ? undefined : nodes.get(rest.fallback));
				if (node !== undefined) {
					matrix = multiplyMatrices(matrix, node);
				}
			}
			models.push({
				model: { pathHash: prefabs.get(prefab)!, ...matrixPlacement(matrix, effect.followRotation) },
				levelTag: effect.levelTag,
				source: `${effect.source}:${effect.effect}`,
				visibility: effect.visibility,
				pose: null,
			});
		}
	}
}

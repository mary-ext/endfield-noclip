import type { LevelInteractive } from '@endfield-noclip/formats/endfield/level-interactives';
import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { trsMatrix, unityEulerQuaternion } from '@endfield-noclip/formats/unity/transform';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';

import type { AssetResolver, ObjectRef } from '../assets/assets.ts';
import { readPrefabNode } from '../prefabs/prefab-walk.ts';

import type { FacilitySources, PrefabHashes } from './facility-sources.ts';
import type { InteractiveRow, SingleModelTemplate, TemplateReader } from './interactive-row.ts';
import type { RestingEffects } from './resting-effects.ts';
import { entityProperties, entityState } from './template-data.ts';
import type { TemplateTraits } from './template-traits.ts';

/** the component of laser gates, which play their model's laser effects while on */
export const ELECTRIC_FENCE_COMPONENTS = ['_ElectricFenceComponentDataForMemoryPack'];

/**
 * reads the effects a laser gate's model plays while on: the `effectsOnActive` names of the fence postmodel
 * MonoBehaviour on the prefab's root, which is where the gate's component asks for it
 *
 * @param resolver bundle reader
 * @param root the model prefab's root GameObject
 * @returns the effects' names, `null` when the root has no fence postmodel MonoBehaviour
 */
export const readFenceEffects = async (
	resolver: AssetResolver,
	root: ObjectRef,
): Promise<string[] | null> => {
	const node = await readPrefabNode(resolver, root);
	for (const component of node.ofClass(UnityClass.MonoBehaviour)) {
		// oxlint-disable-next-line no-await-in-loop -- the root's few MonoBehaviours, in order
		const data: TypeTreeObject = await component.read();
		const names = data.effectsOnActive;
		if (Array.isArray(names)) {
			return names.filter((name): name is string => typeof name === 'string' && name !== '');
		}
	}
	return null;
};

/**
 * @param template the decoded laser gate template
 * @param row a placed laser gate
 * @returns whether it starts on: its `state` is 1, as the gate's component tests it
 */
export const fenceStartsOn = (template: MemoryPackValue, row: LevelInteractive): boolean => {
	const entity = entityProperties(template);
	return entity !== null && entityState(entity, row) === 1;
};

/** laser gates' beams: effects their component attaches to the entity while the gate is on */
export class ElectricFences implements TemplateReader {
	readonly #sources: FacilitySources;
	readonly #prefabs: PrefabHashes;
	readonly #effects: RestingEffects;
	/** by template key, its decoded template and the effects its model plays while on */
	readonly #fences = new Map<string, { template: MemoryPackValue; effects: string[] }>();

	/**
	 * @param sources install readers, where unreadable models are reported
	 * @param prefabs the prefab hash lookup
	 * @param effects where the beams are queued
	 */
	constructor(sources: FacilitySources, prefabs: PrefabHashes, effects: RestingEffects) {
		this.#sources = sources;
		this.#prefabs = prefabs;
		this.#effects = effects;
	}

	async prepare(key: string, template: SingleModelTemplate, traits: TemplateTraits): Promise<void> {
		if (traits.kind !== 'other' || traits.electricFence === null) {
			return;
		}
		const sources = this.#sources;
		const { prefab } = template.forms[0];
		const effects = await sources.attempt(
			prefab,
			async () => readFenceEffects(await sources.context.resolver(), await this.#prefabs.root(prefab)),
			null,
		);
		if (effects === null) {
			sources.report(
				prefab,
				'laser gate model has no fence postmodel MonoBehaviour; drawn without its beams',
			);
			return;
		}
		this.#fences.set(key, { template: traits.electricFence, effects });
	}

	/**
	 * queues the beams of a gate that starts on, independent of its look
	 *
	 * @param placed a placed row with a model
	 */
	decorate(placed: InteractiveRow): void {
		const { row, source } = placed;
		const fence = this.#fences.get(row.template);
		if (fence === undefined || !fenceStartsOn(fence.template, row)) {
			return;
		}
		// attached to the entity with no offset, so they follow its placement but not its model's scale
		const frame = trsMatrix(row.position, unityEulerQuaternion(row.rotation), row.scale);
		for (const effect of fence.effects) {
			this.#effects.queue({
				effect,
				source,
				levelTag: placed.placed.levelTag,
				visibility: placed.gate({ alternatives: [[]] }),
				frame,
				on: null,
				followRotation: true,
			});
		}
	}
}

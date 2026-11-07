import type { LevelInteractive } from '@endfield-noclip/formats/endfield/level-interactives';
import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';
import { quaternionUnityEuler, unityEulerQuaternion } from '@endfield-noclip/formats/unity/transform';

import type { PrefabPose } from '../prefabs/prefab.ts';

import { craneSteps, craneTowerOf, DEFAULT_CONTAINER_HEIGHT, readCraneLook } from './crane-tower.ts';
import type { FacilitySources, PrefabHashes } from './facility-sources.ts';
import type { InteractiveKind, InteractiveRow, SingleModelTemplate } from './interactive-row.ts';
import type { PlacedInteractive } from './placed-interactives.ts';
import { atomFloat, entityInt, type EntityProperties, entityProperty } from './template-data.ts';
import type { AuthoredTemplate } from './template-models.ts';
import type { TemplateTraits } from './template-traits.ts';

/** where a crane tower hangs its container, instead of the container's own placement */
export interface Hang {
	position: [number, number, number];
	/** Unity Euler angles, degrees */
	rotation: [number, number, number];
}

/**
 * crane towers, posed at their starting steps, and the containers they hang from their hooks wherever those
 * were placed. a tower that can't be posed is reported and left to the next kind
 */
export class CraneTowers implements InteractiveKind {
	readonly #sources: FacilitySources;
	readonly #prefabs: PrefabHashes;
	/** crane towers' decoded templates, by key */
	readonly #towers = new Map<string, MemoryPackValue>();
	/** entity properties of other single-model templates (crane containers among them), by key */
	readonly #entities = new Map<string, EntityProperties>();
	/** by tower row id, its look */
	readonly #looks = new Map<bigint, PrefabPose>();
	/** by container row id, where its tower hangs it */
	readonly #hung = new Map<bigint, Hang>();

	/**
	 * @param sources where towers that can't be posed are reported
	 * @param prefabs the prefab hash lookup
	 */
	constructor(sources: FacilitySources, prefabs: PrefabHashes) {
		this.#sources = sources;
		this.#prefabs = prefabs;
	}

	prepare(key: string, _template: SingleModelTemplate, traits: TemplateTraits): void {
		if (traits.kind !== 'other') {
			return;
		}
		if (traits.craneTower !== null) {
			this.#towers.set(key, traits.craneTower);
		}
		if (traits.entity !== null) {
			this.#entities.set(key, traits.entity);
		}
	}

	/**
	 * poses every placed tower and finds where it hangs its container, before any row is placed
	 *
	 * @param placed the placed rows
	 * @param authored what each template draws
	 * @param rows placed rows by id
	 */
	async hang(
		placed: readonly PlacedInteractive[],
		authored: ReadonlyMap<string, AuthoredTemplate>,
		rows: ReadonlyMap<bigint, LevelInteractive>,
	): Promise<void> {
		const sources = this.#sources;
		for (const { path, row } of placed) {
			const template = this.#towers.get(row.template);
			const entity = this.#entities.get(row.template);
			const form = authored.get(row.template)?.forms[0];
			if (template === undefined || entity === undefined || form === undefined) {
				continue;
			}
			const source = `${path}#${row.id}`;
			const tower = craneTowerOf(template, row);
			const steps =
				tower &&
				craneSteps(tower, [
					entityInt(entity, row, 'state_1'),
					entityInt(entity, row, 'state_2'),
					entityInt(entity, row, 'state_3'),
				]);
			if (tower === null || steps === null) {
				sources.report(source, 'crane tower has an empty step list; drawn as saved');
				continue;
			}
			const scale = row.modelScale > 0 ? row.modelScale : form.scale;
			// oxlint-disable-next-line no-await-in-loop -- a few towers per map, each read once
			const look = await sources.attempt(
				form.prefab,
				async () => {
					const resolver = await sources.context.resolver();
					return readCraneLook(
						resolver,
						await this.#prefabs.root(form.prefab),
						form.prefab,
						{
							position: row.position,
							rotation: unityEulerQuaternion(row.rotation),
							scale: row.scale.map((axis) => axis * scale),
						},
						steps,
					);
				},
				null,
			);
			if (look === null) {
				sources.report(source, 'crane tower prefab has no crane MonoBehaviour; drawn as saved');
				continue;
			}
			this.#looks.set(row.id, look.pose);
			const container = tower.target === null ? undefined : rows.get(tower.target);
			const containerEntity = container && this.#entities.get(container.template);
			if (container === undefined || containerEntity === undefined) {
				sources.report(source, `crane tower's container ${tower.target} isn't placed`);
				continue;
			}
			const height = entityProperty(containerEntity, container, 'height')?.[0]?.bits;
			const drop = height === undefined ? DEFAULT_CONTAINER_HEIGHT : atomFloat(height);
			const [x, y, z] = look.attach.position;
			this.#hung.set(container.id, {
				position: [x, y - drop, z],
				rotation: quaternionUnityEuler(look.attach.rotation),
			});
		}
	}

	/**
	 * @param id a placed row's id
	 * @returns where its tower hangs it, if it's a hung container
	 */
	hangOf(id: bigint): Hang | undefined {
		return this.#hung.get(id);
	}

	place(placed: InteractiveRow): boolean {
		const look = this.#looks.get(placed.row.id);
		if (look === undefined) {
			return false;
		}
		placed.place(placed.template.forms[0], { alternatives: [[]] }, look);
		return true;
	}
}

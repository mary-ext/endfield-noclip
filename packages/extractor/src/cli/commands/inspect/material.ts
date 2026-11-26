import { ShaderPropertyFlags, ShaderPropertyType } from '@endfield-noclip/formats/unity/material';

import { definite, mapDefined } from '@mary-ext/array-fns';

import { loadTexture } from '../../../game/assets/asset-decode.ts';
import { type AssetResolver, objectKey, type ObjectRef } from '../../../game/assets/assets.ts';
import { describeMaterial } from '../../../game/materials/material-describe.ts';
import { loadMaterial, type LoadedMaterial } from '../../../game/materials/material-load.ts';
import { withContext } from '../../../install/context.ts';
import { convertMaterial, ShaderTable } from '../../../pipeline/compile/materials.ts';
import { errorText } from '../../../util/errors.ts';
import { collectTargets, jsonReplacer } from '../../helpers.ts';
import { pickFields } from '../../query.ts';

import type { InspectSubArgs } from './parser.ts';
import { resolveMaterialTargets } from './shared.ts';

/**
 * runs `endfield-extract inspect material`
 *
 * @param args parsed CLI arguments
 */
export const runInspectMaterial = async (args: InspectSubArgs<'material'>): Promise<void> => {
	const targets = await collectTargets(args.targets, args.stdin);
	if (targets.length === 0) {
		throw new Error('inspect material needs at least one target or --stdin');
	}
	await withContext(args.config, async (context) => {
		const resolver = await context.resolver();
		const refs: ObjectRef[] = [];
		for (const raw of targets) {
			// oxlint-disable-next-line no-await-in-loop -- preserves target order
			const resolved = await resolveMaterialTargets(context, resolver, raw, {
				pathId: args.pathId,
				nameFilter: args.name,
				all: args.all,
			});
			refs.push(...resolved);
		}
		const results = await Promise.all(
			refs.map(async (ref) => {
				const material = await loadMaterial(resolver, ref);
				const data = materialJson(resolver, ref, material, {
					allProps: args.allProps,
					propFilter: args.prop,
				});
				return args.pick.length === 0 ? data : pickFields(data, args.pick);
			}),
		);
		console.log(
			JSON.stringify(
				results.length === 1 && !args.all && targets.length === 1 ? results[0] : results,
				jsonReplacer,
				'\t',
			),
		);
	});
};

/** converts and describes a loaded material for CLI output */
export const describeLoadedMaterial = (material: LoadedMaterial) => {
	const shaders = new ShaderTable();
	const interned = shaders.intern(material.shader, material.classification.family);
	const slotOrder: string[] = [];
	const slotIds = new Map<string, number>();
	for (const [slot, resolved] of Object.entries(material.textures)) {
		if (resolved.ref !== null) {
			slotIds.set(slot, slotOrder.length);
			slotOrder.push(slot);
		}
	}
	const converted = convertMaterial(material.record, material.classification, interned, (slot) =>
		slotIds.get(slot),
	);
	const surface = describeMaterial(converted.material, interned.entry);
	return { converted, surface, slotOrder };
};

const filterRecord = <T>(record: Record<string, T>, filter: RegExp | undefined): Record<string, T> => {
	if (filter === undefined) {
		return record;
	}
	return Object.fromEntries(Object.entries(record).filter(([key]) => filter.test(key)));
};

const materialJson = async (
	resolver: AssetResolver,
	ref: ObjectRef,
	material: LoadedMaterial,
	options: { allProps: boolean; propFilter: RegExp | undefined },
) => {
	const slots = await Promise.all(
		Object.entries(material.textures).map(async ([slot, resolved]): Promise<[string, object] | undefined> => {
			if (options.propFilter !== undefined && !options.propFilter.test(slot)) {
				return undefined;
			}
			const source = material.record.textures[slot];
			if (resolved.ref === null) {
				return resolved.error === undefined ? undefined : [slot, { error: resolved.error }];
			}
			try {
				const texture = await loadTexture(resolver, resolved.ref);
				return [
					slot,
					{
						object: objectKey(resolved.ref),
						bundle: resolver.manifest.bundleName(resolved.ref.bundleIndex),
						name: texture.name,
						format: texture.format.name,
						size: [texture.width, texture.height],
						mipCount: texture.mipCount,
						srgb: texture.srgb,
						uvSet: source.uvSet,
						scale: source.scale,
						offset: source.offset,
					},
				];
			} catch (error) {
				return [slot, { object: objectKey(resolved.ref), error: errorText(error) }];
			}
		}),
	);
	const textures = Object.fromEntries(definite(slots));
	const { converted, surface, slotOrder } = describeLoadedMaterial(material);
	const { record } = material;
	const { propFilter } = options;
	return {
		name: record.name,
		object: objectKey(ref),
		bundle: resolver.manifest.bundleName(ref.bundleIndex),
		shader: material.shader.name,
		classification: material.classification,
		surface,
		surfaceTextures: Object.fromEntries(slotOrder.map((slot, id) => [id, slot])),
		keywords: record.keywords,
		customRenderQueue: record.customRenderQueue,
		tags: record.tags,
		disabledPasses: record.disabledPasses,
		textures,
		floats: filterRecord(converted.material.floats, propFilter),
		colors: filterRecord(converted.material.colors, propFilter),
		vectors: filterRecord(converted.material.vectors, propFilter),
		...(options.allProps
			? {
					rawFloats: filterRecord(record.floats, propFilter),
					rawColors: filterRecord(record.colors, propFilter),
					rawInts: filterRecord(record.ints, propFilter),
				}
			: {}),
		hdrColors: mapDefined(material.shader.properties, (p) =>
			p.type === ShaderPropertyType.Color &&
			(p.flags & ShaderPropertyFlags.Hdr) !== 0 &&
			(propFilter === undefined || propFilter.test(p.name))
				? p.name
				: undefined,
		),
		gammaColors: mapDefined(material.shader.properties, (p) =>
			p.type === ShaderPropertyType.Color &&
			(p.flags & ShaderPropertyFlags.Gamma) !== 0 &&
			(propFilter === undefined || propFilter.test(p.name))
				? p.name
				: undefined,
		),
	};
};

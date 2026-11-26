import {
	isWaterGlobalConfig,
	readWaterGlobalConfig,
	readWaterSurfaceConfig,
	type WaterGlobalConfig,
} from '@endfield-noclip/formats/endfield/water';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import type { PPtr } from '@endfield-noclip/formats/unity/values';

import { loadTexture } from '../../../game/assets/asset-decode.ts';
import { type AssetResolver, objectKey, type ObjectRef } from '../../../game/assets/assets.ts';
import { loadSectorTexture } from '../../../game/water/water-source.ts';
import { withContext } from '../../../install/context.ts';
import { errorText } from '../../../util/errors.ts';
import { collectTargets, jsonReplacer } from '../../helpers.ts';

import type { InspectSubArgs } from './parser.ts';
import { resolveObjectArg } from './shared.ts';

/**
 * runs `endfield-extract inspect water-config`
 *
 * @param args parsed CLI arguments
 */
export const runInspectWaterConfig = async (args: InspectSubArgs<'water-config'>): Promise<void> => {
	const targets = await collectTargets(args.targets, args.stdin);
	if (targets.length === 0) {
		throw new Error('inspect water-config needs at least one target or --stdin');
	}
	await withContext(args.config, async (context) => {
		const resolver = await context.resolver();
		for (const raw of targets) {
			// oxlint-disable-next-line no-await-in-loop -- preserves target order
			const ref = await resolveObjectArg(context, resolver, raw, UnityClass.MonoBehaviour, {
				pathId: args.pathId,
				nameFilter: args.name,
			});
			// oxlint-disable-next-line no-await-in-loop -- preserves target order
			await inspectWaterConfig(resolver, ref);
		}
	});
};

const inspectWaterConfig = async (resolver: AssetResolver, ref: ObjectRef): Promise<void> => {
	const value = await resolver.read(ref);
	const header = { object: objectKey(ref), bundle: resolver.manifest.bundleName(ref.bundleIndex) };
	if (isWaterGlobalConfig(value)) {
		const config = readWaterGlobalConfig(value);
		console.log(
			JSON.stringify({ ...header, ...(await globalWaterJson(resolver, ref, config)) }, jsonReplacer, '\t'),
		);
		return;
	}
	console.log(
		JSON.stringify({ ...header, ...readWaterSurfaceConfig(ref.info.type.nodes, value) }, jsonReplacer, '\t'),
	);
};

const globalWaterJson = async (
	resolver: AssetResolver,
	from: ObjectRef,
	config: WaterGlobalConfig,
): Promise<object> => {
	const texture = async (pptr: PPtr): Promise<object | null> => {
		try {
			const ref = await resolver.resolve(from, pptr);
			if (ref === null) {
				return null;
			}
			const t = await loadTexture(resolver, ref);
			return {
				object: objectKey(ref),
				bundle: resolver.manifest.bundleName(ref.bundleIndex),
				name: t.name,
				kind: t.kind,
				size: [t.width, t.height],
				layers: t.layers,
				mipCount: t.mipCount,
				format: t.format.name,
				srgb: t.srgb,
				sampler: t.sampler,
			};
		} catch (error) {
			return { error: errorText(error) };
		}
	};
	const surfaceConfigs = await Promise.all(
		config.surfaceConfigs.map(async (pptr): Promise<object> => {
			try {
				const ref = await resolver.resolve(from, pptr);
				if (ref === null) {
					return { null: true };
				}
				const value: TypeTreeObject = await resolver.read(ref);
				return { object: objectKey(ref), name: value.m_Name, materialIndex: value.materialIndex };
			} catch (error) {
				return { error: errorText(error) };
			}
		}),
	);
	const xs = config.sectors.map((sector) => sector.x);
	const zs = config.sectors.map((sector) => sector.z);
	return {
		name: config.name,
		scenePath: config.scenePath,
		sceneCenterOffset: config.sceneCenterOffset,
		mapSize: config.mapSize,
		sectorSize: config.sectorSize,
		flowmapPrecision: config.flowmapPrecision,
		useSectorData: config.useSectorData,
		grid: config.grid,
		textures: {
			flowMap: await texture(config.flowMap),
			causticMap: await texture(config.causticMap),
			rainMap: await texture(config.rainMap),
			normalMapArray: await texture(config.normalMapArray),
		},
		surfaceConfigs,
		sectors: {
			count: config.sectors.length,
			range:
				config.sectors.length === 0
					? null
					: { x: [Math.min(...xs), Math.max(...xs)], z: [Math.min(...zs), Math.max(...zs)] },
			sample: config.sectors.slice(0, 3),
			sampleTexture: config.sectors.length === 0 ? null : await sectorTexture(resolver, config.sectors[0]),
		},
	};
};

const sectorTexture = async (
	resolver: AssetResolver,
	sector: WaterGlobalConfig['sectors'][number],
): Promise<object> => {
	try {
		const { sector: ref, texture: textureRef } = await loadSectorTexture(resolver, sector);
		if (textureRef === null) {
			return { object: objectKey(ref), texture: null };
		}
		const t = await loadTexture(resolver, textureRef);
		return {
			object: objectKey(ref),
			texture: {
				name: t.name,
				size: [t.width, t.height],
				mipCount: t.mipCount,
				format: t.format.name,
				srgb: t.srgb,
			},
		};
	} catch (error) {
		return { error: errorText(error) };
	}
};

// #endregion

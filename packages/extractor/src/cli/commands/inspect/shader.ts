import {
	type ShaderProperty,
	ShaderPropertyFlags,
	ShaderPropertyType,
	type ShaderSummary,
} from '@endfield-noclip/formats/unity/material';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';

import { mapDefined } from '@mary-ext/array-fns';

import { loadShaderSummary } from '../../../game/assets/asset-decode.ts';
import { type AssetResolver, objectKey, type ObjectRef } from '../../../game/assets/assets.ts';
import { openAssetFiles, openBundle } from '../../../install/bundles.ts';
import { type Context, withContext } from '../../../install/context.ts';
import { VfsGroup } from '../../../install/vfs.ts';
import { compareStrings } from '../../../util/compare.ts';
import { mapPool } from '../../../util/pool.ts';
import { jsonReplacer, parseHash } from '../../helpers.ts';

import type { InspectSubArgs } from './parser.ts';
import { BUNDLE_NAME, resolveFromBundle, resolveObjectArg } from './shared.ts';

/**
 * runs `endfield-extract inspect shader`
 *
 * @param args parsed CLI arguments
 */
export const runInspectShader = async (args: InspectSubArgs<'shader'>): Promise<void> => {
	await withContext(args.config, async (context) => {
		const resolver = await context.resolver();
		await inspectShader(context, resolver, args.target, {
			pathId: args.pathId,
			nameFilter: args.name,
			propFilter: args.prop,
			types: parseShaderTypes(args.types),
			flagMask: parseShaderFlags(args.flags),
			group: args.group,
			json: args.json,
		});
	});
};

const SHADER_SCAN_CONCURRENCY = 16;

const SHADER_TYPE_NAMES: Record<number, string> = {
	[ShaderPropertyType.Color]: 'Color',
	[ShaderPropertyType.Vector]: 'Vector',
	[ShaderPropertyType.Float]: 'Float',
	[ShaderPropertyType.Range]: 'Range',
	[ShaderPropertyType.Texture]: 'Texture',
	[ShaderPropertyType.Int]: 'Int',
};

const SHADER_TYPE_LOOKUP = new Map<string, number>(
	Object.entries(SHADER_TYPE_NAMES).map(([id, name]) => [name.toLowerCase(), Number(id)]),
);

const SHADER_FLAG_ENTRIES: readonly [string, number][] = [
	['hide', ShaderPropertyFlags.HideInInspector],
	['per-renderer', ShaderPropertyFlags.PerRendererData],
	['no-scale-offset', ShaderPropertyFlags.NoScaleOffset],
	['normal', ShaderPropertyFlags.Normal],
	['hdr', ShaderPropertyFlags.Hdr],
	['gamma', ShaderPropertyFlags.Gamma],
	['non-modifiable', ShaderPropertyFlags.NonModifiableTextureData],
	['main-texture', ShaderPropertyFlags.MainTexture],
	['main-color', ShaderPropertyFlags.MainColor],
];

const SHADER_FLAG_LOOKUP = new Map<string, number>(SHADER_FLAG_ENTRIES);

const parseShaderTypes = (raw: readonly string[]): Set<number> | undefined => {
	if (raw.length === 0) {
		return undefined;
	}
	const types = new Set<number>();
	for (const part of raw) {
		const key = part.trim().toLowerCase();
		const id = SHADER_TYPE_LOOKUP.get(key);
		if (id === undefined) {
			throw new Error(
				`--type must be a comma-separated list of ${[...SHADER_TYPE_LOOKUP.keys()].join(', ')}`,
			);
		}
		types.add(id);
	}
	return types;
};

const parseShaderFlags = (raw: readonly string[]): number => {
	if (raw.length === 0) {
		return 0;
	}
	let mask = 0;
	for (const part of raw) {
		const key = part.trim().toLowerCase();
		const bit = SHADER_FLAG_LOOKUP.get(key);
		if (bit === undefined) {
			throw new Error(
				`--flag must be a comma-separated list of ${[...SHADER_FLAG_LOOKUP.keys()].join(', ')}`,
			);
		}
		mask |= bit;
	}
	return mask;
};

const shaderFlagNames = (flags: number): string[] => {
	const names: string[] = [];
	for (const [name, bit] of SHADER_FLAG_ENTRIES) {
		if ((flags & bit) !== 0) {
			names.push(name);
		}
	}
	return names;
};

const formatPropertyDefault = (prop: ShaderProperty): string => {
	switch (prop.type) {
		case ShaderPropertyType.Float:
		case ShaderPropertyType.Int: {
			return String(prop.default[0]);
		}
		case ShaderPropertyType.Range: {
			return `${prop.default[0]} (${prop.default[1]}..${prop.default[2]})`;
		}
		case ShaderPropertyType.Texture: {
			return prop.defaultTexture === '' ? '(none)' : prop.defaultTexture;
		}
		default: {
			return `(${prop.default.map((n) => +n.toFixed(4)).join(', ')})`;
		}
	}
};

interface ResolvedShader {
	bundle: string;
	object: string;
	summary: ShaderSummary;
}

const findShadersByName = async (
	context: Context,
	resolver: AssetResolver,
	pattern: RegExp,
	groupName: string,
): Promise<ResolvedShader[]> => {
	let groups: (typeof VfsGroup)[keyof typeof VfsGroup][];
	switch (groupName) {
		case 'all': {
			groups = [VfsGroup.InitialBundle, VfsGroup.Bundle];
			break;
		}
		case 'main': {
			groups = [VfsGroup.Bundle];
			break;
		}
		case 'initial': {
			groups = [VfsGroup.InitialBundle];
			break;
		}
		default: {
			throw new Error('--group must be initial, main, or all');
		}
	}
	const catalogs = await Promise.all(groups.map((group) => context.vfs.group(group)));
	const names = catalogs
		.values()
		.flatMap((group) => group.catalog.names())
		.toArray();
	const found: ResolvedShader[] = [];
	await mapPool(names, SHADER_SCAN_CONCURRENCY, async (bundlePath) => {
		let files;
		try {
			files = await openAssetFiles(await openBundle(context, bundlePath), { eager: false });
		} catch {
			return;
		}
		for (const file of files) {
			for (const info of file.file.objects) {
				if (info.classId !== UnityClass.Shader) {
					continue;
				}
				try {
					const ref: ObjectRef = { bundleIndex: resolver.bundleIndex(bundlePath), file, info };
					// oxlint-disable-next-line no-await-in-loop -- few shaders per bundle
					const shader = await loadShaderSummary(resolver, ref);
					if (pattern.test(shader.name)) {
						found.push({
							bundle: resolver.manifest.bundleName(ref.bundleIndex),
							object: objectKey(ref),
							summary: shader,
						});
					}
				} catch {
					// skip unreadable shader objects during broad scan
				}
			}
		}
	});
	found.sort((a, b) => compareStrings(a.summary.name, b.summary.name) || compareStrings(a.object, b.object));
	return found;
};

const inspectShader = async (
	context: Context,
	resolver: AssetResolver,
	target: string,
	options: {
		pathId: bigint | undefined;
		nameFilter: RegExp | undefined;
		propFilter: RegExp | undefined;
		types: Set<number> | undefined;
		flagMask: number;
		group: string;
		json: boolean;
	},
): Promise<void> => {
	let shaders: ResolvedShader[];
	let explicitSingle = false;

	if (options.pathId !== undefined || parseHash(target) !== null || BUNDLE_NAME.test(target)) {
		const refs =
			options.pathId === undefined && parseHash(target) === null
				? await resolveFromBundle(resolver, target, UnityClass.Shader, {
						nameFilter: options.nameFilter,
						all: true,
					})
				: [
						await resolveObjectArg(context, resolver, target, UnityClass.Shader, {
							pathId: options.pathId,
							nameFilter: options.nameFilter,
						}),
					];
		explicitSingle = refs.length === 1;
		shaders = await Promise.all(
			refs.map(async (ref) => ({
				bundle: resolver.manifest.bundleName(ref.bundleIndex),
				object: objectKey(ref),
				summary: await loadShaderSummary(resolver, ref),
			})),
		);
	} else {
		const hashes = await context.world.hashesOf(target);
		if (hashes.length === 1) {
			const ref = await resolver.findUnique({ hash: hashes[0], path: target }, UnityClass.Shader);
			explicitSingle = true;
			shaders = [
				{
					bundle: resolver.manifest.bundleName(ref.bundleIndex),
					object: objectKey(ref),
					summary: await loadShaderSummary(resolver, ref),
				},
			];
		} else {
			shaders = await findShadersByName(context, resolver, new RegExp(target, 'i'), options.group);
		}
	}

	const filteringProps =
		options.propFilter !== undefined || options.types !== undefined || options.flagMask !== 0;
	const rows = mapDefined(shaders, ({ bundle, object, summary: shader }) => {
		const properties = shader.properties.filter((prop) => {
			if (options.propFilter !== undefined && !options.propFilter.test(prop.name)) {
				return false;
			}
			if (options.types !== undefined && !options.types.has(prop.type)) {
				return false;
			}
			if (options.flagMask !== 0 && (prop.flags & options.flagMask) !== options.flagMask) {
				return false;
			}
			return true;
		});
		if (!explicitSingle && filteringProps && properties.length === 0) {
			return undefined;
		}
		return {
			name: shader.name,
			object,
			bundle,
			renderQueue: shader.renderQueue ?? null,
			tags: shader.tags,
			totalProperties: shader.properties.length,
			properties: properties.map((prop) => ({
				name: prop.name,
				type: SHADER_TYPE_NAMES[prop.type] ?? String(prop.type),
				flags: prop.flags,
				flagNames: shaderFlagNames(prop.flags),
				default: prop.type === ShaderPropertyType.Texture ? prop.defaultTexture : prop.default,
				raw: prop,
			})),
		};
	});

	if (options.json) {
		const payload = rows.map(({ properties, ...rest }) => ({
			...rest,
			properties: properties.map(({ raw: _raw, ...p }) => p),
		}));
		console.log(JSON.stringify(explicitSingle ? (payload[0] ?? null) : payload, jsonReplacer, '\t'));
		return;
	}

	for (const [index, row] of rows.entries()) {
		if (index > 0) {
			console.log('');
		}
		const queue = row.renderQueue === null ? '' : `  queue=${row.renderQueue}`;
		console.log(`${row.name}  (${row.bundle}  ${row.object})${queue}`);
		const tagEntries = Object.entries(row.tags);
		if (tagEntries.length > 0) {
			console.log(`  tags: ${tagEntries.map(([k, v]) => `${k}=${v}`).join(', ')}`);
		}
		const countLabel =
			row.properties.length === row.totalProperties
				? `${row.properties.length}`
				: `${row.properties.length} of ${row.totalProperties}`;
		console.log(`  properties (${countLabel}):`);
		for (const prop of row.properties) {
			const flags = prop.flagNames.length === 0 ? '' : `  [${prop.flagNames.join(', ')}]`;
			const flagHex = prop.flags === 0 ? '' : ` (0x${prop.flags.toString(16)})`;
			console.log(
				`    ${prop.name.padEnd(36)} ${prop.type.padEnd(8)} ${formatPropertyDefault(prop.raw).padEnd(26)}${flags}${flagHex}`,
			);
		}
	}
	console.error(`${rows.length} shader${rows.length === 1 ? '' : 's'}`);
};

// #endregion

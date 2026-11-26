import { type ObjectInfo, typeName, UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import type { TypeTreeValue } from '@endfield-noclip/formats/unity/type-tree';
import {
	isObject,
	numberField,
	pptrField,
	streamingInfo,
	stringField,
} from '@endfield-noclip/formats/unity/values';

import { mapDefined } from '@mary-ext/array-fns';

import { type BundleAssetFile, openAssetFiles, openBundle } from '../../../install/bundles.ts';
import { type Context, withContext } from '../../../install/context.ts';
import { VfsGroup } from '../../../install/vfs.ts';
import { errorText } from '../../../util/errors.ts';
import { collectTargets, parseHash, save } from '../../helpers.ts';
import { matchesWhere, pickFields, type WherePredicate } from '../../query.ts';

import type { BundleArgs } from './parser.ts';

/**
 * runs `endfield-extract bundle`
 *
 * @param args parsed CLI arguments
 */
export const runBundle = async (args: BundleArgs): Promise<void> => {
	await withContext(args.config, async (context) => {
		switch (args.subcommand) {
			case 'info': {
				await info(await openAssetFilesByName(context, args.name, { eager: false }));
				break;
			}
			case 'dump': {
				const targets = await collectTargets(args.targets, args.stdin);
				if (targets.length === 0) {
					throw new Error('bundle dump needs at least one target or --stdin');
				}
				const matches = (object: ObjectInfo): boolean => {
					if (args.pathId !== undefined) {
						return object.pathId === args.pathId;
					}
					return args.classes.length === 0 || args.classes.some((cls) => isClass(object, cls));
				};
				await dumpMany(context, targets, matches, {
					nameFilter: args.name,
					joinGo: args.joinGo,
					where: [...args.where],
					pick: [...args.pick],
					text: args.format === 'text',
					json: args.format === 'json',
					limit: args.limit,
					maxArray: args.maxArray,
					eager: args.pathId === undefined && args.classes.length === 0 && args.name === undefined,
				});
				break;
			}
			case 'stream': {
				await stream(context, args.name, args.pathId, args.output);
				break;
			}
			case 'find': {
				if (args.filter === undefined && args.classes.length === 0) {
					throw new Error('bundle find needs <re>, --filter <re>, and/or --class <class>');
				}
				await find(context, {
					group: args.group,
					filter: args.filter,
					classNames: [...args.classes],
					scan: args.scan,
					limit: args.limit,
				});
				break;
			}
		}
	});
};

/** @returns whether the object's class id or TypeTree class name is `name` */
const isClass = (object: ObjectInfo, name: string): boolean => {
	return String(object.classId) === name || typeName(object.type) === name;
};

const resolveBundleName = async (context: Context, target: string): Promise<string> => {
	const hash = parseHash(target);
	if (hash !== null) {
		const manifest = await context.world.manifest();
		const assets = manifest.findAssets(hash);
		if (assets.length > 0) {
			return manifest.bundleName(assets[0].bundleIndex);
		}
		throw new Error(`hash ${target} has no bundle in manifest`);
	}
	if (/^(assets\/|data\/)/i.test(target) && !target.endsWith('.ab')) {
		const hashes = await context.world.hashesOf(target);
		const manifest = await context.world.manifest();
		for (const h of hashes) {
			const assets = manifest.findAssets(h);
			if (assets.length > 0) {
				return manifest.bundleName(assets[0].bundleIndex);
			}
		}
		throw new Error(`asset ${target} has no bundle in manifest`);
	}
	return target;
};

const openAssetFilesByName = async (
	context: Context,
	name: string,
	options?: { eager?: boolean },
): Promise<BundleAssetFile[]> => {
	const resolved = await resolveBundleName(context, name);
	return openAssetFiles(await openBundle(context, resolved), options);
};

// #region info

const info = async (files: BundleAssetFile[]): Promise<void> => {
	const bundle = files[0]?.bundle;
	if (bundle === undefined) {
		console.log('bundle has no SerializedFiles');
		return;
	}
	const { header, blocks, nodes } = bundle;
	const kinds = new Map<number, number>();
	for (const block of blocks) {
		kinds.set(block.flags, (kinds.get(block.flags) ?? 0) + 1);
	}
	const stored = blocks.reduce((sum, block) => sum + block.compressedSize, 0);
	const unpacked = blocks.reduce((sum, block) => sum + block.uncompressedSize, 0);
	console.log(
		`bundle: ${header.size} bytes, flags 0x${header.flags.toString(16)}, encFlags ${header.encFlags}, ` +
			`blocks-info ${header.compressedBlocksInfoSize}→${header.uncompressedBlocksInfoSize}`,
	);
	console.log(
		`blocks: ${blocks.length} (${kinds
			.entries()
			.map(([kind, count]) => `type ${kind}×${count}`)
			.toArray()
			.join(', ')}), ${stored} → ${unpacked} bytes`,
	);
	console.log('nodes:');
	for (const node of nodes) {
		console.log(
			`  ${node.path.padEnd(44)} ${String(node.size).padStart(11)}  flags 0x${node.flags.toString(16)}`,
		);
	}

	const assetBundles = await Promise.all(files.map((asset) => asset.assetBundles()));
	for (const [i, asset] of files.entries()) {
		const { file } = asset;
		console.log(
			`\n${asset.node.path}: SerializedFile v${file.header.version}, ${file.unityVersion}, ` +
				`platform ${file.targetPlatform}, ${file.objects.length} objects, ${file.types.length} types, ` +
				`${file.refTypes.length} ref types`,
		);
		const counts = new Map<string, number>();
		for (const object of file.objects) {
			const key = `${object.classId} ${typeName(object.type) ?? '?'}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
		for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1])) {
			console.log(`  ${String(count).padStart(6)}  ${key}`);
		}
		if (file.externals.length > 0) {
			console.log(`  externals:`);
			for (const [index, external] of file.externals.entries()) {
				console.log(`    ${index + 1}: ${external.pathName}`);
			}
		}
		for (const { name, container } of assetBundles[i]) {
			console.log(`  AssetBundle ${name ?? '?'}: ${container.length} container entries`);
			for (const entry of container.slice(0, 10)) {
				console.log(`    ${entry.path}`);
			}
			if (container.length > 10) {
				console.log(`    … ${container.length - 10} more`);
			}
		}
	}
};

// #endregion

// #region dump

interface GoJoinIndex {
	goNames: Map<bigint, string>;
	particleRenderMode: Map<bigint, number>;
}

const buildGoJoinIndex = async (asset: BundleAssetFile): Promise<GoJoinIndex> => {
	const goNames = new Map<bigint, string>();
	const particleRenderMode = new Map<bigint, number>();
	for (const object of asset.file.objects) {
		if (object.classId === UnityClass.GameObject) {
			// oxlint-disable-next-line no-await-in-loop -- lightweight name peek per GameObject
			const name = await asset.peekName(object);
			if (name !== undefined) {
				goNames.set(object.pathId, name);
			}
		} else if (object.classId === UnityClass.ParticleSystemRenderer) {
			try {
				// oxlint-disable-next-line no-await-in-loop -- few ParticleSystemRenderers per prefab
				const data = await asset.read(object);
				const go = pptrField(data, 'm_GameObject').pathId;
				if (go !== 0n) {
					particleRenderMode.set(go, numberField(data, 'm_RenderMode'));
				}
			} catch {
				// ignore malformed renderers in debug dumps
			}
		}
	}
	return { goNames, particleRenderMode };
};

const dumpMany = async (
	context: Context,
	targets: readonly string[],
	matches: (object: ObjectInfo) => boolean,
	options: {
		nameFilter: RegExp | undefined;
		joinGo: boolean;
		where: readonly WherePredicate[];
		pick: readonly string[];
		text: boolean;
		json: boolean;
		limit: number;
		maxArray: number;
		eager: boolean;
	},
): Promise<void> => {
	const jsonRows: object[] = [];
	const textRows: { name: string; script: string }[] = [];
	let matched = 0;

	for (const target of targets) {
		if (matched >= options.limit) {
			break;
		}
		// oxlint-disable-next-line no-await-in-loop -- streams results in target order up to the limit
		const bundleName = await resolveBundleName(context, target);
		// oxlint-disable-next-line no-await-in-loop -- streams results in target order up to the limit
		const files = await openAssetFiles(await openBundle(context, bundleName), { eager: options.eager });

		for (const asset of files) {
			let joinIndex: GoJoinIndex | undefined;
			for (const object of asset.file.objects) {
				if (matched >= options.limit) {
					break;
				}
				if (!matches(object)) {
					continue;
				}
				if (options.nameFilter !== undefined) {
					// oxlint-disable-next-line no-await-in-loop -- peeks name before full decode, up to the limit
					const objectName = (await asset.peekName(object)) ?? '';
					if (!options.nameFilter.test(objectName)) {
						continue;
					}
				}
				if (options.text) {
					// oxlint-disable-next-line no-await-in-loop -- objects print in order, up to the limit
					const value = await asset.read(object);
					const objectName = typeof value.m_Name === 'string' ? value.m_Name : object.pathId.toString();
					const script = textContent(value.m_Script);
					if (script === null) {
						throw new Error(
							`object ${object.pathId} (${typeName(object.type) ?? object.classId}) has no m_Script field`,
						);
					}
					matched++;
					textRows.push({ name: objectName, script });
					continue;
				}
				let rawValue: TypeTreeValue | undefined;
				let value: unknown;
				try {
					// oxlint-disable-next-line no-await-in-loop -- objects print in order, up to the limit
					rawValue = await asset.read(object);
					value = toJson(rawValue, options.maxArray);
				} catch (error) {
					value = { error: errorText(error) };
				}
				let gameObject: string | undefined;
				let renderMode: number | undefined;
				if (options.joinGo && rawValue !== undefined && isObject(rawValue)) {
					if (joinIndex === undefined) {
						// oxlint-disable-next-line no-await-in-loop -- built lazily once per SerializedFile
						joinIndex = await buildGoJoinIndex(asset);
					}
					if (object.classId === UnityClass.GameObject) {
						try {
							gameObject = stringField(rawValue, 'm_Name');
						} catch {
							// no name
						}
					} else if ('m_GameObject' in rawValue) {
						try {
							const goId = pptrField(rawValue, 'm_GameObject').pathId;
							gameObject = joinIndex.goNames.get(goId);
							if (object.classId === UnityClass.ParticleSystem) {
								renderMode = joinIndex.particleRenderMode.get(goId);
							}
						} catch {
							// no m_GameObject PPtr
						}
					}
				}
				const header: Record<string, unknown> = {
					...(targets.length > 1 ? { bundle: bundleName } : {}),
					node: asset.node.path,
					pathId: object.pathId.toString(),
					classId: object.classId,
					type: typeName(object.type),
					...(gameObject === undefined ? {} : { gameObject }),
					...(renderMode === undefined ? {} : { renderMode }),
					byteSize: object.byteSize,
				};
				const row = { ...header, value };
				// allow --where and --pick to reference either top-level header keys or fields inside `value` directly
				const queryView =
					value !== null && typeof value === 'object' && !Array.isArray(value)
						? { ...Object.fromEntries(Object.entries(value)), ...header, value }
						: row;
				if (options.where.length > 0 && !matchesWhere(queryView, options.where)) {
					continue;
				}
				matched++;
				const outputRow =
					options.pick.length > 0
						? {
								...(targets.length > 1 ? { bundle: bundleName } : {}),
								pathId: header.pathId,
								type: header.type,
								...(gameObject === undefined ? {} : { gameObject }),
								...pickFields(queryView, options.pick),
							}
						: row;
				if (options.json) {
					jsonRows.push(outputRow);
				} else {
					console.log(JSON.stringify(outputRow));
				}
			}
			if (matched >= options.limit) {
				break;
			}
		}
	}
	if (options.json) {
		console.log(JSON.stringify(jsonRows, null, '\t'));
	} else if (options.text) {
		if (textRows.length === 1) {
			process.stdout.write(textRows[0].script);
			if (!textRows[0].script.endsWith('\n')) {
				process.stdout.write('\n');
			}
		} else {
			for (const row of textRows) {
				console.log(`=== ${row.name} ===`);
				process.stdout.write(row.script);
				if (!row.script.endsWith('\n')) {
					process.stdout.write('\n');
				}
			}
		}
	}
};

const textContent = (value: TypeTreeValue | undefined): string | null => {
	if (typeof value === 'string') {
		return value;
	}
	if (value instanceof Uint8Array) {
		return new TextDecoder().decode(value);
	}
	return null;
};

/** converts a TypeTree value into JSON-safe data, truncating long arrays */
const toJson = (value: TypeTreeValue, maxArray: number): unknown => {
	if (typeof value === 'bigint') {
		return value.toString();
	}
	if (ArrayBuffer.isView(value)) {
		const head = Array.from(value.subarray(0, maxArray) as ArrayLike<number | bigint>, (item) =>
			typeof item === 'bigint' ? item.toString() : item,
		);
		return value.length <= maxArray ? head : { $type: value.constructor.name, length: value.length, head };
	}
	if (Array.isArray(value)) {
		const head = value.slice(0, maxArray).map((item) => toJson(item, maxArray));
		return value.length <= maxArray ? head : { $type: 'Array', length: value.length, head };
	}
	if (typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, toJson(field, maxArray)]));
	}
	return value;
};

// #endregion

// #region stream

const stream = async (context: Context, name: string, pathId: bigint, output: string): Promise<void> => {
	const resolver = await context.resolver();
	const ref = await resolver.object(resolver.bundleIndex(name), pathId);
	const streamInfo = streamingInfo(await resolver.read(ref));
	if (streamInfo === undefined) {
		throw new Error(`object ${pathId} has no m_StreamData or stores its data inline`);
	}
	const data = await resolver.streamData(ref, streamInfo);
	if (data === undefined) {
		throw new Error(`object ${pathId} stores its data inline`);
	}
	await save(output, data);
	console.log(`wrote ${data.length} bytes from ${streamInfo.path} @ ${streamInfo.offset} to ${output}`);
};

// #endregion

// #region find

/** bundles opened concurrently during `bundle find` */
const FIND_CONCURRENCY = 16;

const find = async (
	context: Context,
	options: {
		filter: RegExp | undefined;
		classNames: readonly string[];
		group: string;
		scan: number;
		limit: number;
	},
): Promise<void> => {
	let groups: (typeof VfsGroup)[keyof typeof VfsGroup][];
	switch (options.group) {
		case 'all': {
			groups = [VfsGroup.Bundle, VfsGroup.InitialBundle];
			break;
		}
		case 'initial': {
			groups = [VfsGroup.InitialBundle];
			break;
		}
		default: {
			groups = [VfsGroup.Bundle];
			break;
		}
	}
	const catalogs = await Promise.all(groups.map((group) => context.vfs.group(group)));
	const allNames = catalogs
		.values()
		.flatMap((group) => group.catalog.names())
		.toArray();
	const maxScan = Math.min(allNames.length, options.scan);
	let scanned = 0;
	let found = 0;
	let failed = 0;
	const pending = new Map<number, Promise<string[] | Error>>();
	const start = (index: number): void => {
		if (index >= maxScan) {
			return;
		}
		const name = allNames[index];
		pending.set(
			index,
			(async () => {
				const assets = await openAssetFiles(await openBundle(context, name), { eager: false });
				const matches = await Promise.all(assets.map((asset) => scanAsset(asset, options)));
				return matches.flat();
			})().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error)))),
		);
	};
	for (let i = 0; i < Math.min(FIND_CONCURRENCY, maxScan); i++) {
		start(i);
	}
	try {
		for (let i = 0; i < maxScan && found < options.limit; i++) {
			scanned++;
			// oxlint-disable-next-line no-await-in-loop -- results print in catalog order, stopping at the limit
			const result = await pending.get(i)!;
			pending.delete(i);
			const name = allNames[i];
			if (result instanceof Error) {
				failed++;
				console.error(`${name}: ${errorText(result)}`);
			} else {
				for (const match of result) {
					if (found < options.limit) {
						found++;
						console.log(`${name}\t${match}`);
					}
				}
			}
			if (found < options.limit) {
				start(i + FIND_CONCURRENCY);
			}
		}
	} finally {
		for (const promise of pending.values()) {
			void promise.catch(() => {});
		}
	}
	console.error(`scanned ${scanned} bundles, ${found} matches, ${failed} failures`);
};

/** @returns matching container paths, or individually addressable objects of the requested classes */
const scanAsset = async (
	asset: BundleAssetFile,
	{ filter, classNames }: { filter: RegExp | undefined; classNames: readonly string[] },
): Promise<string[]> => {
	const objects =
		classNames.length === 0
			? []
			: asset.file.objects.filter((object) => classNames.some((cls) => isClass(object, cls)));
	if (classNames.length > 0 && objects.length === 0) {
		return [];
	}
	const paths = (await asset.assetBundles()).flatMap(({ container }) =>
		mapDefined(container, ({ path }) => (filter === undefined || filter.test(path) ? path : undefined)),
	);
	if (filter !== undefined && paths.length === 0) {
		return [];
	}
	if (classNames.length === 0) {
		return paths;
	}
	return Promise.all(
		objects.map(
			async (object) =>
				`${asset.node.path}\t${object.pathId}\t${typeName(object.type) ?? object.classId}\t${(await asset.peekName(object)) ?? '?'}\t${paths.join(',')}`,
		),
	);
};

// #endregion

import { parseArgs } from 'node:util';

import { type ObjectInfo, typeName } from '@endfield-noclip/formats/unity/serialized-file';
import type { TypeTreeValue } from '@endfield-noclip/formats/unity/type-tree';
import { streamingInfo } from '@endfield-noclip/formats/unity/values';

import { parseOptionalInteger, parsePathId, save } from '../cli-args.ts';
import { type Context, withContext } from '../context.ts';
import { errorText } from '../errors.ts';
import { type BundleAssetFile, openAssetFiles, openBundle } from '../hg/bundles.ts';
import { VfsGroup } from '../hg/vfs.ts';

export const summary =
	'inspect asset bundles: info <name> | dump <name> [--path-id N | --class C] | stream <name> --path-id N -o <file> | find [--filter re] [--class C]';

const USAGE = `usage:
  bundle info <name>                     header, nodes and per-class object counts
  bundle dump <name> [--path-id N] [--class Mesh|43] [--limit n] [--max-array n]
                                         objects as JSON; big arrays are truncated
  bundle stream <name> --path-id N -o <file>
                                         writes an object's m_StreamData (.resS) payload
  bundle find [--filter <re>] [--class Shader|48] [--scan n] [--limit n]
                                         searches bundles for m_Container paths matching <re>
                                         and/or objects of a class

<name> is a bundle hex id, main/<hex>.ab, or a full logical path.
negative path ids need the --path-id=-N form.`;

export const run = async (args: string[]): Promise<void> => {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			config: { type: 'string' },
			'path-id': { type: 'string' },
			class: { type: 'string' },
			limit: { type: 'string' },
			'max-array': { type: 'string' },
			filter: { type: 'string' },
			scan: { type: 'string' },
			output: { type: 'string', short: 'o' },
		},
	});
	const [sub, name] = positionals;
	const limit = parseOptionalInteger(values.limit, '--limit') ?? Infinity;
	const maxArray = parseOptionalInteger(values['max-array'], '--max-array') ?? 16;
	const scan = parseOptionalInteger(values.scan, '--scan') ?? Infinity;
	const pathId = parsePathId(values['path-id'], '--path-id');

	await withContext(values.config, async (context) => {
		switch (sub) {
			case 'info': {
				await info(await openAssetFilesByName(context, name));
				break;
			}
			case 'dump': {
				const files = await openAssetFilesByName(context, name);
				const matches = (object: ObjectInfo): boolean => {
					if (pathId !== undefined) {
						return object.pathId === pathId;
					}
					return values.class === undefined || isClass(object, values.class);
				};
				await dump(files, matches, { limit, maxArray });
				break;
			}
			case 'stream': {
				if (pathId === undefined || values.output === undefined) {
					throw new Error('bundle stream needs --path-id N -o <file>');
				}
				if (name === undefined) {
					throw new Error(USAGE);
				}
				await stream(context, name, pathId, values.output);
				break;
			}
			case 'find': {
				if (values.filter === undefined && values.class === undefined) {
					throw new Error('bundle find needs --filter <re> and/or --class <class>');
				}
				await find(context, {
					filter: values.filter === undefined ? undefined : new RegExp(values.filter, 'i'),
					className: values.class,
					scan,
					limit,
				});
				break;
			}
			default: {
				throw new Error(USAGE);
			}
		}
	});
};

/** @returns whether the object's class id or TypeTree class name is `name` */
const isClass = (object: ObjectInfo, name: string): boolean => {
	return String(object.classId) === name || typeName(object.type) === name;
};

const openAssetFilesByName = async (
	context: Context,
	name: string | undefined,
): Promise<BundleAssetFile[]> => {
	if (name === undefined) {
		throw new Error(USAGE);
	}
	return openAssetFiles(await openBundle(context, name));
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
		`blocks: ${blocks.length} (${[...kinds].map(([kind, count]) => `type ${kind}×${count}`).join(', ')}), ` +
			`${stored} → ${unpacked} bytes`,
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
		for (const [key, count] of [...counts].toSorted((a, b) => b[1] - a[1])) {
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

const dump = async (
	files: BundleAssetFile[],
	matches: (object: ObjectInfo) => boolean,
	options: { limit: number; maxArray: number },
): Promise<void> => {
	let printed = 0;
	for (const asset of files) {
		for (const object of asset.file.objects) {
			if (printed >= options.limit) {
				return;
			}
			if (!matches(object)) {
				continue;
			}
			printed++;
			const header = {
				node: asset.node.path,
				pathId: object.pathId.toString(),
				classId: object.classId,
				type: typeName(object.type),
				byteSize: object.byteSize,
			};
			let value: unknown;
			try {
				// oxlint-disable-next-line no-await-in-loop -- objects print in order, up to the limit
				value = toJson(await asset.read(object), options.maxArray);
			} catch (error) {
				value = { error: errorText(error) };
			}
			console.log(JSON.stringify({ ...header, value }, null, '\t'));
		}
	}
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

const find = async (
	context: Context,
	options: { filter: RegExp | undefined; className: string | undefined; scan: number; limit: number },
): Promise<void> => {
	const names = [...(await context.vfs.group(VfsGroup.Bundle)).files.keys()];
	let scanned = 0;
	let found = 0;
	let failed = 0;
	for (const name of names) {
		if (scanned >= options.scan || found >= options.limit) {
			break;
		}
		scanned++;
		try {
			// oxlint-disable-next-line no-await-in-loop -- one bundle at a time, so the scan stops at its limits
			const assets = await openAssetFiles(await openBundle(context, name));
			// oxlint-disable-next-line no-await-in-loop -- one bundle at a time, so the scan stops at its limits
			const matches = await Promise.all(assets.map((asset) => scanAsset(asset, options)));
			for (const match of matches.flat()) {
				if (found < options.limit) {
					found++;
					console.log(`${name}\t${match}`);
				}
			}
		} catch (error) {
			failed++;
			console.error(`${name}: ${errorText(error)}`);
		}
	}
	console.error(`scanned ${scanned} bundles, ${found} matches, ${failed} failures`);
};

/**
 * @returns the asset file's matches: a summary line of its objects of `className`, or else its container
 *   paths matching `filter`
 */
const scanAsset = async (
	asset: BundleAssetFile,
	{ filter, className }: { filter: RegExp | undefined; className: string | undefined },
): Promise<string[]> => {
	if (className !== undefined) {
		const hits = asset.file.objects.filter((object) => isClass(object, className));
		if (hits.length === 0) {
			return [];
		}
		if (filter === undefined) {
			const labels = await Promise.all(
				hits.slice(0, 5).map(async (object) => (await asset.peekName(object)) ?? '?'),
			);
			const more = hits.length > 5 ? ` …${hits.length - 5} more` : '';
			return [`${hits.length}× ${className}: ${labels.join(', ')}${more}`];
		}
	}
	if (filter === undefined) {
		return [];
	}
	return (await asset.assetBundles()).flatMap(({ container }) =>
		container.map(({ path }) => path).filter((path) => filter.test(path)),
	);
};

// #endregion

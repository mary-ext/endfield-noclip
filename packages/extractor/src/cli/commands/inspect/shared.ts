import { isTextureClass, UnityClass } from '@endfield-noclip/formats/unity/serialized-file';

import type { AssetResolver, ObjectRef } from '../../../game/assets/assets.ts';
import type { Context } from '../../../install/context.ts';
import { hashText, parseHash } from '../../helpers.ts';

/** matches a bundle hex id or bundle path */
export const BUNDLE_NAME = /^(?:(?:Data\/Bundles\/Windows\/)?(?:main|initial)\/)?[0-9a-f]{24}(?:\.ab)?$/i;

/** matches a SerializedFile object locator (`CAB-<hex>:<pathId>` or `CAB-<hex>`) */
const CAB_LOCATOR = /^CAB-[0-9a-f]+(?::(-?\d+))?$/i;

interface ResolveOptions {
	pathId: bigint | undefined;
	nameFilter: RegExp | undefined;
}

const matchesClass = (actual: number, expected: number): boolean =>
	expected === UnityClass.Texture2D ? isTextureClass(actual) : actual === expected;

const classMatcherOf = (classId: number): number | ((actual: number) => boolean) =>
	classId === UnityClass.Texture2D ? isTextureClass : classId;

/** resolves `<bundle> [--path-id=N] [--name re]`, an asset path, or a path hash to a single {@link ObjectRef} */
export const resolveObjectArg = async (
	context: Context,
	resolver: AssetResolver,
	target: string,
	classId: number,
	options: ResolveOptions,
): Promise<ObjectRef> => {
	const cabMatch = CAB_LOCATOR.exec(target);
	if (cabMatch !== null) {
		const pathIdHint = cabMatch[1] === undefined ? '' : ` --path-id=${cabMatch[1]}`;
		throw new Error(
			`${target} is a SerializedFile locator, not a bundle or asset path; pass a bundle (e.g. main/<24-hex>.ab${pathIdHint}) or an asset path/name`,
		);
	}
	if (options.pathId !== undefined) {
		return resolver.object(resolver.bundleIndex(target), options.pathId);
	}
	const matcher = classMatcherOf(classId);
	const hash = parseHash(target);
	if (hash !== null) {
		return resolver.findUnique({ hash, path: (await context.world.pathOf(hash)) ?? null }, matcher);
	}
	if (BUNDLE_NAME.test(target)) {
		const [ref] = await resolveFromBundle(resolver, target, classId, {
			nameFilter: options.nameFilter,
			all: false,
		});
		return ref;
	}
	const hashes = await context.world.hashesOf(target);
	if (hashes.length === 1) {
		return resolver.findUnique({ hash: hashes[0], path: target }, matcher);
	}
	if (hashes.length > 1) {
		throw new Error(
			`${target} has ${hashes.length} path hashes; pass one of ${hashes.map(hashText).join(', ')}`,
		);
	}
	// fall back to matching by filename / suffix in StringPathHash
	const lower = target.toLowerCase();
	const suffix = `/${lower}`;
	const hasSlash = lower.includes('/');
	const [main, initial] = await Promise.all([context.world.pathHash(), context.world.initPathHash()]);
	const matches: { hash: bigint; path: string }[] = [];
	const seen = new Set<string>();
	for (const table of [main, initial]) {
		for (const [entryHash, path] of table.entries((candidate) => {
			const c = candidate.toLowerCase();
			if (c === lower || c.endsWith(suffix)) {
				return true;
			}
			if (!hasSlash) {
				const base = c.slice(c.lastIndexOf('/') + 1);
				const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
				return stem === lower;
			}
			return false;
		})) {
			const key = `${entryHash}:${path}`;
			if (!seen.has(key)) {
				seen.add(key);
				matches.push({ hash: entryHash, path });
			}
		}
	}
	if (matches.length === 1) {
		return resolver.findUnique({ hash: matches[0].hash, path: matches[0].path }, matcher);
	}
	if (matches.length === 0) {
		throw new Error(`${target} is not in StringPathHash`);
	}
	const sample = matches
		.slice(0, 10)
		.map((m) => `  ${hashText(m.hash)}  ${m.path}`)
		.join('\n');
	throw new Error(
		`${target} matched ${matches.length} paths in StringPathHash; pass a full path or hash:\n${sample}`,
	);
};

/** resolves one or more Material targets (supporting `--all` and `--name` on bundle arguments) */
/** resolves one or all materials from a target */
export const resolveMaterialTargets = async (
	context: Context,
	resolver: AssetResolver,
	target: string,
	options: ResolveOptions & { all: boolean },
): Promise<ObjectRef[]> => {
	if (options.pathId === undefined && parseHash(target) === null && BUNDLE_NAME.test(target)) {
		return resolveFromBundle(resolver, target, UnityClass.Material, {
			nameFilter: options.nameFilter,
			all: options.all,
		});
	}
	return [await resolveObjectArg(context, resolver, target, UnityClass.Material, options)];
};

/** picks matching objects of `classId` (or main GameObject for prefabs) in a bundle */
/** resolves matching objects of a class within one bundle */
export const resolveFromBundle = async (
	resolver: AssetResolver,
	bundleName: string,
	classId: number,
	options: { nameFilter: RegExp | undefined; all: boolean },
): Promise<ObjectRef[]> => {
	const bundleIndex = resolver.bundleIndex(bundleName);
	const files = await resolver.assetFiles(bundleIndex);
	if (classId === UnityClass.GameObject && options.nameFilter === undefined && !options.all) {
		const containerRoots: ObjectRef[] = [];
		for (const file of files) {
			// oxlint-disable-next-line no-await-in-loop -- typically one SerializedFile per bundle
			for (const assetBundle of await file.assetBundles()) {
				for (const entry of assetBundle.container) {
					const obj = file.file.objectsByPathId.get(entry.asset.pathId);
					if (obj !== undefined && obj.classId === UnityClass.GameObject) {
						containerRoots.push({ bundleIndex, file, info: obj });
					}
				}
			}
		}
		if (containerRoots.length === 1) {
			return containerRoots;
		}
	}
	const candidates: ObjectRef[] = [];
	for (const file of files) {
		for (const info of file.file.objects) {
			if (matchesClass(info.classId, classId)) {
				candidates.push({ bundleIndex, file, info });
			}
		}
	}
	const matches: ObjectRef[] = [];
	if (options.nameFilter === undefined) {
		matches.push(...candidates);
	} else {
		for (const ref of candidates) {
			// oxlint-disable-next-line no-await-in-loop -- peeks names in object order
			const name = (await ref.file.peekName(ref.info)) ?? '';
			if (options.nameFilter.test(name)) {
				matches.push(ref);
			}
		}
	}
	if (matches.length === 0) {
		const suffix = options.nameFilter === undefined ? '' : ` matching ${options.nameFilter}`;
		throw new Error(`bundle ${bundleName} has no class-${classId} objects${suffix}`);
	}
	if (matches.length === 1 || options.all) {
		return matches;
	}
	const sample = await Promise.all(
		matches.slice(0, 12).map(async (ref) => {
			const name = await ref.file.peekName(ref.info);
			return `  --path-id=${ref.info.pathId}${name === undefined ? '' : `  ${name}`}`;
		}),
	);
	throw new Error(
		`bundle ${bundleName} has ${matches.length} class-${classId} objects; pass --path-id=N, --name <re>, or --all:\n${sample.join('\n')}`,
	);
};

// #endregion

import { crc32 } from 'node:zlib';

import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { type ClipTransformValue, readClipEndPose } from '@endfield-noclip/formats/unity/animation-clip';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	arrayField,
	asPPtr,
	isObject,
	numberField,
	pptrField,
	stringField,
} from '@endfield-noclip/formats/unity/values';

import { type AssetResolver, type ObjectRef, objectKey } from '../assets/assets.ts';
import type { PoseClip, PrefabPose } from '../prefabs/prefab.ts';

// settled looks of a telescopic bridge (`InteractiveTelescopicPostmodelMono`): retracted, or extended by a
// number of platform pieces. layout: docs/game-data/interactives.md#telescopic-bridges.

/** a telescopic bridge's looks, each drawn as placements of its own prefab in a pose */
export interface TelescopicPoses {
	/** state 0: the end port over the start port, no track and no pieces */
	retracted: PrefabPose;
	/** state 1: the end port past the pieces and the track stretched under them */
	extended: PrefabPose;
	/** state 1: one more placement per piece, showing only the piece in its slot, rail raised */
	pieces: PrefabPose[];
}

const position = (value: readonly [number, number, number]): ClipTransformValue => ({
	kind: 'position',
	value: [...value],
});

/** a GameObject path's binding key, as AnimationClips and {@link PoseClip.transforms} use */
const pathKey = (path: string): number => crc32(path) >>> 0;

/** Transform values bound below the prefab root, switching nothing */
const rootClip = (transforms: Map<number, ClipTransformValue[]>): PoseClip => ({
	animator: null,
	transforms,
	active: new Map(),
	materials: new Map(),
	renderers: new Map(),
	motion: null,
});

/** a GameObject's components of one class */
const componentsOf = async (
	resolver: AssetResolver,
	go: ObjectRef,
	classId: number,
): Promise<{ ref: ObjectRef; data: TypeTreeObject }[]> => {
	const refs = await Promise.all(
		arrayField(await resolver.read(go), 'm_Component').map((item) => {
			if (!isObject(item)) {
				throw new FormatError('prefab component is not an object');
			}
			return resolver.resolve(go, pptrField(item, 'component'));
		}),
	);
	return Promise.all(
		refs
			.filter((ref) => ref?.info.classId === classId)
			.map(async (ref) => ({ ref: ref!, data: await resolver.read(ref!) })),
	);
};

/** a GameObject's children, with their names */
const childrenOf = async (
	resolver: AssetResolver,
	go: ObjectRef,
): Promise<{ ref: ObjectRef; name: string }[]> => {
	const [transform] = await componentsOf(resolver, go, UnityClass.Transform);
	if (transform === undefined) {
		throw new FormatError(`prefab GameObject ${go.info.pathId} has no Transform`);
	}
	return Promise.all(
		arrayField(transform.data, 'm_Children').map(async (pointer) => {
			const child = await resolver.resolve(transform.ref, asPPtr(pointer));
			const ref =
				child && (await resolver.resolve(child, pptrField(await resolver.read(child), 'm_GameObject')));
			if (!ref) {
				throw new FormatError('prefab Transform child is missing');
			}
			return { ref, name: stringField(await resolver.read(ref), 'm_Name') };
		}),
	);
};

/** the one open-idle clip of an Animator's controller */
const openIdleClip = async (
	resolver: AssetResolver,
	animator: { ref: ObjectRef; data: TypeTreeObject },
	where: string,
): Promise<TypeTreeObject> => {
	const controller = await resolver.resolve(animator.ref, pptrField(animator.data, 'm_Controller'));
	if (controller === null) {
		throw new FormatError(`${where}'s Animator has no controller`);
	}
	const clips = await Promise.all(
		arrayField(await resolver.read(controller), 'm_AnimationClips').map(async (pointer) => {
			const ref = await resolver.resolve(controller, asPPtr(pointer));
			return ref && resolver.read(ref);
		}),
	);
	const open = clips.filter((clip) => clip !== null && /openidle/i.test(stringField(clip, 'm_Name')));
	if (open.length !== 1) {
		throw new FormatError(`${where}'s Animator has ${open.length} open idle clips`);
	}
	return open[0]!;
};

/**
 * the open-idle end pose of the piece's rail Animator, re-keyed from paths below that Animator to paths below
 * the prefab root, so it applies in a pose whose Animator is the root
 */
const railPose = async (
	resolver: AssetResolver,
	piece: ObjectRef,
	pieceName: string,
): Promise<Map<number, ClipTransformValue[]>> => {
	let clip: TypeTreeObject | null = null;
	/** by binding key below the Animator, the same GameObject's path below the prefab root */
	const rootPaths = new Map<number, string>();
	// `below` is the path below the Animator, `null` above it
	const walk = async (go: ObjectRef, rootPath: string, below: string | null): Promise<void> => {
		let here = below;
		const [animator] = here === null ? await componentsOf(resolver, go, UnityClass.Animator) : [];
		if (animator !== undefined) {
			clip = await openIdleClip(resolver, animator, rootPath);
			here = '';
		}
		if (here !== null) {
			rootPaths.set(pathKey(here), rootPath);
		}
		await Promise.all(
			(await childrenOf(resolver, go)).map(({ ref, name }) => {
				let next: string | null = null;
				if (here !== null) {
					next = here === '' ? name : `${here}/${name}`;
				}
				return walk(ref, `${rootPath}/${name}`, next);
			}),
		);
	};
	await walk(piece, pieceName, null);
	const rekeyed = new Map<number, ClipTransformValue[]>();
	for (const [key, values] of clip === null ? [] : readClipEndPose(clip).transforms) {
		const rootPath = rootPaths.get(key);
		// the Animator's own GameObject is placed by the bridge, and paths the prefab lacks move nothing drawn
		if (key !== 0 && rootPath !== undefined) {
			rekeyed.set(pathKey(rootPath), values);
		}
	}
	return rekeyed;
};

/**
 * reads a telescopic bridge prefab's settled looks. the game copies the Mono's platform GameObject (switched
 * off in the prefab) once per piece, places the copies end to end along the root's +z from the start port,
 * moves the end port past the last one and stretches the track under them; retracted, the copies are switched
 * off, the end port returns to the start port and the track is switched off
 *
 * @param resolver bundle reader
 * @param root the prefab's root GameObject
 * @param key tells this prefab's poses apart from other prefabs'
 * @param pieces how many platform pieces the bridge extends by
 * @returns the poses, or `null` when the root has no telescopic bridge MonoBehaviour
 * @throws {FormatError} if the MonoBehaviour's GameObjects aren't children of the root, or the piece's
 *   Animator lacks a single open idle clip
 */
export const readTelescopicPoses = async (
	resolver: AssetResolver,
	root: ObjectRef,
	key: string,
	pieces: number,
): Promise<TelescopicPoses | null> => {
	const mono = (await componentsOf(resolver, root, UnityClass.MonoBehaviour)).find(
		({ data }) => 'platformLength' in data && 'platformGameObject' in data,
	);
	if (mono === undefined) {
		return null;
	}
	const children = new Map(
		(await childrenOf(resolver, root)).map(({ ref, name }) => [objectKey(ref), name] as const),
	);
	const childNamed = async (field: string): Promise<{ ref: ObjectRef; name: string }> => {
		const ref = await resolver.resolve(mono.ref, pptrField(mono.data, field));
		const name = ref === null ? undefined : children.get(objectKey(ref));
		if (ref === null || name === undefined) {
			throw new FormatError(`telescopic bridge ${field} isn't a child of the prefab root`);
		}
		return { ref, name };
	};
	const [platform, startPort, endPort, track] = await Promise.all(
		['platformGameObject', 'startPort', 'endPort', 'horizontalTrack'].map(childNamed),
	);
	const length = numberField(mono.data, 'platformLength');
	const rail = await railPose(resolver, platform.ref, platform.name);
	return {
		retracted: {
			key: `${key}:retracted`,
			clips: [rootClip(new Map([[pathKey(endPort.name), [position([0, 0, 0])]]]))],
			active: new Map([
				[platform.name, false],
				[track.name, false],
			]),
		},
		extended: {
			key: `${key}:extended:${pieces}`,
			clips: [
				rootClip(
					new Map([
						[pathKey(endPort.name), [position([0, 0, pieces * length])]],
						[pathKey(track.name), [{ kind: 'scale', value: [1, 1, pieces] }]],
					]),
				),
			],
			active: new Map([
				[platform.name, false],
				[track.name, true],
			]),
		},
		pieces: Array.from({ length: pieces }, (_, i) => ({
			key: `${key}:piece:${i}`,
			clips: [
				rootClip(
					new Map([
						...rail,
						[
							pathKey(platform.name),
							[position([0, 0, i * length]), { kind: 'rotation', value: [0, 0, 0, 1] }],
						],
					]),
				),
			],
			active: new Map([
				[platform.name, true],
				[startPort.name, false],
				[endPort.name, false],
				[track.name, false],
			]),
		})),
	};
};

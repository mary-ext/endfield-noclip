/* oxlint-disable no-await-in-loop -- reads the root's components and children in authored order */
import { crc32 } from 'node:zlib';

import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { type ClipTransformValue, readClipEndPose } from '@endfield-noclip/formats/unity/animation-clip';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	arrayField,
	asPPtr,
	numberField,
	pptrField,
	stringField,
} from '@endfield-noclip/formats/unity/values';

import { type AssetResolver, type ObjectRef, objectKey } from '../assets/assets.ts';
import { type PrefabComponent, prefabChildren, readPrefabNode, walkPrefab } from '../prefabs/prefab-walk.ts';
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

/** the one open-idle clip of an Animator's controller */
const openIdleClip = async (
	resolver: AssetResolver,
	animator: PrefabComponent,
	where: string,
): Promise<TypeTreeObject> => {
	const controller = await resolver.resolve(animator.ref, pptrField(await animator.read(), 'm_Controller'));
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
	await walkPrefab<{ rootPath: string; below: string | null }>(
		resolver,
		piece,
		{
			enter: async (node, parent) => {
				let { rootPath, below } = parent;
				if (!node.isRoot) {
					rootPath = `${rootPath}/${node.name}`;
					if (below !== null) {
						below = below === '' ? node.name : `${below}/${node.name}`;
					}
				}
				const [animator] = below === null ? node.ofClass(UnityClass.Animator) : [];
				if (animator !== undefined) {
					clip = await openIdleClip(resolver, animator, rootPath);
					below = '';
				}
				if (below !== null) {
					rootPaths.set(pathKey(below), rootPath);
				}
				return { rootPath, below };
			},
		},
		{ rootPath: pieceName, below: null },
	);
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
 * reads a telescopic bridge prefab's settled looks ({@link TelescopicPoses}) from its root MonoBehaviour. the
 * game draws copies of the platform piece, never the piece itself, so each copy is a placement of its own
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
	const rootNode = await readPrefabNode(resolver, root);
	let mono: { ref: ObjectRef; data: TypeTreeObject } | undefined;
	for (const component of rootNode.ofClass(UnityClass.MonoBehaviour)) {
		const data = await component.read();
		if ('platformLength' in data && 'platformGameObject' in data) {
			mono = { ref: component.ref, data };
			break;
		}
	}
	if (mono === undefined) {
		return null;
	}
	const children = new Map<string, string>();
	for (const child of await prefabChildren(resolver, rootNode)) {
		children.set(objectKey(child), stringField(await resolver.read(child), 'm_Name'));
	}
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

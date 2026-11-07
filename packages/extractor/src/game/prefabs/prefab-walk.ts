/* oxlint-disable no-await-in-loop -- walks in authored order with bounded bundle residency */
import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { isTransformClass, UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { multiplyMatrices, trsMatrix } from '@endfield-noclip/formats/unity/transform';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	arrayField,
	asPPtr,
	booleanField,
	isObject,
	numberField,
	objectField,
	pptrField,
	stringField,
} from '@endfield-noclip/formats/unity/values';

import { objectKey, type AssetResolver, type ObjectRef } from '../assets/assets.ts';
import type { LocalTransform } from '../effects/particle-mesh.ts';

// the traversal every prefab reader shares: a GameObject's components, its Transform and its children, in
// authored order. readers supply what to do at each GameObject as a {@link PrefabVisitor}.

/** a component of a walked GameObject */
export interface PrefabComponent {
	ref: ObjectRef;
	/** its class, a {@link UnityClass} id */
	classId: number;
	/** @returns its fields, read on first use */
	read(): Promise<TypeTreeObject>;
}

/** a GameObject as the walk meets it, before it's placed */
export interface PrefabNode {
	go: ObjectRef;
	/** the GameObject's {@link objectKey} */
	key: string;
	name: string;
	/** `m_IsActive` as saved */
	active: boolean;
	/** whether it's the walk's root, whose own placement is the caller's */
	isRoot: boolean;
	/** the GameObject's fields */
	data: TypeTreeObject;
	/** the parent, already placed; `null` on the root */
	parent: PlacedPrefabNode | null;
	/** its components in authored order, without null PPtrs */
	components: readonly PrefabComponent[];
	/** its Transform, or RectTransform on a UI node */
	transform: PrefabComponent;
	/** the Transform's {@link objectKey} */
	transformKey: string;
	/** the Transform's local position, rotation (xyzw) and scale, as saved */
	saved: LocalTransform;
	/** @returns its components of one class, in authored order */
	ofClass(classId: number): PrefabComponent[];
	/** @returns its MonoBehaviours whose serialized fields pass `isType`, in authored order */
	behaviours(isType: (ref: ObjectRef) => boolean): PrefabComponent[];
}

/** a GameObject once its Transform is placed in prefab space */
export interface PlacedPrefabNode extends PrefabNode {
	/** the local transform the matrix composes; the identity on the root */
	local: LocalTransform;
	/** the parent's matrix; the identity on the root */
	parentMatrix: Float32Array;
	/** the Transform's matrix relative to the root, column-major; the identity on the root */
	matrix: Float32Array;
}

/** returned by {@link PrefabVisitor.enter} to leave a GameObject and its subtree out of the walk */
export const PRUNE: unique symbol = Symbol('prune');

/**
 * what a reader does at each GameObject of {@link walkPrefab}, parents before children. `State` is a
 * GameObject's own state, which its children's {@link enter} reads, such as their path below an Animator or
 * whether an ancestor is switched off; `Parent` is the part of it children read, which the start state has
 */
export interface PrefabVisitor<State extends Parent, Parent = State> {
	/**
	 * called first on each GameObject
	 *
	 * @param node the GameObject
	 * @param parent the parent's state, or the walk's start state on the root
	 * @returns its own state, or {@link PRUNE} to skip it and its subtree
	 */
	enter(node: PrefabNode, parent: Parent): State | typeof PRUNE | Promise<State | typeof PRUNE>;
	/**
	 * replaces the saved local transform the GameObject's matrix composes, as a pose does; not called on the
	 * root
	 *
	 * @param node the GameObject
	 * @param state its state
	 * @returns its local transform
	 */
	local?(node: PrefabNode, state: State): LocalTransform;
	/**
	 * called once the GameObject is placed, before its children are entered
	 *
	 * @param node the GameObject
	 * @param state its state
	 */
	visit?(node: PlacedPrefabNode, state: State): void | Promise<void>;
}

const xyz = (value: TypeTreeObject): [number, number, number] => [
	numberField(value, 'x'),
	numberField(value, 'y'),
	numberField(value, 'z'),
];

const identityLocal = (): LocalTransform => ({
	position: [0, 0, 0],
	rotation: [0, 0, 0, 1],
	scale: [1, 1, 1],
});

const readComponent = (resolver: AssetResolver, ref: ObjectRef): PrefabComponent => {
	let fields: Promise<TypeTreeObject> | undefined;
	return {
		ref,
		classId: ref.info.classId,
		read: () => (fields ??= resolver.read(ref)),
	};
};

const readNode = async (
	resolver: AssetResolver,
	go: ObjectRef,
	parent: PlacedPrefabNode | null,
): Promise<PrefabNode> => {
	const key = objectKey(go);
	const data = await resolver.read(go);
	const components: PrefabComponent[] = [];
	for (const item of arrayField(data, 'm_Component')) {
		if (!isObject(item)) {
			throw new FormatError('prefab component is not an object');
		}
		const ref = await resolver.resolve(go, pptrField(item, 'component'));
		if (ref !== null) {
			components.push(readComponent(resolver, ref));
		}
	}
	const transform = components.find((component) => isTransformClass(component.classId));
	if (transform === undefined) {
		throw new FormatError(`prefab GameObject ${key} has no Transform`);
	}
	const t = await transform.read();
	const rotation = objectField(t, 'm_LocalRotation');
	return {
		go,
		key,
		name: stringField(data, 'm_Name'),
		active: booleanField(data, 'm_IsActive'),
		isRoot: parent === null,
		data,
		parent,
		components,
		transform,
		transformKey: objectKey(transform.ref),
		saved: {
			position: xyz(objectField(t, 'm_LocalPosition')),
			rotation: [...xyz(rotation), numberField(rotation, 'w')],
			scale: xyz(objectField(t, 'm_LocalScale')),
		},
		ofClass: (classId) => components.filter((component) => component.classId === classId),
		behaviours: (isType) =>
			components.filter(
				(component) => component.classId === UnityClass.MonoBehaviour && isType(component.ref),
			),
	};
};

/**
 * @param resolver bundle reader
 * @param go a GameObject
 * @returns the GameObject with its components and Transform, as the root of a walk
 * @throws {FormatError} if it has no Transform or a malformed component list
 */
export const readPrefabNode = (resolver: AssetResolver, go: ObjectRef): Promise<PrefabNode> =>
	readNode(resolver, go, null);

/**
 * @param resolver bundle reader
 * @param node a GameObject
 * @returns its children's GameObjects in authored order, skipping null PPtrs
 */
export const prefabChildren = async (resolver: AssetResolver, node: PrefabNode): Promise<ObjectRef[]> => {
	const children: ObjectRef[] = [];
	for (const pointer of arrayField(await node.transform.read(), 'm_Children')) {
		const child = await resolver.resolve(node.transform.ref, asPPtr(pointer));
		if (child === null) {
			continue;
		}
		const childGo = await resolver.resolve(child, pptrField(await resolver.read(child), 'm_GameObject'));
		if (childGo !== null) {
			children.push(childGo);
		}
	}
	return children;
};

/**
 * walks a prefab's hierarchy depth first in authored order, so whatever a reader hands out in walk order is
 * deterministic. inactive GameObjects are walked too; a visitor that skips them prunes them in
 * {@link PrefabVisitor.enter}
 *
 * @param resolver bundle reader
 * @param root the GameObject to start from; its own placement is the caller's, so it sits at the identity
 * @param visitor what to do at each GameObject
 * @param start the state the root enters with, as its parent's
 * @throws {FormatError} on a cyclic hierarchy, a GameObject without a Transform or a malformed component
 *   list, and whatever the visitor throws
 */
export const walkPrefab = async <State extends Parent, Parent = State>(
	resolver: AssetResolver,
	root: ObjectRef,
	visitor: PrefabVisitor<State, Parent>,
	start: Parent,
): Promise<void> => {
	const seen = new Set<string>();
	const identity = trsMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
	const walk = async (go: ObjectRef, parent: PlacedPrefabNode | null, parentState: Parent): Promise<void> => {
		const key = objectKey(go);
		if (seen.has(key)) {
			throw new FormatError(`cyclic prefab hierarchy at ${key}`);
		}
		seen.add(key);
		const node = await readNode(resolver, go, parent);
		const state = await visitor.enter(node, parentState);
		if (state === PRUNE) {
			return;
		}
		let placed: PlacedPrefabNode;
		if (parent === null) {
			placed = { ...node, local: identityLocal(), parentMatrix: identity, matrix: identity };
		} else {
			const local = visitor.local?.(node, state) ?? node.saved;
			placed = {
				...node,
				local,
				parentMatrix: parent.matrix,
				matrix: multiplyMatrices(parent.matrix, trsMatrix(local.position, local.rotation, local.scale)),
			};
		}
		await visitor.visit?.(placed, state);
		for (const child of await prefabChildren(resolver, placed)) {
			await walk(child, placed, state);
		}
	};
	await walk(root, null, start);
};

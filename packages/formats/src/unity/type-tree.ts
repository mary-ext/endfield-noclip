/**
 * generic TypeTree-driven object reader: turns a serialized Unity object into plain JS values, using the
 * TypeTree embedded in its SerializedFile. no per-class code is needed, so Hypergryph's added fields come for
 * free.
 *
 * value mapping:
 *
 * - integers up to 32 bits, floats → `number`; 64-bit integers (including `m_PathID`) → `bigint`; `bool` →
 *   `boolean`; `string` → `string`
 * - `vector`/`staticvector`/`map`/`set` (a class wrapping a single `Array`) → the array itself; map entries are
 *   `{ first, second }` objects
 * - arrays of `UInt8` and `TypelessData` → `Uint8Array` views into the object bytes (no copy)
 * - arrays of other fixed-size numeric primitives → typed arrays (copied, so they're aligned)
 * - other classes → objects keyed by field name, in serialized order
 */

import { FormatError } from '../binary/binary-reader.ts';

import type { ObjectInfo, SerializedFile, SerializedType, TypeTreeNode } from './serialized-file.ts';

// #region types

/** a typed array produced by the numeric-array fast path */
export type TypeTreeTypedArray =
	| Uint8Array
	| Int8Array
	| Uint16Array
	| Int16Array
	| Uint32Array
	| Int32Array
	| Float32Array
	| Float64Array
	| BigInt64Array
	| BigUint64Array;

/** any value a TypeTree read can produce */
export type TypeTreeValue =
	| number
	| bigint
	| boolean
	| string
	| TypeTreeTypedArray
	| TypeTreeValue[]
	| TypeTreeObject;

/** a class instance: field name → value */
export interface TypeTreeObject {
	[field: string]: TypeTreeValue;
}

/** a TypeTree compiled into readers; build once per type with {@link compileTypeTree} */
export interface CompiledTypeTree {
	/** root type name, e.g. `Mesh` */
	type: string;
	/** top-level field names, in serialized order */
	fields: string[];
	/** @internal */
	readonly root: CompiledClass;
	/** @internal top-level field readers, in serialized order */
	readonly children: readonly CompiledNode[];
}

/** options for {@link readTypeTree} */
export interface ReadTypeTreeOptions {
	/** the file's byte order */
	littleEndian: boolean;
	/**
	 * resolves the payload type of a managed reference (`[SerializeReference]`), from the file's `refTypes`;
	 * objects containing non-null managed references fail to read without it
	 */
	resolveRefType?: RefTypeResolver;
}

/** @returns the compiled TypeTree of a managed reference's class, or `undefined` if unknown */
export type RefTypeResolver = (
	klassName: string,
	nameSpace: string,
	asmName: string,
) => CompiledTypeTree | undefined;

interface CompiledNode {
	type: string;
	name: string;
	read: (c: Cursor) => TypeTreeValue;
	skip: (c: Cursor) => void;
	/**
	 * reader for nodes whose layout depends on fields read before them; takes precedence over `read` when the
	 * node is a class member
	 */
	readInClass?: (c: Cursor, siblings: TypeTreeObject) => TypeTreeValue;
	/** byte size if every instance has the same size and no internal alignment, else -1 */
	fixedSize: number;
	/** whether the layout depends on data, so skipping requires reading */
	dynamic: boolean;
}

/** a compiled class node, whose reader always produces an object */
interface CompiledClass extends CompiledNode {
	read: (c: Cursor) => TypeTreeObject;
}

interface Cursor {
	bytes: Uint8Array;
	view: DataView;
	offset: number;
	littleEndian: boolean;
	resolveRefType: RefTypeResolver | undefined;
}

/**
 * fields that Hypergryph's serializer writes conditionally even though the TypeTree lists them
 * unconditionally: class type → field → predicate over the fields read before it.
 */
const HG_FIELD_CONDITIONS: Record<string, Record<string, (siblings: TypeTreeObject) => boolean>> = {
	// collision-only meshes carry cooked PhysX data instead (see AnimeStudio `Mesh.cs`)
	Mesh: { m_CompressedMesh: (siblings) => siblings.m_CollisionMeshBaked !== true },
};

/** a TypeTree node with its children, as built by {@link typeTreeHierarchy} */
export interface TreeNode {
	node: TypeTreeNode;
	children: TreeNode[];
}

// #endregion

// #region compilation

const ALIGN_FLAG = 0x4000;
const ARRAY_FLAG = 0x1;

/**
 * @param nodes a flattened TypeTree, as in `SerializedType.nodes`
 * @returns readers for the tree
 * @throws {FormatError} if the tree is empty or uses an unknown primitive
 */
export const compileTypeTree = (nodes: readonly TypeTreeNode[]): CompiledTypeTree => {
	if (nodes.length === 0) {
		throw new FormatError('empty TypeTree (was the file built without TypeTrees?)');
	}
	const root = buildTree(nodes);
	const children = root.children.map(compileNode);
	return {
		type: root.node.type,
		fields: children.map((child) => child.name),
		root: compileClass(root, children),
		children,
	};
};

/**
 * @param nodes a flattened, non-empty TypeTree, as in `SerializedType.nodes`
 * @returns the root node with its children nested, for walking a read value alongside its types
 * @throws {FormatError} if the tree is empty or a node's level skips one
 */
export const typeTreeHierarchy = (nodes: readonly TypeTreeNode[]): TreeNode => {
	if (nodes.length === 0) {
		throw new FormatError('empty TypeTree (was the file built without TypeTrees?)');
	}
	return buildTree(nodes);
};

const buildTree = (nodes: readonly TypeTreeNode[]): TreeNode => {
	const root: TreeNode = { node: nodes[0], children: [] };
	const stack: TreeNode[] = [root];
	for (let i = 1; i < nodes.length; i++) {
		const node = nodes[i];
		while (stack.length > 0 && (stack.at(-1)?.node.level ?? 0) >= node.level) {
			stack.pop();
		}
		const parent = stack.at(-1);
		if (parent === undefined || node.level !== parent.node.level + 1) {
			throw new FormatError(`TypeTree node ${i} (${node.name}) has level ${node.level} without a parent`);
		}
		const tree: TreeNode = { node, children: [] };
		parent.children.push(tree);
		stack.push(tree);
	}
	return root;
};

const compileNode = (tree: TreeNode): CompiledNode => {
	const { node } = tree;
	let inner: CompiledNode;
	if (isArrayNode(tree)) {
		inner = compileArray(tree);
	} else if (node.type === 'ReferencedObjectData') {
		inner = compileReferencedObjectData();
	} else if (tree.children.length === 0 && node.byteSize === 0 && !Object.hasOwn(PRIMITIVES, node.type)) {
		// a struct without serialized fields
		inner = compileClass(tree, []);
	} else if (tree.children.length === 0) {
		inner = compilePrimitive(node);
	} else {
		switch (node.type) {
			case 'string': {
				const [only] = tree.children;
				// a string can wrap another string (e.g. PropertyName's `string id`)
				inner =
					tree.children.length === 1 && only.node.type === 'string' && !isArrayNode(only)
						? compileNode(only)
						: compileString(tree);
				break;
			}
			case 'TypelessData': {
				inner = compileTypelessData();
				break;
			}
			default: {
				const [only] = tree.children;
				// containers (vector, staticvector, map, set, …) wrap a single Array node
				inner =
					tree.children.length === 1 && isArrayNode(only)
						? compileNode(only)
						: compileClass(tree, tree.children.map(compileNode));
			}
		}
	}
	return withAlignment(tree, inner);
};

const isArrayNode = (tree: TreeNode): boolean => {
	return (tree.node.typeFlags & ARRAY_FLAG) !== 0 || tree.node.type === 'Array';
};

/** applies 4-byte alignment after the node when it or its wrapped Array asks for it */
const withAlignment = (tree: TreeNode, inner: CompiledNode): CompiledNode => {
	const align =
		(tree.node.metaFlag & ALIGN_FLAG) !== 0 ||
		(tree.children.length === 1 &&
			isArrayNode(tree.children[0]) &&
			(tree.children[0].node.metaFlag & ALIGN_FLAG) !== 0);
	const base = { type: tree.node.type, name: tree.node.name };
	if (!align) {
		return { ...inner, ...base };
	}
	const { read, skip, readInClass } = inner;
	return {
		...base,
		read: (c) => {
			const value = read(c);
			alignCursor(c);
			return value;
		},
		skip: (c) => {
			skip(c);
			alignCursor(c);
		},
		readInClass:
			readInClass &&
			((c, siblings) => {
				const value = readInClass(c, siblings);
				alignCursor(c);
				return value;
			}),
		fixedSize: -1,
		dynamic: inner.dynamic,
	};
};

const alignCursor = (c: Cursor): void => {
	c.offset = (c.offset + 3) & ~3;
	if (c.offset > c.bytes.length) {
		throw new FormatError(`alignment ran past the end of the ${c.bytes.length}-byte object`);
	}
};

const compileClass = (tree: TreeNode, children: readonly CompiledNode[]): CompiledClass => {
	const names = children.map((child) => child.name);
	const readers = children.map((child) => child.read);
	const skippers = children.map((child) => child.skip);
	const conditionTable = Object.hasOwn(HG_FIELD_CONDITIONS, tree.node.type)
		? HG_FIELD_CONDITIONS[tree.node.type]
		: undefined;
	const conditions = names.map((name) =>
		conditionTable !== undefined && Object.hasOwn(conditionTable, name) ? conditionTable[name] : undefined,
	);
	const inClass = children.map((child) => child.readInClass);
	const count = children.length;
	const dynamic =
		children.some((child) => child.dynamic || child.readInClass !== undefined) ||
		conditions.some((condition) => condition !== undefined);
	const fixedSize =
		!dynamic && children.every((child) => child.fixedSize >= 0)
			? children.reduce((sum, child) => sum + child.fixedSize, 0)
			: -1;

	const read = (c: Cursor): TypeTreeObject => {
		const out: TypeTreeObject = {};
		for (let i = 0; i < count; i++) {
			const condition = conditions[i];
			if (condition !== undefined && !condition(out)) {
				continue;
			}
			try {
				const special = inClass[i];
				out[names[i]] = special === undefined ? readers[i](c) : special(c, out);
			} catch (error) {
				throw prefixError(error, names[i]);
			}
		}
		return out;
	};
	return {
		type: tree.node.type,
		name: tree.node.name,
		read,
		skip: (c) => {
			if (fixedSize >= 0) {
				advance(c, fixedSize);
			} else if (dynamic) {
				read(c);
			} else {
				for (let i = 0; i < count; i++) {
					skippers[i](c);
				}
			}
		},
		fixedSize,
		dynamic,
	};
};

/** prepends a path segment (`name` or `[index]`) to a FormatError's `at <path>: ` prefix */
const prefixError = (error: unknown, segment: string): unknown => {
	if (!(error instanceof FormatError)) {
		return error;
	}
	const match = error.message.match(/^at (\S+): (.*)$/s);
	if (match === null) {
		return new FormatError(`at ${segment}: ${error.message}`);
	}
	const [, path, rest] = match;
	return new FormatError(`at ${segment}${path.startsWith('[') ? '' : '.'}${path}: ${rest}`);
};

const advance = (c: Cursor, size: number): number => {
	const at = c.offset;
	if (size < 0 || at + size > c.bytes.length) {
		throw new FormatError(
			`read of ${size} bytes at 0x${at.toString(16)} exceeds the ${c.bytes.length}-byte object`,
		);
	}
	c.offset = at + size;
	return at;
};

const readCount = (c: Cursor): number => {
	const count = c.view.getInt32(advance(c, 4), c.littleEndian);
	if (count < 0 || count > c.bytes.length - c.offset) {
		// every element takes at least one byte, except empty classes, which Unity doesn't emit in arrays
		throw new FormatError(`implausible array length ${count} at 0x${(c.offset - 4).toString(16)}`);
	}
	return count;
};

// #endregion

// #region primitives

interface Primitive {
	size: number;
	read: (c: Cursor, at: number) => number | bigint | boolean;
	array?: (c: Cursor, at: number, count: number) => TypeTreeTypedArray;
}

const hostLittleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** copies `count` elements into a fresh aligned typed array, swapping bytes if the file's order differs */
const typedCopy = <T extends TypeTreeTypedArray>(make: (buffer: ArrayBuffer) => T, size: number) => {
	return (c: Cursor, at: number, count: number): T => {
		const copy = c.bytes.slice(at, at + count * size);
		if (c.littleEndian !== hostLittleEndian) {
			for (let i = 0; i < copy.length; i += size) {
				copy.subarray(i, i + size).reverse();
			}
		}
		return make(copy.buffer);
	};
};

const PRIMITIVES: Record<string, Primitive> = (() => {
	const u8: Primitive = {
		size: 1,
		read: (c, at) => c.view.getUint8(at),
		array: (c, at, count) => c.bytes.subarray(at, at + count),
	};
	const i8: Primitive = {
		size: 1,
		read: (c, at) => c.view.getInt8(at),
		array: (c, at, count) => new Int8Array(c.bytes.buffer, c.bytes.byteOffset + at, count),
	};
	const u16: Primitive = {
		size: 2,
		read: (c, at) => c.view.getUint16(at, c.littleEndian),
		array: typedCopy((b) => new Uint16Array(b), 2),
	};
	const i16: Primitive = {
		size: 2,
		read: (c, at) => c.view.getInt16(at, c.littleEndian),
		array: typedCopy((b) => new Int16Array(b), 2),
	};
	const u32: Primitive = {
		size: 4,
		read: (c, at) => c.view.getUint32(at, c.littleEndian),
		array: typedCopy((b) => new Uint32Array(b), 4),
	};
	const i32: Primitive = {
		size: 4,
		read: (c, at) => c.view.getInt32(at, c.littleEndian),
		array: typedCopy((b) => new Int32Array(b), 4),
	};
	const u64: Primitive = {
		size: 8,
		read: (c, at) => c.view.getBigUint64(at, c.littleEndian),
		array: typedCopy((b) => new BigUint64Array(b), 8),
	};
	const i64: Primitive = {
		size: 8,
		read: (c, at) => c.view.getBigInt64(at, c.littleEndian),
		array: typedCopy((b) => new BigInt64Array(b), 8),
	};
	const f32: Primitive = {
		size: 4,
		read: (c, at) => c.view.getFloat32(at, c.littleEndian),
		array: typedCopy((b) => new Float32Array(b), 4),
	};
	const f64: Primitive = {
		size: 8,
		read: (c, at) => c.view.getFloat64(at, c.littleEndian),
		array: typedCopy((b) => new Float64Array(b), 8),
	};
	const bool: Primitive = { size: 1, read: (c, at) => c.view.getUint8(at) !== 0 };
	return {
		SInt8: i8,
		UInt8: u8,
		char: u8,
		short: i16,
		SInt16: i16,
		UInt16: u16,
		'unsigned short': u16,
		int: i32,
		SInt32: i32,
		UInt32: u32,
		'unsigned int': u32,
		'Type*': u32,
		'long long': i64,
		SInt64: i64,
		UInt64: u64,
		'unsigned long long': u64,
		FileSize: u64,
		float: f32,
		double: f64,
		bool,
	};
})();

const primitiveOf = (node: TypeTreeNode): Primitive => {
	const primitive = Object.hasOwn(PRIMITIVES, node.type) ? PRIMITIVES[node.type] : undefined;
	if (primitive === undefined) {
		throw new FormatError(`unknown TypeTree primitive ${node.type} (${node.name})`);
	}
	if (node.byteSize !== primitive.size && node.byteSize !== -1) {
		throw new FormatError(
			`primitive ${node.type} ${node.name} is ${node.byteSize} bytes, expected ${primitive.size}`,
		);
	}
	return primitive;
};

const compilePrimitive = (node: TypeTreeNode): CompiledNode => {
	const { size, read } = primitiveOf(node);
	return {
		type: node.type,
		name: node.name,
		read: (c) => read(c, advance(c, size)),
		skip: (c) => {
			advance(c, size);
		},
		fixedSize: size,
		dynamic: false,
	};
};

// #endregion

// #region strings, blobs and arrays

const utf8 = new TextDecoder('utf-8');

const compileString = (tree: TreeNode): CompiledNode => {
	return {
		type: tree.node.type,
		name: tree.node.name,
		read: (c) => {
			const length = readCount(c);
			const at = advance(c, length);
			return utf8.decode(c.bytes.subarray(at, at + length));
		},
		skip: (c) => {
			advance(c, readCount(c));
		},
		fixedSize: -1,
		dynamic: false,
	};
};

const compileTypelessData = (): CompiledNode => {
	return {
		type: 'TypelessData',
		name: '',
		read: (c) => {
			const length = readCount(c);
			const at = advance(c, length);
			return c.bytes.subarray(at, at + length);
		},
		skip: (c) => {
			advance(c, readCount(c));
		},
		fixedSize: -1,
		dynamic: false,
	};
};

const orphanReferencedObjectData = (): never => {
	throw new FormatError('ReferencedObjectData outside a ReferencedObject');
};

/**
 * a managed reference's payload: its layout is the ref type named by the sibling `type`
 * (`ReferencedManagedType { class, ns, asm }`); an empty class name is a null reference with no payload
 */
const compileReferencedObjectData = (): CompiledNode => {
	return {
		type: 'ReferencedObjectData',
		name: 'data',
		read: orphanReferencedObjectData,
		skip: orphanReferencedObjectData,
		readInClass: (c, siblings) => {
			const { type } = siblings;
			if (typeof type !== 'object' || Array.isArray(type) || ArrayBuffer.isView(type)) {
				throw new FormatError('ReferencedObjectData without a preceding ReferencedManagedType');
			}
			const { class: klass, ns, asm } = type;
			if (typeof klass !== 'string' || typeof ns !== 'string' || typeof asm !== 'string') {
				throw new FormatError('malformed ReferencedManagedType');
			}
			if (klass === '') {
				return {};
			}
			const tree = c.resolveRefType?.(klass, ns, asm);
			if (tree === undefined) {
				throw new FormatError(`unknown managed reference type ${ns}.${klass} (${asm})`);
			}
			return tree.root.read(c);
		},
		fixedSize: -1,
		dynamic: true,
	};
};

const compileArray = (tree: TreeNode): CompiledNode => {
	const element = tree.children[1];
	if (tree.children.length !== 2 || element === undefined) {
		throw new FormatError(`Array node ${tree.node.name} has ${tree.children.length} children, expected 2`);
	}
	const base = { type: tree.node.type, name: tree.node.name, fixedSize: -1, dynamic: false };

	// numeric fast path
	if (element.children.length === 0 && (element.node.metaFlag & ALIGN_FLAG) === 0) {
		const primitive = primitiveOf(element.node);
		const { size, read: readOne, array } = primitive;
		const skip = (c: Cursor): void => {
			const count = readCount(c);
			advance(c, count * size);
		};
		if (array !== undefined) {
			return {
				...base,
				read: (c) => {
					const count = readCount(c);
					return array(c, advance(c, count * size), count);
				},
				skip,
			};
		}
		return {
			...base,
			read: (c) => {
				const count = readCount(c);
				const at = advance(c, count * size);
				const out: TypeTreeValue[] = Array.from({ length: count });
				for (let i = 0; i < count; i++) {
					out[i] = readOne(c, at + i * size);
				}
				return out;
			},
			skip,
		};
	}

	const { read, skip, fixedSize, dynamic } = compileNode(element);
	return {
		...base,
		dynamic,
		read: (c) => {
			const count = readCount(c);
			const out: TypeTreeValue[] = Array.from({ length: count });
			for (let i = 0; i < count; i++) {
				try {
					out[i] = read(c);
				} catch (error) {
					throw prefixError(error, `[${i}]`);
				}
			}
			return out;
		},
		skip: (c) => {
			const count = readCount(c);
			if (fixedSize >= 0) {
				advance(c, count * fixedSize);
				return;
			}
			for (let i = 0; i < count; i++) {
				skip(c);
			}
		},
	};
};

// #endregion

// #region reading

const cursor = (bytes: Uint8Array, options: ReadTypeTreeOptions): Cursor => {
	return {
		bytes,
		view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
		offset: 0,
		littleEndian: options.littleEndian,
		resolveRefType: options.resolveRefType,
	};
};

/**
 * reads a whole object
 *
 * @param tree compiled TypeTree of the object's type
 * @param bytes exactly the object's bytes; `Uint8Array` results are views into it
 * @param options byte order and managed-reference resolution
 * @returns the object's fields
 * @throws {FormatError} if the data doesn't match the tree, including when bytes are left over
 */
export const readTypeTree = (
	tree: CompiledTypeTree,
	bytes: Uint8Array,
	options: ReadTypeTreeOptions,
): TypeTreeObject => {
	const c = cursor(bytes, options);
	const value = tree.root.read(c);
	if (c.offset !== bytes.length) {
		throw new FormatError(`${tree.type} read ${c.offset} of ${bytes.length} bytes`);
	}
	return value;
};

/**
 * reads one top-level field, skipping (without materializing, where the layout allows) the fields before it
 *
 * @param tree compiled TypeTree of the object's type
 * @param bytes the object's bytes
 * @param options byte order and managed-reference resolution
 * @param field top-level field name
 * @returns the field's value, or `undefined` if the type has no such field or the object omits it
 * @throws {FormatError} if the data doesn't match the tree
 */
export const readTypeTreeField = (
	tree: CompiledTypeTree,
	bytes: Uint8Array,
	options: ReadTypeTreeOptions,
	field: string,
): TypeTreeValue | undefined => {
	const index = tree.fields.indexOf(field);
	if (index < 0) {
		return undefined;
	}
	const c = cursor(bytes, options);
	const fields = tree.children;
	for (let i = 0; i < index; i++) {
		if (fields[i].dynamic || fields[i].readInClass !== undefined || tree.root.dynamic) {
			// conditional or data-dependent layouts need the preceding values, so read the whole object
			c.offset = 0;
			return tree.root.read(c)[field];
		}
		fields[i].skip(c);
	}
	return fields[index].read(c);
};

// #endregion

// #region SerializedFile integration

const compiledTypes = new WeakMap<SerializedType, CompiledTypeTree>();

/**
 * @param type a type entry; its compiled tree is cached
 * @returns the compiled TypeTree
 */
export const compiledTypeOf = (type: SerializedType): CompiledTypeTree => {
	let compiled = compiledTypes.get(type);
	if (compiled === undefined) {
		compiled = compileTypeTree(type.nodes);
		compiledTypes.set(type, compiled);
	}
	return compiled;
};

const resolvers = new WeakMap<SerializedFile, RefTypeResolver>();

/**
 * ref type trees end with the host's `ManagedReferencesRegistry`, but a payload doesn't repeat it (nested
 * references go into the host's registry), so it's dropped before compiling
 */
const withoutRegistry = (nodes: readonly TypeTreeNode[]): TypeTreeNode[] => {
	const out: TypeTreeNode[] = [];
	let skipBelow = -1;
	for (const node of nodes) {
		if (skipBelow >= 0 && node.level > skipBelow) {
			continue;
		}
		skipBelow = -1;
		if (node.level === 1 && node.type === 'ManagedReferencesRegistry') {
			skipBelow = node.level;
			continue;
		}
		out.push(node);
	}
	return out;
};

/**
 * @param file parsed metadata
 * @returns the read options for objects in `file`, resolving managed references against its `refTypes`
 */
export const readOptionsOf = (file: SerializedFile): ReadTypeTreeOptions => {
	let resolveRefType = resolvers.get(file);
	if (resolveRefType === undefined) {
		const byName = new Map<string, SerializedType>();
		for (const type of file.refTypes) {
			byName.set(`${type.asmName}\0${type.nameSpace}\0${type.klassName}`, type);
		}
		const compiled = new Map<SerializedType, CompiledTypeTree>();
		resolveRefType = (klassName, nameSpace, asmName) => {
			const type = byName.get(`${asmName}\0${nameSpace}\0${klassName}`);
			if (type === undefined) {
				return undefined;
			}
			let tree = compiled.get(type);
			if (tree === undefined) {
				tree = compileTypeTree(withoutRegistry(type.nodes));
				compiled.set(type, tree);
			}
			return tree;
		};
		resolvers.set(file, resolveRefType);
	}
	return { littleEndian: file.header.littleEndian, resolveRefType };
};

/**
 * @param fileBytes the whole SerializedFile, or at least through the object's end
 * @param info object table entry
 * @returns a view of the object's bytes
 */
export const objectBytes = (fileBytes: Uint8Array, info: ObjectInfo): Uint8Array => {
	if (info.byteStart + info.byteSize > fileBytes.length) {
		throw new FormatError(`object ${info.pathId} lies past the ${fileBytes.length} bytes available`);
	}
	return fileBytes.subarray(info.byteStart, info.byteStart + info.byteSize);
};

/**
 * @param file parsed metadata
 * @param info object table entry
 * @param bytes exactly the object's bytes (see {@link objectBytes})
 * @returns the object's fields
 * @throws {FormatError} if the object doesn't match its TypeTree
 */
export const readObject = (file: SerializedFile, info: ObjectInfo, bytes: Uint8Array): TypeTreeObject => {
	return readTypeTree(compiledTypeOf(info.type), bytes, readOptionsOf(file));
};

/**
 * reads an object's `m_Name` without materializing the fields before it
 *
 * @param file parsed metadata
 * @param info object table entry
 * @param bytes exactly the object's bytes
 * @returns the name, or `undefined` if the type has no top-level `m_Name`
 */
export const peekObjectName = (
	file: SerializedFile,
	info: ObjectInfo,
	bytes: Uint8Array,
): string | undefined => {
	const value = readTypeTreeField(compiledTypeOf(info.type), bytes, readOptionsOf(file), 'm_Name');
	return typeof value === 'string' ? value : undefined;
};

// #endregion

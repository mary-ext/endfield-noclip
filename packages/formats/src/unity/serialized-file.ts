/**
 * Unity SerializedFile ("assets file") metadata reader, for format versions 17–22 with or without embedded
 * TypeTrees. Endfield ships version 22 from Unity 2021.3.34f5 with TypeTrees enabled.
 *
 * layout follows AssetStudio/AnimeStudio's `SerializedFile.cs` (MIT, © Radu, Perfare, Razmoth and
 * contributors).
 */

import { BinaryReader, FormatError } from '../binary/binary-reader.ts';

// #region types

/** the fixed header, which is always big-endian */
export interface SerializedFileHeader {
	version: number;
	metadataSize: number;
	fileSize: number;
	/** absolute offset of object data */
	dataOffset: number;
	littleEndian: boolean;
}

/** one node of a flattened TypeTree, in depth-first order */
export interface TypeTreeNode {
	type: string;
	name: string;
	/** depth; the root is level 0 */
	level: number;
	/** fixed byte size, or -1 for variable-size nodes */
	byteSize: number;
	/** bit 0 marks an `Array` node, bit 1 a managed reference */
	typeFlags: number;
	/** bit 0x4000 means "align to 4 bytes after reading this node" */
	metaFlag: number;
	version: number;
	index: number;
	refTypeHash: bigint;
}

/** a type entry: a class (or script/reference type) and, when enabled, its TypeTree */
export interface SerializedType {
	/** Unity class id, e.g. 1 GameObject, 43 Mesh, 114 MonoBehaviour */
	classId: number;
	isStripped: boolean;
	/** index into {@link SerializedFile.scriptTypes}, or -1 */
	scriptTypeIndex: number;
	/** 16-byte script hash for MonoBehaviours and reference types */
	scriptId: Uint8Array | undefined;
	oldTypeHash: Uint8Array;
	/** flattened TypeTree, or empty if the file has TypeTrees disabled */
	nodes: TypeTreeNode[];
	/** reference types only */
	klassName: string | undefined;
	nameSpace: string | undefined;
	asmName: string | undefined;
	/** non-reference types only (v21+) */
	typeDependencies: number[];
}

/** an object table entry */
export interface ObjectInfo {
	pathId: bigint;
	/** absolute offset in the file */
	byteStart: number;
	byteSize: number;
	classId: number;
	type: SerializedType;
}

/** a script type reference (MonoScript), in the same form as a PPtr */
export interface ScriptTypeRef {
	fileIndex: number;
	pathId: bigint;
}

/** an external file this one references; PPtr `m_FileID` n refers to `externals[n - 1]` */
export interface FileIdentifier {
	guid: Uint8Array;
	type: number;
	/** e.g. `archive:/CAB-<hex>/CAB-<hex>` or `library/unity default resources` */
	pathName: string;
}

/** parsed SerializedFile metadata; object bodies are read separately */
export interface SerializedFile {
	header: SerializedFileHeader;
	unityVersion: string;
	targetPlatform: number;
	enableTypeTree: boolean;
	types: SerializedType[];
	objects: ObjectInfo[];
	objectsByPathId: Map<bigint, ObjectInfo>;
	scriptTypes: ScriptTypeRef[];
	externals: FileIdentifier[];
	refTypes: SerializedType[];
	userInformation: string;
}

// #endregion

// #region header and metadata

/** bytes needed by {@link parseSerializedFileHeader} */
export const SERIALIZED_FILE_HEADER_SIZE = 48;

/** Unity class ids of the object types this project reads */
export const UnityClass = {
	GameObject: 1,
	Transform: 4,
	Material: 21,
	MeshRenderer: 23,
	SkinnedMeshRenderer: 137,
	Texture2D: 28,
	MeshFilter: 33,
	Mesh: 43,
	Shader: 48,
	Cubemap: 89,
	MonoBehaviour: 114,
	Texture3D: 117,
	AssetBundle: 142,
	Texture2DArray: 187,
	CubemapArray: 188,
} as const;

/**
 * @param prefix at least the first {@link SERIALIZED_FILE_HEADER_SIZE} bytes
 * @returns the header
 * @throws {FormatError} if the version is unsupported or the fields are implausible
 */
export const parseSerializedFileHeader = (prefix: Uint8Array): SerializedFileHeader => {
	const r = new BinaryReader(prefix, { littleEndian: false });
	let metadataSize = r.u32();
	let fileSize = r.u32();
	const version = r.u32();
	let dataOffset = r.u32();
	if (version < 17 || version > 22) {
		throw new FormatError(`unsupported SerializedFile version ${version}`);
	}
	const endianness = r.u8();
	r.skip(3);
	if (version >= 22) {
		metadataSize = r.u32();
		fileSize = r.i64Number();
		dataOffset = r.i64Number();
		r.skip(8);
	}
	if (endianness > 1 || dataOffset > fileSize || metadataSize > fileSize) {
		throw new FormatError('implausible SerializedFile header');
	}
	return { version, metadataSize, fileSize, dataOffset, littleEndian: endianness === 0 };
};

/**
 * @param header parsed header
 * @returns how many leading bytes {@link parseSerializedFile} needs
 */
export const serializedFileMetadataEnd = (header: SerializedFileHeader): number => {
	return (header.version >= 22 ? SERIALIZED_FILE_HEADER_SIZE : 20) + header.metadataSize;
};

/**
 * parses the header and metadata. object data isn't needed: `bytes` may be just the first
 * {@link serializedFileMetadataEnd} bytes.
 *
 * @param bytes the file, or a prefix covering its metadata
 * @returns the parsed metadata
 * @throws {FormatError} on malformed metadata
 */
export const parseSerializedFile = (bytes: Uint8Array): SerializedFile => {
	const header = parseSerializedFileHeader(bytes);
	const { version } = header;
	const r = new BinaryReader(bytes, {
		offset: version >= 22 ? SERIALIZED_FILE_HEADER_SIZE : 20,
		littleEndian: header.littleEndian,
	});

	const unityVersion = r.cString();
	const targetPlatform = r.i32();
	const enableTypeTree = r.bool();

	const typeCount = r.i32();
	checkCount(typeCount, r, 23, 'type');
	const types: SerializedType[] = [];
	for (let i = 0; i < typeCount; i++) {
		types.push(readSerializedType(r, { version, enableTypeTree, isRefType: false }));
	}

	const objectCount = r.i32();
	checkCount(objectCount, r, 20, 'object');
	const objects: ObjectInfo[] = [];
	const objectsByPathId = new Map<bigint, ObjectInfo>();
	for (let i = 0; i < objectCount; i++) {
		r.align(4);
		const pathId = r.i64();
		const byteStart = (version >= 22 ? r.i64Number() : r.u32()) + header.dataOffset;
		const byteSize = r.u32();
		const typeIndex = r.i32();
		const type = types[typeIndex];
		if (type === undefined) {
			throw new FormatError(`object ${pathId} has type index ${typeIndex} of ${types.length}`);
		}
		const info: ObjectInfo = { pathId, byteStart, byteSize, classId: type.classId, type };
		objects.push(info);
		objectsByPathId.set(pathId, info);
	}

	const scriptCount = r.i32();
	checkCount(scriptCount, r, 12, 'script type');
	const scriptTypes: ScriptTypeRef[] = [];
	for (let i = 0; i < scriptCount; i++) {
		const fileIndex = r.i32();
		r.align(4);
		scriptTypes.push({ fileIndex, pathId: r.i64() });
	}

	const externalCount = r.i32();
	checkCount(externalCount, r, 22, 'external');
	const externals: FileIdentifier[] = [];
	for (let i = 0; i < externalCount; i++) {
		r.cString();
		const guid = r.bytesView(16).slice();
		const type = r.i32();
		externals.push({ guid, type, pathName: r.cString() });
	}

	const refTypes: SerializedType[] = [];
	if (version >= 20) {
		const refTypeCount = r.i32();
		checkCount(refTypeCount, r, 23, 'reference type');
		for (let i = 0; i < refTypeCount; i++) {
			refTypes.push(readSerializedType(r, { version, enableTypeTree, isRefType: true }));
		}
	}

	const userInformation = r.cString();

	return {
		header,
		unityVersion,
		targetPlatform,
		enableTypeTree,
		types,
		objects,
		objectsByPathId,
		scriptTypes,
		externals,
		refTypes,
		userInformation,
	};
};

const checkCount = (count: number, r: BinaryReader, minSize: number, what: string): void => {
	if (count < 0 || count * minSize > r.remaining) {
		throw new FormatError(`implausible ${what} count ${count} at 0x${r.offset.toString(16)}`);
	}
};

/** what a type entry's layout depends on */
interface SerializedTypeLayout {
	version: number;
	enableTypeTree: boolean;
	/** whether the entry is in the reference-type table rather than the type table */
	isRefType: boolean;
}

const readSerializedType = (r: BinaryReader, layout: SerializedTypeLayout): SerializedType => {
	const { version, enableTypeTree, isRefType } = layout;
	const classId = r.i32();
	const isStripped = r.bool();
	const scriptTypeIndex = r.i16();
	let scriptId: Uint8Array | undefined;
	if ((isRefType && scriptTypeIndex >= 0) || classId === 114) {
		scriptId = r.bytesView(16).slice();
	}
	const oldTypeHash = r.bytesView(16).slice();

	let nodes: TypeTreeNode[] = [];
	let klassName: string | undefined;
	let nameSpace: string | undefined;
	let asmName: string | undefined;
	let typeDependencies: number[] = [];
	if (enableTypeTree) {
		nodes = readTypeTreeBlob(r, version);
		if (version >= 21) {
			if (isRefType) {
				klassName = r.cString();
				nameSpace = r.cString();
				asmName = r.cString();
			} else {
				const count = r.i32();
				checkCount(count, r, 4, 'type dependency');
				typeDependencies = Array.from({ length: count }, () => r.i32());
			}
		}
	}

	return {
		classId,
		isStripped,
		scriptTypeIndex,
		scriptId,
		oldTypeHash,
		nodes,
		klassName,
		nameSpace,
		asmName,
		typeDependencies,
	};
};

const readTypeTreeBlob = (r: BinaryReader, version: number): TypeTreeNode[] => {
	const nodeCount = r.i32();
	const stringBufferSize = r.i32();
	const nodeSize = version >= 19 ? 32 : 24;
	checkCount(nodeCount, r, nodeSize, 'TypeTree node');

	const raw: { typeOffset: number; nameOffset: number; node: TypeTreeNode }[] = [];
	for (let i = 0; i < nodeCount; i++) {
		const nodeVersion = r.u16();
		const level = r.u8();
		const typeFlags = r.u8();
		const typeOffset = r.u32();
		const nameOffset = r.u32();
		const byteSize = r.i32();
		const index = r.i32();
		const metaFlag = r.i32();
		const refTypeHash = version >= 19 ? r.u64() : 0n;
		raw.push({
			typeOffset,
			nameOffset,
			node: {
				type: '',
				name: '',
				level,
				byteSize,
				typeFlags,
				metaFlag,
				version: nodeVersion,
				index,
				refTypeHash,
			},
		});
	}
	const strings = r.bytesView(stringBufferSize);
	const local = new Map<number, string>();
	const lookup = (offset: number): string => {
		if (offset & 0x80000000) {
			const common = offset & 0x7fffffff;
			return COMMON_STRINGS.get(common) ?? `<common ${common}>`;
		}
		let value = local.get(offset);
		if (value === undefined) {
			const end = strings.indexOf(0, offset);
			if (end < 0) {
				throw new FormatError(`TypeTree string at ${offset} is unterminated`);
			}
			value = latin1.decode(strings.subarray(offset, end));
			local.set(offset, value);
		}
		return value;
	};
	return raw.map(({ typeOffset, nameOffset, node }) => {
		node.type = lookup(typeOffset);
		node.name = lookup(nameOffset);
		return node;
	});
};

const latin1 = new TextDecoder('latin1');

// #endregion

// #region object lookup

/**
 * @param file parsed metadata
 * @param pathId object path id
 * @returns the object's table entry
 * @throws {FormatError} if the file has no such object
 */
export const getObjectInfo = (file: SerializedFile, pathId: bigint): ObjectInfo => {
	const info = file.objectsByPathId.get(pathId);
	if (info === undefined) {
		throw new FormatError(`no object with path id ${pathId}`);
	}
	return info;
};

/**
 * @param type a type entry
 * @returns the class name from its TypeTree root (e.g. `Mesh`), or `undefined` without TypeTrees
 */
export const typeName = (type: SerializedType): string | undefined => {
	return type.nodes[0]?.type;
};

// #endregion

// #region common strings

/**
 * Unity's built-in TypeTree string buffer; offsets with the high bit set index into it. the buffer is the
 * NUL-joined concatenation below (as of 2021.3; `+` stands for a space inside an entry), plus two later
 * additions at non-contiguous offsets.
 */
const COMMON_STRINGS: ReadonlyMap<number, string> = (() => {
	const joined = [
		'AABB AnimationClip AnimationCurve AnimationState Array Base BitField bitset bool char ColorRGBA',
		'Component data deque double dynamic_array FastPropertyName first float Font GameObject Generic+Mono',
		'GradientNEW GUID GUIStyle int list long+long map Matrix4x4f MdFour MonoBehaviour MonoScript m_ByteSize',
		'm_Curve m_EditorClassIdentifier m_EditorHideFlags m_Enabled m_ExtensionPtr m_GameObject m_Index',
		'm_IsArray m_IsStatic m_MetaFlag m_Name m_ObjectHideFlags m_PrefabInternal m_PrefabParentObject',
		'm_Script m_StaticEditorFlags m_Type m_Version Object pair PPtr<Component> PPtr<GameObject>',
		'PPtr<Material> PPtr<MonoBehaviour> PPtr<MonoScript> PPtr<Object> PPtr<Prefab> PPtr<Sprite>',
		'PPtr<TextAsset> PPtr<Texture> PPtr<Texture2D> PPtr<Transform> Prefab Quaternionf Rectf RectInt',
		'RectOffset second set short size SInt16 SInt32 SInt64 SInt8 staticvector string TextAsset TextMesh',
		'Texture Texture2D Transform TypelessData UInt16 UInt32 UInt64 UInt8 unsigned+int unsigned+long+long',
		'unsigned+short vector Vector2f Vector3f Vector4f m_ScriptingClassIdentifier Gradient Type*',
		'int2_storage int3_storage BoundsInt m_CorrespondingSourceObject m_PrefabInstance m_PrefabAsset',
		'FileSize Hash128',
	].join(' ');
	const map = new Map<number, string>();
	let offset = 0;
	for (const word of joined.split(' ')) {
		const value = word.replaceAll('+', ' ');
		map.set(offset, value);
		offset += value.length + 1;
	}
	map.set(1188, 'fixed_array');
	map.set(1200, 'EntityId');
	return map;
})();

// #endregion

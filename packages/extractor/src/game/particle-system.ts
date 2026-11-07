import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { type DecodedMesh, MeshTopology } from '@endfield-noclip/formats/unity/mesh';
import { inverseAffine } from '@endfield-noclip/formats/unity/transform';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	arrayField,
	asPPtr,
	booleanField,
	isObject,
	numberField,
	objectField,
	optionalNumberField,
	type Aabb,
	type PPtr,
	pptrField,
	vector3Field,
} from '@endfield-noclip/formats/unity/values';
import {
	type AnimationCurve,
	type CurveKey,
	CurveWrapMode,
	type Gradient,
} from '@endfield-noclip/package-format/curves';
import {
	CurveMode,
	GradientMode,
	GRAVITY,
	type MinMaxCurveInfo,
	type MinMaxGradientInfo,
	ParticleAlignment,
	type ParticleBurstInfo,
	type ParticleClampInfo,
	type ParticleCustom,
	type ParticleDragInfo,
	type ParticleForceFieldInfo,
	ParticleMeshPlacement,
	ParticleMeshSpawn,
	type ParticleSpeedLimitInfo,
	ParticleRenderMode,
	type ParticleRingBufferInfo,
	type ParticleShapeInfo,
	ParticleShapeKind,
	type ParticleShapeMeshInfo,
	type ParticleSystemInfo,
	type ParticleTextureSheetInfo,
	type ParticleVelocityInfo,
	SheetRow,
} from '@endfield-noclip/package-format/particles';

/** the renderer's meshes and their weights */
const MESH_FIELDS = ['m_Mesh', 'm_Mesh1', 'm_Mesh2', 'm_Mesh3'] as const;
const MESH_WEIGHT_FIELDS = [
	'm_MeshWeighting',
	'm_MeshWeighting1',
	'm_MeshWeighting2',
	'm_MeshWeighting3',
] as const;

/** `ParticleSystemRenderer.m_MeshDistribution` that picks meshes by their weights rather than evenly */
const MESH_DISTRIBUTION_WEIGHTED = 1;

/** `ParticleSystemRenderer.m_RenderAlignment` of Unity's `Facing`, which the viewer orients like `View` */
const ALIGNMENT_FACING = 3;

/** `ParticleSystem.scalingMode` values */
export const ScalingMode = {
	/** the whole hierarchy's scale sizes and moves particles */
	Hierarchy: 0,
	/** the system's own scale alone sizes and moves them, ignoring its parents' */
	Local: 1,
	/** the scale moves particles but leaves their size */
	Shape: 2,
} as const;

/** shapes the viewer emits from, by `ShapeModule.type` */
const SHAPES = new Set<number>(Object.values(ParticleShapeKind));
const isShapeKind = (kind: number): kind is ParticleShapeKind => SHAPES.has(kind);

/** `ExternalForcesModule.influenceFilter` values */
export const InfluenceFilter = {
	/** the fields whose layer is in `influenceMask` */
	LayerMask: 0,
	/** the fields in `influenceList` */
	List: 1,
	/** both */
	LayerMaskAndList: 2,
} as const;

/** a system's External Forces module, its fields still unresolved */
export interface ExternalForcesRead {
	multiplier: MinMaxCurveInfo;
	filter: number;
	/** layer bits, for {@link InfluenceFilter.LayerMask} */
	mask: number;
	list: PPtr[];
}

/** what {@link readParticleSystem} found */
export type ParticleSystemRead =
	| {
			/** the system, drawing the first of its meshes */
			info: ParticleSystemInfo;
			/**
			 * the meshes particles pick from, in the order of {@link ParticleSystemInfo.meshWeights}; empty for
			 * quads, which the caller supplies
			 */
			meshes: PPtr[];
			/**
			 * the force fields the particles feel, for the caller to resolve into
			 * {@link ParticleFreeMotionInfo.forces}; `null` without
			 */
			forces: ExternalForcesRead | null;
			/**
			 * the mesh a {@link ParticleShapeKind.Mesh} shape emits from, for the caller to decode into
			 * {@link ParticleShapeInfo.mesh} with {@link particleShapeMesh}; `null` for other shapes
			 */
			shapeMesh: PPtr | null;
	  }
	| { reason: string };

const WRAP_MODES = new Set<number>(Object.values(CurveWrapMode));
const isWrapMode = (mode: number): mode is CurveWrapMode => WRAP_MODES.has(mode);

/** @throws {FormatError} on a value that isn't a {@link CurveWrapMode} */
const readWrapMode = (value: TypeTreeObject, name: string): CurveWrapMode => {
	const mode = optionalNumberField(value, name) ?? CurveWrapMode.Clamp;
	if (!isWrapMode(mode)) {
		throw new FormatError(`unknown curve wrap mode ${mode}`);
	}
	return mode;
};

/**
 * @param value a serialized `AnimationCurve`
 * @returns its keys and wrap modes
 * @throws {FormatError} on an unknown wrap mode
 */
export const readAnimationCurve = (value: TypeTreeObject): AnimationCurve => ({
	keys: arrayField(value, 'm_Curve').map((key): CurveKey => {
		if (!isObject(key)) {
			throw new FormatError('curve key is not an object');
		}
		return {
			time: numberField(key, 'time'),
			value: numberField(key, 'value'),
			inSlope: numberField(key, 'inSlope'),
			outSlope: numberField(key, 'outSlope'),
			weightedMode: optionalNumberField(key, 'weightedMode') ?? 0,
			inWeight: optionalNumberField(key, 'inWeight') ?? 0,
			outWeight: optionalNumberField(key, 'outWeight') ?? 0,
		};
	}),
	preWrapMode: readWrapMode(value, 'm_PreInfinity'),
	postWrapMode: readWrapMode(value, 'm_PostInfinity'),
});

/**
 * @param value a serialized `MinMaxCurve`
 * @returns it, with only the curves its mode reads
 * @throws {FormatError} on an unknown mode
 */
export const readMinMaxCurve = (value: TypeTreeObject): MinMaxCurveInfo => {
	const mode = numberField(value, 'minMaxState');
	switch (mode) {
		case CurveMode.Constant:
		case CurveMode.Curve:
		case CurveMode.TwoCurves:
		case CurveMode.TwoConstants: {
			break;
		}
		default: {
			throw new FormatError(`unknown MinMaxCurve mode ${mode}`);
		}
	}
	const curves = mode === CurveMode.Curve || mode === CurveMode.TwoCurves;
	return {
		mode,
		scalar: numberField(value, 'scalar'),
		min: numberField(value, 'minScalar'),
		curve: curves ? readAnimationCurve(objectField(value, 'maxCurve')) : null,
		minCurve: mode === CurveMode.TwoCurves ? readAnimationCurve(objectField(value, 'minCurve')) : null,
	};
};

/** @returns whether a MinMaxCurve is one constant or a random one between two */
const isConstant = (curve: MinMaxCurveInfo): boolean =>
	curve.mode === CurveMode.Constant || curve.mode === CurveMode.TwoConstants;

/**
 * @param curve a MinMaxCurve
 * @returns the largest magnitude it can take (the keys' values bound a curve, overshoot aside)
 */
export const curveReach = (curve: MinMaxCurveInfo): number => {
	switch (curve.mode) {
		case CurveMode.Constant: {
			return Math.abs(curve.scalar);
		}
		case CurveMode.TwoConstants: {
			return Math.max(Math.abs(curve.scalar), Math.abs(curve.min));
		}
		default: {
			let most = 0;
			for (const key of [...(curve.curve?.keys ?? []), ...(curve.minCurve?.keys ?? [])]) {
				most = Math.max(most, Math.abs(key.value));
			}
			return most * Math.abs(curve.scalar);
		}
	}
};

/** @returns whether the module is present and enabled */
const enabled = (system: TypeTreeObject, module: string): boolean =>
	isObject(system[module]) && booleanField(system[module], 'enabled');

const rgba = (value: TypeTreeObject): [number, number, number, number] => [
	numberField(value, 'r'),
	numberField(value, 'g'),
	numberField(value, 'b'),
	numberField(value, 'a'),
];

/** Unity's `GradientMode.Fixed` */
const GRADIENT_FIXED = 1;

/** the most keys a Unity gradient holds */
const GRADIENT_KEYS = 8;

/**
 * @param value a serialized `Gradient`
 * @returns its keys
 * @throws {FormatError} on a key count outside 1–8
 */
export const readGradient = (value: TypeTreeObject): Gradient => {
	const colors = numberField(value, 'm_NumColorKeys');
	const alphas = numberField(value, 'm_NumAlphaKeys');
	if (colors < 1 || colors > GRADIENT_KEYS || alphas < 1 || alphas > GRADIENT_KEYS) {
		throw new FormatError(`gradient with ${colors} colour and ${alphas} alpha keys`);
	}
	// key times are stored as 0–65535
	return {
		colorKeys: Array.from({ length: colors }, (_, i) => {
			const [r, g, b] = rgba(objectField(value, `key${i}`));
			return { time: numberField(value, `ctime${i}`) / 65_535, color: [r, g, b] };
		}),
		alphaKeys: Array.from({ length: alphas }, (_, i) => ({
			time: numberField(value, `atime${i}`) / 65_535,
			alpha: rgba(objectField(value, `key${i}`))[3],
		})),
		fixed: numberField(value, 'm_Mode') === GRADIENT_FIXED,
	};
};

/**
 * @param value a serialized `MinMaxGradient`
 * @returns it, with only the gradients its mode reads
 * @throws {FormatError} on an unknown mode
 */
export const readMinMaxGradient = (value: TypeTreeObject): MinMaxGradientInfo => {
	const mode = numberField(value, 'minMaxState');
	switch (mode) {
		case GradientMode.Color:
		case GradientMode.Gradient:
		case GradientMode.TwoColors:
		case GradientMode.TwoGradients:
		case GradientMode.RandomColor: {
			break;
		}
		default: {
			throw new FormatError(`unknown MinMaxGradient mode ${mode}`);
		}
	}
	const gradients =
		mode === GradientMode.Gradient || mode === GradientMode.TwoGradients || mode === GradientMode.RandomColor;
	return {
		mode,
		max: rgba(objectField(value, 'maxColor')),
		min: rgba(objectField(value, 'minColor')),
		maxGradient: gradients ? readGradient(objectField(value, 'maxGradient')) : null,
		minGradient: mode === GradientMode.TwoGradients ? readGradient(objectField(value, 'minGradient')) : null,
	};
};

const readShape = (shape: TypeTreeObject): ParticleShapeInfo | string => {
	const kind = numberField(shape, 'type');
	if (!isShapeKind(kind)) {
		return `shape ${kind}`;
	}
	if (kind === ParticleShapeKind.Mesh) {
		const unsupported = meshShapeUnsupported(shape);
		if (unsupported !== null) {
			return unsupported;
		}
	}
	const radius = objectField(shape, 'radius');
	const arc = objectField(shape, 'arc');
	return {
		kind,
		radius: numberField(radius, 'value'),
		radiusThickness: numberField(shape, 'radiusThickness'),
		donutRadius: optionalNumberField(shape, 'donutRadius') ?? 0,
		angle: numberField(shape, 'angle'),
		length: numberField(shape, 'length'),
		arc: numberField(arc, 'value'),
		position: vector3Field(shape, 'm_Position'),
		rotation: vector3Field(shape, 'm_Rotation'),
		scale: vector3Field(shape, 'm_Scale'),
		randomDirection: numberField(shape, 'randomDirectionAmount'),
		sphericalDirection: numberField(shape, 'sphericalDirectionAmount'),
		randomPosition: numberField(shape, 'randomPositionAmount'),
		// the caller decodes the mesh (particleShapeMesh)
		mesh: null,
	};
};

// #region mesh shape

/** `ShapeModule.m_MeshSpawn.mode` values */
const MeshSpawnMode = { Random: 0, Loop: 1 } as const;

/** @returns why the viewer can't emit from a mesh shape's settings, or `null` when it can */
const meshShapeUnsupported = (shape: TypeTreeObject): string | null => {
	if (isObject(shape.m_Texture) && pptrField(shape, 'm_Texture').pathId !== 0n) {
		return 'mesh shape texture';
	}
	const spawn = numberField(objectField(shape, 'm_MeshSpawn'), 'mode');
	// the edge's loop steps by the emission's place in the frame, which isn't traced
	if (numberField(shape, 'placementMode') === ParticleMeshPlacement.Edge && spawn !== MeshSpawnMode.Random) {
		return `edge mesh shape spawn mode ${spawn}`;
	}
	return null;
};

/** rounds to `scale` steps per unit, keeping the table small */
const quantize = (values: ArrayLike<number>, scale: number): number[] =>
	Array.from(values, (value) => Math.round(value * scale) / scale);

/**
 * reads the mesh a mesh shape emits from: every submesh's primitives, or only `m_MeshMaterialIndex`'s when
 * `m_UseMeshMaterialIndex` is set, as the engine does. triangle submeshes give triangles, line and line-strip
 * ones lines, and one without indices a line strip through all the mesh's vertices
 *
 * @param shape a `ShapeModule` of type 6
 * @param mesh its `m_Mesh`, decoded
 * @returns the mesh, or why the viewer can't emit from it: quads or points (which the engine refuses too),
 *   lines alongside triangles, or no primitives
 */
export const particleShapeMesh = (
	shape: TypeTreeObject,
	mesh: DecodedMesh,
): ParticleShapeMeshInfo | string => {
	let submeshes = mesh.submeshes;
	if (booleanField(shape, 'm_UseMeshMaterialIndex') && submeshes.length > 0) {
		const index = Math.min(Math.max(numberField(shape, 'm_MeshMaterialIndex'), 0), submeshes.length - 1);
		submeshes = [submeshes[index]];
	}
	let corners: 2 | 3 | null = null;
	const primitives: number[] = [];
	for (const submesh of submeshes) {
		const at = (i: number) => mesh.indices[submesh.firstIndex + i] + submesh.baseVertex;
		let kind: 2 | 3;
		if (submesh.indexCount === 0) {
			kind = 2;
			// through all the mesh's vertices, whatever the submesh records
			for (let v = 0; v + 1 < mesh.vertexCount; v++) {
				primitives.push(v, v + 1);
			}
		} else {
			switch (submesh.topology) {
				case MeshTopology.Triangles: {
					kind = 3;
					for (let i = 0; i + 2 < submesh.indexCount; i += 3) {
						primitives.push(at(i), at(i + 1), at(i + 2));
					}
					break;
				}
				case MeshTopology.Lines: {
					kind = 2;
					for (let i = 0; i + 1 < submesh.indexCount; i += 2) {
						primitives.push(at(i), at(i + 1));
					}
					break;
				}
				case MeshTopology.LineStrip: {
					kind = 2;
					for (let i = 0; i + 1 < submesh.indexCount; i++) {
						primitives.push(at(i), at(i + 1));
					}
					break;
				}
				default: {
					return `mesh shape topology ${submesh.topology}`;
				}
			}
		}
		// the engine keeps one corner count for the whole mesh, so it samples a mix inconsistently
		if (corners !== null && corners !== kind) {
			return 'mesh shape mixing lines and triangles';
		}
		corners = kind;
	}
	if (corners === null || primitives.length === 0) {
		return 'mesh shape without primitives';
	}
	const placement = numberField(shape, 'placementMode');
	if (
		placement !== ParticleMeshPlacement.Vertex &&
		placement !== ParticleMeshPlacement.Edge &&
		placement !== ParticleMeshPlacement.Triangle
	) {
		return `mesh shape placement ${placement}`;
	}
	const spawnModule = objectField(shape, 'm_MeshSpawn');
	const spawnMode = numberField(spawnModule, 'mode');
	// only vertices follow the spawn mode; Edge's loop stands in, triangles are always random. PingPong and
	// BurstSpread both walk back and forth
	let spawn: ParticleMeshSpawn = ParticleMeshSpawn.Random;
	if (placement === ParticleMeshPlacement.Vertex && spawnMode !== MeshSpawnMode.Random) {
		spawn = spawnMode === MeshSpawnMode.Loop ? ParticleMeshSpawn.Loop : ParticleMeshSpawn.PingPong;
	}
	const colors = booleanField(shape, 'm_UseMeshColors') ? mesh.colors : null;
	return {
		placement,
		spawn,
		spread: placement === ParticleMeshPlacement.Edge ? Math.max(numberField(spawnModule, 'spread'), 0) : 0,
		normalOffset: numberField(shape, 'm_MeshNormalOffset'),
		positions: quantize(mesh.positions, 1e4),
		normals: mesh.normals === null ? null : quantize(mesh.normals, 1e3),
		colors:
			colors === null
				? null
				: Array.from({ length: mesh.vertexCount * 4 }, (_, i) =>
						// the engine reads Color32; rgb without alpha reads as opaque
						i % 4 < colors.dimension
							? Math.round(
									Math.min(Math.max(colors.data[Math.floor(i / 4) * colors.dimension + (i % 4)], 0), 1) * 255,
								)
							: 255,
					),
		corners,
		primitives,
	};
};

// #endregion

const readVelocity = (velocity: TypeTreeObject): ParticleVelocityInfo => {
	const curves = (names: readonly string[]) =>
		names.map((name) => readMinMaxCurve(objectField(velocity, name)));
	const linear = curves(['x', 'y', 'z']);
	const orbital = curves(['orbitalX', 'orbitalY', 'orbitalZ']);
	const [radial, speedModifier] = curves(['radial', 'speedModifier']);
	return {
		linear: [linear[0], linear[1], linear[2]],
		linearInWorld: booleanField(velocity, 'inWorldSpace'),
		orbital: [orbital[0], orbital[1], orbital[2]],
		orbitalOffset: [
			numberField(objectField(velocity, 'orbitalOffsetX'), 'scalar'),
			numberField(objectField(velocity, 'orbitalOffsetY'), 'scalar'),
			numberField(objectField(velocity, 'orbitalOffsetZ'), 'scalar'),
		],
		radial,
		speedModifier,
	};
};

/** a speed limit, `null` when `dampen` is 0 and the limit does nothing */
const readSpeedLimit = (clamp: TypeTreeObject): ParticleSpeedLimitInfo | null | string => {
	const dampen = numberField(clamp, 'dampen');
	if (dampen <= 0) {
		return null;
	}
	if (booleanField(clamp, 'separateAxis')) {
		return 'per-axis velocity limit';
	}
	return {
		kind: 'limit',
		limit: readMinMaxCurve(objectField(clamp, 'magnitude')),
		dampen: Math.min(dampen, 1),
	};
};

const readDrag = (clamp: TypeTreeObject): ParticleDragInfo | null | string => {
	const amount = readMinMaxCurve(objectField(clamp, 'drag'));
	if (!isConstant(amount)) {
		return 'drag curve';
	}
	if (curveReach(amount) === 0) {
		return null;
	}
	return {
		kind: 'drag',
		amount,
		bySize: booleanField(clamp, 'multiplyDragByParticleSize'),
		byVelocity: booleanField(clamp, 'multiplyDragByParticleVelocity'),
	};
};

const readBurst = (burst: TypeTreeObject): ParticleBurstInfo => ({
	time: numberField(burst, 'time'),
	count: readMinMaxCurve(objectField(burst, 'countCurve')),
	cycles: Math.max(1, numberField(burst, 'cycleCount')),
	interval: Math.max(numberField(burst, 'repeatInterval'), 1e-4),
	probability: numberField(burst, 'probability'),
});

/** `UVModule` enums the viewer evaluates */
const SheetMode = { Grid: 0 } as const;
const SheetTime = { Lifetime: 0, Fps: 2 } as const;
const SheetAnimation = { WholeSheet: 0, SingleRow: 1 } as const;
const SheetRowMode = { Custom: 0, Random: 1, MeshIndex: 2 } as const;

/** the most tiles along either side of a sheet, so a tile fits the viewer's instance info word */
const MAX_SHEET_TILES = 64;

const readTextureSheet = (uv: TypeTreeObject): ParticleTextureSheetInfo | string => {
	if (numberField(uv, 'mode') !== SheetMode.Grid) {
		return 'sprite sheet';
	}
	const tiles: [number, number] = [numberField(uv, 'tilesX'), numberField(uv, 'tilesY')];
	if (tiles.some((n) => n < 1 || n > MAX_SHEET_TILES)) {
		return `sheet of ${tiles[0]}×${tiles[1]} tiles`;
	}
	let row: number | null;
	switch (numberField(uv, 'animationType')) {
		case SheetAnimation.WholeSheet: {
			row = null;
			break;
		}
		case SheetAnimation.SingleRow: {
			const mode = optionalNumberField(uv, 'rowMode') ?? SheetRowMode.Custom;
			switch (mode) {
				case SheetRowMode.Custom: {
					row = Math.min(Math.max(numberField(uv, 'rowIndex'), 0), tiles[1] - 1);
					break;
				}
				case SheetRowMode.Random: {
					row = SheetRow.Random;
					break;
				}
				case SheetRowMode.MeshIndex: {
					row = SheetRow.MeshIndex;
					break;
				}
				default: {
					return `sheet row mode ${mode}`;
				}
			}
			break;
		}
		default: {
			return `sheet animation ${numberField(uv, 'animationType')}`;
		}
	}
	const timeMode = numberField(uv, 'timeMode');
	if (timeMode !== SheetTime.Lifetime && timeMode !== SheetTime.Fps) {
		return `sheet time mode ${timeMode}`;
	}
	return {
		tiles,
		row,
		frameOverTime: timeMode === SheetTime.Lifetime ? readMinMaxCurve(objectField(uv, 'frameOverTime')) : null,
		fps: numberField(uv, 'fps'),
		startFrame: readMinMaxCurve(objectField(uv, 'startFrame')),
		cycles: numberField(uv, 'cycles'),
		// -1 (every channel) and other masks keep the two UV sets the viewer's shaders read
		uvChannels: numberField(uv, 'uvChannelMask') & 3,
	};
};

/** `ParticleSystem.ringBufferMode` values */
const RingBufferMode = { Disabled: 0, PauseUntilReplaced: 1, LoopUntilReplaced: 2 } as const;

const readRingBuffer = (system: TypeTreeObject): ParticleRingBufferInfo | null | string => {
	const mode = numberField(system, 'ringBufferMode');
	switch (mode) {
		case RingBufferMode.Disabled: {
			return null;
		}
		case RingBufferMode.PauseUntilReplaced:
		case RingBufferMode.LoopUntilReplaced: {
			const range = objectField(system, 'ringBufferLoopRange');
			return {
				loop: mode === RingBufferMode.LoopUntilReplaced,
				loopRange: [numberField(range, 'x'), numberField(range, 'y')],
			};
		}
		default: {
			return `ring buffer mode ${mode}`;
		}
	}
};

// #region custom data

/** `CustomDataModule` modes */
const CustomDataMode = { Disabled: 0, Vector: 1, Color: 2 } as const;

/** `ParticleSystemVertexStream` values of the first custom stream, Custom1X to Custom1XYZW */
const CUSTOM1_STREAMS = [31, 32, 33, 34];

/**
 * components each `ParticleSystemVertexStream` past the fixed position, normal, tangent and colour (0–3)
 * takes in the texture coordinate sets: UV to UV4, anim blend and frame, center, vertex ID, size, rotation
 * and its speed, velocity, speed, age, inverse lifetime, stable and varying randoms, Custom1 and Custom2,
 * noise sum and impulse, mesh index
 */
const STREAM_COMPONENTS: Record<number, number> = {
	4: 2,
	5: 2,
	6: 2,
	7: 2,
	8: 1,
	9: 1,
	10: 3,
	11: 1,
	12: 1,
	13: 2,
	14: 3,
	15: 1,
	16: 3,
	17: 1,
	18: 3,
	19: 3,
	20: 1,
	21: 1,
	22: 1,
	23: 1,
	24: 2,
	25: 3,
	26: 4,
	27: 1,
	28: 2,
	29: 3,
	30: 4,
	31: 1,
	32: 2,
	33: 3,
	34: 4,
	35: 1,
	36: 2,
	37: 3,
	38: 4,
	39: 1,
	40: 2,
	41: 3,
	42: 1,
	43: 2,
	44: 3,
	45: 1,
};

/**
 * reads what a renderer's second texture coordinate set holds of the particles' first custom data. the engine
 * packs the vertex streams past the fixed ones into 4-wide texture coordinate sets in the renderer's order,
 * and evaluates a vector mode's curves every frame at each particle's age over its lifetime, its randoms
 * fixed per particle
 *
 * @param system the emitter's `ParticleSystem`
 * @param renderer its `ParticleSystemRenderer`
 * @returns the second set's components, or `null` when it holds none of the custom data (no custom streams,
 *   the module off or in colour mode, or a stream the layout doesn't know before it)
 */
export const readCustomData = (
	system: TypeTreeObject,
	renderer: TypeTreeObject,
): ParticleSystemInfo['customData'] => {
	if (!booleanField(renderer, 'm_UseCustomVertexStreams') || !enabled(system, 'CustomDataModule')) {
		return null;
	}
	const module = objectField(system, 'CustomDataModule');
	if (numberField(module, 'mode0') !== CustomDataMode.Vector) {
		return null;
	}
	const count = numberField(module, 'vectorComponentCount0');
	const out: [ParticleCustom, ParticleCustom, ParticleCustom, ParticleCustom] = [null, null, null, null];
	let at = 0;
	for (const value of arrayField(renderer, 'm_VertexStreams')) {
		const stream = Number(value);
		if (stream <= 3) {
			continue;
		}
		const components = STREAM_COMPONENTS[stream];
		if (components === undefined) {
			return null;
		}
		const custom = CUSTOM1_STREAMS.indexOf(stream);
		for (let c = 0; c < components; c++, at++) {
			// the second set is components 4–7; components past the module's count are 0
			if (custom >= 0 && at >= 4 && at < 8 && c < count) {
				out[at - 4] = readMinMaxCurve(objectField(module, `vector0_${c}`));
			}
		}
		if (at >= 8) {
			break;
		}
	}
	return out.some((component) => component !== null) ? out : null;
};

// #endregion

/**
 * reads a particle system that plays on its own once loaded. modules the viewer doesn't evaluate (forces,
 * noise, collision, sub-emitters, trails, the by-speed modules, …) are ignored, so such systems play without
 * them.
 *
 * @param system the emitter's `ParticleSystem`
 * @param renderer its `ParticleSystemRenderer`
 * @returns the system and the meshes its particles draw, or why the viewer can't play it: a render mode, a
 *   module, shape, texture sheet or ring buffer mode it doesn't evaluate, a speed modifier curve alongside
 *   drag, a per-axis speed limit or one alongside drag, a drag or rate curve, or no mesh. `null` for a system
 *   that doesn't play on awake, which shows nothing until a script starts it
 */
export const readParticleSystem = (
	system: TypeTreeObject,
	renderer: TypeTreeObject,
): ParticleSystemRead | null => {
	const renderMode = numberField(renderer, 'm_RenderMode');
	switch (renderMode) {
		case ParticleRenderMode.Billboard:
		case ParticleRenderMode.Stretched:
		case ParticleRenderMode.Horizontal:
		case ParticleRenderMode.Vertical:
		case ParticleRenderMode.Mesh: {
			break;
		}
		default: {
			return { reason: `render mode ${renderMode}` };
		}
	}
	if (!booleanField(system, 'playOnAwake')) {
		return null;
	}
	const ringBuffer = readRingBuffer(system);
	if (typeof ringBuffer === 'string') {
		return { reason: ringBuffer };
	}
	// each particle picks one of up to four meshes, evenly or by the weights; other modes draw one quad
	const meshes: PPtr[] = [];
	const meshWeights: number[] = [];
	if (renderMode === ParticleRenderMode.Mesh) {
		const weighted =
			(optionalNumberField(renderer, 'm_MeshDistribution') ?? 0) === MESH_DISTRIBUTION_WEIGHTED;
		for (const [i, field] of MESH_FIELDS.entries()) {
			if (!isObject(renderer[field]) || pptrField(renderer, field).pathId === 0n) {
				continue;
			}
			const weight = weighted ? (optionalNumberField(renderer, MESH_WEIGHT_FIELDS[i]) ?? 1) : 1;
			if (weight > 0) {
				meshes.push(pptrField(renderer, field));
				meshWeights.push(weight);
			}
		}
		if (meshes.length === 0) {
			return { reason: 'no mesh' };
		}
	} else {
		meshWeights.push(1);
	}
	const renderAlignment = numberField(renderer, 'm_RenderAlignment');
	let alignment: ParticleAlignment;
	switch (renderAlignment) {
		case ParticleAlignment.View:
		case ALIGNMENT_FACING: {
			alignment = ParticleAlignment.View;
			break;
		}
		case ParticleAlignment.World:
		case ParticleAlignment.Local:
		case ParticleAlignment.Velocity: {
			alignment = renderAlignment;
			break;
		}
		default: {
			return { reason: `alignment ${renderAlignment}` };
		}
	}
	const initial = objectField(system, 'InitialModule');
	const emission = objectField(system, 'EmissionModule');
	const emits = booleanField(emission, 'enabled');
	const rate = emits
		? readMinMaxCurve(objectField(emission, 'rateOverTime'))
		: { mode: CurveMode.Constant, scalar: 0, min: 0, curve: null, minCurve: null };
	if (!isConstant(rate)) {
		return { reason: 'rate curve' };
	}
	const bursts = emits
		? arrayField(emission, 'm_Bursts').map((burst) => {
				if (!isObject(burst)) {
					throw new FormatError('burst is not an object');
				}
				return readBurst(burst);
			})
		: [];

	let shape: ParticleShapeInfo | null = null;
	if (enabled(system, 'ShapeModule')) {
		const read = readShape(objectField(system, 'ShapeModule'));
		if (typeof read === 'string') {
			return { reason: read };
		}
		shape = read;
	}
	let velocity: ParticleVelocityInfo | null = null;
	if (enabled(system, 'VelocityModule')) {
		velocity = readVelocity(objectField(system, 'VelocityModule'));
	}
	let clamp: ParticleClampInfo | null = null;
	if (enabled(system, 'ClampVelocityModule')) {
		const module = objectField(system, 'ClampVelocityModule');
		const limit = readSpeedLimit(module);
		const drag = readDrag(module);
		if (typeof limit === 'string') {
			return { reason: limit };
		}
		if (typeof drag === 'string') {
			return { reason: drag };
		}
		// where the game applies drag relative to the limit isn't known
		if (limit !== null && drag !== null) {
			return { reason: 'velocity limit with drag' };
		}
		clamp = limit ?? drag;
		// the viewer's dragged path takes the speed modifier as a constant
		if (drag !== null && velocity !== null && !isConstant(velocity.speedModifier)) {
			return { reason: 'speed modifier curve with drag' };
		}
	}

	let forces: ExternalForcesRead | null = null;
	if (enabled(system, 'ExternalForcesModule')) {
		const module = objectField(system, 'ExternalForcesModule');
		const multiplier = readMinMaxCurve(objectField(module, 'multiplierCurve'));
		// the engine skips the module unless the multiplier's scalar is above 0
		if (multiplier.scalar > 0) {
			// the stepped path the forces need takes no drag
			if (clamp?.kind === 'drag') {
				return { reason: 'force fields with drag' };
			}
			forces = {
				multiplier,
				filter: numberField(module, 'influenceFilter'),
				mask: numberField(objectField(module, 'influenceMask'), 'm_Bits'),
				list: arrayField(module, 'influenceList').map(asPPtr),
			};
		}
	}

	const curve = (parent: TypeTreeObject, name: string) => readMinMaxCurve(objectField(parent, name));
	const { startSize, startRotation } = readStartPose(initial);
	const zero: MinMaxCurveInfo = { mode: CurveMode.Constant, scalar: 0, min: 0, curve: null, minCurve: null };

	let sizeOverLifetime: ParticleSystemInfo['sizeOverLifetime'] = null;
	if (enabled(system, 'SizeModule')) {
		const sizeModule = objectField(system, 'SizeModule');
		const x = curve(sizeModule, 'curve');
		sizeOverLifetime = booleanField(sizeModule, 'separateAxes')
			? [x, curve(sizeModule, 'y'), curve(sizeModule, 'z')]
			: [x, x, x];
	}
	let rotationOverLifetime: ParticleSystemInfo['rotationOverLifetime'] = null;
	if (enabled(system, 'RotationModule')) {
		const rotation = objectField(system, 'RotationModule');
		const z = curve(rotation, 'curve');
		rotationOverLifetime = booleanField(rotation, 'separateAxes')
			? [curve(rotation, 'x'), curve(rotation, 'y'), z]
			: [zero, zero, z];
	}
	let textureSheet: ParticleTextureSheetInfo | null = null;
	if (enabled(system, 'UVModule')) {
		const read = readTextureSheet(objectField(system, 'UVModule'));
		if (typeof read === 'string') {
			return { reason: read };
		}
		textureSheet = read;
	}

	const duration = Math.max(numberField(system, 'lengthInSec'), 1e-3);
	const startLifetime = curve(initial, 'startLifetime');
	const bound = emissionBound(rate, bursts, startLifetime, duration);
	let maxParticles = numberField(initial, 'maxNumParticles');
	if (maxParticles === 0) {
		// some effects store a cap of 0 yet show in game (the tilted torch flames), so the game must size them
		// itself. take the most one lifetime's emission can hold, which also keeps a ring buffer from piling up
		maxParticles = bound;
	}
	const delay = curve(system, 'startDelay');
	// Unity's inspector offers a constant or two for the delay; a curve would need a time to read it at
	if (!isConstant(delay)) {
		return { reason: 'start delay curve' };
	}
	return {
		info: {
			renderMode,
			stretch:
				renderMode === ParticleRenderMode.Stretched
					? {
							lengthScale: numberField(renderer, 'm_LengthScale'),
							velocityScale: numberField(renderer, 'm_VelocityScale'),
						}
					: null,
			screenSize:
				renderMode === ParticleRenderMode.Mesh
					? null
					: {
							min: numberField(renderer, 'm_MinParticleSize'),
							max: numberField(renderer, 'm_MaxParticleSize'),
						},
			// the packer folds the other modes' scale into the emitter's matrix (particleEmitterMatrix)
			sizedByScale: numberField(system, 'scalingMode') !== ScalingMode.Shape,
			duration,
			looping: booleanField(system, 'looping'),
			startDelay: delay,
			maxParticles,
			emissionBound: bound,
			simulationSpeed: numberField(system, 'simulationSpeed'),
			startLifetime,
			startColor: readMinMaxGradient(objectField(initial, 'startColor')),
			colorOverLifetime: enabled(system, 'ColorModule')
				? readMinMaxGradient(objectField(objectField(system, 'ColorModule'), 'gradient'))
				: null,
			startSize,
			startRotation,
			rate,
			bursts,
			shape,
			motion: {
				kind: 'free',
				startSpeed: curve(initial, 'startSpeed'),
				gravityModifier: curve(initial, 'gravityModifier'),
				velocity,
				clamp,
				// the caller resolves the fields
				forces: null,
			},
			sizeOverLifetime,
			rotationOverLifetime,
			alignment,
			pivot: vector3Field(renderer, 'm_Pivot'),
			meshWeights,
			mesh: 0,
			ringBuffer,
			textureSheet,
			customData: readCustomData(system, renderer),
		},
		meshes,
		forces,
		shapeMesh:
			shape?.kind === ParticleShapeKind.Mesh ? pptrField(objectField(system, 'ShapeModule'), 'm_Mesh') : null,
	};
};

/**
 * @param rate particles per second, a constant or two
 * @param bursts each loop's bursts
 * @param startLifetime the particles' lifetime
 * @param duration seconds per loop
 * @returns the most particles one longest lifetime of emission holds, whatever the cap: the top rate times
 *   the lifetime, plus each loop's top burst counts times the loops that lifetime spans
 */
export const emissionBound = (
	rate: MinMaxCurveInfo,
	bursts: readonly ParticleBurstInfo[],
	startLifetime: MinMaxCurveInfo,
	duration: number,
): number => {
	const life = Math.max(curveReach(startLifetime), 0);
	const perLoop = bursts.reduce((sum, burst) => sum + curveReach(burst.count) * burst.cycles, 0);
	return Math.ceil(curveReach(rate) * life + perLoop * Math.ceil(life / duration - 1e-6));
};

/**
 * @param initial a `ParticleSystem`'s `InitialModule`
 * @returns each particle's start size per axis and start Euler angles (radians, about x, y and z), as
 *   {@link ParticleSystemInfo} keeps them: one size for all three axes and a turn about z alone unless the
 *   module sets them per axis
 */
export const readStartPose = (
	initial: TypeTreeObject,
): Pick<ParticleSystemInfo, 'startSize' | 'startRotation'> => {
	const curve = (name: string) => readMinMaxCurve(objectField(initial, name));
	const size = curve('startSize');
	const zero: MinMaxCurveInfo = { mode: CurveMode.Constant, scalar: 0, min: 0, curve: null, minCurve: null };
	return {
		startSize: booleanField(initial, 'size3D')
			? [size, curve('startSizeY'), curve('startSizeZ')]
			: [size, size, size],
		startRotation: booleanField(initial, 'rotation3D')
			? [curve('startRotationX'), curve('startRotationY'), curve('startRotation')]
			: [zero, zero, curve('startRotation')],
	};
};

/** `ParticleSystemForceField` shapes, of which the viewer steps the sphere */
const FORCE_FIELD_SPHERE = 0;

/**
 * @param field a `ParticleSystemForceField`
 * @param fromEmitter the emitter's frame as seen from the field's
 *   ({@link ParticleForceFieldInfo.fromEmitter})
 * @returns the field, or why the viewer can't step it: a shape other than a sphere, or a vector field
 */
export const readForceField = (
	field: TypeTreeObject,
	fromEmitter: Float32Array,
): ParticleForceFieldInfo | string => {
	const parameters = objectField(field, 'm_Parameters');
	const shape = numberField(parameters, 'm_Shape');
	if (shape !== FORCE_FIELD_SPHERE) {
		return `force field shape ${shape}`;
	}
	if (pptrField(parameters, 'm_VectorField').pathId !== 0n) {
		return 'force field vector field';
	}
	const curve = (name: string) => readMinMaxCurve(objectField(parameters, name));
	const randomness = objectField(parameters, 'm_RotationRandomness');
	return {
		fromEmitter: [...fromEmitter],
		startRange: numberField(parameters, 'm_StartRange'),
		endRange: numberField(parameters, 'm_EndRange'),
		gravityFocus: numberField(parameters, 'm_GravityFocus'),
		rotationRandomness: [numberField(randomness, 'x'), numberField(randomness, 'y')],
		direction: [curve('m_DirectionCurveX'), curve('m_DirectionCurveY'), curve('m_DirectionCurveZ')],
		gravity: curve('m_GravityCurve'),
		rotationSpeed: curve('m_RotationSpeedCurve'),
		rotationAttraction: curve('m_RotationAttractionCurve'),
		drag: curve('m_DragCurve'),
		dragBySize: booleanField(parameters, 'm_MultiplyDragByParticleSize'),
		dragByVelocity: booleanField(parameters, 'm_MultiplyDragByParticleVelocity'),
	};
};

/**
 * @param curve a MinMaxCurve
 * @returns its constant, or the midpoint of its two constants (the game's random draws can't be reproduced
 *   offline); `null` for curves
 */
export const constantMidpoint = (curve: MinMaxCurveInfo): number | null => {
	switch (curve.mode) {
		case CurveMode.Constant: {
			return curve.scalar;
		}
		case CurveMode.TwoConstants: {
			return (curve.min + curve.scalar) / 2;
		}
		default: {
			return null;
		}
	}
};

/**
 * a conservative box around everywhere a system's particles can reach, meshes included, in the emitter's
 * frame: the shape's extent plus the farthest any velocity, gravity or radial push carries a particle in its
 * longest lifetime, around the orbits' centre
 *
 * @param info the system
 * @param meshRadius the particle mesh's bounding radius at size 1
 * @returns the box
 */
export const particleReach = (info: ParticleSystemInfo, meshRadius: number): Aabb => {
	const motion = info.motion;
	if (motion.kind === 'spline') {
		// a Bézier segment stays inside its control points' hull
		let farthest = 0;
		for (const segment of motion.segments) {
			for (const point of segment.points) {
				farthest = Math.max(farthest, Math.hypot(...point));
			}
		}
		const start =
			info.shape === null ? 0 : Math.hypot(...info.shape.position) + Math.hypot(...info.shape.scale) / 2;
		const size =
			meshRadius *
			Math.max(...info.startSize.map(curveReach)) *
			Math.max(1, ...(info.sizeOverLifetime ?? []).map(curveReach));
		const half = farthest + start + size;
		return { center: [0, 0, 0], extents: [half, half, half] };
	}
	const life = curveReach(info.startLifetime);
	const { velocity } = motion;
	const speedScale = velocity === null ? 1 : curveReach(velocity.speedModifier);
	let speed = curveReach(motion.startSpeed);
	let offset = 0;
	if (velocity !== null) {
		const [x, y, z] = velocity.linear.map(curveReach);
		speed += Math.hypot(x, y, z) + curveReach(velocity.radial);
		offset = Math.hypot(...velocity.orbitalOffset);
	}
	let shape = 0;
	if (info.shape !== null) {
		const s = info.shape;
		const along = s.kind === ParticleShapeKind.ConeVolume ? s.length : 0;
		const tube = s.kind === ParticleShapeKind.Donut ? s.donutRadius : 0;
		let spread = s.radius + tube + along * Math.tan((Math.min(Math.abs(s.angle), 89) * Math.PI) / 180);
		if (s.mesh !== null) {
			// the farthest vertex; edges and triangles lie within their vertices' hull
			spread = 0;
			const p = s.mesh.positions;
			for (let i = 0; i < p.length; i += 3) {
				spread = Math.max(spread, Math.hypot(p[i], p[i + 1], p[i + 2]));
			}
		}
		shape =
			Math.hypot(...s.position) +
			Math.max(...s.scale.map(Math.abs)) * Math.hypot(spread, along) +
			s.randomPosition * Math.sqrt(3);
	}
	const gravity = 0.5 * GRAVITY * curveReach(motion.gravityModifier) * life * life;
	// the pivot moves the mesh by multiples of the particle's size
	let size =
		(meshRadius + Math.hypot(...info.pivot)) *
		Math.max(...info.startSize.map(curveReach)) *
		Math.max(1, ...(info.sizeOverLifetime ?? []).map(curveReach));
	if (info.stretch !== null) {
		// a stretched quad lengthens by its length scale and its speed
		const fastest = speed * speedScale + GRAVITY * curveReach(motion.gravityModifier) * life;
		size =
			size * Math.max(1, Math.abs(info.stretch.lengthScale)) + Math.abs(info.stretch.velocityScale) * fastest;
	}
	// orbits keep a particle's distance from their centre, which lies `offset` from the emitter
	let half = 2 * offset + shape + speed * speedScale * life + gravity + size;
	// a field holds its particles within its range around it, but they can coast out of it as well
	let fieldReach = 0;
	for (const field of motion.forces?.fields ?? []) {
		const toEmitter = inverseAffine(new Float32Array(field.fromEmitter));
		const stretch = Math.max(
			...[0, 4, 8].map((c) => Math.hypot(toEmitter[c], toEmitter[c + 1], toEmitter[c + 2])),
		);
		fieldReach = Math.max(
			fieldReach,
			Math.hypot(toEmitter[12], toEmitter[13], toEmitter[14]) + field.endRange * stretch,
		);
	}
	half += fieldReach;
	return { center: [0, 0, 0], extents: [half, half, half] };
};

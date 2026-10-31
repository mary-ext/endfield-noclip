import { BinaryReader, FormatError } from '../binary/binary-reader.ts';

import type { PPtr } from './values.ts';

// SRP core's `LensFlareDataSRP`: a MonoBehaviour asset listing a lens flare's elements. the game's bundles ship
// it without a TypeTree, so it's read from its raw bytes in the field order SRP core 12 declares, every bool
// padded to 4 bytes as Unity serializes them.

/** an `AnimationCurve` key */
export interface CurveKey {
	time: number;
	value: number;
	inSlope: number;
	outSlope: number;
	weightedMode: number;
	inWeight: number;
	outWeight: number;
}

/** an `AnimationCurve` */
export interface AnimationCurve {
	keys: CurveKey[];
	/** Unity's internal wrap modes; 2 (clamp) is the default */
	preWrapMode: number;
	postWrapMode: number;
}

/** a `Gradient`: up to eight colour and eight alpha keys at times 0–1 */
export interface Gradient {
	/** 0 blends between keys, 1 holds each key's value until the next */
	mode: number;
	colorKeys: { time: number; color: [r: number, g: number, b: number] }[];
	alphaKeys: { time: number; alpha: number }[];
}

/** one `LensFlareDataElementSRP`, under SRP core's field names; the editor's fold state is left out */
export interface LensFlareElementSRP {
	visible: boolean;
	/** along the ray through the screen's centre: 0 at the light, 1 at the centre, 2 mirrored */
	position: number;
	positionOffset: [number, number];
	/** degrees the ray turns */
	angularOffset: number;
	translationScale: [number, number];
	localIntensity: number;
	/** the image, `null` for none */
	lensFlareTexture: PPtr | null;
	uniformScale: number;
	sizeXY: [number, number];
	allowMultipleElement: boolean;
	count: number;
	preserveAspectRatio: boolean;
	/** degrees */
	rotation: number;
	tint: [r: number, g: number, b: number, a: number];
	/** 0 additive, 1 screen, 2 premultiplied, 3 lerp */
	blendMode: number;
	autoRotate: boolean;
	/** 0 image, 1 circle, 2 polygon */
	flareType: number;
	modulateByLightColor: boolean;
	/** 0 uniform, 1 curve, 2 random */
	distribution: number;
	lengthSpread: number;
	positionCurve: AnimationCurve;
	scaleCurve: AnimationCurve;
	seed: number;
	colorGradient: Gradient;
	intensityVariation: number;
	positionVariation: [number, number];
	scaleVariation: number;
	rotationVariation: number;
	enableRadialDistortion: boolean;
	targetSizeDistortion: [number, number];
	distortionCurve: AnimationCurve;
	distortionRelativeToCenter: boolean;
	fallOff: number;
	edgeOffset: number;
	sideCount: number;
	sdfRoundness: number;
	inverseSDF: boolean;
	uniformAngle: number;
	uniformAngleCurve: AnimationCurve;
}

/** a decoded `LensFlareDataSRP` */
export interface LensFlareDataSRP {
	name: string;
	elements: LensFlareElementSRP[];
}

/** keys and times a serialized `Gradient` always holds, used or not */
const GRADIENT_SLOTS = 8;

/**
 * @param bytes the MonoBehaviour's raw object bytes
 * @param options the serialized file's byte order
 * @returns the flare's name and elements
 * @throws {FormatError} if the bytes run out or are left over, or a count is implausible
 */
export const readLensFlareData = (
	bytes: Uint8Array,
	options: { littleEndian: boolean },
): LensFlareDataSRP => {
	const r = new BinaryReader(bytes, { littleEndian: options.littleEndian });
	const bool = (): boolean => {
		const value = r.u8() !== 0;
		r.align(4);
		return value;
	};
	const pptr = (): PPtr => ({ fileId: r.i32(), pathId: r.i64() });
	const vec2 = (): [number, number] => [r.f32(), r.f32()];
	const count = (what: string, max: number): number => {
		const n = r.i32();
		if (n < 0 || n > max) {
			throw new FormatError(`lens flare ${what} count ${n} is out of range`);
		}
		return n;
	};
	const curve = (): AnimationCurve => {
		const keys = Array.from({ length: count('curve key', 1024) }, () => ({
			time: r.f32(),
			value: r.f32(),
			inSlope: r.f32(),
			outSlope: r.f32(),
			weightedMode: r.i32(),
			inWeight: r.f32(),
			outWeight: r.f32(),
		}));
		const preWrapMode = r.i32();
		const postWrapMode = r.i32();
		// the rotation order, unused by float curves
		r.i32();
		return { keys, preWrapMode, postWrapMode };
	};
	const gradient = (): Gradient => {
		const colors = Array.from({ length: GRADIENT_SLOTS }, () => [r.f32(), r.f32(), r.f32(), r.f32()]);
		const colorTimes = Array.from({ length: GRADIENT_SLOTS }, () => r.u16() / 65535);
		const alphaTimes = Array.from({ length: GRADIENT_SLOTS }, () => r.u16() / 65535);
		const mode = r.i32();
		const colorCount = Math.min(r.u8(), GRADIENT_SLOTS);
		const alphaCount = Math.min(r.u8(), GRADIENT_SLOTS);
		r.align(4);
		return {
			mode,
			colorKeys: colors.slice(0, colorCount).map(([cr, cg, cb], i) => ({
				time: colorTimes[i],
				color: [cr, cg, cb],
			})),
			alphaKeys: colors.slice(0, alphaCount).map((c, i) => ({ time: alphaTimes[i], alpha: c[3] })),
		};
	};

	// MonoBehaviour: game object, enabled, script, name
	pptr();
	bool();
	pptr();
	const name = r.utf8(count('name byte', 4096));
	r.align(4);
	const elements = Array.from({ length: count('element', 256) }, (): LensFlareElementSRP => {
		const visible = bool();
		const position = r.f32();
		const positionOffset = vec2();
		const angularOffset = r.f32();
		const translationScale = vec2();
		const localIntensity = r.f32();
		const texture = pptr();
		const uniformScale = r.f32();
		const sizeXY = vec2();
		const allowMultipleElement = bool();
		const elementCount = r.i32();
		const preserveAspectRatio = bool();
		const rotation = r.f32();
		const tint: LensFlareElementSRP['tint'] = [r.f32(), r.f32(), r.f32(), r.f32()];
		const blendMode = r.i32();
		const autoRotate = bool();
		const flareType = r.i32();
		const modulateByLightColor = bool();
		// the inspector's fold state
		bool();
		return {
			visible,
			position,
			positionOffset,
			angularOffset,
			translationScale,
			localIntensity,
			lensFlareTexture: texture.pathId === 0n ? null : texture,
			uniformScale,
			sizeXY,
			allowMultipleElement,
			count: elementCount,
			preserveAspectRatio,
			rotation,
			tint,
			blendMode,
			autoRotate,
			flareType,
			modulateByLightColor,
			distribution: r.i32(),
			lengthSpread: r.f32(),
			positionCurve: curve(),
			scaleCurve: curve(),
			seed: r.i32(),
			colorGradient: gradient(),
			intensityVariation: r.f32(),
			positionVariation: vec2(),
			scaleVariation: r.f32(),
			rotationVariation: r.f32(),
			enableRadialDistortion: bool(),
			targetSizeDistortion: vec2(),
			distortionCurve: curve(),
			distortionRelativeToCenter: bool(),
			fallOff: r.f32(),
			edgeOffset: r.f32(),
			sideCount: r.i32(),
			sdfRoundness: r.f32(),
			inverseSDF: bool(),
			uniformAngle: r.f32(),
			uniformAngleCurve: curve(),
		};
	});
	if (r.remaining !== 0) {
		throw new FormatError(`lens flare ${name} has ${r.remaining} bytes past its elements`);
	}
	return { name, elements };
};

/**
 * the sun's lens flare as the CPU lays it out: SRP core's data-driven lens flare, which the game draws for
 * its sun from the environment's `lensFlare` section. each frame, every visible element becomes one quad per
 * copy, placed from where the sun falls on screen; `lens-flare.ts` draws them.
 *
 * the layout follows SRP core 12 (`LensFlareCommonSRP`), in its screen frame: x right and y down, both −1 to
 * 1, with sizes in units of the screen's height
 *
 * @module
 */

import type {
	AnimationCurve,
	Gradient,
	LensFlareConfig,
	LensFlareElement,
	LightConfig,
} from '@endfield-noclip/package-format/environment';
import type { Vec2, Vec4 } from '@endfield-noclip/package-format/values';

import type { Vec3 } from '../scene/camera.ts';

import { towardsRotatedLight } from './environment.ts';

// #region look

/** the flare in effect: the config's settings and the elements that can draw */
export interface LensFlareLook {
	/** unit vector towards the sun */
	direction: Vec3;
	/** the light's raw colour, which elements marked `modulateByLightColor` take */
	lightColor: Vec4;
	intensity: number;
	scale: number;
	/** the occlusion test, or `null` without one */
	occlusion: { radius: number; samples: number } | null;
	allowOffScreen: boolean;
	/** visible image and circle elements, in drawing order */
	elements: LensFlareElement[];
}

/** the profile sections the flare comes from; absent in packages from before it was packed */
export interface LensFlareInput {
	lensFlare?: LensFlareConfig;
	light?: Pick<LightConfig, 'rotationLensFlare' | 'directColor'>;
}

const IMAGE = 0;
const CIRCLE = 1;

/**
 * the sun's flare as the game overrides the sun's flare component with the environment's: the section's
 * flare, intensity, scale and occlusion, the light's flare direction and colour. polygons aren't drawn
 *
 * @param input the blended profile's sections, or `null` for the defaults (no flare)
 * @returns the flare, or `null` when nothing draws
 */
export const lensFlareLook = (input: LensFlareInput | null): LensFlareLook | null => {
	const config = input?.lensFlare;
	const light = input?.light;
	const data = config?.lensFlareData ?? null;
	if (
		config === undefined ||
		light === undefined ||
		data === null ||
		!config.enable ||
		config.intensity <= 0
	) {
		return null;
	}
	const elements = data.elements.filter(
		(element) =>
			element.visible &&
			element.count > 0 &&
			element.localIntensity > 0 &&
			((element.flareType === IMAGE && element.lensFlareTexture !== null) || element.flareType === CIRCLE),
	);
	if (elements.length === 0) {
		return null;
	}
	const [r, g, b, a] = light.directColor;
	return {
		direction: towardsRotatedLight(light.rotationLensFlare),
		lightColor: [r, g, b, a],
		intensity: config.intensity,
		scale: config.scale,
		occlusion: config.useOcclusion ? { radius: config.occlusionRadius, samples: config.sampleCount } : null,
		allowOffScreen: config.allowOffScreen,
		elements,
	};
};

/**
 * @param look the flare, or `null` for none
 * @returns the texture-table ids the flare's image elements sample
 */
export const lensFlareTextures = (look: LensFlareLook | null): number[] => [
	...new Set(
		(look?.elements ?? []).flatMap(({ flareType, lensFlareTexture }) =>
			flareType === IMAGE && lensFlareTexture !== null ? [lensFlareTexture] : [],
		),
	),
];

// #endregion

// #region curves and randomness

/** Unity's `Random`: xorshift128, seeded as `Random.InitState` seeds it */
export class UnityRandom {
	#x: number;
	#y: number;
	#z: number;
	#w: number;

	/** @param seed the seed */
	constructor(seed: number) {
		this.#x = seed >>> 0;
		this.#y = (Math.imul(this.#x, 1812433253) + 1) >>> 0;
		this.#z = (Math.imul(this.#y, 1812433253) + 1) >>> 0;
		this.#w = (Math.imul(this.#z, 1812433253) + 1) >>> 0;
	}

	/** @returns the next 32-bit value */
	next(): number {
		const t = (this.#x ^ (this.#x << 11)) >>> 0;
		this.#x = this.#y;
		this.#y = this.#z;
		this.#z = this.#w;
		this.#w = (this.#w ^ (this.#w >>> 19) ^ t ^ (t >>> 8)) >>> 0;
		return this.#w;
	}

	/**
	 * `Random.Range` for floats; how Unity maps the 23 random bits onto the range is assumed
	 *
	 * @param min one end
	 * @param max the other
	 * @returns a value between them
	 */
	range(min: number, max: number): number {
		const t = (this.next() & 0x7fffff) / 8388607;
		return min * t + (1 - t) * max;
	}
}

/**
 * @param curve an `AnimationCurve`
 * @param time where to read it
 * @returns its Hermite value, clamped to the first and last keys (key weights are ignored); 0 without keys
 */
export const evaluateCurve = (curve: AnimationCurve, time: number): number => {
	const keys = curve.keys;
	if (keys.length === 0) {
		return 0;
	}
	if (time <= keys[0].time) {
		return keys[0].value;
	}
	const last = keys.at(-1)!;
	if (time >= last.time) {
		return last.value;
	}
	let i = 0;
	while (keys[i + 1].time < time) {
		i++;
	}
	const a = keys[i];
	const b = keys[i + 1];
	if (!Number.isFinite(a.outSlope) || !Number.isFinite(b.inSlope)) {
		return a.value;
	}
	const dt = b.time - a.time;
	const s = (time - a.time) / dt;
	const s2 = s * s;
	const s3 = s2 * s;
	return (
		(2 * s3 - 3 * s2 + 1) * a.value +
		(s3 - 2 * s2 + s) * a.outSlope * dt +
		(-2 * s3 + 3 * s2) * b.value +
		(s3 - s2) * b.inSlope * dt
	);
};

/**
 * @returns a value of keys at `time`: blended between neighbours, or held from the next key in fixed mode;
 *   empty without keys
 */
const evaluateKeys = <T extends { time: number }>(
	keys: readonly T[],
	time: number,
	value: (key: T) => number[],
	fixed: boolean,
): number[] => {
	if (keys.length === 0) {
		return [];
	}
	if (time <= keys[0].time) {
		return value(keys[0]);
	}
	for (let i = 1; i < keys.length; i++) {
		const b = keys[i];
		if (time <= b.time) {
			if (fixed) {
				return value(b);
			}
			const a = keys[i - 1];
			const t = (time - a.time) / Math.max(b.time - a.time, 1e-6);
			const from = value(a);
			return value(b).map((to, c) => from[c] + (to - from[c]) * t);
		}
	}
	return value(keys.at(-1)!);
};

/**
 * @param gradient a `Gradient`
 * @param time where to read it, 0–1
 * @returns its colour and alpha there (white without keys)
 */
export const evaluateGradient = (gradient: Gradient, time: number): Vec4 => {
	const fixed = gradient.mode === 1;
	const [r = 1, g = 1, b = 1] = evaluateKeys(gradient.colorKeys, time, ({ color }) => [...color], fixed);
	const [a = 1] = evaluateKeys(gradient.alphaKeys, time, ({ alpha }) => [alpha], fixed);
	return [r, g, b, a];
};

// #endregion

// #region layout

/** one quad of the flare, as `lens-flare.wgsl` takes it (SRP core's `_FlareData0..3` and colour) */
export interface FlareQuad {
	/** texture-table id of the image, or `null` for a circle */
	texture: number | null;
	/** 0 additive, 1 screen, 2 premultiplied, 3 lerp */
	blendMode: number;
	/** the quad's rotation (cos, sin) and offset from the sun */
	data0: Vec4;
	/** the sun's position and the quad's half size */
	data2: Vec4;
	color: Vec4;
	/** off-screen sign (1 allowed, −1 hidden), circle edge, circle falloff exponent, 1 / side count */
	data3: Vec4;
}

const DEG = Math.PI / 180;
/** SRP core's arbitrary size unit */
const SIZE_SCALE = 0.1;

const rotate2 = ([x, y]: Vec2, cos: number, sin: number): Vec2 => [cos * x - sin * y, sin * x + cos * y];

/** the element's ray through the screen's centre at `position`, turned by the angular offset */
const rayOffset = (screen: Vec2, position: number, cos: number, sin: number): Vec2 =>
	rotate2([-(screen[0] * position), -(screen[1] * position)], cos, sin);

/** SRP core's `GetFlareData0`: the quad's rotation and its offset along the ray */
const flareData0 = (
	screen: Vec2,
	element: LensFlareElement,
	rayOff0: Vec2,
	ratio: Vec2,
	angle: number,
	position: number,
	offset: Vec2,
): Vec4 => {
	const cos0 = Math.cos(-element.angularOffset * DEG);
	const sin0 = Math.sin(-element.angularOffset * DEG);
	const [tx, ty] = element.translationScale;
	const ray = rotate2([-tx * screen[0] * position, -ty * screen[1] * position], cos0, sin0);
	let rotation = angle + 180;
	if (element.autoRotate) {
		const length = Math.hypot(ray[0], ray[1]) || 1;
		const x = (ray[0] / length) * ratio[0] * tx;
		const y = (ray[1] / length) * ratio[1] * ty;
		rotation -= Math.atan2(y, x) / DEG;
	}
	rotation *= DEG;
	return [
		Math.cos(-rotation),
		Math.sin(-rotation),
		offset[0] + rayOff0[0] * tx,
		-offset[1] + rayOff0[1] * ty,
	];
};

/**
 * lays out the flare's quads for where the sun falls on screen
 *
 * @param look the flare
 * @param screen the sun's position, x right and y down, −1 to 1
 * @param aspect the screen's width over its height
 * @param textureAspect gives an image's height over its width
 * @returns the quads in drawing order
 */
export const flareQuads = (
	look: LensFlareLook,
	screen: Vec2,
	aspect: number,
	textureAspect: (texture: number) => number,
): FlareQuad[] => {
	const quads: FlareQuad[] = [];
	const ratio: Vec2 = [aspect, 1];
	for (const element of look.elements) {
		const texture = element.flareType === IMAGE ? element.lensFlareTexture : null;
		const intensity = look.intensity * element.localIntensity;
		const modulation: Vec4 = element.modulateByLightColor ? look.lightColor : [1, 1, 1, 1];
		const color = modulation.map((c, i) => c * element.tint[i] * intensity);
		const aspectRatio = texture !== null && element.preserveAspectRatio ? textureAspect(texture) : 1;
		let [sizeX, sizeY] = element.sizeXY;
		if (element.preserveAspectRatio) {
			if (aspectRatio >= 1) {
				sizeX /= aspectRatio;
			} else {
				sizeY *= aspectRatio;
			}
		}
		const combined = SIZE_SCALE * element.uniformScale * look.scale;
		const size: Vec2 = [sizeX * combined, sizeY * combined];
		const cos0 = Math.cos(-element.angularOffset * DEG);
		const sin0 = Math.sin(-element.angularOffset * DEG);
		const data3: Vec4 = [
			look.allowOffScreen ? 1 : -1,
			Math.min(Math.max(1 - element.edgeOffset - 1e-6, 0), 1),
			Math.exp(4 * Math.min(Math.max(1 - element.fallOff, 0), 1)),
			1 / element.sideCount,
		];

		/** the size after radial distortion, which grows the quad towards its target size away from the sun */
		const localSize = (rayOff: Vec2): Vec2 => {
			if (!element.enableRadialDistortion) {
				return size;
			}
			let radius: number;
			if (element.distortionRelativeToCenter) {
				const [ox, oy] = element.positionOffset;
				const x = screen[0] + (rayOff[0] + ox) * element.translationScale[0];
				const y = screen[1] + (rayOff[1] - oy) * element.translationScale[1];
				radius = Math.min(Math.hypot(x, y), 1);
			} else {
				const rayOff0 = rayOffset(screen, 0, cos0, sin0);
				radius = Math.min(
					Math.max(Math.abs(rayOff[0] - rayOff0[0]), Math.abs(rayOff[1] - rayOff0[1])) * 0.5,
					1,
				);
			}
			const t = Math.min(Math.max(evaluateCurve(element.distortionCurve, radius), 0), 1);
			const [targetX, targetY] = element.targetSizeDistortion;
			return [
				size[0] + ((targetX * combined) / aspectRatio - size[0]) * t,
				size[1] + (targetY * combined - size[1]) * t,
			];
		};

		/** one copy of the element: along the ray at `position`, its size times `scale`, its colour times `tint` */
		const push = (copy: {
			position: number;
			angle: number;
			offset: Vec2;
			scale: number;
			tint: Vec4;
		}): void => {
			const rayOff = rayOffset(screen, copy.position, cos0, sin0);
			const [w, h] = localSize(rayOff);
			const tint = copy.tint;
			quads.push({
				texture,
				blendMode: element.blendMode,
				data0: flareData0(screen, element, rayOff, ratio, copy.angle, copy.position, copy.offset),
				data2: [screen[0], screen[1], w * copy.scale, h * copy.scale],
				color: [color[0] * tint[0], color[1] * tint[1], color[2] * tint[2], color[3] * tint[3]],
				data3,
			});
		};

		const start = 2 * element.position;
		const offset = element.positionOffset;
		if (!element.allowMultipleElement || element.count === 1) {
			push({ position: start, angle: element.rotation, offset, scale: 1, tint: [1, 1, 1, 1] });
			continue;
		}
		const step = (2 * element.lengthSpread) / (element.count - 1);
		switch (element.distribution) {
			case 0: {
				let position = start;
				let angle = 0;
				for (let i = 0; i < element.count; i++) {
					const time = i / (element.count - 1);
					push({
						position,
						angle: element.rotation + angle,
						offset,
						scale: 1,
						tint: evaluateGradient(element.colorGradient, time),
					});
					position += step;
					angle += element.uniformAngle;
				}
				break;
			}
			case 1: {
				for (let i = 0; i < element.count; i++) {
					const time = i / (element.count - 1);
					const spacing =
						element.positionCurve.keys.length > 0 ? evaluateCurve(element.positionCurve, time) : 1;
					push({
						position: start + 2 * element.lengthSpread * spacing,
						angle: element.rotation + evaluateCurve(element.uniformAngleCurve, time),
						offset,
						scale: element.scaleCurve.keys.length > 0 ? evaluateCurve(element.scaleCurve, time) : 1,
						tint: evaluateGradient(element.colorGradient, time),
					});
				}
				break;
			}
			case 2: {
				const random = new UnityRandom(element.seed);
				const side: Vec2 = [sin0 * element.positionVariation[1], cos0 * element.positionVariation[1]];
				let position = start;
				for (let i = 0; i < element.count; i++) {
					// SRP core draws its random numbers in this order
					const variation = random.range(-1, 1) * element.intensityVariation + 1;
					const scale = 1 + element.scaleVariation * random.range(-1, 1);
					const [r, g, b, a] = evaluateGradient(element.colorGradient, random.range(0, 1));
					const shift = random.range(-1, 1);
					// degrees plus a variation in ±π, as SRP core has it
					const angle = element.rotation + random.range(-Math.PI, Math.PI) * element.rotationVariation;
					if (variation > 0) {
						push({
							position,
							angle,
							offset: [offset[0] + shift * side[0], offset[1] + shift * side[1]],
							scale,
							tint: [r * variation, g * variation, b * variation, a * variation],
						});
					}
					position += step;
					position += 0.5 * step * random.range(-1, 1) * element.positionVariation[0];
				}
				break;
			}
			default: {
				break;
			}
		}
	}
	return quads;
};

// #endregion

import type {
	BlendSchema,
	EnvironmentPhaseInfo,
	EnvironmentProfile,
	EnvironmentSchema,
	EnvironmentSections,
	FieldBlend,
} from '@endfield-noclip/package-format/environment';

import { SUN_EFFECTS } from './sun.ts';

type Sections = Record<keyof EnvironmentSections, Record<string, unknown>>;

/**
 * blends a phase's active sections into the profile, replacing them. the new sections may share values with
 * both sides', which are never changed in place
 */
export const applyPhase = (
	profile: EnvironmentProfile,
	phase: EnvironmentPhaseInfo,
	t: number,
	schema: EnvironmentSchema,
): void => {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sections are plain JSON records
	const target = profile as unknown as Sections;
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above
	const source = phase.sections as unknown as Sections;
	// the atmosphere each side's fog defers to, read before the loop replaces `target.atmosphere`
	const atmospheres = {
		from: target.atmosphere,
		to: phase.active.includes('atmosphere') ? source.atmosphere : target.atmosphere,
	};
	for (const name of phase.active) {
		if (t >= 1 - 1e-4) {
			target[name] = source[name];
		} else {
			target[name] = lerpSection(name, target[name], source[name], atmospheres, t, schema[name] ?? {});
		}
	}
};

/** lerps one section, below full strength */
const lerpSection = (
	name: keyof EnvironmentSections,
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	atmospheres: { from: Record<string, unknown>; to: Record<string, unknown> },
	t: number,
	schema: BlendSchema,
): Record<string, unknown> => {
	switch (name) {
		case 'light': {
			return lerpLight(a, b, t, schema);
		}
		case 'fog': {
			return lerpFog(a, b, atmospheres, t, schema);
		}
		case 'cloud': {
			return lerpCloud(a, b, t, schema);
		}
		case 'rain': {
			// the section is optional, and a profile without it is dry
			return lerpRain(a ?? {}, b, t, schema);
		}
		case 'snow': {
			// the section is optional, and a profile without it has no snow
			return lerpSnow(a ?? {}, b, t, schema);
		}
		case 'heightFog':
		case 'volumetricFog': {
			return lerpFlowNoise(a, b, t, schema);
		}
		case 'lensFlare': {
			return lerpLensFlare(a, b, t);
		}
		default: {
			return lerpObject(a, b, t, schema);
		}
	}
};

/** lerps two objects field by field, as their schema says */
const lerpObject = (
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	t: number,
	schema: BlendSchema,
): Record<string, unknown> => {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(b)) {
		out[key] = lerpValue(schema[key], a[key], b[key], t);
	}
	return out;
};

/** @returns `a` before ½, else `b` (or `b` when `a` is missing) */
const switchValue = (a: unknown, b: unknown, t: number): unknown => (t < 0.5 && a !== undefined ? a : b);

const lerpValue = (
	blend: FieldBlend | BlendSchema | undefined,
	a: unknown,
	b: unknown,
	t: number,
): unknown => {
	if (typeof blend === 'object') {
		return isRecord(a) && isRecord(b) ? lerpObject(a, b, t, blend) : switchValue(a, b, t);
	}
	if (blend !== 'lerp' && blend !== 'round') {
		return switchValue(a, b, t);
	}
	const lerp = (x: number, y: number): number => {
		const value = x + (y - x) * t;
		return blend === 'round' ? Math.round(value) : value;
	};
	if (typeof a === 'number' && typeof b === 'number') {
		return lerp(a, b);
	}
	if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && isNumbers(a) && isNumbers(b)) {
		return Array.from({ length: b.length }, (_, i) => lerp(a[i], b[i]));
	}
	return switchValue(a, b, t);
};

const isNumbers = (value: unknown): value is number[] =>
	Array.isArray(value) && value.every((v) => typeof v === 'number');

const isPitchYaw = (value: unknown): value is [number, number] =>
	Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'number');

/** lerps a pitch and yaw (degrees), turning the yaw the short way round */
const lerpPitchYaw = (
	a: readonly [number, number],
	b: readonly [number, number],
	t: number,
): [number, number] => {
	const yaw = ((((b[1] - a[1]) % 360) + 540) % 360) - 180;
	return [a[0] + (b[0] - a[0]) * t, a[1] + yaw * t];
};

/**
 * the light lerp's directions: each effect's direction in effect on either side (its own, or the sun's per
 * its mode) lerps as a pitch and yaw, so every direction stays a unit vector between the two. the game's own
 * direction lerp isn't known
 */
const lerpLight = (
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	t: number,
	schema: BlendSchema,
): Record<string, unknown> => {
	const out = lerpObject(a, b, t, schema);
	const sunA = a.directPitchYaw;
	const sunB = b.directPitchYaw;
	if (!isPitchYaw(sunA) || !isPitchYaw(sunB)) {
		return out;
	}
	out.directPitchYaw = lerpPitchYaw(sunA, sunB, t);
	for (const effect of SUN_EFFECTS) {
		const modeKey = `${effect}PitchYawMode`;
		const key = `${effect}PitchYaw`;
		const own = (side: Record<string, unknown>, sun: [number, number]): [number, number] => {
			const value = side[key];
			return side[modeKey] === 1 && isPitchYaw(value) ? value : sun;
		};
		if (a[modeKey] !== 1 && b[modeKey] !== 1) {
			// both follow the sun, and still do
			out[modeKey] = 0;
			continue;
		}
		out[modeKey] = 1;
		out[key] = lerpPitchYaw(own(a, sunA), own(b, sunB), t);
	}
	return out;
};

/**
 * the fog lerp: a negative `rayleighScatteringScale` defers to the atmosphere's, so where only one side
 * defers, it takes its atmosphere's scale before the lerp. how the game blends the deferral isn't known
 */
const lerpFog = (
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	atmospheres: { from: Record<string, unknown>; to: Record<string, unknown> },
	t: number,
	schema: BlendSchema,
): Record<string, unknown> => {
	const key = 'rayleighScatteringScale';
	const scaleA = number(a[key]);
	const scaleB = number(b[key]);
	if (scaleA < 0 === scaleB < 0) {
		return lerpObject(a, b, t, schema);
	}
	return lerpObject(
		scaleA < 0 ? { ...a, [key]: number(atmospheres.from[key]) } : a,
		scaleB < 0 ? { ...b, [key]: number(atmospheres.to[key]) } : b,
		t,
		schema,
	);
};

/** a side of a lerp that shows, and how strongly */
interface Shown<T> {
	side: T;
	weight: number;
}

/**
 * the game's crossfade between two versions of a feature that can't lerp: the first fades out to the halfway
 * point, then the second fades in
 */
const crossFade = <T>(a: T, b: T, t: number): Shown<T> =>
	t < 0.5 ? { side: a, weight: 1 - 2 * t } : { side: b, weight: 2 * t - 1 };

/** the game's fade of a feature only one side has: it fades in from nothing, with that side's settings */
const oneSided = <T>(a: T, b: T, aHasIt: boolean, t: number): Shown<T> =>
	aHasIt ? { side: a, weight: 1 - t } : { side: b, weight: t };

/** the game's cloud lerp: a changed panorama fades out to the halfway point and the new one fades in */
const lerpCloud = (
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	t: number,
	schema: BlendSchema,
): Record<string, unknown> => {
	const out = lerpObject(a, b, t, schema);
	const aOn = a.enable === true && a.cloudTexture !== null;
	const bOn = b.enable === true && b.cloudTexture !== null;
	let shown: Shown<Record<string, unknown>>;
	if (aOn !== bOn) {
		out.enable = true;
		shown = oneSided(a, b, aOn, t);
	} else if (aOn && a.cloudTexture !== b.cloudTexture) {
		shown = crossFade(a, b, t);
	} else {
		return out;
	}
	const { side, weight } = shown;
	out.cloudTexture = side.cloudTexture;
	out.cloudFadeAlpha = (typeof side.cloudFadeAlpha === 'number' ? side.cloudFadeAlpha : 1) * weight;
	return out;
};

/** falling-rain fields the game's `HGRainConfig.Lerp` takes from the enabled side when only one enables rain */
const FALLING_RAIN_FIELDS = [
	'speed',
	'streakLength',
	'horizontalRainAngle',
	'horizontalRainLevel',
	'sceneEffectRainJitterLevel',
	'sceneEffectRainWidthScale',
	'sceneEffectRainLightingPercent',
	'rainCenterBias',
	'middleRainLayerSpeedDiffMultiplier',
	'middleRainAlphaMultiplier',
	'middleHorizontalRainAngle',
	'middleHorizontalRainLevel',
	'middleRainLightingPercent',
	'farRainLayerSpeedDiffMultiplier',
	'farRainAlphaMultiplier',
	'farRainHorizontalRainAngle',
	'farRainHorizontalRainLevel',
	'rainWaveVerticalSpeed',
	'rainWaveHorizontalSpeed',
	'rainWaveBottomFadeFactor',
	'screenDropMaxCountLim',
	'screenDropMinMaxLifeTime',
	'screenDropMinMaxSize',
	'screenDropCentroidFadeParam',
	'screenDropFlowPercent',
	'screenDropMinMaxSpeed',
	'screenDropJitterSpeedScale',
	'screenRainDropEdgeSharpness',
	'rainSplashSpeed',
	'rainSplashMinMaxSize',
	'rainSplashLightingPercent',
	'rainDirection',
	'middleRainDirection',
	'farRainDirection',
];

/** wetness fields the game's `HGRainConfig.Lerp` takes from the side with wetness on, when only one has it */
const WETNESS_FIELDS = [
	'enableWetnessAffectSSR',
	'wetnessBasePorosity',
	'wetnessPorosityFactor',
	'baseWetnessLevel',
	'verticalWetnessScalar',
	'verticalFlowSpeed',
	'verticalFlowNormalStrength',
	'verticalFlowSurfaceThreshold',
	'verticalFlowPorosityBias',
	'rippleFrequency',
	'rippleNormalStrength',
	'rippleWaveSpeed',
	'rippleWaveNormalStrength',
	'farSceneWetnessDistanceFactor',
	'farSceneWetnessValue',
	'rippleRoughnessMaskThreshold',
	'wetnessProceduralForWater',
];

/** scales a 4-channel colour from `[0, 0, 0, 0]` by `weight` */
const fadeColor = (value: unknown, weight: number): unknown =>
	isNumbers(value) && value.length === 4 ? value.map((c) => c * weight) : value;

/** normalized lerp of two 3D direction vectors (approximates Unity's `Vector3.Slerp`) */
const slerpDirection = (a: unknown, b: unknown, t: number): unknown => {
	if (!isNumbers(a) || !isNumbers(b) || a.length !== 3 || b.length !== 3) {
		return switchValue(a, b, t);
	}
	const x = a[0] + (b[0] - a[0]) * t;
	const y = a[1] + (b[1] - a[1]) * t;
	const z = a[2] + (b[2] - a[2]) * t;
	const len = Math.hypot(x, y, z);
	return len > 1e-6 ? [x / len, y / len, z / len] : b;
};

/**
 * the game's `HGRainConfig.Lerp`: falling rain and wetness blend independently. when only one side enables
 * falling rain, its settings stay and intensity, wave alpha, splash count/alpha, and colours fade from 0.
 * when only one side enables wetness, its settings stay and `wetness` fades from 0
 */
const lerpRain = (
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	t: number,
	schema: BlendSchema,
): Record<string, unknown> => {
	const out = lerpObject(a, b, t, schema);
	const rainA = a.enable === true;
	const rainB = b.enable === true;
	if (rainA !== rainB) {
		const { side, weight } = oneSided(a, b, rainA, t);
		for (const key of FALLING_RAIN_FIELDS) {
			if (key in side) {
				out[key] = side[key];
			}
		}
		out.enable = true;
		out.intensity = number(side.intensity) * weight;
		if ('color' in side) {
			out.color = fadeColor(side.color, weight);
		}
		if ('screenDropColor' in side) {
			out.screenDropColor = fadeColor(side.screenDropColor, weight);
		}
		if ('rainWaveAlpha' in side) {
			out.rainWaveAlpha = number(side.rainWaveAlpha) * weight;
		}
		if ('rainSplashCount' in side) {
			out.rainSplashCount = Math.round(number(side.rainSplashCount) * weight);
		}
		if ('rainSplashAlpha' in side) {
			out.rainSplashAlpha = number(side.rainSplashAlpha) * weight;
		}
	} else if (rainA && rainB) {
		out.enable = true;
		for (const key of ['rainDirection', 'middleRainDirection', 'farRainDirection']) {
			if (key in a && key in b) {
				out[key] = slerpDirection(a[key], b[key], t);
			}
		}
	} else {
		out.enable = false;
	}
	const wetA = a.enableWetness === true;
	const wetB = b.enableWetness === true;
	if (wetA !== wetB) {
		const { side, weight } = oneSided(a, b, wetA, t);
		for (const key of WETNESS_FIELDS) {
			if (key in side) {
				out[key] = side[key];
			}
		}
		out.enableWetness = true;
		out.wetness = number(side.wetness) * weight;
	}
	return out;
};

/**
 * the game's `HGSnowConfig.Lerp`: when only one side enables snow, its settings stay and `intensity` and
 * `color` fade from 0; when both enable snow, `snowDirection` slerps
 */
const lerpSnow = (
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	t: number,
	schema: BlendSchema,
): Record<string, unknown> => {
	const snowA = a.enable === true;
	const snowB = b.enable === true;
	if (!snowA && !snowB) {
		return { ...a, ...b, enable: false };
	}
	if (snowA !== snowB) {
		const { side, weight } = oneSided(a, b, snowA, t);
		return {
			...side,
			enable: true,
			intensity: number(side.intensity) * weight,
			color: fadeColor(side.color, weight),
		};
	}
	const out = lerpObject(a, b, t, schema);
	out.enable = true;
	if ('snowDirection' in a && 'snowDirection' in b) {
		out.snowDirection = slerpDirection(a.snowDirection, b.snowDirection, t);
	}
	return out;
};

const number = (value: unknown): number => (typeof value === 'number' ? value : 0);

/** the height-fog sections' lerp for their flow noise (docs/game-data/sky-and-fog.md#flow-noise) */
const lerpFlowNoise = (
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	t: number,
	schema: BlendSchema,
): Record<string, unknown> => {
	const out = lerpObject(a, b, t, schema);
	const aOn = a.enableFlowNoise === true;
	const bOn = b.enableFlowNoise === true;
	const keep = (from: Record<string, unknown>): void => {
		for (const key of ['flowNoiseSpeed', 'flowNoiseTilling', 'flowNoiseDir']) {
			out[key] = from[key];
		}
	};
	if (aOn && bOn) {
		// Unity's Mathf.Approximately
		const close = (key: string): boolean => {
			const x = number(a[key]);
			const y = number(b[key]);
			return Math.abs(x - y) < Math.max(Math.max(Math.abs(x), Math.abs(y)) * 1e-6, 8 * 1.401298e-45);
		};
		if (close('flowNoiseSpeed') && close('flowNoiseTilling')) {
			return out;
		}
		const { side, weight } = crossFade(a, b, t);
		keep(side);
		out.flowNoiseIntensity = weight * number(side.flowNoiseIntensity);
	} else if (aOn !== bOn) {
		const { side, weight } = oneSided(a, b, aOn, t);
		keep(side);
		out.enableFlowNoise = true;
		out.flowNoiseDistance = side.flowNoiseDistance;
		out.flowNoiseIntensity = number(side.flowNoiseIntensity) * weight;
	} else {
		for (const key of [
			'enableFlowNoise',
			'flowNoiseIntensity',
			'flowNoiseDistance',
			'flowNoiseSpeed',
			'flowNoiseTilling',
			'flowNoiseDir',
		]) {
			out[key] = a[key];
		}
	}
	return out;
};

/** @returns an enabled lens flare section with its intensity scaled by `weight` */
const faded = (from: Record<string, unknown>, weight: number): Record<string, unknown> => ({
	...from,
	enable: true,
	intensity: number(from.intensity) * weight,
});

/**
 * the game's lens flare lerp: a flare on one side only fades in from nothing with that side's settings; with
 * a flare on both sides, the first fades out to the halfway point and the second fades in
 */
const lerpLensFlare = (
	a: Record<string, unknown> | undefined,
	b: Record<string, unknown>,
	t: number,
): Record<string, unknown> => {
	const aOn = a?.enable === true;
	const bOn = b.enable === true;
	if (aOn === bOn) {
		if (a !== undefined && aOn) {
			const { side, weight } = crossFade(a, b, t);
			return faded(side, weight);
		}
		return a ?? b;
	}
	// without a section under it, `a` has no flare and `b` is the side with one
	const { side, weight } = oneSided(a ?? b, b, aOn, t);
	return faded(side, weight);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

// #endregion

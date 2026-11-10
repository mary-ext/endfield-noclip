/**
 * the sky beyond the atmosphere as the game packs it: the sun disc of the profile's `sky` section, the stars
 * and nebula of its `star` section and the planets of its `celestial` section
 * (docs/game-data/sky-and-fog.md#beyond-the-atmosphere). `render/sky/celestial.ts` draws it.
 *
 * @module
 */

import type {
	CelestialAtmosphereObjectConfig,
	CelestialConfig,
	EnvironmentMaterial,
	LightConfig,
	SkyConfig,
	StarConfig,
} from '@endfield-noclip/package-format/environment';
import type { Color, Vec3, Vec4 } from '@endfield-noclip/package-format/values';

import { linearRgb } from '../math/color.ts';
import { times3Columns } from '../math/mat3.ts';
import { normalize } from '../math/vec3.ts';

import { exposedSunIntensity, type SunDirections, towardsEffectLight, towardsLight } from './sun.ts';

// #region look

/** the nebula painted over the sky */
export interface NebulaLook {
	texture: number;
	/** the raw tint × 2, as the game adds it */
	tint: Vec3;
	/** radians about the vertical */
	rotation: number;
	/** how far the sky planets hide it */
	planetMask: number;
}

/** the procedural star field */
export interface StarLook {
	/** the density map, or `null` for none (no stars show, as with the game's black fallback) */
	densityTexture: number | null;
	/** the game's `_SkyBoxStarParam0..6` */
	params: [Vec4, Vec4, Vec4, Vec4, Vec4, Vec4, Vec4];
}

/** the ray-traced planet (`HGRP/Planet/PlanetBillboard`), in its material's units (metres) */
export interface RayPlanetLook {
	textures: { base: number; rsm: number; clouds: number; lut: number };
	/** world position of the centre */
	center: Vec3;
	radius: number;
	groundRadius: number;
	topRadius: number;
	cloudRadius: number;
	viewSamples: number;
	scaleHeights: [rayleigh: number, mie: number];
	mieAnisotropy: number;
	useLut: boolean;
	rayleigh: Vec3;
	mie: Vec3;
	brightness: number;
	cloudShadows: boolean;
	/** towards its light, or `null` for the scene's sun */
	light: Vec3 | null;
	/** the surface's light colour, or `null` for the scene's sun; multiplied by `lightScale` */
	lightColor: Vec3 | null;
	lightScale: number;
	/** columns of the texture-space tilt */
	tilt: [Vec3, Vec3, Vec3];
	spin: number;
	/** the base colour map's scale (xy) and offset (zw) */
	baseTransform: Vec4;
	tint: Vec3;
	seaShallow: Vec3;
	seaDeep: Vec3;
	fresnel: Vec3;
	indirect: Vec3;
	cloudShadow: Vec3;
	ambient: Vec3;
	cloudAlpha: number;
	cloudBrightness: number;
	roughness: number;
	roughnessFromMap: boolean;
}

/** a planet painted on the sky dome (`HGRP/SkydomeStar`) */
export interface SkyPlanetLook {
	textures: { main: number | null; emissive: number | null; ring: number | null };
	/** unit direction to the centre */
	center: Vec3;
	/** the planet's axes: up (pole), forward (u = 0), right (u sign) */
	up: Vec3;
	forward: Vec3;
	right: Vec3;
	/** towards its light */
	light: Vec3;
	/** radius at unit distance (the sine of its angular radius) */
	radius: number;
	/** ring: shadow scale, radial scale and offset (radial scale 0 = no ring) */
	ring: [shadowScale: number, radialScale: number, radialOffset: number];
	ringColor: [r: number, g: number, b: number, a: number];
	color: Vec3;
	emissive: Vec3;
	sharpness: number;
	backFace: number;
	ringShadowSoftness: number;
	/** 1 to fade it out below the horizon */
	horizonFade: number;
	/** the atmosphere rim, or `null` without one */
	atmosphere: {
		/** rim lit all round (1) or only on the lit side (0) */
		unlit: number;
		height: number;
		viewSamples: number;
		scattering: number;
		lightSamples: number;
		falloff: number;
		brightness: number;
		hueShift: number;
		/** planet radius and distance, in the same units as the height */
		planetRadius: number;
		distance: number;
	} | null;
}

/** the sun disc added onto the sky (`_SunDiscParam0..2`) */
export interface SunDiscLook {
	/** unit vector towards the sun */
	direction: Vec3;
	/** the raw disc colour times the light's intensity over π and the sky's lux factor (pre-exposed) */
	color: Vec3;
	/** the lobe's exponent, `8 · radius^0.65` */
	sharpness: number;
	/** how far the lobe's soft skirt shows, 0 to 1 */
	ramp: number;
}

/** everything beyond the atmosphere; parts not drawn are `null` */
export interface CelestialLook {
	sun: SunDiscLook | null;
	nebula: NebulaLook | null;
	stars: StarLook | null;
	ray: RayPlanetLook | null;
	sky: [SkyPlanetLook | null, SkyPlanetLook | null];
}

/** nothing beyond the atmosphere */
export const NO_CELESTIAL: CelestialLook = {
	sun: null,
	nebula: null,
	stars: null,
	ray: null,
	sky: [null, null],
};

/** the profile sections the sky's celestial layers come from; a missing one draws nothing of its layers */
export interface CelestialInput {
	celestial?: CelestialConfig;
	star?: StarConfig;
	sky?: Pick<
		SkyConfig,
		'enableSunDisc' | 'sunDiscRadius' | 'sunDiscRampIntensity' | 'sunDiscColor' | 'proceduralSkyLuxFactor'
	>;
	light?: Pick<LightConfig, 'directLux' | 'directEV100'> & SunDirections<'sunDisc'>;
}

const DEG = Math.PI / 180;

const rgb = (c: readonly number[] | undefined, scale = 1): Vec3 =>
	c === undefined ? [0, 0, 0] : [c[0] * scale, c[1] * scale, c[2] * scale];

/** a gamma-encoded colour linearised, as Unity's `Color.linear` does, times `scale` */
const linear = (c: Readonly<Color> | undefined, scale = 1): Vec3 =>
	rgb(c === undefined ? undefined : linearRgb(c), scale);

const nebulaLook = (star: StarConfig | undefined): NebulaLook | null => {
	if (star === undefined || !star.enableNebula || star.nebulaMap === null) {
		return null;
	}
	return {
		texture: star.nebulaMap,
		tint: rgb(star.nebulaTint, 2),
		rotation: star.nebulaMapRotation * DEG,
		planetMask: star.celestialNebulaConverage,
	};
};

/** the star config's fields as the game packs them: as they are, colours raw */
const starLook = (star: StarConfig | undefined): StarLook | null => {
	if (star === undefined || !star.enableStars) {
		return null;
	}
	const tint = star.starsTint;
	const tint1 = star.starsTint1;
	return {
		densityTexture: star.skyBoxStarRangeMap,
		params: [
			[1 - star.starsDensity, star.starsExposure, star.starsTilling, star.starsFlickerSpeed],
			[tint[0], tint[1], tint[2], star.thresholdSoftness],
			[tint1[0], tint1[1], tint1[2], star.starDensityMapMaskThres],
			[
				star.minMaxRange[0],
				star.minMaxRange[1],
				star.cloudRingStarCoverage,
				star.skyBoxStarDensityMapRotation,
			],
			[star.brightnessRandomSeed, star.debugMode, star.nebulaMapRotation, star.nebulaStarConverage],
			[star.nebulaTint[0], star.nebulaTint[1], star.nebulaTint[2], star.starRingStarCoverage],
			[star.colorRandomSeed, star.distributionRandomSeed, star.celestialNebulaConverage, 0],
		],
	};
};

/**
 * a material's properties by their Unity names. the package fills in every property the shader declares, so a
 * missing one is a shader that doesn't declare it, read as 0
 */
const propertiesOf = (material: EnvironmentMaterial) => ({
	float: (name: string): number => material.floats[name] ?? 0,
	color: (name: string): Color | undefined => material.colors[name],
	texture: (name: string): number | null => material.textures[name] ?? null,
	transform: (name: string): Vec4 | undefined => material.textureTransforms[name],
});

/**
 * the ray-traced planet's constants, which the game fills from the material: floats and vectors as stored,
 * colours linearised
 */
const rayPlanetLook = (material: EnvironmentMaterial): RayPlanetLook | null => {
	const { float: f, color, texture, transform } = propertiesOf(material);
	const base = texture('_BaseColorMap');
	const rsm = texture('_RSM');
	const clouds = texture('_CloudsTexMain');
	const lut = texture('_TransmittanceLLUT');
	if (base === null || rsm === null || clouds === null || lut === null) {
		return null;
	}
	const radius = f('_RealPlanetRadius');
	const offset = f('_GlobalRadiusOffset');
	const groundRadius = 0.92 * radius + offset;
	const topRadius = f('_AtmosphereRatios') * radius + offset;
	const rayleighHeight = 0.06 * (topRadius - groundRadius);
	const density = f('_Density_Multiplier');
	const phi = f('_Phi2') * DEG;
	const theta = f('_Theta2') * DEG;
	const distance = f('_Dist');
	const origin = rgb(color('_PlanetWSBase'));
	const pitch = f('_Pitch') * DEG;
	const roll = f('_Roll') * DEG;
	const ambient = color('_Ambient') ?? [0, 0, 0, 0];
	return {
		textures: { base, rsm, clouds, lut },
		center: [
			origin[0] - Math.sin(phi) * distance,
			origin[1] + Math.sin(theta) * distance,
			origin[2] - Math.cos(theta) * Math.cos(phi) * distance,
		],
		radius,
		groundRadius,
		topRadius,
		cloudRadius: radius + f('_CloudsHeight'),
		viewSamples: f('_StepsI'),
		scaleHeights: [rayleighHeight, rayleighHeight * f('_Mie_Height_Scale')],
		mieAnisotropy: f('_g'),
		useLut: f('_Use_Lut') !== 0,
		rayleigh: linear(color('_Ray'), density),
		mie: linear(color('_Mie'), density),
		brightness: f('_Light_Intensity_Multiplier'),
		cloudShadows: material.keywords.split(' ').includes('_ENABLE_CLOUDS_SHADOW'),
		light: f('_CustomLightDirection') !== 0 ? normalize(rgb(color('_CustomLightDir'))) : null,
		lightColor: f('_CustomLightColorPla') !== 0 ? linear(color('_CustomLightColPla')) : null,
		lightScale: f('_DirectLightIntensityBillboard'),
		tilt: [
			[Math.cos(roll), -Math.sin(roll) * Math.cos(pitch), Math.sin(roll) * Math.sin(pitch)],
			[Math.sin(roll), Math.cos(roll) * Math.cos(pitch), -Math.cos(roll) * Math.sin(pitch)],
			[0, Math.sin(pitch), Math.cos(pitch)],
		],
		spin: f('_PlanetRotateStart') * 0.001,
		baseTransform: transform('_BaseColorMap') ?? [1, 1, 0, 0],
		tint: linear(color('_TintColor') ?? [1, 1, 1, 1]),
		seaShallow: linear(color('_SeaShallow')),
		seaDeep: linear(color('_SeaDeep')),
		fresnel: linear(color('_FresnelColor')),
		indirect: linear(color('_IndirectColor'), f('_IndirectIntensity')),
		cloudShadow: linear(color('_CloudsShadowColor') ?? [1, 1, 1, 1]),
		ambient: linear(ambient, density * ambient[3]),
		cloudAlpha: f('_CloudsAlphaMain'),
		cloudBrightness: f('_Light_Intensity_Clouds_Multiplier'),
		roughness: f('_Roughness'),
		roughnessFromMap: f('_UseRoughnessMap') !== 0,
	};
};

/** a 3×3 rotation as columns; Unity's quaternions rotate with the same matrices as a right-handed frame */
type Mat3 = [Vec3, Vec3, Vec3];

/** `Quaternion.AngleAxis(degrees, axis)` as a matrix (Rodrigues) */
const angleAxis = (degrees: number, axis: Vec3): Mat3 => {
	const [x, y, z] = normalize(axis);
	const c = Math.cos(degrees * DEG);
	const s = Math.sin(degrees * DEG);
	const t = 1 - c;
	return [
		[t * x * x + c, t * x * y + s * z, t * x * z - s * y],
		[t * x * y - s * z, t * y * y + c, t * y * z + s * x],
		[t * x * z + s * y, t * y * z - s * x, t * z * z + c],
	];
};

/** `Quaternion.Euler(x, y, z)`: z first, then x, then y */
const euler = (x: number, y: number, z: number): Mat3 => {
	const rz = angleAxis(z, [0, 0, 1]);
	const rx = angleAxis(x, [1, 0, 0]);
	const ry = angleAxis(y, [0, 1, 0]);
	const columns = rz.map((column) => times3Columns(ry, times3Columns(rx, column)));
	return [columns[0], columns[1], columns[2]];
};

/**
 * a material colour as `Material.SetColor` hands it to a shader in linear colour space. HDR colours (any
 * channel past 1) are taken as authored linear, as for emission
 */
const materialColor = (c: Readonly<Color> | undefined, fallback: Color): Vec3 => {
	const color = c ?? fallback;
	return color[0] > 1 || color[1] > 1 || color[2] > 1 ? rgb(color) : linearRgb(color);
};

/**
 * a planet painted on the sky dome, as the game packs it: a sphere seen at the distance `moon.orbitRadius −
 * moon.radius` (the moon is the body the map stands on), along its pitch and yaw
 */
const skyPlanetLook = (
	planet: CelestialAtmosphereObjectConfig,
	moon: CelestialConfig['moonConfig'],
): SkyPlanetLook | null => {
	const material = planet.skydomeDrawer.drawMaterial;
	if (!planet.drawPlanetInSkydome || material === null) {
		return null;
	}
	const { float, color, texture } = propertiesOf(material);
	const property = planet.objectProperty;
	const distance = moon.orbitRadius - moon.radius;
	if (distance <= 0) {
		return null;
	}
	// the body's frame: tilted, then spun about its pole. the game hands its right vector over as "forward"
	// and its forward as "right"; the shader reads them that way
	const tilt = euler(property.selfTiltX, 0, property.selfTiltZ);
	const up = times3Columns(tilt, [0, 1, 0]);
	const spin = angleAxis(property.selfRotationY, up);
	const right = times3Columns(spin, times3Columns(tilt, [1, 0, 0]));
	const front = times3Columns(spin, times3Columns(tilt, [0, 0, 1]));

	const ring = planet.ring;
	let ringParams: SkyPlanetLook['ring'] = [0, 0, 0];
	if (planet.enableRing && ring.width > 0) {
		const outer = Math.min(ring.outerRadius, distance - 10);
		ringParams = [distance / outer, distance / ring.width, (ring.width - outer) / ring.width];
	}
	const ringColor = ring.ringColor;
	const atmosphere = planet.enableAtmosphere ? planet.atmosphere : null;
	return {
		textures: {
			main: texture('_MainTex'),
			emissive: texture('_EmissiveTex'),
			ring: ringParams[1] === 0 ? null : texture('_RingTex'),
		},
		center: towardsLight(planet.skydomeDrawer.pitchYaw),
		up,
		forward: right,
		right: front,
		light: towardsLight(planet.skydomeDrawer.incidentLightingPitchYaw),
		radius: property.radius / distance,
		ring: ringParams,
		ringColor: [...linearRgb(ringColor), ringColor[3]],
		color: materialColor(color('_Color'), [1, 1, 1, 1]),
		emissive: materialColor(color('_PlanetEmissive'), [1, 1, 1, 1]),
		sharpness: float('_StarNdlSharp'),
		backFace: float('_StarBackFaceAlpha'),
		ringShadowSoftness: float('_RingShadowSoftness'),
		horizonFade: planet.drawPlanetBelowHorizon ? 1 : 0,
		atmosphere:
			atmosphere === null
				? null
				: {
						unlit: atmosphere.bakeFaceVisibility ? 1 : 0,
						height: atmosphere.atmosphereHeight,
						viewSamples: Math.min(Math.max(atmosphere.numInscatteredSamplePoints, 0), 10),
						scattering: atmosphere.coff_R,
						lightSamples: Math.min(Math.max(atmosphere.numOpticalDepthSamplePoints, 0), 5),
						falloff: Math.max(30 - atmosphere.heightScale_R, 1e-4),
						brightness: atmosphere.atmosphereBrightness,
						hueShift: atmosphere.atmosphereHueshift,
						// the game centres the rim 2000 units out, with the disc's angular size
						planetRadius: (property.radius / distance) * SKY_PLANET_DISTANCE,
						distance: SKY_PLANET_DISTANCE,
					},
	};
};

/** how far out the game places the sky planets' atmosphere rims */
const SKY_PLANET_DISTANCE = 2000;

/**
 * the sun disc as the game packs it: the raw colour, scaled by the light's intensity over π and the sky's lux
 * factor
 */
const sunDiscLook = (sky: CelestialInput['sky'], light: CelestialInput['light']): SunDiscLook | null => {
	if (sky === undefined || light === undefined || !sky.enableSunDisc) {
		return null;
	}
	const scale = (exposedSunIntensity(light) / Math.PI) * sky.proceduralSkyLuxFactor;
	if (scale <= 0) {
		return null;
	}
	return {
		direction: towardsEffectLight(light, 'sunDisc'),
		color: rgb(sky.sunDiscColor, scale),
		sharpness: 8 * Math.max(sky.sunDiscRadius, 0) ** 0.65,
		ramp: sky.sunDiscRampIntensity,
	};
};

/**
 * @param input the blended profile's sections, or `null` for the defaults (nothing beyond the atmosphere)
 * @returns what to draw beyond the atmosphere
 */
export const celestialLook = (input: CelestialInput | null): CelestialLook => {
	const { celestial, star, sky, light } = input ?? {};
	const sun = sunDiscLook(sky, light);
	if (celestial === undefined) {
		return { ...NO_CELESTIAL, sun, nebula: nebulaLook(star), stars: starLook(star) };
	}
	const advanced = celestial.advancedPlanetConfig;
	return {
		sun,
		nebula: nebulaLook(star),
		stars: starLook(star),
		ray:
			advanced.drawAdvancedPlanet && advanced.advancedPlanetMat !== null
				? rayPlanetLook(advanced.advancedPlanetMat)
				: null,
		sky: [
			skyPlanetLook(celestial.planetConfig, celestial.moonConfig),
			skyPlanetLook(celestial.talosAlphaConfig, celestial.moonConfig),
		],
	};
};

// #endregion

// #region textures

/** the textures the celestial layer binds, in its binding order from 3 */
export const CELESTIAL_TEXTURE_SLOTS = [
	'nebula',
	'rayBase',
	'rayRsm',
	'rayClouds',
	'rayLut',
	'sky0Main',
	'sky0Emissive',
	'sky0Ring',
	'sky1Main',
	'sky1Emissive',
	'sky1Ring',
	'starDensity',
] as const;

/** a texture the celestial layer binds */
export type CelestialTextureSlot = (typeof CELESTIAL_TEXTURE_SLOTS)[number];

/**
 * @param look what to draw beyond the atmosphere
 * @returns each slot's texture-table id, or `null` for none
 */
export const celestialTextures = (look: CelestialLook): Record<CelestialTextureSlot, number | null> => ({
	nebula: look.nebula?.texture ?? null,
	rayBase: look.ray?.textures.base ?? null,
	rayRsm: look.ray?.textures.rsm ?? null,
	rayClouds: look.ray?.textures.clouds ?? null,
	rayLut: look.ray?.textures.lut ?? null,
	sky0Main: look.sky[0]?.textures.main ?? null,
	sky0Emissive: look.sky[0]?.textures.emissive ?? null,
	sky0Ring: look.sky[0]?.textures.ring ?? null,
	sky1Main: look.sky[1]?.textures.main ?? null,
	sky1Emissive: look.sky[1]?.textures.emissive ?? null,
	sky1Ring: look.sky[1]?.textures.ring ?? null,
	starDensity: look.stars?.densityTexture ?? null,
});

// #endregion

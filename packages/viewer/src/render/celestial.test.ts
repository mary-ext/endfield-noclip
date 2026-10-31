import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
	CelestialAtmosphereObjectConfig,
	CelestialConfig,
	EnvironmentMaterial,
	StarConfig,
} from '@endfield-noclip/package-format/environment';

import { type CelestialInput, celestialLook } from './celestial.ts';

const material = (overrides: Partial<EnvironmentMaterial>): EnvironmentMaterial => ({
	shader: 'HGRP/SkydomeStar',
	keywords: '',
	floats: {},
	colors: {},
	textures: {},
	textureTransforms: {},
	...overrides,
});

const skyPlanet = (drawn: boolean): CelestialAtmosphereObjectConfig => ({
	drawPlanetInSkydome: drawn,
	drawPlanetBelowHorizon: false,
	objectProperty: { radius: 1000, selfTiltX: 0, selfTiltZ: 0, selfRotationY: 0 },
	skydomeDrawer: {
		drawMode: 1,
		drawMaterial: material({ textures: { _MainTex: 1 } }),
		pitchYaw: [30, 0],
		incidentLightingPitchYaw: [45, 90],
	},
	enableRing: true,
	ring: { outerRadius: 3000, width: 1000, ringColor: [1, 1, 1, 1], planetRingMap: null },
	enableAtmosphere: false,
	atmosphere: {
		bakeFaceVisibility: false,
		atmosphereHeight: 10,
		numInscatteredSamplePoints: 4,
		numOpticalDepthSamplePoints: 4,
		coff_R: 1,
		heightScale_R: 10,
		atmosphereBrightness: 1,
		atmosphereHueshift: 0,
	},
});

const celestial = (overrides: Partial<CelestialConfig>): CelestialConfig => ({
	moonConfig: {
		radius: 1000,
		orbitRadius: 11000,
		enableRing: false,
		drawPlanetBelowHorizon: false,
		worldLongitude: 0,
		worldLatitude: 0,
		rotationAroundUp: 0,
		ring: { outerRadius: 0, width: 0, ringColor: [0, 0, 0, 0], planetRingMap: null },
	},
	talosAlphaConfig: skyPlanet(false),
	planetConfig: skyPlanet(true),
	advancedPlanetConfig: { drawAdvancedPlanet: false, advancedPlanetMat: null },
	...overrides,
});

describe('celestialLook', () => {
	it('draws only the sky planets the phase puts in the sky dome', () => {
		const look = celestialLook({ celestial: celestial({}) });
		assert.notEqual(look.sky[0], null);
		assert.equal(look.sky[1], null);
	});

	it('sizes a sky planet by its distance from the moon it is seen from', () => {
		const planet = celestialLook({ celestial: celestial({}) }).sky[0];
		assert.ok(planet !== null);
		// seen from orbitRadius − radius = 10000
		assert.equal(planet.radius, 0.1);
		// pitch 30 puts it 30° up
		assert.ok(Math.abs(planet.center[1] - 0.5) < 1e-9);
		// the ring's v runs from its inner radius (2000) to its outer radius (3000)
		const [, scale, offset] = planet.ring;
		assert.ok(Math.abs(0.2 * scale + offset) < 1e-9);
		assert.ok(Math.abs(0.3 * scale + offset - 1) < 1e-9);
	});

	it('places the ray-traced planet from its material', () => {
		const advancedPlanetMat = material({
			shader: 'HGRP/Planet/PlanetBillboard',
			floats: { _RealPlanetRadius: 100, _Dist: 1000, _Phi2: 0, _Theta2: -90 },
			colors: { _PlanetWSBase: [0, 0, 0, 0] },
			textures: { _BaseColorMap: 1, _RSM: 2, _CloudsTexMain: 3, _TransmittanceLLUT: 4 },
		});
		const look = celestialLook({
			celestial: celestial({ advancedPlanetConfig: { drawAdvancedPlanet: true, advancedPlanetMat } }),
		});
		assert.ok(look.ray !== null);
		const [x, y, z] = look.ray.center;
		// θ = −90° puts it straight down
		assert.ok(Math.abs(x) < 1e-9 && Math.abs(y + 1000) < 1e-9 && Math.abs(z) < 1e-9);
	});

	it('packs the star density as the game does, inverted', () => {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the fields the stars read
		const star = {
			enableStars: true,
			enableNebula: false,
			starsDensity: 0.015,
			starsTint: [1, 1, 1, 1],
			starsTint1: [1, 1, 1, 1],
			minMaxRange: [100, 1000],
			nebulaTint: [1, 1, 1, 1],
			skyBoxStarRangeMap: 7,
		} as unknown as StarConfig;
		const look = celestialLook({ star });
		assert.equal(look.stars?.densityTexture, 7);
		assert.ok(Math.abs((look.stars?.params[0][0] ?? 0) - 0.985) < 1e-9);
	});

	it('draws the sun disc only where the sky enables it, scaled by the sun and the lux factor', () => {
		const sky: NonNullable<CelestialInput['sky']> = {
			enableSunDisc: true,
			sunDiscRadius: 1,
			sunDiscRampIntensity: 0.25,
			sunDiscColor: [2, 1, 0.5, 1],
			proceduralSkyLuxFactor: 3,
		};
		// a rotation of 180° about y: the light travels along −z, so the sun lies towards +z
		const light: NonNullable<CelestialInput['light']> = {
			rotationSunDisc: [0, 1, 0, 0],
			directIntensityDividePi: 0.5,
		};
		const look = celestialLook({ sky, light });
		assert.ok(look.sun !== null);
		assert.deepEqual(look.sun.color, [3, 1.5, 0.75]);
		assert.equal(look.sun.sharpness, 8);
		assert.equal(look.sun.ramp, 0.25);
		const [x, y, z] = look.sun.direction;
		assert.ok(Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9 && Math.abs(z - 1) < 1e-9);
		assert.equal(celestialLook({ sky: { ...sky, enableSunDisc: false }, light }).sun, null);
		assert.equal(celestialLook({ sky }).sun, null);
	});
});

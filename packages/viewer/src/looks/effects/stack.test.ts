import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ReadyMaterial } from '@endfield-noclip/package-format/materials';
import type {
	EffectSoftBody,
	EffectStackSurface,
	EffectTexture,
	StackLayer,
} from '@endfield-noclip/package-format/surfaces';

import { LOOK_FLOATS, LookFlags } from '../look.ts';
import { materialLooks } from '../material-looks.ts';

import { EffectKind, EffectRole, EffectRow, ROLE_NONE, SLOT_NO_BASE, SlotSource } from './effect-look.ts';
import { NO_WATER_BLEND, OFFSET_SLOT, VertexMotion } from './stack.ts';

/** a ready material drawing `surface` */
const described = (
	surface: ReadyMaterial['surface'],
	cull: ReadyMaterial['cull'] = 'back',
): ReadyMaterial => ({ status: 'ready', cull, surface });

const texture = (id: number, overrides: Partial<EffectTexture> = {}): EffectTexture => ({
	texture: id,
	scale: [1, 1],
	offset: [0, 0],
	scroll: [0, 0],
	rotation: [1, 0],
	customScroll: [0, 0],
	...overrides,
});

const layer = (id: number, role: StackLayer['role'], overrides: Partial<StackLayer> = {}): StackLayer => ({
	...texture(id),
	role,
	redAlpha: false,
	source: 'uv0',
	disturbShare: 0,
	...overrides,
});

/** a VFXBaseV2 stack with a main texture and nothing optional */
const stack = (overrides: Partial<EffectStackSurface> = {}): EffectStackSurface => ({
	kind: 'effectStack',
	variant: 'base',
	layers: [layer(1, 'main'), null, null, null, null, null, null],
	tint: [1, 1, 1, 1],
	blendTint: [1, 1, 1, 0],
	disturb: [0, 0, 0, 0],
	disturbBias: 0,
	distorted: false,
	particleDisturb: false,
	weight: { disturb: 0, dissolve: 0, used: false },
	dissolve: null,
	masked: false,
	fresnel: null,
	soft: null,
	ignorePostExposure: 1,
	vertexColor: true,
	near: null,
	brighten: { threshold: 1, intensity: 0 },
	breathing: null,
	edge: null,
	decalFade: null,
	alphaPower: 1,
	offset: null,
	softBody: null,
	cameraPull: null,
	waterBlendBelow: null,
	lighting: null,
	unfogged: true,
	blendMode: 'over',
	opaque: false,
	screenUv: { byDepth: true, heightAsV: false },
	stencil: null,
	appear: null,
	...overrides,
});

test('a texture stack’s reveal around the player fills the rows past the customScroll ones', () => {
	const params = (appear: EffectStackSurface['appear']) =>
		materialLooks({ entries: [described(stack({ variant: 'advance', appear }))] })[0].params;
	const revealed = params({
		inner: 2,
		outer: -4,
		alphaFar: 0,
		edge: 1,
		noiseScale: 8,
		noiseSpeed: 0.5,
		brightColor: [0, 0, 0, 1],
		brightVertexAlpha: true,
		characterHeight: 0.1,
	});
	assert.deepEqual(
		[...revealed.subarray(EffectRow.appear, EffectRow.appearVertexAlpha + 1)],
		[2, -4, 0, 1, 8, 0.5, Math.fround(0.1), 1, 0, 0, 0, 1, 1],
	);
	// without one the switch stays off
	assert.equal(params(null)[EffectRow.appearNoise + 3], 0);
	assert.ok(EffectRow.appearVertexAlpha < LOOK_FLOATS);
});

test('a texture stack packs each layer’s role, red alpha, source and distortion share into its slot bits', () => {
	const [look] = materialLooks({
		entries: [
			described(
				stack({
					layers: [
						layer(1, 'main', { source: null }),
						layer(2, 'disturb1', { source: 'polar', scale: [3, 0.5] }),
						null,
						null,
						layer(4, 'mask', { redAlpha: true, disturbShare: 0.25, scroll: [0, -0.1], rotation: [0, 1] }),
						null,
						null,
					],
					tint: [2, 0.5, 1, 0.4],
					soft: { distance: 4, bias: 0 },
				}),
			),
		],
	});
	assert.deepEqual(
		[look.queue, look.castsShadows, look.cull, look.flags],
		['effect', false, 'back', LookFlags.Effect],
	);
	assert.deepEqual(look.textures, [1, 2, null, null, 4, null, null]);
	assert.deepEqual(
		[...look.params.subarray(EffectRow.slotBits, EffectRow.slotBits + 5)],
		[
			EffectRole.Main + SLOT_NO_BASE,
			EffectRole.Disturb1 + SlotSource.Polar * 32,
			ROLE_NONE,
			ROLE_NONE,
			// a quarter of the distortion, in 1/1024ths above the low byte
			EffectRole.Mask + 16 + 256 * 256,
		],
	);
	assert.deepEqual([...look.params.subarray(EffectRow.uv + 4, EffectRow.uv + 8)], [3, 0.5, 0, 0]);
	assert.deepEqual(
		[...look.params.subarray(EffectRow.anim + 16, EffectRow.anim + 20)],
		[0, -0.1, 0, 1].map(Math.fround),
	);
	assert.deepEqual(
		[...look.params.subarray(EffectRow.tint, EffectRow.tint + 4)],
		[2, 0.5, 1, 0.4].map(Math.fround),
	);
	assert.equal(look.params[EffectRow.soft], 4);
	assert.deepEqual(
		[...look.params.subarray(EffectRow.unfogged, EffectRow.unfogged + 4)],
		[1, EffectKind.Stack, 0, 1],
	);
});

test('a texture stack keeps each layer’s custom data shift per slot', () => {
	// the anchors' black smoke: the main texture shifts by (1, 1) per unit of custom x, the distortion by (1, 0)
	const [look] = materialLooks({
		entries: [
			described(
				stack({
					layers: [
						layer(1, 'main', { customScroll: [1, 1] }),
						layer(2, 'disturb1', { customScroll: [1, 0] }),
						null,
						null,
						null,
						null,
						null,
					],
				}),
			),
		],
	});
	assert.deepEqual(
		[...look.params.subarray(EffectRow.customScroll, EffectRow.customScroll + 6)],
		[1, 1, 1, 0, 0, 0],
	);
});

test('a stack decal is a box drawn by its back faces with its fades; a multiplying stack draws over the scene', () => {
	const [decal, multiply, opaque] = materialLooks({
		entries: [
			described(
				stack({
					variant: 'decal',
					decalFade: { edge: [0.1, 0.2], width: 0.3, height: 2, heightOffset: 0.5, angle: 5 },
					weight: { disturb: 0.5, dissolve: 0.5, used: true },
				}),
			),
			described(stack({ blendMode: 'multiply' })),
			described(stack({ opaque: true })),
		],
	});
	assert.deepEqual([decal.cull, decal.flags, decal.queue], ['front', LookFlags.Effect, 'effectDecal']);
	assert.deepEqual(
		[...decal.params.subarray(EffectRow.decalFade, EffectRow.decalFade + 4)],
		[0.1, 0.2, 0.3, 2].map(Math.fround),
	);
	assert.deepEqual(
		[...decal.params.subarray(EffectRow.decal, EffectRow.decal + 4)],
		[0.5, 5, Math.fround(NO_WATER_BLEND), 1],
	);
	assert.deepEqual([...decal.params.subarray(EffectRow.weight + 1, EffectRow.weight + 4)], [0.5, 0.5, 1]);
	assert.equal(multiply.queue, 'screenMultiply');
	// opaque layers shade in the main pass, still without casting shadows
	assert.deepEqual([opaque.queue, opaque.castsShadows], ['effectOpaque', false]);
	assert.equal(multiply.params[EffectRow.unfogged + 2], 2);
});

test('a breathing stack keeps its pulse in the decal fade row, which decals don’t share with it', () => {
	const [breathing, still] = materialLooks({
		entries: [described(stack({ breathing: { minAlpha: 0.3, speed: 2, power: 1 } })), described(stack())],
	});
	assert.deepEqual(
		[...breathing.params.subarray(EffectRow.decalFade, EffectRow.decalFade + 4)],
		[0.3, 2, 1, 1].map(Math.fround),
	);
	assert.equal(still.params[EffectRow.decalFade + 3], 0);
});

test('a stack’s edge colour fills the rows past the mesh looks’ 32, marked on even at zero distance', () => {
	const [edged, plain] = materialLooks({
		entries: [
			described(
				stack({ edge: { color: [1.5, 1.5, 1.5, 1], alpha: 0.8, mode: 0, distance: 0, offset: 0.1 } }),
			),
			described(stack()),
		],
	});
	assert.equal(edged.params.length, LOOK_FLOATS);
	assert.deepEqual(
		[...edged.params.subarray(EffectRow.edgeColor, EffectRow.edgeColor + 4)],
		[1.5, 1.5, 1.5, 1],
	);
	assert.deepEqual(
		[...edged.params.subarray(EffectRow.edge, EffectRow.edge + 4)],
		[0, 0.1, 0, 1].map(Math.fround),
	);
	assert.equal(edged.params[EffectRow.edgeAlpha], Math.fround(0.8));
	assert.equal(plain.params[EffectRow.edge + 3], 0);
});

test('a stack’s vertex offset takes the offset slot and rows, and its stencil is tested under reversed-Z', () => {
	const [moved, portal, mask] = materialLooks({
		entries: [
			described(
				stack({
					offset: {
						texture: texture(2, { scale: [1, 0.5], scroll: [0, 0.2] }),
						uv1: true,
						direction: [0, 1, 0],
						space: 'world',
						intensity: 0.5,
						bias: 0,
						vertexAlphaWeight: 0,
						// the collectible pieces' glow (`M_fx_interactive_collection_2102`) masks its offset
						mask: { texture: texture(4, { scale: [2, 2] }), slot: 5, strength: 0.6 },
					},
					alphaPower: 3,
				}),
			),
			described(
				stack({
					stencil: {
						compare: 'equal',
						replace: false,
						reference: 3,
						readMask: 255,
						writeMask: 255,
						depthCompare: 'less-equal',
					},
				}),
			),
			described({
				kind: 'stencilMask',
				stencil: {
					compare: 'always',
					replace: true,
					reference: 3,
					readMask: 255,
					writeMask: 255,
					depthCompare: 'less-equal',
				},
			}),
		],
	});
	assert.equal(moved.textures[OFFSET_SLOT], 2);
	// the fragment stage skips the slot
	assert.equal(moved.params[EffectRow.slotBits + OFFSET_SLOT], ROLE_NONE);
	assert.deepEqual(
		[...moved.params.subarray(EffectRow.uv + OFFSET_SLOT * 4, EffectRow.uv + OFFSET_SLOT * 4 + 4)],
		[1, 0.5, 0, 0],
	);
	assert.deepEqual([...moved.params.subarray(EffectRow.offsetDir, EffectRow.offsetDir + 4)], [0, 1, 0, 1]);
	assert.equal(moved.params[EffectRow.offset], 0.5);
	assert.deepEqual([...moved.params.subarray(EffectRow.offsetMode, EffectRow.offsetMode + 2)], [1, 1]);
	// the mask takes its slot without a role, which the fragment stage skips
	assert.equal(moved.textures[5], 4);
	assert.equal(moved.params[EffectRow.slotBits + 5], ROLE_NONE);
	assert.deepEqual([...moved.params.subarray(EffectRow.uv + 20, EffectRow.uv + 22)], [2, 2]);
	assert.deepEqual(
		[...moved.params.subarray(EffectRow.offsetMask, EffectRow.offsetMask + 2)],
		[5, Math.fround(0.6)],
	);
	assert.equal(portal.params[EffectRow.offsetMask + 1], 0);
	assert.equal(moved.params[EffectRow.decal + 3], 3);
	assert.deepEqual(
		[portal.stencil?.compare, portal.stencil?.depthCompare, portal.queue],
		['equal', 'greater-equal', 'effect'],
	);
	assert.deepEqual([mask.queue, mask.castsShadows, mask.stencil === null], ['stencilMask', false, false]);
});

test('a soft body takes the offset slot for its position texture, with its playback and bounds in the offset rows', () => {
	// map01's Aurelyne blob (`M_erosionmud_core`): 100 frames played at 70 fps, five times over, from HDR offsets
	const body = {
		texture: 3,
		min: [0, 0, 0],
		range: [1, 1, 1],
		frameCount: 100,
		cycleRate: (70 / 99.99) * 5,
		cycleStart: 2,
		fixedFrame: null,
		uScale: 1,
		vScale: 1,
	} satisfies EffectSoftBody;
	const [playing, still] = materialLooks({
		entries: [
			described(stack({ softBody: body })),
			described(stack({ softBody: { ...body, fixedFrame: 49 } })),
		],
	});
	assert.equal(playing.textures[OFFSET_SLOT], 3);
	assert.equal(playing.params[EffectRow.slotBits + OFFSET_SLOT], ROLE_NONE);
	assert.equal(playing.params[EffectRow.offsetMode], VertexMotion.SoftBody);
	assert.deepEqual(
		[...playing.params.subarray(EffectRow.offsetDir, EffectRow.offsetDir + 4)],
		[0, 0, 0, 100],
	);
	assert.deepEqual([...playing.params.subarray(EffectRow.offset, EffectRow.offset + 4)], [1, 1, 1, 0]);
	// the phase starts the cycle at `cycleStart`
	const anim = EffectRow.anim + OFFSET_SLOT * 4;
	assert.deepEqual(
		[...playing.params.subarray(anim, anim + 2)],
		[body.cycleRate, -2 * body.cycleRate].map(Math.fround),
	);
	// a fixed frame stands still in the middle of its row
	assert.deepEqual([...still.params.subarray(anim, anim + 2)], [0, Math.fround(0.495)]);
});

test('a pull towards the camera sets its most and its switch, and no pull leaves both at 0', () => {
	// Marker Stone's tower lamp stars (`M_fxmap_map_lv004_lamp_light_05`) pull up to 50 m
	const [pulled, still] = materialLooks({
		entries: [described(stack({ cameraPull: 50 })), described(stack({}))],
	});
	assert.deepEqual([...pulled.params.subarray(EffectRow.cameraPull, EffectRow.cameraPull + 2)], [50, 1]);
	assert.deepEqual([...still.params.subarray(EffectRow.cameraPull, EffectRow.cameraPull + 2)], [0, 0]);
});

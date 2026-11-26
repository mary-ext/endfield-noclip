import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	ParticleAlignment,
	ParticleRenderMode,
	type ParticleSystemInfo,
	SheetUvChannels,
} from '@endfield-noclip/package-format/particles';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { ROW_WORDS, RowBillboard, RowWord, rowSheet } from '../content/instance-rows.ts';

import type { ParticleWorkerResponse } from './particle-protocol.ts';
import { type EmitterBlock, ParticleField, type ParticleRowStore } from './particle-rows.ts';
import { createParticleWorkerHandler } from './particle-worker.ts';
import { type ParticleView, screenLimited, turnedByBillboard } from './row-geometry.ts';
import { between, constant, line, system, trailed } from './test-systems.ts';

describe('ParticleField', () => {
	/** @returns the row the field writes for one particle of a system on an identity emitter at the origin */
	const written = (info: ParticleSystemInfo, view: Omit<ParticleView, 'time'>): Float32Array => {
		let rows = new Float32Array(0);
		const store: ParticleRowStore = {
			allocateRows: (count) => ({ start: 0, count }),
			freeRows: () => {},
			writeRows: (_start, words) => {
				rows = new Float32Array(words.buffer.slice(0, ROW_WORDS * 4));
			},
		};
		const rowsF32 = new Float32Array(ROW_WORDS);
		rowsF32.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
		// the field reads only the emitter row, the block's origin and its slot
		const instances = { rowsF32, origin: [0, 0, 0], blockSlot: 0 } satisfies EmitterBlock;
		const field = new ParticleField({ systems: [info] }, store);
		assert.equal(field.rows(instances, 0, 0, 0, { time: 0, ...view }).length, 1);
		return rows;
	};
	/** @returns a written row's custom data, from its f16 words */
	const customOf = (row: Float32Array): number[] => [
		...new Float16Array(row.buffer, row.byteOffset + RowWord.custom * 4, 4),
	];
	const center = (info: ParticleSystemInfo, view: Omit<ParticleView, 'time'>): number[] => {
		const row = written(info, view);
		return [row[3], row[7], row[11]];
	};
	const eye: Vec3 = [0, 0, -10];

	it('draws a trail as quads from each point to the next, facing the camera across them', () => {
		let rows = new Float32Array(0);
		let rowCount = 0;
		const store: ParticleRowStore = {
			allocateRows: (count) => ({ start: 0, count }),
			freeRows: () => {},
			writeRows: (_start, words, n) => {
				rows = new Float32Array(words.buffer.slice(0, n * ROW_WORDS * 4));
				rowCount = n;
			},
		};
		const rowsF32 = new Float32Array(ROW_WORDS);
		rowsF32.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
		const block = { rowsF32, origin: [0, 0, 0], blockSlot: 0 } satisfies EmitterBlock;
		const field = new ParticleField({ systems: [trailed()] }, store);
		const view: ParticleView = {
			time: 1,
			eye: [-10, 0, 0.75],
			widthPerDepth: 2,
			right: [0, 0, -1],
			up: [0, 1, 0],
			forward: [1, 0, 0],
		};
		// the system starts as it's first drawn; a second later the trail runs from 1 m back to 0.5 m
		field.rows(block, 0, 0, 0, { ...view, time: 0 });
		const segments = field.rows(block, 0, 0, 1, view).length;
		assert.equal(segments, rowCount);
		assert.equal(segments, 8);
		const words = new Uint32Array(rows.buffer);
		const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-5, `${a} ≠ ${b}`);
		// the head's segment: its x runs back along the trail, its y across it, square to the line of sight
		near(rows[2 * 4], -0.0625);
		near(rows[3 + 2 * 4], 1 - 0.03125);
		near(rows[1 + 1 * 4], 0.1 - 0.05 / 16);
		near(rows[1], 0);
		// right-handed, its +z away from the camera, as stretched quads'
		const column = (c: number) => [rows[c], rows[4 + c], rows[8 + c]];
		const [x, y, z] = [column(0), column(1), column(2)];
		const crossed = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
		assert.ok(crossed[0] * z[0] + crossed[1] * z[1] + crossed[2] * z[2] > 0);
		assert.ok(z[0] > 0);
		assert.equal(words[RowWord.sheet], rowSheet([8, 1], 0, SheetUvChannels.Uv0));
		assert.equal(words[7 * ROW_WORDS + RowWord.sheet], rowSheet([8, 1], 7, SheetUvChannels.Uv0));
	});

	it('lays a stretched particle back from its head, its width set by where the camera is, not how it turns', () => {
		// Suiming's drifting fog (`smoke` in p_fxmap_map02_lv007_windice01): legacy stretched quads
		const moving = (linear: Vec3, pivot: Vec3 = [0, 0, 0]) =>
			system({
				renderMode: ParticleRenderMode.Stretched,
				stretch: { lengthScale: 2, velocityScale: 0, freeform: false, rotateWithStretchDirection: false },
				screenSize: { min: 0, max: 2 },
				looping: false,
				startLifetime: constant(5),
				rate: constant(0),
				bursts: [{ time: 0, count: constant(1), cycles: 1, interval: 0.01, probability: 1 }],
				shape: null,
				startSize: [constant(1), constant(1), constant(1)],
				startRotation: [constant(0), constant(0), constant(0)],
				gravityModifier: constant(0),
				pivot,
				velocity: {
					linear: [constant(linear[0]), constant(linear[1]), constant(linear[2])],
					linearInWorld: false,
					orbital: [constant(0), constant(0), constant(0)],
					orbitalOffset: [0, 0, 0],
					radial: constant(0),
					speedModifier: constant(1),
				},
			});
		const fog = moving([0, 1, 0]);
		const level = written(fog, {
			eye,
			widthPerDepth: 2,
			right: [1, 0, 0],
			up: [0, 1, 0],
			forward: [0, 0, 1],
		});
		// looking 30° down from the same place
		const pitched = written(fog, {
			eye,
			widthPerDepth: 2,
			right: [1, 0, 0],
			up: [0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)],
			forward: [0, -Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)],
		});
		const near = (a: Float32Array, b: number[]) =>
			b.every((value, i) => Math.abs(a[[0, 4, 8, 1, 5, 9, 2, 6, 10, 3, 7, 11][i]] - value) < 1e-5);
		// x runs 2 m back from the head (u = 0 at head, 1 at tail), y runs across the width, its face's normal on
		// the line of sight, the particle at the top end
		const expected = [0, -2, 0, 1, 0, 0, 0, 0, 1, 0, -1, 0];
		assert.ok(near(level, expected), [...level.subarray(0, 12)].join());
		assert.ok(near(pitched, expected), [...pitched.subarray(0, 12)].join());
		// moving along the line of sight it has no width, and the game draws nothing
		const view = {
			eye,
			widthPerDepth: 2,
			right: [1, 0, 0],
			up: [0, 1, 0],
			forward: [0, 0, 1],
		} satisfies Omit<ParticleView, 'time'>;
		const along = written(moving([0, 0, 1]), view);
		assert.ok(
			[0, 1, 2, 4, 5, 6, 8, 9, 10].every((i) => along[i] === 0),
			[...along.subarray(0, 12)].join(),
		);
		// its pivot moves the head along the velocity by its size, and the streak across by half its width
		const pivoted = written(moving([0, 1, 0], [1, 0.5, 0]), view);
		assert.ok(near(pivoted, [0, -2, 0, 1, 0, 0, 0, 0, 1, 0.5, -0.5, 0]), [...pivoted.subarray(0, 12)].join());
		// negative lengthScale stretches ahead of the head and flips both axes (keeping positive determinant)
		const neg = written(
			{
				...fog,
				stretch: { lengthScale: -2, velocityScale: 0, freeform: false, rotateWithStretchDirection: false },
			},
			view,
		);
		assert.ok(near(neg, [0, 2, 0, -1, 0, 0, 0, 0, 1, 0, 1, 0]), [...neg.subarray(0, 12)].join());
		// m_Flip packs UV flip bits into the sheet word for quads and negates particle size for meshes
		const flippedQuad = written({ ...fog, flip: [1, 1, 0] }, view);
		assert.equal(new Uint32Array(flippedQuad.buffer)[RowWord.sheet], rowSheet([1, 1], 0, 0, 3));
		const flippedMesh = written(
			system({
				renderMode: ParticleRenderMode.Mesh,
				alignment: ParticleAlignment.World,
				looping: false,
				startLifetime: constant(5),
				rate: constant(0),
				bursts: [{ time: 0, count: constant(1), cycles: 1, interval: 0.01, probability: 1 }],
				shape: null,
				startSize: [constant(2), constant(3), constant(4)],
				startRotation: [constant(0), constant(0), constant(0)],
				gravityModifier: constant(0),
				flip: [0, 1, 1],
			}),
			view,
		);
		assert.ok(
			near(flippedMesh, [2, 0, 0, 0, -3, 0, 0, 0, -4, 0, 0, 0]),
			[...flippedMesh.subarray(0, 12)].join(),
		);
		assert.equal(new Uint32Array(flippedMesh.buffer)[RowWord.sheet], 0);
		assert.equal(flippedMesh[RowWord.extent], 4);
		// positive 2D Z rotation turns billboard quads clockwise on screen (x → -up, y → +right at +π/2)
		const spunQuad = written(
			system({
				renderMode: ParticleRenderMode.Billboard,
				alignment: ParticleAlignment.View,
				looping: false,
				startLifetime: constant(5),
				rate: constant(0),
				bursts: [{ time: 0, count: constant(1), cycles: 1, interval: 0.01, probability: 1 }],
				shape: null,
				startSize: [constant(1), constant(1), constant(1)],
				startRotation: [constant(0), constant(0), constant(Math.PI / 2)],
				gravityModifier: constant(0),
			}),
			view,
		);
		assert.ok(near(spunQuad, [0, -1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0]), [...spunQuad.subarray(0, 12)].join());
	});

	it('keeps a freeform stretched billboard centred on the particle and stretches it linearly along velocity', () => {
		// Jingyu waterfall mist (`shuiwu` in P_fxmap_common_splashes_middle_2501): downward velocity, freeform stretch
		const freeform = (linear: Vec3, rotateWithStretchDirection: boolean, pivot: Vec3 = [0, 0, 0]) =>
			system({
				renderMode: ParticleRenderMode.Stretched,
				stretch: { lengthScale: 1.5, velocityScale: 0, freeform: true, rotateWithStretchDirection },
				screenSize: { min: 0, max: 2 },
				looping: false,
				startLifetime: constant(5),
				rate: constant(0),
				bursts: [{ time: 0, count: constant(1), cycles: 1, interval: 0.01, probability: 1 }],
				shape: null,
				startSize: [constant(2), constant(3), constant(1)],
				startRotation: [constant(0), constant(0), constant(0)],
				gravityModifier: constant(0),
				pivot,
				velocity: {
					linear: [constant(linear[0]), constant(linear[1]), constant(linear[2])],
					linearInWorld: false,
					orbital: [constant(0), constant(0), constant(0)],
					orbitalOffset: [0, 0, 0],
					radial: constant(0),
					speedModifier: constant(1),
				},
			});
		const view = {
			eye,
			widthPerDepth: 2,
			right: [1, 0, 0],
			up: [0, 1, 0],
			forward: [0, 0, 1],
		} satisfies Omit<ParticleView, 'time'>;
		const near = (a: Float32Array, b: number[]) =>
			b.every((value, i) => Math.abs(a[[0, 4, 8, 1, 5, 9, 2, 6, 10, 3, 7, 11][i]] - value) < 1e-5);
		// moving down without rotateWithStretchDirection: centred at origin, x stays 2, y stretches 3 × 1.5 = 4.5
		const plain = written(freeform([0, -10, 0], false), view);
		assert.ok(near(plain, [2, 0, 0, 0, 4.5, 0, 0, 0, 1, 0, 0, 0]), [...plain.subarray(0, 12)].join());
		// moving right with rotateWithStretchDirection: rotates 90° so x aligns along -vel (stretched 2 × 1.5 = 3),
		// y stays perpendicular (3), still centred on the particle
		const turned = written(freeform([10, 0, 0], true), view);
		assert.ok(near(turned, [-3, 0, 0, 0, -3, 0, 0, 0, 1, 0, 0, 0]), [...turned.subarray(0, 12)].join());
		// still particle draws unstretched, centred on the particle
		const still = written(freeform([0, 0, 0], true), view);
		assert.ok(near(still, [2, 0, 0, 0, 3, 0, 0, 0, 1, 0, 0, 0]), [...still.subarray(0, 12)].join());
		// pivot offset is stretched along velocity too
		const pivoted = written(freeform([0, -10, 0], false, [0.5, 0.5, 0]), view);
		assert.ok(near(pivoted, [2, 0, 0, 0, 4.5, 0, 0, 0, 1, 1, 2.25, 0]), [...pivoted.subarray(0, 12)].join());
	});

	it('writes custom data read at the age over the lifetime, and none for systems without it', () => {
		// the anchors' black smoke: a random texture shift, and a dissolve rising over the particle's life
		const smoke = system({
			looping: false,
			startLifetime: constant(5),
			rate: constant(0),
			bursts: [{ time: 0, count: constant(1), cycles: 1, interval: 0.01, probability: 1 }],
			shape: null,
			customData: [between(0, 1), null, line(0.3, 1), constant(2)],
		});
		const view = {
			eye,
			widthPerDepth: 2,
			right: [1, 0, 0],
			up: [0, 1, 0],
			forward: [0, 0, 1],
		} satisfies Omit<ParticleView, 'time'>;
		const [x, y, z, w] = customOf(written(smoke, view));
		assert.ok(x >= 0 && x <= 1);
		assert.deepEqual([y, w], [0, 2]);
		// just born, to f16's precision
		assert.ok(Math.abs(z - 0.3) < 1e-3, String(z));
		assert.deepEqual(customOf(written({ ...smoke, customData: null }, view)), [0, 0, 0, 0]);
	});

	it('offsets a view-aligned mesh by its pivot in the camera-turned frame it is drawn in', () => {
		// the blue talosite's shards: one mesh particle each, pivoted off centre, facing the camera
		const shard = system({
			looping: false,
			startLifetime: constant(5),
			rate: constant(0),
			bursts: [{ time: 0, count: constant(1), cycles: 1, interval: 0.01, probability: 1 }],
			shape: null,
			startSize: [constant(2), constant(2), constant(2)],
			startRotation: [constant(0), constant(0), constant(0)],
			gravityModifier: constant(0),
			pivot: [0, 0.5, 0],
		});
		const level = center(shard, {
			eye,
			widthPerDepth: 2,
			right: [1, 0, 0],
			up: [0, 1, 0],
			forward: [0, 0, 1],
		});
		assert.deepEqual(level, [0, 1, 0]);
		// looking straight down, the camera's up is the world's +z, so the offset goes there
		const down = center(shard, {
			eye,
			widthPerDepth: 2,
			right: [1, 0, 0],
			up: [0, 0, 1],
			forward: [0, -1, 0],
		});
		assert.deepEqual(down, [0, 0, 1]);
		// a world-aligned one keeps it in the world's frame
		const world = center(
			{ ...shard, alignment: ParticleAlignment.World },
			{
				eye,
				widthPerDepth: 2,
				right: [1, 0, 0],
				up: [0, 0, 1],
				forward: [0, -1, 0],
			},
		);
		assert.deepEqual(world, [0, 1, 0]);
	});

	it('frees the rows of emitters left undrawn, though their block stays resident', () => {
		const allocated = new Set<number>();
		let next = 0;
		const store: ParticleRowStore = {
			allocateRows: (count) => {
				allocated.add(next);
				const alloc = { start: next, count };
				next += count;
				return alloc;
			},
			freeRows: (alloc) => {
				allocated.delete(alloc.start);
			},
			writeRows: () => {},
		};
		const rowsF32 = new Float32Array(ROW_WORDS * 2);
		rowsF32.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
		rowsF32.set([1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0], ROW_WORDS);
		// a pinned block, never released
		const block = { rowsF32, origin: [0, 0, 0], blockSlot: 0 } satisfies EmitterBlock;
		const field = new ParticleField({ systems: [system()] }, store);
		const view = {
			eye,
			widthPerDepth: 2,
			right: [1, 0, 0],
			up: [0, 1, 0],
			forward: [0, 0, 1],
		} satisfies Omit<ParticleView, 'time'>;
		field.rows(block, 0, 0, 1, { time: 0, ...view });
		field.rows(block, 1, 0, 1, { time: 0, ...view });
		assert.equal(allocated.size, 2);
		// only the first stays in view
		for (let frame = 2; frame <= 1300; frame++) {
			field.rows(block, 0, 0, frame, { time: frame / 60, ...view });
		}
		assert.equal(allocated.size, 1);
		// the other comes back with rows of its own
		assert.ok(field.rows(block, 1, 0, 1301, { time: 1301 / 60, ...view }).length > 0);
		assert.equal(allocated.size, 2);
	});

	it('refreshes active emitters in place while live count fits, and falls back when it grows', () => {
		const writes: { rows: Uint32Array; count: number }[] = [];
		let next = 0;
		const store: ParticleRowStore = {
			allocateRows: (count) => {
				const start = next;
				next += count;
				return { start, count };
			},
			freeRows: () => {},
			writeRows: (_start, rows, count) => {
				writes.push({ rows: rows.slice(0, count * ROW_WORDS), count });
			},
		};
		const rowsF32 = new Float32Array(ROW_WORDS);
		rowsF32[0] = 1;
		rowsF32[5] = 1;
		rowsF32[10] = 1;
		const block = { rowsF32, origin: [0, 0, 0], blockSlot: 3 } satisfies EmitterBlock;
		const field = new ParticleField(
			{
				systems: [
					system({
						duration: 2,
						looping: false,
						startLifetime: constant(0.5),
						rate: constant(4),
					}),
				],
			},
			store,
		);
		const view = {
			eye,
			widthPerDepth: 2,
			right: [1, 0, 0],
			up: [0, 1, 0],
			forward: [0, 0, 1],
		} satisfies Omit<ParticleView, 'time'>;
		// emitter starts at view.time = 0 (1 particle at t = 0); at t = 0.1 still 1 → refresh fits in place
		const initial = field.rows(block, 0, 0, 1, { time: 0, ...view });
		assert.equal(initial.length, 1);
		assert.equal(field.refreshActive(2, { time: 0.1, ...view }), true);
		// at t = 0.4, 2 particles are alive (> listed 1) → refresh asks for a full traversal
		assert.equal(field.refreshActive(3, { time: 0.4, ...view }), false);
		assert.equal(field.rows(block, 0, 0, 4, { time: 0.4, ...view }).length, 2);
		// at t = 3, all particles have died → refresh pads the 2 listed slots to zero-scale rows
		assert.equal(field.refreshActive(5, { time: 3, ...view }), true);
		const last = writes.at(-1)!;
		assert.equal(last.count, 2);
		assert.equal(last.rows[0], 0);
		assert.equal(last.rows[ROW_WORDS], 0);
		assert.equal(last.rows[RowWord.block], 3);
	});
});

describe('turnedByBillboard', () => {
	it('turns as row_basis turns a billboard row', () => {
		const view = {
			time: 0,
			eye: [0, 0, 0],
			widthPerDepth: 2,
			right: [0, 0, -1],
			up: [0.6, 0.8, 0],
			forward: [0.8, -0.6, 0],
		} satisfies ParticleView;
		assert.deepEqual(turnedByBillboard(RowBillboard.None, view, [1, 2, 3]), [1, 2, 3]);
		assert.deepEqual(turnedByBillboard(RowBillboard.Facing, view, [1, 0, 0]), [0, 0, -1]);
		// kept upright: right stays level, up is the world's, forward is right × up
		assert.deepEqual(
			turnedByBillboard(RowBillboard.Upright, view, [0, 1, 1]).map((value) => value + 0),
			[1, 1, 0],
		);
	});
});

describe('screenLimited', () => {
	const view = {
		time: 0,
		eye: [0, 0, 0],
		widthPerDepth: 2,
		right: [1, 0, 0],
		up: [0, 1, 0],
		forward: [0, 0, 1],
	} satisfies ParticleView;

	it('holds the larger side to a fraction of the viewport width at the depth, scaling both', () => {
		// 4 m away the viewport is 8 m wide, so half of it is 4 m: a 10 × 5 m quad shrinks to 4 × 2 m
		assert.deepEqual(screenLimited([10, 5, 1], { min: 0, max: 0.5 }, view, [3, 0, 4]), [4, 2, 1]);
		// small ones grow to the minimum, those within the limits stay
		assert.deepEqual(screenLimited([0.5, 1, 1], { min: 0.25, max: 0.5 }, view, [0, 0, 4]), [1, 2, 1]);
		assert.deepEqual(screenLimited([3, 1, 1], { min: 0, max: 0.5 }, view, [0, 0, 4]), [3, 1, 1]);
		// behind the camera the game drops it only with a minimum; without one it keeps its whole size
		assert.deepEqual(screenLimited([3, 1, 1], { min: 0.1, max: 0.5 }, view, [0, 0, -4]), [0, 0, 1]);
		assert.deepEqual(screenLimited([3, 1, 1], { min: 0, max: 0.5 }, view, [0, 0, -4]), [3, 1, 1]);
	});
});

describe('createParticleWorkerHandler', () => {
	it('evaluates emitters off-thread, packs rows, recycles buffers, and removes released emitters', () => {
		const responses: ParticleWorkerResponse[] = [];
		const handle = createParticleWorkerHandler((response) => {
			responses.push(response);
		});
		const info = system({
			looping: true,
			duration: 2,
			rate: constant(10),
			startLifetime: constant(1),
		});
		const view: ParticleView = {
			time: 0.5,
			eye: [0, 0, -10],
			widthPerDepth: 2,
			right: [1, 0, 0],
			up: [0, 1, 0],
			forward: [0, 0, 1],
		};
		handle({ kind: 'system', system: 0, info });
		handle({
			kind: 'add',
			id: 1,
			system: 0,
			seed: 42,
			start: 0,
			offset: 1,
			capacity: 32,
			origin: [0, 0, 0],
			blockSlot: 7,
		});
		const transforms = new Float32Array([1, 0, 0, 2, 0, 1, 0, 3, 0, 0, 1, 4]);
		handle({
			kind: 'step',
			seq: 1,
			view,
			count: 1,
			ids: new Uint32Array([1]),
			transforms,
			buffer: null,
		});
		assert.equal(responses.length, 1);
		const first = responses[0];
		assert.equal(first.seq, 1);
		assert.ok(first.counts[0] > 0);
		assert.equal(first.rows.length, first.counts[0] * ROW_WORDS);
		assert.equal(first.rows[RowWord.block], 7);

		// buffer recycling and removal
		const recycled = first.rows.buffer;
		handle({ kind: 'remove', ids: [1] });
		handle({
			kind: 'step',
			seq: 2,
			view,
			count: 1,
			ids: first.ids,
			transforms: first.transforms,
			buffer: recycled,
		});
		assert.equal(responses.length, 2);
		assert.equal(responses[1].counts[0], 0);
		assert.equal(responses[1].rows.length, 0);
		assert.equal(responses[1].rows.buffer, recycled);
	});
});

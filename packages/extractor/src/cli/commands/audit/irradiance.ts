import { BlobKind } from '@endfield-noclip/package-format/blobs';

import { PackedPackage } from '../../../pipeline/read-package.ts';

import type { AuditSubArgs } from './parser.ts';
import { packageDirsOf } from './shared.ts';

/**
 * runs `endfield-extract audit irradiance`
 *
 * @param args parsed CLI arguments
 */
export const runAuditIrradiance = async (args: AuditSubArgs<'irradiance'>): Promise<void> => {
	const { packageDir } = packageDirsOf(args.scene, args.dir);
	await auditIrradiance(packageDir, {
		at: args.at,
		json: args.json,
	});
};

const IRRADIANCE_ORIGIN = 8192;

const popcount32 = (n: number): number => {
	let x = n >>> 0;
	x -= (x >>> 1) & 0x55555555;
	x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
	return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

const unpackFloat16 = (half: number): number => {
	const exp = (half >>> 10) & 31;
	const mant = half & 1023;
	if (exp === 0) {
		return mant * 2 ** -24;
	}
	if (exp === 31) {
		return mant === 0 ? Number.POSITIVE_INFINITY : Number.NaN;
	}
	return (1 + mant / 1024) * 2 ** (exp - 15);
};

const unpackUnorm4 = (w: number): [number, number, number, number] => [
	(w & 255) / 255,
	((w >>> 8) & 255) / 255,
	((w >>> 16) & 255) / 255,
	((w >>> 24) & 255) / 255,
];

const unpackProbeWords = (u32: Uint32Array, at: number) => {
	const word = u32[at];
	const l0: [number, number, number] = [
		unpackFloat16((word << 4) & 0x7ff0),
		unpackFloat16((word >>> 7) & 0x7ff0),
		unpackFloat16((word >>> 17) & 0x7fe0),
	];
	const b0 = unpackUnorm4(u32[at + 1]);
	const b1 = unpackUnorm4(u32[at + 2]);
	const b2 = unpackUnorm4(u32[at + 3]);
	return { l0, b0, b1, b2 };
};

const findProbeWordInCell = (
	u32: Uint32Array,
	p: readonly [number, number, number],
	level: number,
): number => {
	const t = u32[0];
	const o = u32[1];
	const mask = (64 << level) - 1;
	const shift = 2 + 2 * level;
	const bx = (p[0] & mask) >> shift;
	const by = (p[1] & mask) >> shift;
	const bz = (p[2] & mask) >> shift;
	const sx = (p[0] >> (2 * level)) & 3;
	const sy = (p[1] >> (2 * level)) & 3;
	const sz = (p[2] >> (2 * level)) & 3;
	const bit = (((sx << 2) | sx) & 9) | (((sy << 3) | (sy << 1)) & 18) | (((sz << 4) | (sz << 2)) & 36);
	const oi = (bx % o) + (by % o) * o + (bz % o) * o * o;
	const offset = u32[2 + oi];
	const hx = (bx + (offset & 255)) % t;
	const hy = (by + ((offset >>> 8) & 255)) % t;
	const hz = (bz + ((offset >>> 16) & 255)) % t;
	const entry = 2 + o * o * o + (hx + hy * t + hz * t * t) * 4;
	if (u32[entry] !== (bx | (by << 8) | (bz << 16)) >>> 0) {
		return -1;
	}
	const lo = u32[entry + 2];
	const hi = u32[entry + 3];
	let below: number;
	if (bit < 32) {
		if (((lo >>> bit) & 1) === 0) {
			return -1;
		}
		below = popcount32(lo & ((1 << bit) - 1));
	} else {
		if (((hi >>> (bit - 32)) & 1) === 0) {
			return -1;
		}
		below = popcount32(lo) + popcount32(hi & ((1 << (bit - 32)) - 1));
	}
	return (u32[entry + 1] >>> 2) + below * 4;
};

const auditIrradiance = async (
	packageDir: string,
	options: { at: number[] | undefined; json: boolean },
): Promise<void> => {
	await using pkg = await PackedPackage.open(packageDir);
	const table = await pkg.irradiance();
	const regions = pkg.manifest.irradianceRegions;

	if (options.at === undefined) {
		const byLevel = new Map<number, number>();
		for (let i = 0; i < table.keys.length; i++) {
			const level = table.keys[i] >>> 24;
			byLevel.set(level, (byLevel.get(level) ?? 0) + 1);
		}
		const summaryData = {
			entries: table.keys.length,
			byLevel: Object.fromEntries([...byLevel.entries()].toSorted((a, b) => a[0] - b[0])),
			regions: regions.length,
		};
		if (options.json) {
			console.log(JSON.stringify(summaryData, null, '\t'));
			return;
		}
		console.log(
			`cells: ${summaryData.entries} (${Object.entries(summaryData.byLevel)
				.map(([l, n]) => `L${l}:${n}`)
				.join(' ')})  regions: ${summaryData.regions}`,
		);
		return;
	}

	const [wx, wy, wz] = options.at;
	const regionHits = [];
	const idx0: [number, number, number] = [Math.round(wx * 2), Math.round(wy * 2), Math.round(wz * 2)];
	for (const region of regions) {
		const lx = idx0[0] - region.origin[0];
		const ly = idx0[1] - region.origin[1];
		const lz = idx0[2] - region.origin[2];
		if (lx >= 0 && ly >= 0 && lz >= 0 && lx < region.size[0] && ly < region.size[1] && lz < region.size[2]) {
			// oxlint-disable-next-line no-await-in-loop -- at most a handful of overlapping regions
			const bytes = await pkg.readBlob(region.blob, BlobKind.Irradiance);
			const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2);
			const at = 4 * (lx + ly * region.size[0] + lz * region.size[0] * region.size[1]);
			regionHits.push({
				name: region.name,
				group: region.group,
				blob: region.blob,
				local: [lx, ly, lz],
				probe: unpackProbeWords(u32, at),
			});
		}
	}

	const levelHits = [];
	for (let level = 0; level <= 2; level++) {
		const spacing = 0.5 * (1 << (2 * level));
		const index: [number, number, number] = [
			Math.round(wx / spacing),
			Math.round(wy / spacing),
			Math.round(wz / spacing),
		];
		const p: [number, number, number] = [
			index[0] * (1 << (2 * level)) + IRRADIANCE_ORIGIN,
			index[1] * (1 << (2 * level)) + IRRADIANCE_ORIGIN,
			index[2] * (1 << (2 * level)) + IRRADIANCE_ORIGIN,
		];
		const cellShift = 6 + level;
		const cellSizeUnits = 1 << level;
		const cx = (p[0] >> cellShift) * cellSizeUnits;
		const cy = (p[1] >> cellShift) * cellSizeUnits;
		const cz = (p[2] >> cellShift) * cellSizeUnits;
		const key = (cx | (cy << 8) | (cz << 16) | (level << 24)) >>> 0;
		const matches = [];
		for (let i = 0; i < table.keys.length; i++) {
			if (table.keys[i] !== key) {
				continue;
			}
			const blob = table.blobs[i];
			const group = table.groups[i];
			// oxlint-disable-next-line no-await-in-loop -- at most 3 levels × few state bakes
			const bytes = await pkg.readBlob(blob, BlobKind.Irradiance);
			const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2);
			const at = findProbeWordInCell(u32, p, level);
			matches.push({
				group,
				blob,
				probe: at < 0 ? null : unpackProbeWords(u32, at),
			});
		}
		levelHits.push({
			level,
			spacing,
			probeWorld: [index[0] * spacing, index[1] * spacing, index[2] * spacing],
			cellKey: `0x${key.toString(16).padStart(8, '0')}`,
			bakes: matches,
		});
	}

	if (options.json) {
		console.log(JSON.stringify({ at: options.at, regions: regionHits, levels: levelHits }, null, '\t'));
		return;
	}
	for (const r of regionHits) {
		const l0 = r.probe.l0.map((v) => v.toFixed(4)).join(', ');
		console.log(
			`region ${r.name} (group=${r.group}, blob#${r.blob}): L0=[${l0}] valid=${r.probe.b0[3].toFixed(3)}`,
		);
	}
	for (const hit of levelHits) {
		const pos = hit.probeWorld.map((v) => v.toFixed(2)).join(', ');
		if (hit.bakes.length === 0) {
			console.log(`L${hit.level} (${hit.spacing}m, probe=[${pos}], key=${hit.cellKey}): no cell`);
			continue;
		}
		for (const bake of hit.bakes) {
			if (bake.probe === null) {
				console.log(
					`L${hit.level} (${hit.spacing}m, probe=[${pos}], key=${hit.cellKey}, group=${bake.group}): empty probe`,
				);
			} else {
				const l0 = bake.probe.l0.map((v) => v.toFixed(4)).join(', ');
				console.log(
					`L${hit.level} (${hit.spacing}m, probe=[${pos}], key=${hit.cellKey}, group=${bake.group}): L0=[${l0}] valid=${bake.probe.b0[3].toFixed(3)}`,
				);
			}
		}
	}
};

// #endregion

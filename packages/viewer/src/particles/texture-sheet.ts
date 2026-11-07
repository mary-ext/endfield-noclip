import type { ParticleTextureSheetInfo } from '@endfield-noclip/package-format/particles';

import { evaluateMinMax } from './curves.ts';
import { Channel } from './random.ts';

/**
 * the tile of a texture sheet a particle shows
 *
 * @param sheet the system's texture sheet
 * @param lived the particle's age over its lifetime, 0–1
 * @param age its age, s
 * @param loop the emission's place in its loop, where the start frame is read
 * @param randomOf the particle's random value for a channel
 * @param mesh the index of the particle's mesh
 * @returns the tile, counted from the sheet's top-left along its rows
 */
export const sheetTile = (
	sheet: ParticleTextureSheetInfo,
	lived: number,
	age: number,
	loop: number,
	randomOf: (channel: number) => number,
	mesh: number,
): number => {
	const [columns, rows] = sheet.tiles;
	const frames = sheet.rows.kind === 'all' ? columns * rows : columns;
	let frame = evaluateMinMax(sheet.startFrame, loop, randomOf(Channel.StartFrame));
	if (sheet.frameOverTime === null) {
		frame += (age * sheet.fps) / frames;
	} else {
		// a particle held at the end of its lifetime keeps the last cycle's end
		const t = lived * sheet.cycles;
		const phase = lived >= 1 ? 1 : t - Math.floor(t);
		frame += evaluateMinMax(sheet.frameOverTime, phase, randomOf(Channel.FrameOverTime));
	}
	const index = Math.min(Math.floor((frame - Math.floor(frame)) * frames), frames - 1);
	switch (sheet.rows.kind) {
		case 'all': {
			return index;
		}
		case 'fixed': {
			return sheet.rows.row * columns + index;
		}
		case 'random': {
			return Math.floor(randomOf(Channel.SheetRow) * rows) * columns + index;
		}
		case 'mesh': {
			return Math.min(mesh, rows - 1) * columns + index;
		}
	}
};

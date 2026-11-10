import type { StreamManager } from './stream-manager.ts';

/** what the reduction reads of the stream */
export type ReductionStream = Pick<StreamManager, 'saturated' | 'usedBytes'>;

/** levels added or removed at a time; half a level about halves or doubles the textures in use */
const STEP = 0.5;
/** levels at most, past which the textures are too blurry to be worth the meshes they make room for */
export const MAX_REDUCTION = 3;
/** frames after a raise before the next, so the levels it let go can be evicted first */
const RAISE_FRAMES = 4;
/** frames between checks for room to lower the reduction */
const LOWER_FRAMES = 30;
/** a lowered reduction must leave the content in use within this share of the budget */
const HEADROOM = 0.85;
/** textures in use below this share of the budget aren't what fills it, so reducing them can't help */
const TEXTURE_SHARE = 0.25;

/**
 * lowers material texture resolution while the stream budget is full of content in use, and restores it once
 * there's room, as Unity's texture streaming drops mip levels to stay within its budget. without it, textures
 * fill the budget and pause all streaming, so meshes that come into view afterwards stay boxes
 */
export class TextureReduction {
	/** mip levels added to every material texture request */
	levels = 0;
	/**
	 * whether the stream is saturated and a raise may still help, so traversals should go on while the view is
	 * still: a saturated stream is idle, and the frame loop stops traversing an idle stream
	 */
	raising = false;
	#stream: ReductionStream | null = null;
	#changedFrame = 0;

	/**
	 * call once a frame after the stream update
	 *
	 * @param stream the scene's stream; a different one from the last call starts over at no reduction
	 * @param frame the frame counter
	 * @param budget the stream's budget, bytes
	 */
	update(stream: ReductionStream, frame: number, budget: number): void {
		if (stream !== this.#stream) {
			this.#stream = stream;
			this.levels = 0;
			this.#changedFrame = frame;
		}
		const since = frame - this.#changedFrame;
		this.raising = false;
		if (stream.saturated) {
			if (this.levels >= MAX_REDUCTION) {
				return;
			}
			this.raising = true;
			if (since < RAISE_FRAMES) {
				return;
			}
			if (stream.usedBytes('texture').kind < budget * TEXTURE_SHARE) {
				this.raising = false;
				return;
			}
			this.levels += STEP;
			this.#changedFrame = frame;
			return;
		}
		if (this.levels === 0 || since < LOWER_FRAMES) {
			return;
		}
		const used = stream.usedBytes('texture');
		// a half level coarser holds about half the bytes of one, so lowering by one step about doubles them
		const grown = used.all + used.kind * (4 ** STEP - 1);
		if (grown <= budget * HEADROOM) {
			this.levels = Math.max(0, this.levels - STEP);
		}
		this.#changedFrame = frame;
	}
}

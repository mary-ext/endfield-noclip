import type { Vec3 } from '@endfield-noclip/package-format/values';

import type { Camera } from '../../scene/camera.ts';

/** floats {@link CameraHistory.write} writes: the previous view-projection, then the eye delta */
export const CAMERA_HISTORY_FLOATS = 20;

/**
 * the camera a temporal pass's history was rendered with, and which of the pass's two histories a frame
 * writes, for passes that reproject last frame's output through the depth buffer
 */
export class CameraHistory {
	/** which of the pair this frame writes; it reads the other */
	#index = 0;
	/** whether the history holds a frame of the current view and targets */
	#valid = false;
	#viewProj = new Float32Array(16);
	#previousViewProj = new Float32Array(16);
	#eye: Vec3 = [0, 0, 0];
	#previousEye: Vec3 = [0, 0, 0];

	/** @returns which of the pass's two histories this frame writes */
	get index(): number {
		return this.#index;
	}

	/** @returns whether the history holds a frame of the current view and targets */
	get valid(): boolean {
		return this.#valid;
	}

	/**
	 * writes last frame's reprojection uniforms without advancing or recording the current frame:
	 * `previousViewProj` (16 floats), then `eye - previousEye` and 0 when valid (else 1).
	 *
	 * @param out target array, written from index 0 for {@link CAMERA_HISTORY_FLOATS} floats
	 * @param eye this frame's camera position
	 */
	readPrevious(out: Float32Array, eye: Vec3): void {
		out.set(this.#previousViewProj, 0);
		out[16] = eye[0] - this.#previousEye[0];
		out[17] = eye[1] - this.#previousEye[1];
		out[18] = eye[2] - this.#previousEye[2];
		out[19] = this.#valid ? 0 : 1;
	}

	/** drops the history, so the next frame doesn't read it (a cut, a resize) */
	reset(): void {
		this.#valid = false;
	}

	/**
	 * writes the uniforms the shader reprojects with: last frame's camera-relative view-projection (16 floats),
	 * then this frame's eye minus last frame's and, in the 4th float, 1 when there's no history to read
	 *
	 * @param out the pass's uniforms, written from float 0 to {@link CAMERA_HISTORY_FLOATS}
	 * @param camera this frame's camera (unjittered)
	 * @param aspect the history's width / height
	 */
	write(out: Float32Array, camera: Camera, aspect: number): void {
		camera.writeViewProjection(aspect, this.#viewProj);
		const eye = camera.position;
		this.#eye = [eye[0], eye[1], eye[2]];
		out.set(this.#previousViewProj, 0);
		out[16] = eye[0] - this.#previousEye[0];
		out[17] = eye[1] - this.#previousEye[1];
		out[18] = eye[2] - this.#previousEye[2];
		out[19] = this.#valid ? 0 : 1;
	}

	/** keeps the camera last {@link write}ten as the one the history now holds, and swaps the pair */
	advance(): void {
		this.#previousViewProj.set(this.#viewProj);
		this.#previousEye = this.#eye;
		this.#valid = true;
		this.#index = 1 - this.#index;
	}
}

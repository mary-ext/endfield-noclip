/**
 * the viewer camera. its position is kept in Unity world coordinates in double precision; everything sent to
 * the GPU is relative to it (camera-relative rendering), so f32 stays precise anywhere in the world.
 *
 * the package keeps Unity's left-handed frame. building the view as rows (right, up, -forward) of Unity
 * vectors is the same as applying `scale(1, 1, -1)` at the root followed by a right-handed look-at, so the
 * image matches the game and Unity's clockwise front faces stay clockwise on screen.
 *
 * @module
 */

/** a plane `n·p + d ≥ 0` (inside), with `p` relative to the camera */
export type Plane = [nx: number, ny: number, nz: number, d: number];

/** a 3-vector in Unity space */
export type Vec3 = [x: number, y: number, z: number];

/** position, orientation and lens */
export class Camera {
	/** Unity world position, f64 */
	position: Vec3 = [0, 0, 0];
	/** radians; 0 looks along +Z (north), positive turns right (towards +X) */
	yaw = 0;
	/** radians; positive looks up */
	pitch = 0;
	/** vertical field of view, radians */
	fovY = (60 * Math.PI) / 180;
	/** near plane distance (m); the far plane is at infinity */
	near = 0.25;

	/** @returns unit forward vector */
	forward(): Vec3 {
		const cp = Math.cos(this.pitch);
		return [Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp];
	}

	/** @returns unit right vector (horizontal) */
	right(): Vec3 {
		return [Math.cos(this.yaw), 0, -Math.sin(this.yaw)];
	}

	/** @returns unit up vector */
	up(): Vec3 {
		const sp = Math.sin(this.pitch);
		return [-Math.sin(this.yaw) * sp, Math.cos(this.pitch), -Math.cos(this.yaw) * sp];
	}

	/**
	 * @param viewportHeight drawing buffer height, px
	 * @returns pixels per metre at 1 m distance: `viewportHeight / (2 tan(fovY / 2))`; screen-space error is
	 *   `geometricError · factor / distance`
	 */
	pixelFactor(viewportHeight: number): number {
		return viewportHeight / (2 * Math.tan(this.fovY / 2));
	}

	/**
	 * writes the camera-relative view-projection: reversed-Z, infinite far plane, WebGPU clip space.
	 *
	 * @param aspect width / height
	 * @param out 16 floats, column-major; overwritten
	 */
	writeViewProjection(aspect: number, out: Float32Array): void {
		const f = 1 / Math.tan(this.fovY / 2);
		const r = this.right();
		const u = this.up();
		const fw = this.forward();
		// clip = (f/a · r·d, f · u·d, near, fw·d): depth = near / distance along the view axis
		for (let j = 0; j < 3; j++) {
			out[j * 4] = (f / aspect) * r[j];
			out[j * 4 + 1] = f * u[j];
			out[j * 4 + 2] = 0;
			out[j * 4 + 3] = fw[j];
		}
		out[12] = 0;
		out[13] = 0;
		out[14] = this.near;
		out[15] = 0;
	}

	/**
	 * @param aspect width / height
	 * @returns the left, right, bottom, top and near planes, camera-relative (no far plane)
	 */
	frustumPlanes(aspect: number): Plane[] {
		const f = 1 / Math.tan(this.fovY / 2);
		const r = this.right();
		const u = this.up();
		const fw = this.forward();
		const plane = (sx: number, sy: number): Plane => {
			const n: Vec3 = [
				fw[0] + sx * (f / aspect) * r[0] + sy * f * u[0],
				fw[1] + sx * (f / aspect) * r[1] + sy * f * u[1],
				fw[2] + sx * (f / aspect) * r[2] + sy * f * u[2],
			];
			const length = Math.hypot(n[0], n[1], n[2]);
			return [n[0] / length, n[1] / length, n[2] / length, 0];
		};
		return [plane(1, 0), plane(-1, 0), plane(0, 1), plane(0, -1), [fw[0], fw[1], fw[2], -this.near]];
	}
}

/**
 * @param planes camera-relative planes
 * @param min box minimum, world
 * @param max box maximum, world
 * @param eye camera position, world
 * @returns whether the box is at least partly inside every plane
 */
export const boxInFrustum = (
	planes: readonly Plane[],
	min: readonly number[],
	max: readonly number[],
	eye: Vec3,
): boolean => {
	for (const [nx, ny, nz, d] of planes) {
		// the box corner furthest along the plane normal
		const px = (nx >= 0 ? max[0] : min[0]) - eye[0];
		const py = (ny >= 0 ? max[1] : min[1]) - eye[1];
		const pz = (nz >= 0 ? max[2] : min[2]) - eye[2];
		if (nx * px + ny * py + nz * pz + d < 0) {
			return false;
		}
	}
	return true;
};

/**
 * @param min box minimum
 * @param max box maximum
 * @param p a point
 * @returns the distance from the point to the box (0 inside)
 */
export const distanceToBox = (min: readonly number[], max: readonly number[], p: Vec3): number => {
	const dx = Math.max(min[0] - p[0], 0, p[0] - max[0]);
	const dy = Math.max(min[1] - p[1], 0, p[1] - max[1]);
	const dz = Math.max(min[2] - p[2], 0, p[2] - max[2]);
	return Math.hypot(dx, dy, dz);
};

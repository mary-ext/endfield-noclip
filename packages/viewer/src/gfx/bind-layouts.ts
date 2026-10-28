/**
 * bind-group layouts shared by the material families. every family uses group 0 for per-pass frame uniforms
 * and group 1 for its own data, so a pass binds the frame once and families only swap group 1.
 *
 * @module
 */

const VERTEX = GPUShaderStage.VERTEX;
const FRAGMENT = GPUShaderStage.FRAGMENT;

const storage = (binding: number, visibility: number): GPUBindGroupLayoutEntry => ({
	binding,
	visibility,
	buffer: { type: 'read-only-storage' },
});

/** the layouts and the pipeline layouts built from them */
export interface BindLayouts {
	/** group 0: `Frame` uniforms at a dynamic offset into the uniform ring */
	frame: GPUBindGroupLayout;
	/** group 1 of the terrain family: height pages, patch list, isolate cell mask */
	terrain: GPUBindGroupLayout;
	/** group 1 of the instance families: instance rows, block origins, this frame's visible-instance list */
	instances: GPUBindGroupLayout;
	/** group 2 of the mesh families: per-draw parameters (dequantization, material look), per-entry draw ids */
	draw: GPUBindGroupLayout;
	/** group 3 of the mesh families: the material's base colour texture and its sampler */
	materials: GPUBindGroupLayout;

	terrainPipeline: GPUPipelineLayout;
	instancesPipeline: GPUPipelineLayout;
	meshPipeline: GPUPipelineLayout;
}

/**
 * @param device the device
 * @returns the shared layouts
 */
export const createBindLayouts = (device: GPUDevice): BindLayouts => {
	const frame = device.createBindGroupLayout({
		label: 'frame',
		entries: [
			{
				binding: 0,
				visibility: VERTEX | FRAGMENT,
				buffer: { type: 'uniform', hasDynamicOffset: true },
			},
		],
	});
	const terrain = device.createBindGroupLayout({
		label: 'terrain',
		entries: [storage(0, VERTEX), storage(1, VERTEX), storage(2, FRAGMENT)],
	});
	const instances = device.createBindGroupLayout({
		label: 'instances',
		entries: [storage(0, VERTEX), storage(1, VERTEX), storage(2, VERTEX)],
	});
	const draw = device.createBindGroupLayout({
		label: 'draw',
		entries: [storage(0, VERTEX), storage(1, VERTEX)],
	});
	const materials = device.createBindGroupLayout({
		label: 'materials',
		entries: [
			{ binding: 0, visibility: FRAGMENT, texture: { sampleType: 'float' } },
			{ binding: 1, visibility: FRAGMENT, sampler: { type: 'filtering' } },
		],
	});
	return {
		frame,
		terrain,
		instances,
		draw,
		materials,
		terrainPipeline: device.createPipelineLayout({ label: 'terrain', bindGroupLayouts: [frame, terrain] }),
		instancesPipeline: device.createPipelineLayout({
			label: 'instances',
			bindGroupLayouts: [frame, instances],
		}),
		meshPipeline: device.createPipelineLayout({
			label: 'mesh',
			bindGroupLayouts: [frame, instances, draw, materials],
		}),
	};
};

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
	/** group 1 of the terrain family: height pages, patch list, surface and splat pages, layer textures */
	terrain: GPUBindGroupLayout;
	/** group 1 of the instance families: instance rows, block origins, this frame's visible-instance list */
	instances: GPUBindGroupLayout;
	/**
	 * group 2 of the mesh families: per-draw parameters (dequantization, flags, look slot), per-entry draw ids,
	 * the fog's inputs, and the look table (each drawn material's parameters)
	 */
	draw: GPUBindGroupLayout;

	terrainPipeline: GPUPipelineLayout;
	instancesPipeline: GPUPipelineLayout;
}

/**
 * @param device the device
 * @returns the shared layouts
 */
export const createBindLayouts = (device: GPUDevice): BindLayouts => {
	// the volumetric fog's compute pass lights froxels with the same frame
	const lighting = FRAGMENT | GPUShaderStage.COMPUTE;
	const frame = device.createBindGroupLayout({
		label: 'frame',
		entries: [
			{
				binding: 0,
				visibility: VERTEX | lighting,
				buffer: { type: 'uniform', hasDynamicOffset: true },
			},
			{ binding: 1, visibility: lighting, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
			{ binding: 2, visibility: lighting, sampler: { type: 'comparison' } },
			{ binding: 3, visibility: lighting, texture: { sampleType: 'float', viewDimension: 'cube' } },
			{ binding: 4, visibility: lighting, sampler: { type: 'filtering' } },
			// the irradiance clipmaps, A and B with the levels stacked, and their repeating and clamping samplers
			{ binding: 5, visibility: lighting, texture: { sampleType: 'float', viewDimension: '3d' } },
			{ binding: 6, visibility: lighting, texture: { sampleType: 'float', viewDimension: '3d' } },
			{ binding: 7, visibility: lighting, sampler: { type: 'filtering' } },
			{ binding: 8, visibility: lighting, sampler: { type: 'filtering' } },
			// raw shadow-map depth reads
			{ binding: 9, visibility: lighting, sampler: { type: 'non-filtering' } },
			// the shadow's penumbra ramp
			{ binding: 10, visibility: lighting, texture: { sampleType: 'float' } },
			// local lights and their bins
			storage(11, lighting),
			storage(12, lighting),
			// the cloud shadow texture, sampled with the repeating sampler
			{ binding: 13, visibility: lighting, texture: { sampleType: 'float' } },
			// the local lights' shadow atlas, compared through the shadow sampler
			{ binding: 14, visibility: lighting, texture: { sampleType: 'depth' } },
		],
	});
	const terrain = device.createBindGroupLayout({
		label: 'terrain',
		entries: [
			storage(0, VERTEX),
			storage(1, VERTEX),
			// surface pages: albedo and normal arrays and their sampler
			{ binding: 2, visibility: FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
			{ binding: 3, visibility: FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
			{ binding: 4, visibility: FRAGMENT, sampler: { type: 'filtering' } },
			// splat pages (control, tint), layer textures (diffuse, normal), the splat index and layer
			// parameters, and the layers' repeating sampler
			...[5, 6, 7, 8].map((binding): GPUBindGroupLayoutEntry => ({
				binding,
				visibility: FRAGMENT,
				texture: { sampleType: 'float', viewDimension: '2d-array' },
			})),
			storage(9, FRAGMENT),
			storage(10, FRAGMENT),
			{ binding: 11, visibility: FRAGMENT, sampler: { type: 'filtering' } },
		],
	});
	const instances = device.createBindGroupLayout({
		label: 'instances',
		// rows, block table, visible list, decal placements
		entries: [storage(0, VERTEX), storage(1, VERTEX), storage(2, VERTEX), storage(3, VERTEX)],
	});
	const draw = device.createBindGroupLayout({
		label: 'draw',
		entries: [
			storage(0, VERTEX | FRAGMENT),
			storage(1, VERTEX),
			// what transparent draws fog themselves with: the post uniforms, the volumetric fog and its sampler
			{ binding: 2, visibility: FRAGMENT, buffer: { type: 'uniform' } },
			{ binding: 3, visibility: FRAGMENT, texture: { sampleType: 'float', viewDimension: '3d' } },
			{ binding: 4, visibility: FRAGMENT, sampler: { type: 'filtering' } },
			// the look table, by the draw's slot
			storage(5, VERTEX | FRAGMENT),
		],
	});
	return {
		frame,
		terrain,
		instances,
		draw,
		terrainPipeline: device.createPipelineLayout({ label: 'terrain', bindGroupLayouts: [frame, terrain] }),
		instancesPipeline: device.createPipelineLayout({
			label: 'instances',
			bindGroupLayouts: [frame, instances],
		}),
	};
};

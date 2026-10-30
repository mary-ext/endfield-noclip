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
	/** group 1 of the terrain family: height pages, patch list, surface and detail pages, layer textures */
	terrain: GPUBindGroupLayout;
	/** group 1 of the instance families: instance rows, block origins, this frame's visible-instance list */
	instances: GPUBindGroupLayout;
	/** group 2 of the mesh families: per-draw parameters (dequantization, material look), per-entry draw ids */
	draw: GPUBindGroupLayout;
	/**
	 * group 3 of the mesh families: the material's base colour, normal, mask and emissive textures, the base
	 * colour's sampler and one for the rest
	 */
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
			// the irradiance clipmaps, A and B per level, and their repeating and clamping samplers
			...[5, 6, 7, 8, 9, 10].map((binding): GPUBindGroupLayoutEntry => ({
				binding,
				visibility: lighting,
				texture: { sampleType: 'float', viewDimension: '3d' },
			})),
			{ binding: 11, visibility: lighting, sampler: { type: 'filtering' } },
			{ binding: 12, visibility: lighting, sampler: { type: 'filtering' } },
			// raw shadow-map depth reads
			{ binding: 13, visibility: lighting, sampler: { type: 'non-filtering' } },
			// the shadow's penumbra ramp
			{ binding: 14, visibility: lighting, texture: { sampleType: 'float' } },
			// local lights and their bins
			storage(15, lighting),
			storage(16, lighting),
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
			// detail pages (control, tint), layer textures (diffuse, normal), the detail index and layer
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
		entries: [storage(0, VERTEX), storage(1, VERTEX), storage(2, VERTEX)],
	});
	const draw = device.createBindGroupLayout({
		label: 'draw',
		entries: [storage(0, VERTEX | FRAGMENT), storage(1, VERTEX)],
	});
	const texture = (binding: number): GPUBindGroupLayoutEntry => ({
		binding,
		visibility: FRAGMENT,
		texture: { sampleType: 'float' },
	});
	const materials = device.createBindGroupLayout({
		label: 'materials',
		entries: [
			texture(0),
			texture(1),
			texture(2),
			texture(3),
			{ binding: 4, visibility: FRAGMENT, sampler: { type: 'filtering' } },
			{ binding: 5, visibility: FRAGMENT, sampler: { type: 'filtering' } },
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

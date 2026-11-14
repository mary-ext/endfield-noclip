/**
 * what the viewer shows instead of the lit image, in the order of their `Frame.flags.y` codes: material
 * channels; `clouds`, the raw cloud panorama in place of the sky; and `gaps`, grey surfaces with amber
 * stripes on the meshes whose material is drawn without something the game draws (`MaterialLook.gaps`)
 */
export const DEBUG_VIEWS = ['lit', 'albedo', 'normals', 'roughness', 'ambient', 'clouds', 'gaps'] as const;

export type DebugView = (typeof DEBUG_VIEWS)[number];

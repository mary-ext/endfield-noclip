// instance stand-ins: each row's world AABB as a box, coloured by HLOD tier / detail, or by owning level.
// rows mirror `instance-rows.ts`.

struct Row {
	// object-to-world rows, translation relative to the block origin (unused by boxes)
	t0: vec4f,
	t1: vec4f,
	t2: vec4f,
	center: vec3f,
	block: u32,
	extent: vec3f,
	// tag | kind << 8 | scene state << 16
	info: u32,
}

@group(1) @binding(0) var<storage, read> rows: array<Row>;
// block origins relative to the eye, rewritten every frame
@group(1) @binding(1) var<storage, read> blocks: array<vec4f>;
// this frame's visible-instance list (row indices), read when USE_LIST is set
@group(1) @binding(2) var<storage, read> list: array<u32>;

// instance_index is a row index (row-range draws) or an index into `list` (per-instance selection)
override USE_LIST: bool = false;

struct VertexOut {
	@builtin(position) position: vec4f,
	@location(0) rel: vec3f,
	@location(1) @interpolate(flat) normal: vec3f,
	@location(2) @interpolate(flat) color: vec3f,
}

// 6 faces × 2 triangles: face axis, sign and the two in-face corner signs per vertex
const FACE_CORNERS = array<vec2f, 6>(
	vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
	vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0),
);

// 12 edges as corner sign pairs
const EDGES = array<vec3f, 24>(
	vec3f(-1, -1, -1), vec3f(1, -1, -1), vec3f(-1, 1, -1), vec3f(1, 1, -1),
	vec3f(-1, -1, 1), vec3f(1, -1, 1), vec3f(-1, 1, 1), vec3f(1, 1, 1),
	vec3f(-1, -1, -1), vec3f(-1, 1, -1), vec3f(1, -1, -1), vec3f(1, 1, -1),
	vec3f(-1, -1, 1), vec3f(-1, 1, 1), vec3f(1, -1, 1), vec3f(1, 1, 1),
	vec3f(-1, -1, -1), vec3f(-1, -1, 1), vec3f(1, -1, -1), vec3f(1, -1, 1),
	vec3f(-1, 1, -1), vec3f(-1, 1, 1), vec3f(1, 1, -1), vec3f(1, 1, 1),
);

fn kind_color(kind: u32) -> vec3f {
	switch kind {
		case 0u: { return vec3f(0.30, 0.62, 0.30); }
		case 1u: { return vec3f(0.80, 0.55, 0.18); }
		case 2u: { return vec3f(0.75, 0.25, 0.22); }
		case 3u: { return vec3f(0.62, 0.62, 0.66); }
		default: { return vec3f(0.30, 0.45, 0.75); }
	}
}

fn culled() -> VertexOut {
	var out: VertexOut;
	// outside the clip volume: the primitive is dropped
	out.position = vec4f(2.0, 2.0, 2.0, 1.0);
	return out;
}

struct Box {
	center: vec3f,
	extent: vec3f,
	color: vec3f,
	visible: bool,
	// too large to fill without hiding everything around it (skyline and far-terrain meshes)
	outline_only: bool,
}

fn load_box(ii: u32) -> Box {
	var index = ii;
	if (USE_LIST) {
		index = list[ii];
	}
	let row = rows[index];
	var box: Box;
	box.center = blocks[row.block].xyz + row.center;
	// a coloured particle row keeps its colour in extent.z; its extents are all equal
	let extent = select(row.extent, row.extent.xxx, (row.info & (1u << 30u)) != 0u);
	box.extent = max(extent, vec3f(0.05));
	box.color = kind_color(row.info & 0xfu);
	// small-feature culling: drop boxes below the projected size threshold
	let pixels = length(box.extent) * frame.viewport.z / max(length(box.center), 1.0);
	box.visible = pixels >= frame.viewport.w;
	box.outline_only = max(box.extent.x, max(box.extent.y, box.extent.z)) > frame.params.x;
	return box;
}

@vertex
fn vs_fill(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VertexOut {
	let box = load_box(ii);
	if (!box.visible || box.outline_only) {
		return culled();
	}
	let face = vi / 6u;
	let axis = face % 3u;
	let sign = select(-1.0, 1.0, face < 3u);
	let c = FACE_CORNERS[vi % 6u];
	var corner: vec3f;
	var normal = vec3f(0.0);
	switch axis {
		case 0u: { corner = vec3f(sign, c.x, c.y); normal.x = sign; }
		case 1u: { corner = vec3f(c.x, sign, c.y); normal.y = sign; }
		default: { corner = vec3f(c.x, c.y, sign); normal.z = sign; }
	}
	let rel = box.center + corner * box.extent;
	var out: VertexOut;
	out.position = frame.view_proj * vec4f(rel, 1.0);
	out.rel = rel;
	out.normal = normal;
	out.color = box.color;
	return out;
}

@vertex
fn vs_wire(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VertexOut {
	let box = load_box(ii);
	// outlines are drawn for every box in wireframe mode, else only for those too large to fill
	if (!box.visible || (frame.flags.x == 0u && !box.outline_only)) {
		return culled();
	}
	let rel = box.center + EDGES[vi] * box.extent;
	var out: VertexOut;
	out.position = frame.view_proj * vec4f(rel, 1.0);
	out.rel = rel;
	out.normal = vec3f(0.0, 1.0, 0.0);
	out.color = box.color;
	return out;
}

@fragment
fn fs_fill(in: VertexOut) -> Shaded {
	return shade_surface(default_surface(in.color, in.normal), in.rel, in.position.xy);
}

@fragment
fn fs_wire(in: VertexOut) -> Shaded {
	return unlit(in.color * 1.4);
}

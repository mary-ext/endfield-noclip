// the sky as the composite applies it. needs post-common.wgsl, atmosphere.wgsl and fog.wgsl.

// the atmosphere's sky along a direction; the cloud panorama and what lies beyond the atmosphere go over it in
// celestial.wgsl
fn sky_radiance(direction: vec3f) -> vec3f {
	if (post.flags.x == 0u) {
		return vec3f(0.0);
	}
	// the game's LUT scale (its outer sun colour, exposed sun and procedural sky lux factor); it fades the LUT out
	// just below the horizon
	return sky_view(direction) * post.sky_illuminance.rgb * clamp(1.0 + direction.y * 10.0, 0.0, 1.0);
}

// the fog over something `distance` metres away
fn atmosphere_over(color: vec3f, direction: vec3f, distance: f32, froxels: Froxels) -> vec3f {
	let fog = fog_over(direction, distance, froxels);
	return color * fog.transmittance + fog.inscatter;
}

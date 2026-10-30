/**
 * the game's stream areas: sets of static scenery that load by where the streaming centre is. entering a
 * trigger zone replaces the areas shown outside every zone (`rootVisible`) with the zone's own list; inside
 * several zones the lists are united ({@link zonesAt}, {@link areasShownIn}). content of a non-default area
 * loads through an {@link streamAreaControl} requirement, whose value a viewer sets from the camera with
 * {@link streamAreaValues}
 */
export interface StreamAreasInfo {
	/** area ids content requires, i.e. the areas a viewer gives a value */
	areas: number[];
	/** areas shown while the point is in no trigger */
	rootVisible: number[];
	/** zone id and the areas shown while inside its trigger */
	shownInside: { zone: number; areas: number[] }[];
	triggers: StreamAreaTriggerInfo[];
}

/** a zone's trigger volume */
export interface StreamAreaTriggerInfo {
	zone: number;
	/** world XZ box, inclusive */
	min: [x: number, z: number];
	max: [x: number, z: number];
	/** world Y range, inclusive */
	minHeight: number;
	maxHeight: number;
	/** closed ring in world XZ */
	polygon: [x: number, z: number][];
}

/**
 * @param area a stream area id
 * @returns the control whose value is 1 while the area is shown
 */
export const streamAreaControl = (area: number): string => `area:${area}`;

/**
 * the game's point-in-trigger test: inclusive XZ box and height range, then an even-odd ring test
 *
 * @param trigger trigger to test
 * @param point world position `[x, y, z]`
 * @returns whether the point activates the trigger
 */
export const triggerContains = (trigger: StreamAreaTriggerInfo, point: readonly number[]): boolean =>
	point[1] >= trigger.minHeight && point[1] <= trigger.maxHeight && footprintContains(trigger, point);

/**
 * @param trigger trigger to test
 * @param point world position `[x, y, z]`; `y` is ignored
 * @returns whether the trigger's XZ footprint holds the point, at any height
 */
export const footprintContains = (trigger: StreamAreaTriggerInfo, point: readonly number[]): boolean => {
	const [x, , z] = point;
	if (x < trigger.min[0] || x > trigger.max[0] || z < trigger.min[1] || z > trigger.max[1]) {
		return false;
	}
	const ring = trigger.polygon;
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [ax, az] = ring[i];
		const [bx, bz] = ring[j];
		if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) {
			inside = !inside;
		}
	}
	return inside;
};

/**
 * @param info the scene's stream areas
 * @param point streaming centre (the camera) `[x, y, z]`
 * @returns the zones whose trigger holds the point
 */
export const zonesAt = (info: StreamAreasInfo, point: readonly number[]): Set<number> =>
	new Set(info.triggers.filter((trigger) => triggerContains(trigger, point)).map((trigger) => trigger.zone));

/**
 * @param info the scene's stream areas
 * @param point world position `[x, y, z]`
 * @returns the zones whose trigger footprint lies under or over the point
 */
export const zonesAround = (info: StreamAreasInfo, point: readonly number[]): Set<number> =>
	new Set(
		info.triggers.filter((trigger) => footprintContains(trigger, point)).map((trigger) => trigger.zone),
	);

/**
 * @param info the scene's stream areas
 * @param zones zones holding the streaming centre, from {@link zonesAt}
 * @returns the areas the game shows: the union of the zones' lists, or `rootVisible` with no zone
 */
export const areasShownIn = (info: StreamAreasInfo, zones: ReadonlySet<number>): Set<number> => {
	if (zones.size === 0) {
		return new Set(info.rootVisible);
	}
	const visible = new Set<number>();
	for (const { zone, areas } of info.shownInside) {
		if (zones.has(zone)) {
			for (const area of areas) {
				visible.add(area);
			}
		}
	}
	return visible;
};

/**
 * @param info the scene's stream areas
 * @param visible areas to show, from {@link areasShownIn}, or `null` to show every area
 * @returns a value per {@link streamAreaControl} of `info.areas`: 1 shown, 0 hidden
 */
export const streamAreaValues = (
	info: StreamAreasInfo,
	visible: ReadonlySet<number> | null,
): Record<string, number> =>
	Object.fromEntries(
		info.areas.map((area) => [streamAreaControl(area), visible === null || visible.has(area) ? 1 : 0]),
	);

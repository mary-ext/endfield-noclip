import type { LevelInfo, PackageManifest } from '@endfield-noclip/package-format/manifest';
import type { Vec3 } from '@endfield-noclip/package-format/values';
import type { WaterSurfaceEntry } from '@endfield-noclip/package-format/water';

import { ROW_BYTES, ROW_WORDS } from '../content/instance-rows.ts';
import type { AppliedVolume } from '../environment/blend.ts';
import { windClockRate } from '../environment/environment.ts';
import { type GfxDevice, createGfxDevice } from '../gfx/device.ts';
import { DecodePool } from '../package/decode-pool.ts';
import type { PackageSource } from '../package/package-source.ts';
import { openViewerPackage } from '../package/viewer-package.ts';
import { frameSettings } from '../render/frame/frame-graph.ts';
import { SETTLE_FRAMES } from '../render/post/temporal-aa.ts';
import { volumesForLevel } from '../scene-states/listing.ts';
import { type GroupsConsumer, SceneState } from '../scene-states/scene-state.ts';
import { WaterLevels, type WaterVolumeState } from '../scene-states/water-levels.ts';
import { Camera } from '../scene/camera.ts';
import { cellIdAt, levelCellIds, levelPose, levelsByCell, overviewPose } from '../scene/level-pose.ts';
import { type CameraPose, NoclipControls } from '../scene/noclip-controls.ts';
import type { ResidentInstances } from '../streaming/resident.ts';

import { EnvironmentState } from './environment-state.ts';
import { DEFAULT_OPTIONS, type ViewerOptions, postSettings } from './options.ts';
import { Renderer } from './renderer.ts';
import { type LevelEntry, type LoadedScene, openScene } from './scene-loader.ts';
import { type ViewerStats, FrameTimes, STATS_INTERVAL, collectStats, emptyStats } from './stats.ts';
import { Traversal } from './traversal.ts';

/** the irradiance volume of a package without one */
const EMPTY_IRRADIANCE = { keys: new Uint32Array(), blobs: new Uint32Array(), groups: new Uint32Array() };

/** the running viewer */
export class Viewer {
	readonly camera = new Camera();
	readonly controls: NoclipControls;
	readonly options: ViewerOptions = structuredClone(DEFAULT_OPTIONS);
	stats: ViewerStats;
	/** bumped when the package, the options or the current level change; a cheap snapshot for the UI */
	stateRevision = 0;
	/** bumped when {@link stats} change */
	statsRevision = 0;
	/** bumped when {@link environmentName} or {@link appliedVolumes} change as the camera moves */
	environmentRevision = 0;
	scene: LoadedScene | null = null;

	readonly #gfx: GfxDevice;
	readonly #renderer: Renderer;
	readonly #traversal: Traversal;
	readonly #pool: DecodePool;
	readonly #waterLevels = new WaterLevels();
	/** the package's scene controls and the visibility groups they show */
	readonly #sceneState: SceneState;
	/** what shows content by visibility group, besides the loaded package's selector */
	readonly #groupsConsumers: readonly GroupsConsumer[];
	/** the current level's environment, blended at the camera */
	readonly #environment = new EnvironmentState();
	readonly #times = new FrameTimes();
	readonly #listeners = new Set<() => void>();
	#raf = 0;
	#frame = 0;
	#lastTime = 0;
	#lastStats = 0;
	#statsKey = '';
	/** what the panels show of the blended environment, so a re-blend notifies only when that changes */
	#environmentKey = '';
	#lastDraws = 0;
	#dirty = true;
	/** compiled pipelines when the last frame began */
	#seenPipelines = 0;
	/** frames still to render so the temporal antialiasing settles after the view stopped changing */
	#settleFrames = 0;
	/** the current level's cells, whose content streams right after what's near the camera */
	#focusCells: Set<string> | null = null;
	/**
	 * the current level: the one last flown to, then the one owning the cell the camera moves into. its base
	 * environment is what the volumes blend over, and the UI lists its controls first. `null` when the package
	 * has no level with content
	 */
	#level: LevelInfo | null = null;
	/**
	 * the cell under the camera when {@link #level} was last decided, so only moving into another cell changes
	 * it; `null` until a flight lands, since a level's vantage point can sit over a neighbour's cells
	 */
	#levelCell: string | null = null;
	/** the loaded package's levels by owned cell */
	#levelsByCell: ReadonlyMap<string, LevelInfo> = new Map();
	/**
	 * the first view after loading, when it was posed before the coarse terrain was resident (at the spawn
	 * height); it's re-posed over the ground once that lands, unless the camera moved first
	 */
	#unsettledPose: CameraPose | null = null;
	/**
	 * the animation time everything that moves by the clock reads, s. it advances only on rendered frames while
	 * `animate` is on, so animation pauses when the view idles and resumes where it stopped
	 */
	#time = 0;
	/** the wind clock (`Frame.wind.x`), which advances with {@link #time} at the wind's rate */
	#windClock = 0;
	/**
	 * redraws when the page is shown again: Firefox re-shows a hidden tab's last frame with red and blue
	 * swapped, and an idle view would otherwise never present a new one
	 */
	readonly #onVisibilityChange = (): void => {
		if (document.visibilityState === 'visible') {
			this.#dirty = true;
		}
	};
	/** the frame loop's callback, made once */
	readonly #onFrame = (time: number): void => {
		this.#tick(time);
	};
	/** rewrites a row a water volume floats, made once */
	readonly #writeFloater = (resident: ResidentInstances, row: number): void => {
		this.#renderer.instances.writeRows(
			resident.alloc.start + row,
			new Uint32Array(resident.rowsF32.buffer, row * ROW_BYTES, ROW_WORDS),
			1,
		);
	};

	private constructor(gfx: GfxDevice, canvas: HTMLCanvasElement) {
		this.#gfx = gfx;
		const renderer = new Renderer(gfx, canvas, this.#environment.look, this.camera.near);
		this.#renderer = renderer;
		this.#traversal = new Traversal(renderer);
		this.#pool = new DecodePool(Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) >> 1)));
		this.#groupsConsumers = [renderer.water, renderer.lights, renderer.irradiance];
		this.#sceneState = new SceneState(this.#waterLevels, this.options);
		this.#sceneState.setPackage(null, this.#groupsConsumers);
		this.controls = new NoclipControls(this.camera, canvas);
		this.stats = emptyStats(gfx);
	}

	/**
	 * @param canvas the canvas to render into
	 * @param onLost called if the GPU device is lost
	 * @param signal abandons the creation; once aborted, the canvas is left untouched
	 * @returns a running viewer
	 * @throws {GfxUnsupportedError} without WebGPU
	 * @throws the signal's reason when aborted
	 */
	static async create(
		canvas: HTMLCanvasElement,
		onLost: (reason: string) => void,
		signal: AbortSignal,
	): Promise<Viewer> {
		const gfx = await createGfxDevice(onLost);
		// a canvas has one WebGPU context, shared by every viewer made on it. an abandoned viewer built anyway
		// would reconfigure that context and then unconfigure it on destroy, blacking out the viewer that
		// replaced it, so drop the device before touching the canvas
		if (signal.aborted) {
			gfx.device.destroy();
			throw signal.reason;
		}
		const viewer = new Viewer(gfx, canvas);
		viewer.#raf = requestAnimationFrame(viewer.#onFrame);
		document.addEventListener('visibilitychange', viewer.#onVisibilityChange);
		return viewer;
	}

	// #region package

	/**
	 * opens a package and starts streaming it, replacing any loaded one.
	 *
	 * @param source where the package lives
	 * @param initialLevel id of the level to look over first; when absent from the package, the first level
	 *   with content
	 * @param onProgress loading phases for the UI
	 */
	async load(
		source: PackageSource,
		initialLevel: string | null,
		onProgress: (phase: string) => void,
	): Promise<void> {
		this.unload();
		const pkg = await openViewerPackage(source, onProgress);
		const manifest = pkg.manifest;
		const renderer = this.#renderer;
		renderer.setIrradiance(pkg.irradiance, manifest.irradianceRegions);
		const scene = openScene(pkg, {
			device: this.#gfx.device,
			bc: this.#gfx.features.textureCompressionBc,
			pool: this.#pool,
			terrain: renderer.terrain,
			instances: renderer.instances,
			meshes: renderer.meshes,
			irradiance: renderer.irradiance,
			waterLevels: this.#waterLevels,
			budgetBytes: this.options.budgetMiB * 2 ** 20,
		});
		this.scene = scene;
		this.#sceneState.setPackage(manifest.states, [scene.selector, ...this.#groupsConsumers]);
		const showable = manifest.levels.filter((level) => level.instances > 0);
		const level = showable.find((candidate) => candidate.id === initialLevel) ?? showable[0] ?? null;
		this.#level = level;
		this.#levelCell = null;
		this.#levelsByCell = levelsByCell(manifest);
		renderer.post.resetExposure();
		renderer.water.setTable(pkg.water);
		this.#waterLevels.setVolumes(pkg.water.volumes);
		renderer.lights.setLights(pkg.lights.lights);
		this.#updateVisibility();
		this.#waterLevels.settle();
		this.#applyEnvironment();
		if (level === null) {
			this.#setPose(overviewPose(manifest));
		} else {
			this.#focusCells = levelCellIds(manifest, level);
			const { pose, settled } = this.#levelPose(scene, level);
			this.#setPose(pose);
			this.#unsettledPose = settled ? null : pose;
		}
		this.#dirty = true;
		this.#emitState();
		onProgress('streaming');
	}

	/** drops the loaded package and its GPU content */
	unload(): void {
		const renderer = this.#renderer;
		this.scene?.stream.destroy();
		this.scene?.textures.destroy();
		renderer.meshes.releaseMaterials();
		// the destroyed store's sky textures
		renderer.post.clearSkyTextures();
		renderer.bindings.setReflection(null, 1);
		renderer.bindings.set('shadowRamp', null);
		this.scene = null;
		this.#sceneState.setPackage(null, this.#groupsConsumers);
		this.options.environmentPin = null;
		this.#environment.fades.reset();
		renderer.setIrradiance(EMPTY_IRRADIANCE, []);
		renderer.water.setTable(null);
		this.#waterLevels.setVolumes([]);
		renderer.lights.setLights([]);
		renderer.terrain.setSplat(null);
		this.#level = null;
		this.#levelCell = null;
		this.#levelsByCell = new Map();
		this.#unsettledPose = null;
		this.#focusCells = null;
		this.#applyEnvironment();
		this.#dirty = true;
		this.#emitState();
	}

	/** @returns the loaded package's levels (the same array until the package changes) */
	levels(): LevelEntry[] {
		return this.scene?.levels ?? [];
	}

	/** @returns the loaded package's manifest, or `null` without a package */
	get manifest(): PackageManifest | null {
		return this.scene?.pkg.manifest ?? null;
	}

	/** @returns the loaded package's water surfaces; none without a package */
	get waterSurfaces(): readonly WaterSurfaceEntry[] {
		return this.scene?.pkg.water.surfaces ?? [];
	}

	// #endregion

	// #region environment

	/** lights the scene with the current level's environment, or the defaults */
	#applyEnvironment(): void {
		this.#environment.setBase(this.#level?.environment ?? null);
		this.#blendEnvironment({ force: true, dt: 0 });
	}

	/**
	 * makes a level current: its base environment is what the next blend starts from, and its cells stream next
	 * after what's near the camera
	 */
	#setLevel(level: LevelInfo, manifest: PackageManifest): void {
		this.#level = level;
		this.#focusCells = levelCellIds(manifest, level);
		this.#environment.setBase(level.environment);
		this.#emitState();
	}

	/**
	 * follows the camera into a cell another level owns, once any flight has landed
	 *
	 * @returns whether the current level changed
	 */
	#followCameraLevel(): boolean {
		const manifest = this.scene?.pkg.manifest;
		if (manifest === undefined || this.controls.flying) {
			return false;
		}
		const cell = cellIdAt(manifest.tree, this.camera.position);
		const last = this.#levelCell;
		this.#levelCell = cell;
		if (last === null || cell === last) {
			return false;
		}
		const level = this.#levelsByCell.get(cell);
		if (level === undefined || level === this.#level) {
			return false;
		}
		this.#setLevel(level, manifest);
		return true;
	}

	/**
	 * re-blends the environment volumes at the camera when it moved, a fade is running or the options changed,
	 * and relights the scene if the result differs
	 *
	 * @param options.force blend even if nothing changed
	 * @param options.dt seconds since the last frame, which time-faded volumes advance by
	 */
	#blendEnvironment({ force, dt }: { force: boolean; dt: number }): void {
		const look = this.#environment.update(
			{
				scene: this.scene?.pkg,
				eye: this.camera.position,
				volumes: this.options.environmentVolumes,
				pinnedPhase: this.options.environmentPin,
				loaded: this.#sceneState.conditionResults,
				dt,
			},
			{ force },
		);
		if (look === null) {
			return;
		}
		this.#renderer.setEnvironment(look, this.camera.near);
		this.#dirty = true;
		// the look changes on most frames while the camera moves through a volume's fade, and the panels that
		// don't show it (the scene conditions panel takes over 100 ms) mustn't re-render with it
		let key = look.environment.name ?? '';
		for (const { id, phase, factor } of this.#environment.applied) {
			key += '|' + id + ':' + phase + ':' + Math.round(factor * 100);
		}
		if (key !== this.#environmentKey) {
			this.#environmentKey = key;
			this.environmentRevision++;
			this.#notify();
		}
	}

	/** @returns the name of the environment profile lighting the camera, or `null` for the defaults */
	get environmentName(): string | null {
		return this.#environment.look.environment.name;
	}

	/** @returns the environment volumes applied at the camera, in order */
	get appliedVolumes(): readonly AppliedVolume[] {
		return this.#environment.applied;
	}

	/** @returns the phases the volumes listed for the current level apply, for pinning one: index and name */
	environmentPhases(): { index: number; name: string }[] {
		const pkg = this.scene?.pkg;
		const level = this.currentLevelIndex;
		if (pkg === undefined || level === null) {
			return [];
		}
		const indices = new Set<number>();
		for (const { volume } of volumesForLevel(pkg, level)) {
			if (volume.phase !== null) {
				indices.add(volume.phase);
			}
		}
		return [...indices]
			.map((index) => ({ index, name: pkg.environment.phases[index].name }))
			.toSorted((a, b) => a.name.localeCompare(b.name));
	}

	// #endregion

	// #region camera and levels

	#levelInfo(id: string): LevelInfo | undefined {
		return this.scene?.pkg.manifest.levels.find((candidate) => candidate.id === id);
	}

	/** @returns {@link levelPose} under the current options and scene values */
	#levelPose(scene: LoadedScene, level: LevelInfo): { pose: CameraPose; settled: boolean } {
		return levelPose(scene.ground, level, {
			environmentVolumes: this.options.environmentVolumes,
			loaded: this.#sceneState.conditionResults,
		});
	}

	#setPose({ position, yaw, pitch }: CameraPose): void {
		this.camera.position = [...position];
		this.camera.yaw = yaw;
		this.camera.pitch = pitch;
		// a cut: the last frames show somewhere else
		this.#renderer.cut();
	}

	/** re-poses the first view over the ground once the coarse terrain lands; drops it if the camera moved */
	#settleFirstPose(): boolean {
		const pending = this.#unsettledPose;
		const level = this.#level;
		const scene = this.scene;
		if (pending === null || level === null || scene === null) {
			return false;
		}
		const camera = this.camera;
		if (
			camera.yaw !== pending.yaw ||
			camera.pitch !== pending.pitch ||
			camera.position.some((value, axis) => value !== pending.position[axis])
		) {
			this.#unsettledPose = null;
			return false;
		}
		const { pose, settled } = this.#levelPose(scene, level);
		if (!settled) {
			return false;
		}
		this.#setPose(pose);
		this.#unsettledPose = null;
		return true;
	}

	/**
	 * flies to view a point from the south, above and behind it
	 *
	 * @param target Unity-space point to look at
	 * @param distance how far back to stand, in metres
	 */
	flyToPoint(target: Vec3, distance: number): void {
		const back = Math.max(distance, 10);
		const up = back * 0.6;
		this.controls.flyTo({
			position: [target[0], target[1] + up, target[2] - back],
			yaw: 0,
			pitch: -Math.atan2(up, back),
		});
		this.#dirty = true;
	}

	/**
	 * makes a level current and flies to a vantage point over it; every level shows either way
	 *
	 * @param id level id
	 */
	flyToLevel(id: string): void {
		const level = this.#levelInfo(id);
		const scene = this.scene;
		if (level === undefined || scene === null) {
			return;
		}
		this.#setLevel(level, scene.pkg.manifest);
		this.#blendEnvironment({ force: true, dt: 0 });
		this.controls.flyTo(this.#levelPose(scene, level).pose);
		// the vantage point can sit over a neighbour's cells, so the cell the flight lands in doesn't count
		this.#levelCell = null;
		this.#dirty = true;
	}

	/** @returns the current level's id, or `null` when the package has no level with content */
	get level(): string | null {
		return this.#level?.id ?? null;
	}

	/**
	 * @returns the current level's manifest entry (the one last flown to or moved into), or `null` when the
	 *   package has no level with content
	 */
	get currentLevel(): LevelInfo | null {
		return this.#level;
	}

	/** @returns {@link currentLevel} 's index into the manifest's levels, or `null` */
	get currentLevelIndex(): number | null {
		const index = this.#level === null ? -1 : (this.manifest?.levels.indexOf(this.#level) ?? -1);
		return index === -1 ? null : index;
	}

	// #endregion

	// #region scene states

	/** @returns every scene control's current value, by index into the manifest's controls */
	get sceneValues(): readonly number[] {
		return this.#sceneState.values;
	}

	/** @returns the values the user picked, by control index; other controls follow their default or formula */
	get scenePicks(): ReadonlyMap<number, number> {
		return this.#sceneState.picks;
	}

	/** @returns per conditional set of the loaded package, whether the selected scene values satisfy it */
	get conditionResults(): readonly boolean[] {
		return this.#sceneState.conditionResults;
	}

	/**
	 * @returns the stream areas shown at the camera, or `null` when every area shows (the option is off or the
	 *   package has no stream areas)
	 */
	get visibleStreamAreas(): ReadonlySet<number> | null {
		return this.#sceneState.visibleStreamAreas;
	}

	/** @returns every gameplay water volume of the package, with its fill now and the fill it's moving to */
	get waterVolumes(): WaterVolumeState[] {
		return this.#waterLevels.states;
	}

	/**
	 * @param control a scene control's index into the manifest's controls
	 * @param value one of its values, or `null` to drop the pick so it follows its default or formula again
	 */
	setSceneValue(control: number, value: number | null): void {
		this.setSceneValues(new Map([[control, value]]));
	}

	/**
	 * sets several controls at once, re-evaluating visibility once
	 *
	 * @param values by control index, one of its values or `null` to drop the pick; unknown controls and values
	 *   are ignored
	 */
	setSceneValues(values: ReadonlyMap<number, number | null>): void {
		if (!this.#sceneState.pick(values)) {
			return;
		}
		this.#updateVisibility();
		this.#emitState();
	}

	/** restores scene control and environment preview defaults for the current package */
	resetSceneValues(): void {
		this.#sceneState.resetPicks();
		this.options.environmentPin = null;
		this.#environment.fades.reset();
		this.#updateVisibility();
		this.#waterLevels.settle();
		this.#emitState();
	}

	/** re-evaluates the scene state for the camera, and redraws */
	#updateVisibility(): void {
		this.#sceneState.evaluate(this.camera.position);
		this.#dirty = true;
	}

	// #endregion

	// #region options and stats

	/** @param patch options to change */
	setOptions(patch: Partial<ViewerOptions>): void {
		const { post, targets } = this.#renderer;
		Object.assign(this.options, patch);
		targets.renderScale = Math.min(1, Math.max(0.25, this.options.renderScale));
		post.setAntialiasing(this.options.antialiasing);
		if (patch.debugView !== undefined || patch.antialiasing !== undefined) {
			post.resetAntialiasing();
		}
		if (patch.streamAreas !== undefined) {
			this.#updateVisibility();
		}
		if (this.scene !== null) {
			this.scene.stream.options.budgetBytes = this.options.budgetMiB * 2 ** 20;
		}
		this.#dirty = true;
		this.#emitState();
	}

	/**
	 * @param listener called when {@link stateRevision}, {@link statsRevision} or {@link environmentRevision}
	 *   change (stats at most about four times a second)
	 * @returns unsubscribe
	 */
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emitState(): void {
		this.stateRevision++;
		this.#notify();
	}

	#notify(): void {
		for (const listener of this.#listeners) {
			listener();
		}
	}

	/** refreshes {@link stats}, notifying subscribers only if something changed */
	#publishStats(): void {
		const renderer = this.#renderer;
		const stats = collectStats(this.stats, {
			times: this.#times,
			profiler: renderer.profiler,
			post: renderer.post,
			terrain: renderer.terrain,
			instances: renderer.instances,
			meshes: renderer.meshes,
			terrainShown: this.options.terrain,
			draws: this.#lastDraws,
			visited: this.#traversal.visited,
			textureReduction: this.#traversal.textureReduction.levels,
			scene: this.scene,
			pools: renderer.pools,
			camera: this.camera,
			speed: this.controls.effectiveSpeed,
		});
		const key = JSON.stringify(stats);
		if (key === this.#statsKey) {
			return;
		}
		this.#statsKey = key;
		this.stats = stats;
		this.statsRevision++;
		this.#notify();
	}

	// #endregion

	// #region frame loop

	#tick(time: number): void {
		this.#raf = requestAnimationFrame(this.#onFrame);
		const dt = this.#lastTime === 0 ? 1 / 60 : Math.min(0.1, (time - this.#lastTime) / 1000);
		this.#lastTime = time;
		this.#times.begin();
		const renderer = this.#renderer;
		const traversal = this.#traversal;

		const moved = this.controls.update(dt) || this.#settleFirstPose();
		const watered = this.#waterLevels.update(dt, this.options.waterLevelRate);
		this.#waterLevels.applyFloaters(this.#writeFloater);
		if (this.#sceneState.follow(this.camera.position)) {
			this.#dirty = true;
		}
		const resized = renderer.targets.update();
		this.#blendEnvironment({ force: this.#followCameraLevel(), dt });
		this.#times.span('controls');
		const scene = this.scene;
		const options = this.options;
		// pipeline variants compile on first use (stencil effects), and draw once ready
		const compiled = renderer.pipelines.size !== this.#seenPipelines;
		this.#seenPipelines = renderer.pipelines.size;
		const changed =
			this.#dirty ||
			moved ||
			watered ||
			resized ||
			options.continuous ||
			compiled ||
			(scene !== null && scene.stream.version !== traversal.seenVersion);
		this.#dirty = false;
		// the temporal antialiasing converges over a few more jittered frames of the same view
		let settling = false;
		if (changed) {
			this.#settleFrames = options.antialiasing ? SETTLE_FRAMES : 0;
		} else if (this.#settleFrames > 0) {
			this.#settleFrames--;
			settling = true;
		}
		// keep rendering while the exposure adapts. it meters only while the view changes or settles: water and
		// particles change what it meters every frame, so a meter that kept running would never let it settle
		const settings = frameSettings(options, scene !== null, postSettings(options, scene !== null));
		const adapting = renderer.post.adaptExposure(settings.post, dt, { metering: changed || settling });
		const render = changed || settling || adapting;
		const look = this.#environment.look;
		if (render && options.animate) {
			this.#time += dt;
			this.#windClock += windClockRate(look.environment.wind) * dt;
		}
		// frames that only settle or adapt reuse the last selection, unless it holds particles, which move by
		// the clock like the effects' scrolling textures, while the clock runs. with nothing rendering and nothing
		// loading, the traversal would repeat the last frame's
		const moving = options.animate && (traversal.particlesShown || traversal.spinsShown);
		const traverse =
			scene !== null &&
			((render && (changed || moving)) || !scene.stream.idle || traversal.textureReduction.raising);
		if (settings.shadows && (traverse || render)) {
			// once a frame, for both the mesh selection, which groups instances by the layers they reach, and the
			// shadow passes
			const { width, height } = renderer.targets;
			renderer.shadows.fit(this.camera, width / height, look.environment.sunDirection);
		}
		if (scene !== null && traverse) {
			this.#frame++;
			traversal.run(scene, {
				camera: this.camera,
				options,
				settings,
				look,
				focusCells: this.#focusCells,
				index: this.#frame,
				time: this.#time,
				waterOffsets: this.#waterLevels.offsets,
				prepare: render,
				times: this.#times,
			});
		}
		if (render) {
			this.#lastDraws = renderer.render({
				camera: this.camera,
				settings,
				look,
				index: this.#frame,
				time: this.#time,
				windClock: this.#windClock,
				terrain: scene?.pkg.manifest.terrain,
				options,
				times: this.#times,
			});
			this.#times.rendered(dt);
		}
		if (render || traverse) {
			this.#times.worked();
		}

		if (time - this.#lastStats > STATS_INTERVAL) {
			this.#lastStats = time;
			this.#publishStats();
		}
	}

	/** stops the loop and frees everything */
	destroy(): void {
		cancelAnimationFrame(this.#raf);
		document.removeEventListener('visibilitychange', this.#onVisibilityChange);
		this.unload();
		this.controls.destroy();
		this.#pool.destroy();
		this.#renderer.destroy();
	}

	// #endregion
}

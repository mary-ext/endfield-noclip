# driving the viewer

how an agent opens the viewer in a browser, poses the camera, reads its state and profiles it. how
the viewer works is in [viewer/index.md](viewer/index.md); its options are `ViewerOptions` in
[`src/viewer/options.ts`](../packages/viewer/src/viewer/options.ts) and its stats `ViewerStats` in
[`src/viewer/stats.ts`](../packages/viewer/src/viewer/stats.ts).

## opening it

use the `agent-browser` CLI with WebGPU enabled; without it the canvas stays blank. on macOS, pass
`--webgpu`:

```sh
pnpm run dev --port 0
agent-browser --webgpu open 'http://localhost:<port>/?package=map02&level=map02_lv007'
```

read the port from the `Local:` line the server prints. the URL takes the
[`package` and `level` parameters](viewer/loading.md#url-parameters).

- after `agent-browser close`, reopen with `--webgpu` again.
- `agent-browser console` keeps lines from before a reload; read only what follows
  `[vite] connected`.
- reload after editing a `.wgsl` file: the page keeps the pipelines it compiled, so a shader change
  doesn't show until then.
- reload after re-packing to read the new core. an open page retains the old manifest and may
  request archives the replacement removed; see [sources](viewer/loading.md#sources).
- wrap multi-statement `agent-browser eval` code in an IIFE: top-level `const` collides across
  evals.
- give `agent-browser screenshot` an absolute path; relative paths land in agent-browser's own
  working directory.

### on Linux

`--webgpu` runs WebGPU on SwiftShader, a software Vulkan, so the viewer crawls and screenshots time
out. run a headed browser on the hardware Vulkan driver instead. the flags depend on the machine, so
keep them in the gitignored `agent-browser.local.json` rather than in the repo or a global
agent-browser config:

```json
{
	"headed": true,
	"args": "--enable-unsafe-webgpu\n--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan\n--use-vulkan=native\n--use-angle=vulkan\n--ignore-gpu-blocklist\n--ozone-platform=wayland\n--disable-gpu-vsync\n--disable-frame-rate-limit\n--disable-renderer-backgrounding\n--disable-background-timer-throttling"
}
```

point agent-browser at it from `mise.local.toml` (add that file to `.git/info/exclude`), then run
`mise trust`:

```toml
[env]
AGENT_BROWSER_CONFIG = "{{config_root}}/agent-browser.local.json"
```

- interactive shells pick the variable up on entering the repo. non-interactive shells, such as an
  agent's, skip mise's prompt hook: launch with `mise exec -- agent-browser open '<url>'`. later
  commands reuse the open browser and can be plain `agent-browser`.
- `--ozone-platform=wayland` is for Wayland sessions; drop it under X11.
- the vsync and frame-rate flags keep the browser drawing when its window is on a hidden workspace.
  without them Wayland stops sending frame callbacks, the page drops to about 1 fps, and screenshots
  time out. the page still reports itself visible, so `document.visibilityState` can't detect this.
- with the frame-rate limit off, `continuous` renders as fast as the GPU allows; turn it off when
  done.
- headless mode reaches the GPU but captures the canvas as blank, because Chrome disables WebGPU
  interop with the compositor there. keep `headed` on.
- check the adapter with `viewer.stats.adapter` (the stats panel shows it too); `google swiftshader`
  means the config wasn't loaded.

## posing

`pnpm run dev` exposes the `Viewer` as `window.viewer` (production builds, `vite preview` included,
don't). because it renders only when dirty, set `viewer.options.continuous = true` before posing or
measuring. change other options with `viewer.setOptions({...})`, which marks the frame dirty and
applies the budget.

- `viewer.controls.flyTo({ position: [x, y, z], yaw, pitch })` takes **radians** (the on-screen
  camera readout shows degrees) and animates for up to 3 s; wait for it before reading results. yaw
  0 looks along +z, positive yaw turns towards +x, negative pitch looks down.
- writing `viewer.camera.position` directly moves the view only while `continuous` is on, since it
  doesn't mark the frame dirty; this is useful for walking the camera per frame.
- `viewer.flyToLevel(id)` makes a level current and flies over it; every level shows either way.
  after a flight lands, moving the camera into another level's cells makes that level current.
  `viewer.flyToPoint([x, y, z], distance)` flies to a view of a point from that far away, and
  `viewer.controls.flying` is true while a flight runs.

## inspecting

- environment: `viewer.environmentName`, `viewer.appliedVolumes` (volumes blended at the camera, in
  order), `viewer.environmentPhases()`, and `viewer.options.environmentVolumes / environmentPin`;
  switch a volume with `viewer.setSceneValue(volume.control, 0 | 1)`. volumes have height bands, so
  pose near the ground to see a level's own look; a high camera gets only the scene's global
  environment.
- `viewer.manifest` holds levels and controls, and `viewer.scene.pkg.environment` the environment
  table (`volumes`, `phases` with their sections looked up, `posts`); `viewer.currentLevel` is the
  current level's entry and `viewer.currentLevelIndex` its index.
  `await import('/src/environment/derive.ts')` gives `deriveEnvironment` for checking derived values
  against a profile.
- scene states are keyed by control index, the control's position in
  `viewer.manifest.states.controls` (find one with
  `controls.findIndex(({ id }) => id === 'quest:…')`): `viewer.sceneValues` (every control's value),
  `viewer.scenePicks` (a `Map`), `viewer.conditionResults`, `viewer.setSceneValue(index, value)`
  (`null` drops the pick), `viewer.setSceneValues(map)` for several at once and
  `viewer.resetSceneValues()`. `viewer.waterVolumes` lists the gameplay water volumes with their
  fill.
- stream areas: `viewer.visibleStreamAreas` (the areas shown at the camera, `null` when every area
  shows) and `viewer.options.streamAreas`. the viewer re-runs the trigger test whenever the camera
  moves and re-evaluates conditions when the set changes. above or below every trigger the game
  would fall back to the root areas; the viewer instead keeps the zones whose footprint the camera
  is over, so an overview still shows the level.
- look: `viewer.options.exposure` (EV on top of the level's and the auto exposure's),
  `viewer.options.autoExposure`, `viewer.stats.autoExposureEv` and `viewer.options.debugView`
  (`'clouds'` shows the raw cloud panorama).
- what draws something: `viewer.scene.meshes.selection.buckets` is the last frame's mesh selection
  (what `MeshSelector.run` returned; `meshes` is `null` for a package without converted geometry).
  each bucket has its `material` id (its row in the package's `debug/assets.json`), its `look`
  (`queue`, `unsupported`, `flags`, `textures`, and `params`, laid out by `LookRow` in
  [`looks/look.ts`](../packages/viewer/src/looks/look.ts): floats 0–2 the linear tint, 3 the
  alpha-test threshold; effect looks by `EffectRow` in `looks/effects/effect-look.ts`), its
  `geometry` item and `nearest`, the distance to its nearest instance. a look only says how a
  material draws, so first check the content is loaded: `viewer.scene.stream.get(blob)` is
  `undefined` for a blob never requested, and its `resident` is `null` until it's ready
  (`bucket.geometry.resident`, or a texture's blob). to name the entity behind a draw, search by
  position with [`world find --near`](extraction.md#finding-assets-and-scenery) or read the
  package's `debug/instances.jsonl` ([debug outputs](extraction.md#report-and-debug-outputs)).
- `viewer.stats` (refreshed every 250 ms): draws, triangles, instances, residency, queue and request
  counters, `cpuMs`, `cpuPhases` and `gpuMs`. `viewer.scene.stream.residentByKind()` splits the
  streamed residency by kind (textures, geometry, irradiance, …).

## profiling

- run `agent-browser set viewport 2560 1600` first to match a retina window.
- for each pose, fly there with `continuous` on, wait until streaming settles (`stats.queued`,
  `requestsInFlight`, `decoding` and `uploading` at 0), then sample `stats` over a couple of
  seconds.
- `stats.gpuMs` spans the first timed pass's start to the last one's end and matches frame time when
  GPU-bound. `stats.cpuPhases` splits CPU time into `controls`, `tree`, `mesh select`, `sky, water`,
  `stream`, `prepare`, `uniforms`, `encode` and `submit`.
- `cpuMs` includes waiting on the GPU (backpressure lands in `writeBuffer`), so when GPU-bound a CPU
  saving shows up as less waiting rather than a shorter frame; compare busy CPU time from a profile
  (`agent-browser profiler`).
- JS heap readings after a navigation include the previous page held in the back/forward cache, and
  readings over 1 GB while streaming are uncollected garbage; measure the heap from a fresh browser
  after a GC.
- Apple GPUs (tile-based) overlap passes, so `stats.gpuPasses` are pass lifetimes, not costs, and
  can sum to far more than `gpuMs`. attribute cost by ablation: toggle one option (`shadows`, `ao`,
  `bloom`, `water`, `sky`, `terrain`, `instances`, HLOD tiers, …) at a fixed pose, take a fresh
  baseline before each variant, and compare `gpuMs`.
- ablate only frames well over the 16.7 ms budget (raise the viewport if needed): a lightly loaded
  GPU clocks down, and a variant can then read slower than its baseline.
- large regions at the default budget evict content during a run, so resident content differs
  between runs; compare numbers within one run.
- `viewer.stats` is smoothed and hides hitches. for per-frame times, import the module in an eval
  (`await import('/src/viewer/stats.ts')`) and wrap `FrameTimes.prototype.begin` and `span`, with a
  `requestAnimationFrame` recorder for frame intervals. restart the dev server after any source edit
  before patching, and don't edit source during a run: once Vite has hot-updated a module it serves
  it under a `?t=` URL, so the plain import is another module instance and the patch records
  nothing.
- to compare two builds, give each its own worktree and dev server
  (`git worktree add --detach <dir> <commit>`, `pnpm install --offline`,
  `NOCLIP_PACKAGES=<repo>/out pnpm run dev --port 0`) and alternate runs between them, only while
  the machine is quiet: an extractor `pack` running beside it makes every CPU span 2–3× longer. GPU
  timestamps are steadier under load, but not immune.

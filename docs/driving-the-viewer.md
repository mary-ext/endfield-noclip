# driving the viewer

how an agent opens the viewer in a browser, poses the camera, reads its state and profiles it. how
the viewer works is in [viewer.md](viewer.md); its options and stats are `ViewerOptions` and
`ViewerStats` in [`src/viewer.ts`](../packages/viewer/src/viewer.ts).

## opening it

use the `agent-browser` CLI with WebGPU enabled; without it the canvas stays blank. on macOS, pass
`--webgpu`:

```sh
pnpm run dev --port 5199 --strictPort
agent-browser --webgpu open 'http://localhost:5199/?package=map02&level=map02_lv007'
```

the URL takes the [`package` and `level` parameters](viewer.md#url-parameters).

- after `agent-browser close`, reopen with `--webgpu` again.
- `agent-browser console` keeps lines from before a reload; read only what follows
  `[vite] connected`.
- after re-packing, reload: an open page keeps the old core archive's offsets. it notices when a
  shard's size no longer matches its manifest, stops streaming and offers a reload (see
  [sources](viewer.md#sources)), but a re-pack that keeps a shard's size goes unnoticed.
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
- `viewer.showLevel(id)` shows one level alone; `viewer.flyToLevel(id)` only flies there.

## inspecting

- environment: `viewer.environmentName`, `viewer.appliedVolumes` (volumes blended at the camera, in
  order), `viewer.environmentPhases()`, and
  `viewer.options.environmentVolumes / environmentPin / environmentEnabled`. volumes have height
  bands, so pose near the ground to see a level's own look; a high camera gets only the scene's
  global environment.
- `viewer.scene.pkg.manifest` holds levels, environment profiles, `environmentVolumes` and
  `environmentPhases`. `await import('/src/render/environment.ts')` gives `deriveEnvironment` for
  checking derived values against a profile.
- scene states: `viewer.sceneValues` (every control), `viewer.scenePicks`,
  `viewer.conditionResults`, `viewer.setSceneValue(id, value)` (`null` drops the pick).
- stream areas: `viewer.visibleStreamAreas` (the areas shown at the camera, `null` when every area
  shows) and `viewer.options.streamAreas`. the viewer re-runs the trigger test whenever the camera
  moves and re-evaluates conditions when the set changes. above or below every trigger the game
  would fall back to the root areas; the viewer instead keeps the zones whose footprint the camera
  is over, so an overview still shows the level.
- look: `viewer.options.exposure` (EV on top of the level's and the auto exposure's),
  `viewer.options.autoExposure`, `viewer.stats.autoExposureEv` and `viewer.options.debugView`
  (`'clouds'` shows the raw cloud panorama).
- `viewer.stats` (refreshed every 250 ms): draws, triangles, instances, residency, queue and request
  counters, `cpuMs`, `cpuPhases` and `gpuMs`. `viewer.scene.stream.stats.residentByKind` splits the
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

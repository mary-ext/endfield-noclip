# driving the viewer

how an agent opens, poses, inspects, and profiles the viewer in a browser. for viewer internals, see
[viewer/index.md](viewer/index.md), `ViewerOptions` in
[`src/viewer/options.ts`](../packages/viewer/src/viewer/options.ts), and `ViewerStats` in
[`src/viewer/stats.ts`](../packages/viewer/src/viewer/stats.ts).

## opening it

launch the dev server and open it with `agent-browser` (WebGPU must be enabled, or the canvas stays
blank). on macOS, pass `--webgpu`:

```sh
pnpm run dev --port 0
agent-browser --webgpu open 'http://localhost:<port>/?package=map02&level=map02_lv007'
```

read the port from the `Local:` line. the URL accepts
[`package` and `level` parameters](viewer/loading.md#url-parameters).

- pass `--webgpu` again when reopening after `agent-browser close`.
- `agent-browser console` keeps pre-reload output; read only lines after `[vite] connected`.
- reload after editing shader modules; the page keeps already-compiled pipelines.
- reload after re-packing; an open page retains the old manifest and may request removed archives
  ([sources](viewer/loading.md#sources)).
- wrap multi-statement `agent-browser eval` snippets in an IIFE so top-level `const` bindings don't
  collide across evals.
- pass an absolute path to `agent-browser screenshot`; relative paths resolve in agent-browser's own
  working directory.

### on Linux

`--webgpu` falls back to SwiftShader (software Vulkan), causing slow frames and screenshot timeouts.
instead, run Chrome headed on hardware Vulkan inside
[gamescope](https://github.com/ValveSoftware/gamescope)'s headless backend: it renders off-screen
with full GPU compositing, so frame times, GPU timings, screenshots, video, input, and pointer lock
match a visible window.

keep machine-specific config in the gitignored `agent-browser.local.json`:

```json
{
	"headed": true,
	"executablePath": "<repo>/agent-browser-gamescope.local.sh",
	"args": "--enable-unsafe-webgpu\n--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan\n--use-vulkan=native\n--use-angle=vulkan\n--ignore-gpu-blocklist\n--disable-gpu-vsync\n--disable-frame-rate-limit\n--disable-renderer-backgrounding\n--disable-background-timer-throttling"
}
```

create the wrapper script (add it to `.git/info/exclude`); `-r 1000` lifts gamescope's 60 Hz cap,
and Chrome runs on X11 via Xwayland:

```sh
#!/usr/bin/env bash
set -euo pipefail
chrome=$(ls -d "$HOME"/.agent-browser/browsers/chrome-* | sort -V | tail -1)/chrome
exec gamescope --backend headless -w 2560 -h 1600 -W 2560 -H 1600 -r 1000 --force-windows-fullscreen -- \
	env -u WAYLAND_DISPLAY "$chrome" --ozone-platform=x11 "$@"
```

point agent-browser at it in `mise.local.toml` (also add to `.git/info/exclude`), then run
`mise trust`:

```toml
[env]
AGENT_BROWSER_CONFIG = "{{config_root}}/agent-browser.local.json"
```

- non-interactive shells skip mise's prompt hook: launch with
  `mise exec -- agent-browser open '<url>'`. subsequent commands reuse the session and can call
  `agent-browser` directly.
- `agent-browser close` terminates that session's gamescope. named sessions (`--session <name>`)
  each spawn their own gamescope and GPU device; measure one at a time.
- with the frame-rate limit disabled, `continuous` renders uncapped; turn it off when done.
- the 2560×1600 window includes Chrome's toolbar; use `agent-browser set viewport` to set page size.
- for a visible window on Wayland, drop `executablePath` and add `--ozone-platform=wayland` to
  `args`. the vsync and frame-rate flags also keep rendering active on hidden workspaces (where
  Wayland otherwise throttles frame callbacks to ~1 fps while reporting the page visible).
- verify the GPU with `viewer.stats.adapter` (also in the stats panel); `google swiftshader` means
  the config did not load.

#### Chrome's own headless mode

where gamescope is unavailable, set `"headed": false` and add `--disable-vulkan-surface` to `args`
(required for an adapter). this uses hardware Vulkan but composites in software (`chrome://gpu`
shows "Compositing: Software only" and "WebGPU interop: Disabled"):

- every frame copies back to CPU, inflating frame and CPU times (on map02: `mesh select` 8 ms vs 6.5
  ms, flight median 11.7 ms vs 7.4 ms). compare headless runs only against each other.
- `agent-browser screenshot` captures a blank canvas. read the canvas directly instead (returns the
  last drawn frame without UI panels, even with `continuous` off):

```sh
agent-browser eval 'document.querySelector("canvas").toDataURL("image/png")' \
	| jq -r | cut -d, -f2 | base64 -d > /abs/path/shot.png
```

## posing

`pnpm run dev` exposes `window.viewer` (production builds and `vite preview` do not). the viewer
renders only when dirty, so set `viewer.options.continuous = true` before posing or measuring.
update other options with `viewer.setOptions({...})`, which marks dirty and applies the budget.

- `viewer.controls.flyTo({ position: [x, y, z], yaw, pitch })` takes **radians** (the on-screen
  readout shows degrees) and animates up to 3 s; wait for completion before sampling. yaw 0 faces
  `+z`, positive yaw turns toward `+x`, negative pitch looks down.
- mutating `viewer.camera.position` directly skips the dirty flag and only renders while
  `continuous` is on (useful for per-frame camera walks).
- `viewer.flyToLevel(id)` makes `id` current and flies over it (all levels still render). after
  landing, moving into another level's cells switches the current level.
- `viewer.flyToPoint([x, y, z], distance)` frames a point from `distance` m away.
  `viewer.controls.flying` is `true` during a flight.

## inspecting

| area         | APIs & notes                                                                                                                                                                                                                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| environment  | `viewer.environmentName`, `viewer.appliedVolumes` (blended in order), `viewer.environmentPhases()`, `viewer.options.environmentVolumes` / `environmentPin`, `viewer.setSceneValue(volume.control, 0 \| 1)`. pose near ground to hit height bands                                                                            |
| tables       | `viewer.manifest` (levels, controls), `viewer.scene.pkg.environment` (`volumes`, `phases`, `posts`), `viewer.currentLevel`, `viewer.currentLevelIndex`. `await import('/src/environment/derive.ts')` exposes `deriveEnvironment`                                                                                            |
| scene states | keyed by index in `viewer.manifest.states.controls` (`controls.findIndex(({ id }) => id === 'quest:…')`): `viewer.sceneValues`, `viewer.scenePicks` (`Map`), `viewer.conditionResults`, `viewer.setSceneValue(i, v)` (`null` clears pick), `viewer.setSceneValues(map)`, `viewer.resetSceneValues()`, `viewer.waterVolumes` |
| stream areas | `viewer.visibleStreamAreas` (`null` when all show), `viewer.options.streamAreas` ([camera controls](viewer/scene-states.md#camera-controls))                                                                                                                                                                                |
| look         | `viewer.options.exposure` (EV offset), `viewer.options.autoExposure`, `viewer.stats.autoExposureEv`, `viewer.options.debugView` (`'clouds'` for raw cloud panorama, `'gaps'` for incomplete materials)                                                                                                                      |
| stats        | `viewer.stats` (250 ms refresh: draws, triangles, instances, residency, queue/request counts, `cpuMs`, `cpuPhases`, `gpuMs`); `viewer.scene.stream.residentByKind()` splits residency by kind                                                                                                                               |

- **incomplete materials**: `viewer.setOptions({ debugView: 'gaps' })` stripes meshes missing
  features the game draws ([gaps](viewer/materials.md#gaps)). `viewer.gapsInView()` lists missing
  features from last frame (`gap`, `materials`, `nearest` in metres, sorted nearest first). check it
  before assuming a material is complete.
- **draw inspection**: `viewer.scene.meshes.selection.buckets` holds last frame's `MeshSelector.run`
  output (`meshes` is `null` if the package has no converted geometry). each bucket has:
  - `material`: id matching its row in `debug/assets.json`
  - `look`: `queue`, `unsupported`, `gaps`, `flags`, `textures`, `params` (`LookRow` in
    [`looks/look.ts`](../packages/viewer/src/looks/look.ts): floats 0–2 linear tint, 3 alpha-test
    threshold; effect looks use `EffectRow` in `looks/effects/effect-look.ts`)
  - `geometry` and `nearest` (distance to nearest instance)
  - check residency before debugging a look: `viewer.scene.stream.get(blob)` is `undefined` if never
    requested, and `resident` is `null` while loading (`bucket.geometry.resident` or a texture
    blob).
  - to identify the source entity, run
    [`scene find --near`](extraction.md#finding-assets-and-scenery) or read `debug/instances.jsonl`
    ([debug outputs](extraction.md#report-and-debug-outputs)).

## profiling

- set a retina-sized viewport first: `agent-browser set viewport 2560 1600`.
- fly to each pose with `continuous` on, wait for streaming to settle (`stats.queued`,
  `requestsInFlight`, `decoding`, and `uploading` all 0), then sample `stats` for a couple seconds.
- `stats.gpuMs` spans from the first timed pass's start to the last one's end (matches frame time
  when GPU-bound). `stats.cpuPhases` breaks CPU time into `controls`, `tree`, `mesh select`,
  `sky, water`, `stream`, `prepare`, `uniforms`, `encode`, and `submit`.
- `cpuMs` includes GPU backpressure (shows up in `writeBuffer`). when GPU-bound, CPU savings reduce
  wait time instead of frame time; compare busy CPU time with `agent-browser profiler`.
- uncapped Linux frames of a few milliseconds can outpace the GPU process, causing occasional 20–50
  ms blocks in `writeBuffer` or a draw. these disappear under pacing (tested at 2/3 frame rate) and
  aren't vsynced hitches; judge hitches by spans that stay long across runs or by timing the call
  directly.
- queue writes ≥1 MB stall the main thread ([staged writes](viewer/gpu-resources.md)). wrap
  `GPUQueue.prototype.writeTexture` and `writeBuffer` when `stream` is slow with few uploads.
- JS heap after navigation includes the previous page in bfcache, and >1 GB during streaming is
  uncollected garbage; measure heap in a fresh browser after GC.
- Apple tile-based GPUs overlap passes, so `stats.gpuPasses` are pass lifetimes, not exclusive
  costs, and can sum well above `gpuMs`. attribute cost by ablation: toggle one option (`shadows`,
  `ao`, `bloom`, `water`, `sky`, `terrain`, `instances`, HLOD tiers, …) at a fixed pose, take a
  fresh baseline before each variant, and compare `gpuMs`.
- ablate only on frames well over 16.7 ms (raise the viewport if needed); lightly loaded GPUs clock
  down, making a cheaper variant read slower.
- large regions evict under the default budget, so resident sets vary across runs; compare within
  one run.
- `viewer.stats` is smoothed and hides hitches. for per-frame timings, import
  `await import('/src/viewer/stats.ts')`, wrap `FrameTimes.prototype.begin` and `span`, and record
  `requestAnimationFrame` intervals. restart the dev server after source edits and don't edit during
  a run (Vite HMR serves updated modules with `?t=`, splitting module instances).
- to compare two builds, use separate worktrees and dev servers
  (`git worktree add --detach <dir> <commit>`, `pnpm install --offline`,
  `NOCLIP_PACKAGES=<repo>/out pnpm run dev --port 0`) and alternate runs on a quiet machine. a
  concurrent `pack` makes CPU spans 2–3× longer; GPU timestamps are steadier but not immune.

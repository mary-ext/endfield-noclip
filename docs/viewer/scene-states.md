# scene states

how the viewer evaluates and presents the conditional content that
[game-data/scene-states.md](../game-data/scene-states.md) describes. the package's controls and
conditional sets are in [package-format.md](../package-format.md#conditions).

## evaluation

`SceneState`
([`scene-states/scene-state.ts`](../../packages/viewer/src/scene-states/scene-state.ts)) resolves
every control's value when a pick changes (`resolveSceneValues`), recomputes `conditionVisible` for
every set (`conditionResults`) and turns the results into the shown visibility groups
(`groupsShown`), which go to every consumer the viewer registers (the instance selector, the local
lights, the water renderer, the irradiance regions). the resolved values also move the water levels,
and the condition results feed the environment blend, which re-plans only when they change: the
results array is replaced only when a result differs.

### camera controls

the camera stands in for the player: unless the user picks a value, the viewer sets every camera
control from the eye (`cameraValues`; [package format](../package-format.md#controls)). an `area`
test is 1 while the game's trigger test ([stream areas](../game-data/world.md#stream-areas)) shows
its area at the eye (`zonesAt`, `areasShownIn`); a `near` test is 1 while the eye is within any of
its reaches (an interactive's radius); a `triggers` test keeps the value the last trigger volume the
eye entered or left set. `SceneState` holds the triggers' memory of the camera's path and drops it
with the package, so the first evaluation enters every volume holding the eye. the viewer recomputes
them whenever the camera moves and re-evaluates visibility only when one changes. an interactive
swaps between its two settled looks at once, without the game's transition clips.

## the scene conditions panel

[`ui/scene-controls/`](../../packages/viewer/src/ui/scene-controls/) shows the "Scene conditions"
panel, a section per package category in the package's order, with modules for the sections that
show more than their controls (`story-controls.tsx`, `water-levels.tsx`, `environment-volumes.tsx`)
and per row (`control-row.tsx`, `drivers.tsx`). a row is a checkbox for an off/on control only the
user sets, else a select, with "Follow game" or "Follow camera" for derived and camera controls:

- **scene states**: a select per state, "Follow game (on/off)" for derived states, else on/off
- **quests and missions**: quests run in order, so progress is picked as a story point rather than
  per quest ([`story.ts`](../../packages/package-format/src/story.ts)). "Main story progress" lists
  the main story's missions in id order (episode, mission, decimal) with a point at each mission's
  start and at each step a listed quest sits at; picking one completes every quest and mission
  before it, sets that step and its mission in progress and leaves the rest not started. each
  mission below, grouped by quest log tab (with chapter, episode and where it takes place), has the
  same "Progress" select over its own steps, and its quests' individual state selects under
  "Quests". rules elsewhere show quests by mission and quest name instead of id. since a mission's
  quests can switch scenery of other levels
  ([quest and mission labels](../game-data/scene-states.md#quest-and-mission-labels)), the panel
  lists a quest for the levels it gates and shows where its mission takes place
- **variables**: a select of ranges, the default marked "(initial)"
- **progression**: one select per progression, "Level n", "Visual form n" or "Group level n",
  starting at the highest (the finished world) with every lower one selectable, and one per campfire
  or saved Animator bool (The Hub's comm terminal), activated or set by default; facility forms are
  labelled "Visual form", not "Level", because form numbers aren't gameplay levels
  ([facility visual forms](../game-data/scene-states.md#facility-visual-forms))
- **Dijiang**: a Control Nexus level select, a checkbox per cabin slot, built or empty, and a level
  select for the growth chamber
- **created during play**: a checkbox per level for its interactives created after it loads
  (`createState` ≠ 0), off by default
- **limited-time events**: one checkbox per scene for its event photo spots
  ([event placements](../game-data/scene-states.md#event-placements)), off by default
- **doors and bridges**: a checkbox per door, open or closed, or "Follow game" for a cabin's door; a
  checkbox per telescopic bridge, extended or retracted
- **stream areas**: a select per area, "Follow camera (shown/hidden)", shown or hidden
- **player nearby**: a select per interactive whose look the player's presence changes, "Follow
  camera", away or near, each labelled with its settled states
- **harvest**: standing or felled
- **script / event scenery**, **logic-gate previews**: checkboxes, or "Follow game (on/off)" for a
  script group derived from its scripts' quest checks; a script group lists its drivers ("Shown when
  the player uses …", "Hidden by quest progress: …"), with "Go" flying to a driver's place
- **water levels**: a select per gameplay water volume's `waterLevel` control, over the fills
  scripts set it to, listing what sets each ("Set to 37% … by quest progress: …")
  ([water volumes](water.md#water-volumes))
- **lighting / environment volumes**: volumes owned by the current level or reaching into it, then
  the rest under their owning level, each a checkbox over its `environmentVolume` control, which its
  group requires alongside its scene states ("(not loaded)" when those fail). scripted-blend volumes
  (blend mode 3) default off, since the script that fades them in isn't followed (see
  [environment.md](../game-data/environment.md#activation))

every row shows where the control's content is (its [place](../package-format.md#controls) label,
with "Go" flying there), the control's rule (what it follows) and the assumption behind its default,
and "Drives …" naming the derived controls that read it (`followersOf`), so a cabin slot names its
door and a quest the scene states it switches. every section starts collapsed. "Show" picks which
controls the sections list
([`scene-states/listing.ts`](../../packages/viewer/src/scene-states/listing.ts), which also decides
the volumes listed):

- **near the camera** (the default): controls whose content lies within 200 m of the camera (the
  distance to its box, else to its position), nearest first, in the sections that have any. the list
  follows the camera in 25 m steps. controls whose content is spread over the scene have no place
  and aren't listed here
- **this level**: first the controls whose `levels` include the
  [current level](streaming.md#levels), then, under "Other levels", a collapsed group per other
  level with the controls it gates; a control gating several levels is in each of their groups
- **everything**, and **picked**: the controls the user picked a value for, wherever they are

"Reset" drops every pick. the settings panel's "stream areas at camera" toggle switches every area
that follows the camera between following it and showing. conditional detail ignores HLOD refinement
and stops streaming once its tile is below the screen error threshold ([streaming](streaming.md)).

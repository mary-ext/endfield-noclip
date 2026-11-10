---
name: investigating-render-gaps
description:
  Use when the viewer is missing something the game shows, draws it wrong (wrong texture, colour,
  transparency, lighting on one object), shows magenta checkers or stand-ins, or the user asks
  whether something is conditional — finds the source offline, establishes the game's behaviour,
  implements it and records what's left
---

# investigating render gaps

## overview

the viewer gets content right by reading what the game does, not by fitting it by eye. find what
sits at the spot, read how the game draws or gates it, implement that, and write the finding into
`docs/`. answer questions offline from the install, the packages in `out/` and the decompiled
evidence in `.research/`: those answers are scriptable and reproducible, and they don't compete with
other agents for the browser or dev server. leave browser reproductions until a question can only be
answered by looking at the rendered frame.

## 1. announce

other agents may be editing the same tree. call `ListAgents` and message only the sessions working
in this repo: the list doesn't show directories, but session names start with their working folder's
name (`endfield-noclip-…` here), and a message to an unrelated session interrupts work that can't
conflict with yours. `SendMessage` each one with what you're investigating, the files and docs you
expect to touch, whether you'll repack `out/<scene>/` and the browser session name you'd use. ask
for their files and avoid them. as a subagent without those tools, your parent coordinates; tell it
which files you'll touch. either way, treat uncommitted changes you didn't make (`git status`) as
someone else's work. while others are active:

- stage only your own hunks (`filterdiff` + `git apply --cached`); never stash, reset or check out
  files, which breaks their work and their dev servers
- format only the files you changed (`pnpm exec oxfmt <files>`); the repo-wide `pnpm run fmt`
  rewrites their in-progress files
- tell them before repacking a package they may have open, since an open page keeps the old manifest

## 2. orient

1. read `.research/README.md`, `docs/status.md` and the `docs/` page for the area. if status already
   lists the gap, start from what it names as missing.
2. get a position. the user's shot or the viewer's camera readout gives Unity coordinates; cells are
   128 m (`floor(x / 128)`, `floor(z / 128)`).

## 3. locate offline

| question                                        | answer with                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| what is placed here, from any source, gated how | `pnpm extract world find <scene> --near=x,y,z --radius n [--name re] [--kind k] [--max-size 50]` |
| an entity's draws, meshes and materials         | `pnpm extract asset entity <map> <x> <z> <index or id>`                                          |
| a material's shader, keywords and properties    | `pnpm extract asset material <asset path>`; `bundle dump` for the raw record                     |
| why something didn't pack or became a stand-in  | `out/<scene>/debug/{assets,stand-ins,unsupported-*}.json`                                        |
| which drawn block came from which entity        | `out/<scene>/debug/instances.jsonl` with `chunk-files.json`                                      |
| stream areas and progressions                   | `pnpm extract variants`                                                                          |

write negative coordinates as `--near=-763,215,-1190`; with a space, the value parses as a flag. run
any command without arguments for its usage. for what the CLI doesn't answer, write a scratch probe
on the `packages/formats` readers and delete it once the finding is recorded; when a probe answers a
question you expect to ask again, move it into the CLI.

the obvious material is often not the cause: check child objects, other submeshes and dynamic
structures before concluding. a "no renderer" row lists its component ids; one the packer doesn't
read can be what the game draws there. the packer can also drop content without a `debug/` record,
so absence there doesn't prove nothing was dropped; a silent drop is itself a gap to fix.

## 4. decide whether it's conditional

content that shows in only some game states lives in scene states, stream areas, load gates,
progressions, view states or script groups
([scene-states.md](../../../docs/game-data/scene-states.md)).

- **client-driven** (a table, mission, level script or client default sets it): implement it as a
  scene control, defaulting to its known default.
- **server-driven** (nothing in client data sets it): keep the known default and document it as
  server-driven.
- **only in a quest or boss state**: tell the user before going further; they may drop it.

## 5. establish the game's behaviour

read it from the source: the shader variant the material uses (`.research/shaders/dump.sh`, see
`.research/tooling.md`), the IL2CPP dump and headless Ghidra for C# and native code, and the
material's own properties. when notes disagree, read the source again. search GitHub for existing
Endfield tooling before writing a decoder (CLAUDE.md).

every claim you report is either checked against the source or labelled unverified. "probably
intended" isn't a finding.

## 6. implement

- draw what the viewer can't render yet as unsupported (the magenta checker) or as a
  [stand-in](../../../docs/package-format.md#stand-ins), never hidden: a missing object is harder to
  notice than a marked one. hiding or skipping content needs the user's agreement first.
- when offering choices, recommend the one that matches the game; a cheaper option is a fallback.
- bump the package version on any incompatible format change, then repack every package in `out/`.

## 7. verify

1. tests for the new reader or look, using the real material family or record; `pnpm test`,
   `pnpm run lint`.
2. repack the scene if the extractor or format changed (`pnpm extract pack <scene>`; a crash on the
   first run is worth one retry).
3. check the result offline where it's numeric (packed values, `debug/` outputs, decoded textures).
4. only then, if the look itself has to be seen, use the browser (below). check the user's pose, one
   other place, and the control's other state.

## 8. browser, when needed

follow [driving-the-viewer.md](../../../docs/driving-the-viewer.md). use your own session and, with
others active, your own dev server, so you don't move another agent's camera or show them your debug
colours. start it in the background and take the port from its `Local:` line:

```sh
pnpm run dev --port 0
mise exec -- agent-browser --session <task> open 'http://localhost:<port>/?package=<scene>&level=<level>'
```

how to find what draws something on screen is in that page's "inspecting" section. when done, turn
off `continuous` and any debug view, then close the session (`agent-browser --session <task> close`)
and stop the dev server you started.

## 9. record and finish

- game behaviour goes in `docs/game-data/`, how our code does it in `docs/viewer/`, `extraction.md`
  or `package-format.md`, and whatever remains in `docs/status.md`, in the same commit. decompiled
  code, paraphrases of it and addresses stay in `.research/`.
- leads that aren't settled go in the topic's `.research/` note, with the date, the ids and
  coordinates involved and what's still unverified, so the next investigation starts from them. a
  pasted shot isn't saved: record what it shows and its pose. delete scratch probes; the note
  records what they found.
- one commit per logical change, per CLAUDE.md.
- report what was verified and what wasn't. a gap that stays open is fine once status lists it.
- send peers a completion message: commits, packages repacked (so they reload), files freed.

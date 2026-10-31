Endfield's game levels in the browser: an offline extractor turns a local game install into a
package, and a WebGPU viewer streams that package one level at a time.

Last verified: 2026-10-31

## layout

- `packages/formats`: environment-agnostic decoders for the game's containers and Unity/Endfield
  formats
- `packages/extractor`: the `pnpm extract` CLI; reads the install and writes packages to
  `out/<map>/`
- `packages/package-format`: the package contract shared by the packer and the viewer
- `packages/viewer`: the WebGPU viewer (React, Vite)
- `docs/`: how the game data and our code work. read the page for the area you're changing before
  changing it, and update it in the same commit when behavior changes, because these pages are the
  only durable record of the findings. start at [docs/architecture.md](docs/architecture.md); known
  gaps are in [docs/status.md](docs/status.md)

## development notes

### project management

- manage tools like Node.js, Bun, and pnpm with mise
- run the dev server with `pnpm run dev`, build with `pnpm run build` (Vite)
- run tests with `pnpm test` (`node --test`), the extractor with `pnpm extract <command>` (no
  arguments lists commands)
- format with `pnpm run fmt` (oxfmt)
- lint and typecheck with `pnpm run lint` (oxlint)
- check `pnpm view <package>` before adding a new dependency

### code writing

#### formatting

- name new files in kebab-case
- indent with tabs (spaces allowed for diagrams in comments)
- use single quotes for strings; reserve template literals for localization (user-facing strings,
  error messages)
- add trailing commas
- order type/object fields in the way you'd introduce a thing to someone, typically this would be:
  discriminant → identifiers → names → description → classification/status → data/values →
  metadata/references → methods

#### control flow and structure

- use braces for control statements, even single-line bodies
- group related code and limit variable scope with bare blocks `{ }`
- use `switch` over `if`/`else if` chains when branching on a single discriminant value
- use `if` over ternaries for complex statements
- delimit sections of larger files with `// #region <name>` and `// #endregion`
- prefer direct imports over barrel modules unless their tree-shaking behavior is understood and
  their impact on bundle size is negligible or absent

#### functions and methods

- prefer arrow functions; use method shorthand for object/class methods
- make parameters optional only when callers both pass and omit them. remove unused defaults;
  require always-passed parameters. use separate functions when presence/absence selects distinct
  behavior
- prefer an options object for boolean flags, confusable same-typed parameters, or 2+
  optional/defaulted parameters. split boolean-selected behaviors into separate functions.
  otherwise, positional parameters are fine when their types and order are clear

#### types

- use `as Type` or `as const` only to resolve TypeScript errors when no cleaner solution exists

#### mutation

- do not mutate arguments or values reachable through them; copy first. mutation is fine for owned
  values (locals, clones, new objects), or when the function's name and JSDoc explicitly promise it

### commit workflow

- commit directly on `trunk`; this repo doesn't use feature branches
- one logical change per commit; choose the type for the whole change, not each file category
- accepted types:
  - `feat`: additions to the public API
  - `fix`: bug fixes
  - `refactor`: restructuring without behavior changes
  - `docs`: Markdown documentation
  - `chore`: build, tooling, dependencies, mass-autofixes, or standalone tests/comments/JSDoc
- ship related tests and comments with their feature or fix
- no scopes: `feat: ...`
- mark breaking changes with `!`: `feat!: ...`

### documentation

- use lowercase in READMEs, comments, JSDoc, and commit messages, except for proper nouns, acronyms,
  and 'I'. public-facing interfaces (web UI) are exempt
- omit boilerplate and obvious restatements in documentation and user-facing messages. keep shared
  explanations in one place; link instead of repeating
- comment only non-trivial code; explain why
- add JSDoc to new publicly exported functions, methods, classes, fields, and enums:
  - `@param` for parameters (no dashes after param names)
  - `@returns` for return values
  - `@throws` for exceptions when applicable
  - describe the caller-facing contract, including preconditions. put implementation details and
    rationale in regular comments unless they constrain callers

### agentic coding

- use root `.research/` for experiments, probes, plans, and reference materials like cloned Git
  repositories; create it if absent. it is local and disposable: committed code, documentation, and
  commit messages must not reference paths inside it or depend on its contents. when a finding there
  settles, write it into the matching `docs/` page, following that page's rules on what stays out
- to see a change in the viewer, drive it with `agent-browser` as described in
  [docs/driving-the-viewer.md](docs/driving-the-viewer.md)
- before building a decoder, dumper, or other reverse-engineering tool, search GitHub
  (`gh search code '<identifier>'`, `gh search repos`) for existing Endfield tooling and build only
  the missing part. MIT code can be adapted; GPL, AGPL, and non-commercial tools are reference only

### what the repo holds

the repo ships extractors and the viewer, never the game's keys or content. the game's ToS bans
reverse engineering, and Hypergryph has had a VFS decryptor removed from GitHub by DMCA, so
committed keys or game-derived files would expose the repo the same way.

- keys come from the user's install: `init` derives what it can, takes the rest from `--keys-from`,
  validates each against the install, and saves them to the gitignored `endfield.local.json`
- extracted output stays in the gitignored `out/` or outside the repo
- decompiled shaders and C#, paraphrases of them, binary addresses, and other listings of
  Hypergryph's code stay out of the repo, including `docs/`. describe the behavior our code
  implements instead
- check each diff for keys and game-derived files before committing

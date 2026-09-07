# F.A.J.R. — Forward Assessment of Joint-node Relationships

A single-page web app for exploring how a set of coded items depend on each
other, and for answering the question *"if I change this one number, what else
moves, and by how much?"*

Upload two spreadsheets, get an interactive dependency graph, change any code,
and watch the effect propagate. Everything runs in the browser — no server, no
build step, and no file ever leaves the machine.


## Running it

Open `index.html` in a browser. That is the whole installation.

To serve it over HTTP instead (any static host works — GitHub Pages, S3, nginx):

```bash
npx http-server -p 8080 .      # then visit http://localhost:8080
```

Two datasets are bundled, so there is something to explore before you upload
anything:

* **Sample · 25 codes** — a real-shaped export: every code carries a formula,
  many `BCode`s are missing from the values file, and six codes form a loop.
* **Demo · 100 codes** — a generated layered model (inputs → components →
  assemblies → modules → products → indicators) with 241 links, weighted terms,
  a few references outside the values file, and one deliberate feedback loop.

**Download templates** gives you correctly-shaped starter files.

## Working with several datasets

Datasets live side by side. The switcher in the header selects the active one,
**+ Add** loads another pair of files (or a bundled dataset), **Rename** gives it
a meaningful name, and **Remove** deletes it — your original files are never
touched.

Each dataset keeps its own rows *and* its own hand-arranged node positions, and
the whole set is saved in `localStorage`, so a reload picks up where you left
off. If the browser refuses to store them — private mode, or a very large
upload — the app says so and keeps them in memory for the session.

## The home screen

Click the logo, or the **Home** button in the header, to return to the landing
page — the same instructions-and-upload screen you see on a first visit. Once
you have datasets loaded, they're listed there too, as a grid of cards: the one
marked **Currently open** is the one **Back to workspace** returns you to;
click any other card to jump straight to its view instead.

Going home and coming straight back to the dataset you left doesn't lose your
place — the app only rebuilds the model when you actually switch to a
*different* dataset, so an in-progress scenario survives a quick look around.

## The two files

Accepted formats: `.xlsx`, `.xlsm`, `.csv`, `.tsv` (and `.xls` where the optional
SheetJS library is reachable). Headers are matched case-insensitively, common
synonyms are accepted (`ID` for `Code`, `Depends On` for `BCode`, `Op` for
`Operation`), and if a workbook has several sheets the first one carrying the
required columns is used — a title banner above the header row is fine.

### 1 · Values — the master record

| Code | Value | Description | Type |
|------|-------|-------------|------|
| 1 | 51 | Controls integration point for linked entities | TypeA |
| 2 | 71 | Aligns dependency structure for dependent items | TypeA |

`Code` is the primary key. `Value` is the current number, and is treated as
authoritative (see *How the simulation works*). `Description` and `Type` are
labels — `Type` also drives the filter chips on the Data tab.

### 2 · Dependencies — one row per term

| Code | Operation | BCode |
|------|-----------|-------|
| 7 | + | 67 |
| 7 | − | 6 |
| 7 | + | 31 |

`BCode` is the foreign key back into the values file. Rows sharing a `Code`
combine **in file order**, so the three rows above mean `7 = +67 − 6 + 31`.

* **Operations**: `+ − × ÷ ^ %`, written as symbols or words (`add`, `minus`,
  `times`, `divide`, `pow`, `mod`). Normal arithmetic precedence applies:
  `^` first, then `× ÷ %`, then `+ −`.
* **Weights**: an optional `Weight` / `Factor` column scales a term, as does a
  number written into the operation itself (`*0.5` means "half of that code").
* **Constants**: a row with a number in `Operation` and an empty `BCode` adds a
  literal, e.g. `Operation = +250`.

## How the simulation works

Real dependency exports are rarely tidy. In the bundled sample **every** code
carries a formula (there are no pure input codes), 40 of the referenced `BCode`s
have no row in the values file at all, and codes 5, 6, 7, 8, 23 and 24 form a
circular loop. Recomputing every value from first principles would invent
numbers, so the engine does something more careful.

Each code stores a **residual** — the part of its declared value the formula does
not explain:

```
residual(C) = declaredValue(C) − evaluate(formula(C) using declared operands)
```

A scenario then evaluates `value(C) = evaluate(formula(C) using current operands) + residual(C)`.
Two useful properties follow:

1. **With no changes applied, every value matches your file exactly.** The app
   never silently disagrees with the source data.
2. **Unresolved operands stay constant**, because their contribution is captured
   inside the residual — so a change propagates cleanly through the codes you
   *do* have.

Results are labelled wherever that reasoning weakens:

| Label | Meaning |
|-------|---------|
| *(none)* | Exact. |
| `approx` | A `×` or `÷` term has an operand that could not be resolved, so the propagated amount is an approximation. |
| `in loop` | The code sits in a circular dependency. |
| `estimate` | The value comes from a single propagation pass because the loop it depends on does not settle. |

A loop whose gain reaches 1 has no stable solution — iterating it just produces
ever-larger numbers. The solver detects that, falls back to a first-order
estimate, and marks the affected codes rather than reporting a figure that is
really an artefact of the iteration count. Pinning a code inside a loop (adding
it to the scenario) cuts the loop and makes the surrounding results exact again.

## What you can do

* **Find a code** — a searchable dropdown in the graph toolbar lists every code
  with its value and description, matches on code *or* description, and focuses
  the one you pick: it is selected, centred, and revealed even if a filter was
  hiding it.
* **Graph** — layered left-to-right (dependencies feed the codes to their right),
  with pan, zoom (wheel, buttons, or pinch on touch), and per-node detail.
  Oversized layers wrap into sub-columns so a hundred codes still read at a
  sensible zoom, and hovering a code lights up everything it touches. Green and
  red show the direction of change, blue traces the live propagation path,
  dashed links are subtracted terms, and amber marks circular groups. External
  codes are hidden by default; the toolbar checkbox brings them in.
* **Arrange it yourself** — drag any code to reposition it. Moved codes are
  pinned (marked with a dot), keep their place through filtering and
  re-rendering, and are remembered with the dataset. *Reset layout* returns
  everything to the automatic arrangement, and *Unpin* releases one code.
* **Isolate** — narrow the map to one code and its dependency chain, at direct
  links, two hops, or the full chain. *Hide* drops individual codes out of the
  view instead. Both show as chips above the graph and are one click to undo,
  and isolation overrides the toolbar filters so nothing relevant stays hidden.
* **Scenario** — pick a code from the same searchable dropdown, then stack
  several changes at once, each as *set to*, *adjust by*, or *adjust by %*.
  Choosing a code also highlights it in the graph, so you can see what it feeds
  before committing to a number. Click any node and *Simulate this code* to
  target it.
* **Impact** — every affected code with baseline, simulated value, change,
  % change and a magnitude bar. Sortable; click a row to centre that code.
* **Formulas** — each formula next to its declared value, what the formula
  explains, and the residual.
* **Data** — the merged dataset with dependency counts, searchable and
  filterable by type.
* **Similar** — find codes that overlap. See *Finding overlap between codes* below.
* **Issues** — duplicate codes, missing `BCode`s, unreadable operations,
  self-references, circular loops, and declared-vs-formula mismatches.
* **Export** — the scenario and its results as CSV, notes included.

## Finding overlap between codes

"Overlap" here means shared *dependencies* — two codes that both read from the
same inputs — not similar values. A code with a small value and a code with a
huge one can still be a 100% match if they are built from exactly the same
pieces.

The **Similar** tab has two views:

* **Overlap scan** automatically compares every code in the model against
  every other and lists the pairs that share something, ranked by how much.
  Each row shows two numbers, because one hides a real distinction:
  - **Match** (Jaccard: shared ÷ everything either uses) — how alike two codes
    are overall.
  - **Containment** (shared ÷ the smaller code's own total) — whether one code
    sits *entirely inside* the other. A 3-term code fully contained in a
    30-term one scores a low match but 100% containment, and is flagged
    `is part of` rather than buried as a weak match.

  Codes whose dependency set is *exactly* identical are called out separately
  above the table — usually worth a second look at the source data. Rows are
  sortable, the shared codes themselves are shown as chips so you can see
  *what* overlaps and not just *how much*, and clicking a row opens those two
  codes in Compare.

  Three bases are selectable, because they answer different questions: direct
  dependencies (near-duplicate formulas), the full upstream chain (shared
  foundations, however many steps back), or shared dependents (codes that feed
  the same consumers). A dependency used by almost everything (a hub) is
  excluded automatically — it does not distinguish anything, and would swamp
  every row with the same match.

* **Compare codes** lets you pick any number of codes by hand — search and add
  them one at a time, up to eight — and see a match-percentage matrix between
  every pair, plus a full breakdown of which dependency belongs to which
  codes, with rows shared by all of them highlighted first.

## Project layout

```
index.html              markup and layout
assets/css/style.css    styling, light and dark themes
assets/js/xlsx-lite.js  self-contained .xlsx reader (ZIP + XML, no dependencies)
assets/js/parse.js      file reading, header matching, CSV parsing
assets/js/engine.js     model building, formula evaluation, scenario solving
assets/js/graph.js      layered SVG graph: pan, zoom, pinch, drag, isolate
assets/js/similarity.js dependency-overlap scan and multi-code compare
assets/js/combobox.js   searchable code picker used by both dropdowns
assets/js/datasets.js   the dataset store and its localStorage persistence
assets/js/dialog.js     small modal prompts for renaming and removing
assets/js/app.js        UI wiring
assets/js/sample.js     embedded demo dataset
sample-data/            both bundled datasets as CSV files
```

## On phones and tablets

The layout stacks into a single column — controls first, then the graph, then
the numbers — and the page scrolls normally. The graph keeps a workable height
of its own (about 60% of the viewport, more in landscape) and responds to drag
and pinch-to-zoom. The code pickers are built as custom dropdowns rather than a
native `datalist`, which mobile browsers handle inconsistently, and their rows
are sized for touch.

## Browser support and privacy

`.xlsx` files are unzipped with the browser's native `DecompressionStream` and
read with `DOMParser`, so no library is downloaded — the page is fully functional
offline, including straight from the filesystem. That needs Chrome 103+, Edge
103+, Firefox 113+ or Safari 16.4+. CSV and TSV work in any browser.

SheetJS is referenced from a CDN purely as an optional extra so legacy `.xls`
files can also be opened; if it is blocked or unavailable, everything else
continues to work.

Files are parsed in the browser. Nothing is uploaded anywhere, and there is no
analytics or tracking of any kind. The only thing stored is your light/dark
preference, in `localStorage`.

Date-formatted cells are returned as their underlying serial number, which suits
the code / number / label columns this app reads.

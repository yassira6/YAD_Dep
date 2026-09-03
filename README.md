# YAD Dep — dependency & impact simulator

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

Click **Load sample data** to explore immediately with the dataset in
`sample-data/`, or **Download templates** to get correctly-shaped starter files.

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

* **Graph** — layered left-to-right (dependencies feed the codes to their right),
  with pan, zoom, search, and per-node detail. Green and red show the direction
  of change, blue traces the live propagation path, dashed links are subtracted
  terms, and amber marks circular groups. External codes are hidden by default;
  the toolbar checkbox brings them in.
* **Scenario** — stack several changes at once, each as *set to*, *adjust by*, or
  *adjust by %*. Click any node and *Simulate this code* to target it.
* **Impact** — every affected code with baseline, simulated value, change,
  % change and a magnitude bar. Sortable; click a row to centre that code.
* **Formulas** — each formula next to its declared value, what the formula
  explains, and the residual.
* **Data** — the merged dataset with dependency counts, searchable and
  filterable by type.
* **Issues** — duplicate codes, missing `BCode`s, unreadable operations,
  self-references, circular loops, and declared-vs-formula mismatches.
* **Export** — the scenario and its results as CSV, notes included.

## Project layout

```
index.html              markup and layout
assets/css/style.css    styling, light and dark themes
assets/js/xlsx-lite.js  self-contained .xlsx reader (ZIP + XML, no dependencies)
assets/js/parse.js      file reading, header matching, CSV parsing
assets/js/engine.js     model building, formula evaluation, scenario solving
assets/js/graph.js      layered SVG graph with pan/zoom
assets/js/app.js        UI wiring
assets/js/sample.js     embedded demo dataset
sample-data/            the same demo data as CSV files
```

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

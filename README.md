# Fast CSV reader for broken files

[![make.fun competition](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/Vikkry88/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/Vikkry88/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's csv-reader 1.0.0, entered in
[csv-reader-speed-01-run-20261121](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
on [make.fun](https://make.fun). `solve.js` exports `run(input)`, which returns
exactly what csv-reader's `readCsv` returns for every `{text, header}` input —
`{columns, rows, errors}` — and `main.ts` is the harness driver that answers
every case in `/input/cases.json` into `/output/answers.json`.

## Approach

csv-reader reads the text one character at a time and builds each field one
character at a time. This entry keeps its broken-row policy exactly (BOM
dropped, empty lines are no record, stray CRs dropped, junk after a closing
quote appended, a quote that never closes read as a literal with its text
re-read as unquoted, ragged rows padded/cut to the first record's width,
errors in the order met) but finds field boundaries with native `indexOf`
scans:

- Three delimiter pointers (next comma, next LF, next CR at or after the read
  position) are cached and refreshed with a single `indexOf` each as the read
  position passes them, so total native scanning stays linear and most fields
  cost one string slice.
- A quoted field's closing quote is found with `indexOf`, skipping doubled
  pairs; when the content holds no escaped quote and no CR, the value is one
  slice and its line count is tallied with `indexOf`.
- Only fields that need rewriting — a stray CR outside quotes, an escaped
  quote or a CR inside quotes — take a segmented char-code scan that joins a
  few slices.

No regex, no `split`, no per-field result objects; field values are single
slices in the common case.

## Correctness

Checked against csv-reader 1.0.0 (the kit's oracle) with deep JSON equality:

- Practice set: 6/6 cases identical.
- 18 further cases drawn with the competition's own generator under fresh
  seeds: 18/18 identical.
- 156 hand-written edge cases (BOMs, stray CRs, unterminated quotes, quote
  junk, ragged rows, CRLF/LF mixes, empty lines, EOF quirks) × both header
  settings: all identical.
- 60,000 random small strings over a delimiter-heavy alphabet and 3,000
  randomly assembled broken CSV files: all identical.

## Benchmarks

Measured locally (Node 24, shared 1.5-CPU cell; treat as indicative):

- Parse only (`run()` over 24 cases totalling 40.7 MB — the 6 practice cases
  plus 18 generator-drawn ones): csv-reader median ≈ 3.69 s (≈ 11 MB/s),
  this entry median ≈ 0.58 s (≈ 70 MB/s) — about **6.4× faster**.
- End to end (`main.ts` on the practice set, including JSON parsing and
  writing): csv-reader ≈ 1.7 s, this entry ≈ 0.65 s — about **2.6× faster**;
  outputs byte-identical.

## Run

```
node main.ts
```

Reads `/input/cases.json`, writes `/output/answers.json` (outside a container,
`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` stand in for those directories).

## License

MIT — see `LICENSE`.

# mend — one patch tool for every AI edit format

`mend` reads a patch in any of the four formats AI coding tools emit and applies it to the files it names. One tool, every format, no guessing which one you're looking at.

## Formats

- **Unified diffs** — classic `---`/`+++` hunks with `@@` ranges.
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` style.
- **V4A patches** — `*** Begin Patch` / `*** Add File` / `*** Update File` / `*** Delete File` with `@@` anchors.
- **JSON tool calls** — structured edit operations as JSON.

Format is auto-detected; pass `--format unified|search-replace|v4a|json` to force one.

## Run

```sh
node main.ts [options] [PATCH]
```

Node 22, standard library only, nothing to install. `PATCH` is a file, or omit it to read from stdin.

## How it applies

Each edit is located at the first of three matching tiers (exact, then re-indented, then fuzzy), so a patch still lands when the file's indentation drifted. Every file is changed or none is — if any edit fails to match, nothing is written. Paths are kept safe (no escaping the working directory).

## Options

`--check` verifies a patch would apply without writing. `--strict` turns warnings into errors. `--format` forces a format. See `node main.ts --help` for the full list.

## License

MIT.

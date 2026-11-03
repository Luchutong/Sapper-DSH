# Third-party notices

`resources/kb/*.json` contains 56 unchanged knowledge-base entries from
[N1nEmAn/sapper-v2](https://github.com/N1nEmAn/sapper-v2), revision
`ba3d3d4`. Their original `source` fields are retained. The upstream MIT license
is included at `resources/licenses/sapper-v2-MIT.txt`.

The TypeScript implementation and role prompts in this repository are new.
`tests/reference/sapper_store.py` is an unchanged prefix of the upstream
`lib/sapper.py` at the same revision, through `render_graph_text`. It is the
behavioral reference for Python/TypeScript golden round-trip tests. Provenance
and SHA256 are recorded in `tests/reference/provenance.json`, with the MIT
license also copied beside the snapshot. The test runner supplies a Windows
locking adapter because upstream imports POSIX `fcntl`.

The reference and runner are excluded from the npm package. Python is needed
only to run development compatibility tests; desktop users do not need it.

DSH SDK packages, React and build dependencies retain their respective licenses.
They are either host-provided peers or development dependencies and are not
vendored into this repository.

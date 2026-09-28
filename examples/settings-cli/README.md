# settings-cli: OrcaSlicer's settings from the command line

Validates presets and prints OrcaSlicer's settings forms as text, through the engine host's settings service
(`settings.view` and `settings.edit` of protocol v2). It starts the host in a Node worker thread (the built
`dist/host.<hash>.js` when there is one, else the host's sources) and needs no engine build and no app: the
settings service runs without the wasm.

```bash
node examples/settings-cli/settings.mjs --validate                           # the M1 presets
node examples/settings-cli/settings.mjs --presets my-presets.json --validate  # exit 1 when Orca raises an error
node examples/settings-cli/settings.mjs --scope process --mode expert         # the Process tab, as text
node examples/settings-cli/settings.mjs --set process.layer_height=0 --set process.spiral_mode=1
node examples/settings-cli/settings.mjs --scope object --object layer_height=0.5 --object wall_loops=5
node examples/settings-cli/settings.mjs --scope machine --json                # the settings.view document
```

The presets file is the one `examples/node-cli` takes: `machine`, `process` and `filaments`, each flattened.
`--set scope.key=value` edits a setting as a user would: Orca's edit handlers run, and the example prints what the
edit writes, Orca's questions and its notices, before it prints the form with the edits applied.

What it prints comes from the engine: the pages, groups and rows of Orca's tabs for the mode, the rows Orca hides
or greys out for the current values, narrowed choices, and Orca's warnings. The example only formats it.

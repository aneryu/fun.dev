# Local duck authoring examples

These scripts accompany [character authoring](../../docs/workshop-characters.md)
and its [acceptance record](../../docs/workshop-character-acceptance.md). They use
the public workshop APIs to reproduce the stages of one local duck project.
They are not installed package tests or a generator for an arbitrary new duck.

Run commands from the repository root. The stage scripts read earlier model and
inspection files under `test-results/`; those user-model files and generated
renders remain local and are intentionally not committed. Each script names its
input near the start. The acceptance record lists the stage order, the accepted
outputs and rejected experiments. A fresh checkout needs those local source
files to replay the duck case. The API examples in the authoring docs and the
small fixtures in `tests/workshop-*.test.mjs` do not depend on those duck files.

Scripts exporting a default function use the isolated Node workbench:

```sh
node scripts/editor-agent.mjs --run scripts/examples/duck-controls.mjs
```

Scripts with top-level execution run directly, for example:

```sh
node scripts/examples/duck-final-reedit.mjs
```

Browser scripts use the built site and launch a local loopback server/Chromium;
run `npm run build:production` before them. Do not add `--connect` to replay a
whole study against an unrelated open document. Generated `candidate-*.json`,
their preview PNGs and `error-*.json` beside these scripts are ignored by Git;
other results are written to each stage's `test-results/duck-*/` directory.

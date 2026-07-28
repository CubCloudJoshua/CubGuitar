# Test corpus

Drop real Guitar Pro files here (`.gp`, `.gp3`, `.gp4`, `.gp5`, `.gpx`) and run:

```sh
pnpm build && pnpm corpus
```

Every file is loaded and rendered in a headless browser; the runner reports track
count, bar count, note count, and render time, and exits non-zero on any failure.
This is the Phase 0 exit test from PLAN.md: open the corpus and have it render.

## Why this directory is gitignored

We do not commit other people's transcriptions. Copyright in a tab belongs to
whoever wrote the song and whoever made the transcription, and the plan keeps
CubScore a tool rather than a content host until the licensing strategy is
cleared. Build your corpus from files you own or created, plus public-domain
material.

Original scores that *are* safe to commit live in `fixtures/` as alphaTex and
run in CI.

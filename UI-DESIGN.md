# CubScore UI: Design Plan

**Direction: Apple meets Tesla.** Typography-led restraint and physics-grade polish from one; the single-surface dark cockpit with exactly one accent from the other. The explicit anti-goal is Microsoft-style density: no ribbons, no rows of boxed buttons, no dialogs, no settings sprawl. The current UI is honest developer chrome that proved the engine works. This plan replaces it.

## 1. Principles

1. **The score is the interface.** Everything else earns its pixels. Default state shows the music, a transport, and nothing more; controls appear where and when intent appears, and leave when it passes.
2. **One accent, spent carefully.** CubCloud orange (#F07D00) marks exactly three things: what is playing, what is selected, and the primary action. If everything glows, nothing does. All other state renders in a gray ramp on near-black (#080808).
3. **Modes, not menus.** Tesla ships one screen per intent. CubScore has three: **Listen** (player, catalog), **Write** (editor), **Perform** (setlist, stage-dark, huge type, auto-scroll). A single top-level switch, each mode carrying only its own controls.
4. **Keyboard first, chrome last.** Power users never leave the keys. A command palette (Cmd+K) reaches every action; visible controls are the shortlist a beginner needs, not the inventory of what exists. The palette teaches shortcuts inline, which is how the shortlist stays short.
5. **Motion explains, never decorates.** 150 to 250ms, physical easing, and only for causality: a panel slides from the edge it lives on, playback flows, an edit lands with a soft settle on the affected bar. Nothing bounces. `prefers-reduced-motion` honored fully.
6. **Confidence through silence.** No confirmation dialogs. Actions apply instantly and undo cleanly (the op log is the safety net); destructive ones get a 5-second inline undo toast instead of an "are you sure."

## 2. Design language

- **Type.** Bebas Neue for the wordmark and mode labels only. Inter (licensed, variable) for UI text; IBM Plex Mono demoted to data readouts (tick positions, tempo, tuning) where mono earns it. The score's engraving remains Bravura. Scale: 4 sizes, 2 weights, nothing else.
- **Surface.** One continuous background (#080808), no card borders. Depth comes from two elevation tints (#111, #161616) and a single 1px hairline (#2A2A2A) used sparingly. Corners 8px, uniform.
- **Color.** Background ramp, text ramp (#EEE / #9A9A9A / #6A6A6A), accent #F07D00 with #FF9120 reserved for live/active pulses. Semantic red only for destructive and error. Total palette: 9 values.
- **Iconography.** Single stroke-weight set (Lucide, 1.5px), never labeled AND iconed together except in the palette.
- **The bear stays subtle.** CyberBear appears once: empty library state. Not in chrome.

## 3. The three modes

**Listen.** Score full-bleed. A floating transport pill bottom-center (play, position, tempo multiplier); it fades to 40% during playback and returns on pointer. Library is a left drawer summoned by hover-edge or Cmd+L, never permanently docked. Track mixer collapses to colored dots on the pill; expands on press.

**Write.** The edit caret is the control surface: a compact context strip floats above the current bar showing only what applies to the selection (duration, dots, the three most recent articulations, "more" opens the palette pre-filtered). Track switching is a left rail of instrument glyphs. Tempo and meter live in the score itself — click the printed "♩= 150" or the time signature to edit in place, which is how notation apps should always have worked.
**Collab presence** renders as colored carets with name tags in the score, not a banner; the session link lives behind the LIVE indicator.

**Perform.** Near-zero chrome: score at maximum width, stage-dark theme (true black, high-contrast engraving), giant time/position readout, foot-pedal and tap zones for page turns, auto-scroll at tempo. Setlist as a bottom filmstrip that hides during play.

## 4. Signature moments

Three interactions worth over-investing in, because they carry the demo:

1. **Play.** Space bar: the transport pill contracts to a progress ring, the playing bar lifts one elevation step, and the beat cursor glides (already animated by the engine) with the page following in a slow cinematic scroll. Everything else dims 15%.
2. **Share.** One press produces the link with a spring-in card and auto-copy; the card shows a live miniature of the first system of the score, so what you send looks like music, not a URL.
3. **Join a session.** Opening a collab link plays a 400ms sequence: score materializes system by system, then peer carets fade in with names. First impression of the moat feature.

## 5. Implementation plan

**Status.** Phase A shipped: `packages/design` owns the tokens and the six primitives every component is built from, and no component hard-codes a color. Phase B shipped: the floating transport, the library drawer, and dim-on-play, all inherited automatically by share-link recipients. Phase C's keystone shipped: the Cmd+K palette assembles its commands from live context, which is what lets visible chrome shrink. Reduced motion and a visible focus ring are in.

Still open in Phase C: the context strip that replaces the edit bar's button rows, the instrument rail, and in-score tempo/meter editing (the edit bar still carries every control at once, which is the ribbon shape this document exists to remove). Phases D and E are untouched.

Each phase has held its gate: seven browser-driven e2e suites (76 checks) plus unit and corpus suites pass before a phase lands. That gate has caught a semantic element lost in a restyle, a focus race that misrouted palette keystrokes, a button that swallowed the spacebar, and a transport that overflowed phone screens.

- **Phase A: tokens and shell (1-2 weeks).** Extract every inline style into a `packages/design` token set (colors, type, spacing, motion curves) plus primitives (Button, Field, Select, Drawer, Pill, Toast). Mechanical, zero behavior change, all e2e suites must stay green. This also deletes the current `styles.ts`/inline-style debt.
- **Phase B: Listen mode (2 weeks).** Transport pill, library drawer, mixer dots, dim-on-play. The shared-view page inherits this automatically, which upgrades every link recipient's first impression.
- **Phase C: Write mode (2-3 weeks).** Context strip, instrument rail, in-score tempo/meter editing, command palette (the palette is a dependency for shrinking visible chrome everywhere).
- **Phase D: Perform mode (2 weeks).** New mode, builds on PLAN.md's Perform pillar; stage-dark theme doubles as the app's high-contrast accessibility theme.
- **Phase E: motion pass and the three signature moments (1 week).**

Each phase ends with the existing headless suites passing plus new screenshot-diff checks (Playwright screenshots into CI artifacts) so design regressions are visible in review.

## 6. What we deliberately do not do

No light theme at launch (the brand is the dark cockpit; print/PDF output stays black-on-white). No skeuomorphic amps or wood textures. No onboarding tour — the empty states and palette teach instead. No settings page until there are five real settings; until then, preferences live in the palette.

## 7. Open questions for Joshua

1. Inter as the UI face (needs a license check) or stay all-Plex? Inter reads friendlier at small sizes; Plex Mono everywhere reads more terminal-brutalist. The recommendation is Inter for UI, Plex Mono for data.
2. Does Perform mode's stage theme justify pulling Phase D ahead of C for the worship/band demo path?
3. Budget for a motion/visual designer pass after Phase E, or ship engineer-grade polish first and iterate with design partners?

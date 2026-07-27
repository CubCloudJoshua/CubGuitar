# CubGuitar Product Plan

**The tab editor the market should have built ten years ago.**

CubGuitar is a web-first, AI-native guitar tablature editor, player, and practice platform built and hosted on CubCloud sovereign infrastructure in Missoula. It targets the seat Guitar Pro has held since the late 90s and takes it by doing the three things no incumbent does: run everywhere with full parity, transcribe audio to editable tab in one click, and let two people edit the same score at the same time.

---

## 1. Market Landscape (verified July 2026)

| Product | Model | Price | Strength | Weakness |
|---|---|---|---|---|
| Guitar Pro 8 (Arobas) | Desktop, one-time | $69 ($58 street), 50% upgrades | Industry-standard editor, RSE soundbanks, de facto file format | Desktop-only workflow, iPad app missing desktop features, no collaboration, mobile app still a NAMM 2025 prototype |
| Songsterr | Web/mobile subscription | $9.99/mo | Huge community tab catalog, instant web playback, AI tab generation for subscribers | Player, not an editor. You learn there, you don't create there |
| Soundslice | Web subscription | Teacher-oriented per-seat pricing | Best-in-class synced audio+notation player, click-to-seek, loop, slowdown | Learning tool, not a composition tool |
| MuseScore 4 (Muse Group) | Desktop, free | Free | Opens Guitar Pro files, linked standard/tab staves, strong engraving | General notation first, guitar second. No guitar-native workflow, playback below RSE quality |
| Ultimate Guitar Pro (Muse Group) | Web/mobile subscription | Subscription | Largest catalog, official licensed tabs, publisher deals | Content business, weak creation tools |
| Klangio / Songscription / Moises | AI transcription SaaS | Per-transcription or subscription | Audio-to-tab at 70 to 90% usable accuracy | Standalone tools. Output lands in someone else's editor |

### The gaps nobody fills

1. **No serious editor lives on the web.** Guitar Pro is desktop. MuseScore is desktop. The web products (Songsterr, Soundslice) are players. The person who wants Google-Docs-grade editing of tablature in a browser has nothing.
2. **No editor has real-time collaboration.** Bands, teachers with students, co-writers, transcription teams: all of them email .gp files back and forth in 2026.
3. **AI transcription and editing are separate products.** Klangio gets you 80% of a tab, then you export and fix it elsewhere. The obvious product is transcription inside the editor with a review-and-correct workflow.
4. **Mobile parity is unsolved.** Guitar Pro's iPad app ships without desktop features and users complain about it publicly. A web-first architecture gets parity for free.
5. **Version history and cloud library are absent.** Every serious creator tool (Figma, Notion, Google Docs) has undo across sessions, named versions, and sharing links. Tab software has files on disk.

### Why CubCloud wins this

The AI features (transcription, stem separation, practice feedback) need GPU inference. Competitors rent that from hyperscalers and price accordingly. We run H200/H100/RTX PRO 6000 capacity in Missoula, so inference is a cost we control, not a margin leak. CubGuitar also becomes a public proof point for the product-development pillar: a consumer-grade app built end to end on CubCloud metal, and a natural cross-sell surface for CubSound and CubLabs work.

---

## 2. Product Definition

### One-liner

Compose, transcribe, practice, and collaborate on guitar music from any device, with AI that turns recordings into editable tabs in seconds.

### Core pillars

**P1. Editor.** Full multitrack tablature and standard notation editing: guitar, bass, drums, keys, vocals. Everything Guitar Pro 8 does (bends, slides, harmonics, tapping, tremolo, vibrato, dead notes, palm mutes, let ring, grace notes, tuplets, time/key signature changes, repeats and codas, slash notation, multi-voice) plus modern editing ergonomics: command palette, contextual toolbars, infinite undo with session-spanning history, and keyboard-first entry that matches Guitar Pro's shortcuts so switchers feel at home day one.

**P2. Playback.** A sound engine good enough that people practice against it. SF2/SFZ soundfont synthesis at MVP, then a WASM DSP pipeline (amp sim, cabinet IRs, effects rack modeled as a virtual pedalboard) to compete with Guitar Pro's RSE. Speed trainer (loop a section, ramp tempo), count-in, metronome, per-track mute/solo/pan, audio track sync for playing along with the original recording.

**P3. AI (the moat).** All inference on CubCloud GPUs:
- **Audio-to-tab transcription.** Upload audio or record in-browser, get an editable multitrack score with a confidence overlay. Low-confidence bars are flagged for human review. This is the feature that collapses the Klangio-plus-Guitar-Pro two-tool workflow into one product.
- **Stem separation** as a preprocessing stage so users can transcribe just the guitar out of a full mix.
- **Practice feedback.** User plays along on mic input; we score timing and pitch accuracy per note and show a heatmap over the tab.
- **Smart fingering.** Given notes, suggest playable fret positions using a cost model of hand movement, with player-level presets (beginner-friendly vs. economy-of-motion).

**P4. Collaboration and cloud.** CRDT-based real-time co-editing, presence cursors, comments anchored to bars, share links with view/comment/edit roles, named version history, and organizations (bands, studios, schools). This is the feature no incumbent can bolt onto a 25-year-old desktop codebase.

**P5. Compatibility.** Import .gp3/.gp4/.gp5/.gpx/.gp, MusicXML, and MIDI. Export .gp, MusicXML, MIDI, PDF, PNG, and audio (WAV/MP3 render). Perfect Guitar Pro import is table stakes: the world's tabs live in that format, and switching cost is zero only if their back catalog opens flawlessly.

### Explicitly out of scope for v1

- Hosting a public catalog of copyrighted song tabs. Ultimate Guitar spent years on publisher licensing deals. We ship a private-library product first; a licensed or original-content marketplace is a later, lawyer-gated phase. User files are private by default and we stay a tool, not a content host, until Joshua signs off on the licensing strategy.
- Native DAW features (multitrack audio recording, mixing). We sync one backing audio track per score; we do not become a DAW.

---

## 3. Architecture

### Stack

- **Monorepo** (pnpm + Turborepo), TypeScript end to end.
- **`packages/core`**: the score model. Immutable document tree, operation-based edits (every edit is a serializable op, which gives us undo, version history, and CRDT sync from one design decision).
- **`packages/formats`**: importers/exporters for GP3 through GP8, MusicXML, MIDI. Pure functions, fuzz-tested against a corpus of thousands of real .gp files.
- **`packages/notation`**: layout and rendering engine. Canvas/WebGL renderer with a layout pass modeled on music engraving rules. Same engine renders the editor, print PDFs, and thumbnails server-side.
- **`packages/audio`**: playback engine. Web Audio + AudioWorklet, soundfont synth first, WASM effects pipeline second.
- **`apps/web`**: React app. The product.
- **`apps/desktop`**: Tauri wrapper (file associations for .gp files, offline mode, low-latency audio). Thin shell, same web codebase.
- **`apps/mobile`**: capacitor or PWA at first; parity comes from the architecture, not a second codebase.
- **`services/api`**: Node/TypeScript API, Postgres, S3-compatible object storage, all on CubCloud infra.
- **`services/sync`**: WebSocket CRDT sync server (Yjs or a purpose-built CRDT over the op log).
- **`services/inference`**: Python, GPU-backed. Transcription (basic-pitch-class models fine-tuned for guitar, plus stem separation via Demucs-class models), fingering optimizer, practice scoring. Queued jobs with progress streaming to the client.

### Build vs. buy: the rendering engine

alphaTab (open source, reads GP3 through GP7, renders and plays in the browser) is the fastest path to a working player and would cut months off Phase 1. Search results report it as LGPL; legal must verify the current license and its implications before it touches the codebase. Recommended posture: use alphaTab to ship the Phase 1 player fast, build our own `notation` engine in parallel, and swap it in by Phase 2. Owning the engine is what makes "best in the market" possible; renting it is what makes "shipped this quarter" possible. We do both, in that order.

### The one decision that matters most

Every edit is an operation in a log. That single choice gives us undo, autosave, version history, real-time sync, and audit trails without retrofitting. It costs discipline in `packages/core` up front and pays for itself in every pillar.

---

## 4. Roadmap

### Phase 0: Foundations (weeks 1 to 4)
- Monorepo, CI, deploy pipeline to CubCloud infra.
- Score data model and op-log design finalized and documented.
- GP5/GP file importer working against a test corpus.
- alphaTab spike: embed, load a .gp file, play it. Decision memo on license and integration depth.

**Exit test:** open any of 50 corpus .gp files in the browser and hear them play.

### Phase 1: Player (weeks 5 to 12)
- Cloud library: upload, organize, share view-only links.
- Player UX that beats Soundslice: click-to-seek, loop regions, speed trainer, per-track mixer, count-in, dark mode, responsive down to phone width.
- Accounts, orgs, billing rails (Stripe), free tier limits.
- PDF/PNG export.

**Exit test:** a guitar teacher can run a full lesson from a phone and a laptop with nothing installed.

### Phase 2: Editor (weeks 13 to 28)
- Own rendering engine replaces alphaTab.
- Full note entry and articulation editing, Guitar Pro keyboard-shortcut compatibility mode.
- MusicXML and MIDI import/export, .gp export.
- Named versions, session-spanning undo.

**Exit test:** transcribe a full 5-track song start to finish without touching Guitar Pro, and a GP8 power user rates the editing speed as equal or better.

### Phase 3: AI (weeks 20 to 36, overlaps Phase 2; inference team runs parallel)
- Stem separation and audio-to-tab pipeline on Missoula GPUs, confidence-scored output opening directly in the editor.
- Review workflow: flagged bars, accept/correct loop that also generates training data with user consent.
- Smart fingering suggestions.

**Exit test:** a clean solo-guitar recording becomes a tab a player calls "usable with light edits" in under two minutes.

### Phase 4: Collaboration (weeks 29 to 44)
- Real-time co-editing, presence, comments, roles.
- Band/school organizations, assignment workflows for teachers.
- Practice feedback (mic input scoring) beta.

**Exit test:** two people in different states edit one score simultaneously with no conflicts and sub-second latency.

### Phase 5: Polish and expansion (post-launch)
- WASM effects rack / amp sim to close the RSE gap.
- Desktop (Tauri) and mobile packaging.
- Original-content and licensed-catalog strategy (legal review first).
- Public API and embed player (Soundslice's embed business validates demand; schools and course platforms pay for this).

---

## 5. Business Model

- **Free:** 5 scores, full player, watermarked PDF export, 3 AI transcriptions total. Free tier is the top of funnel and the reason switchers try us.
- **Pro ($7.99/mo or $79/yr):** unlimited scores, full editor, all exports, 20 AI transcriptions/mo, version history. Priced under Songsterr's $9.99 while doing far more, and one year costs about what Guitar Pro 8 costs once.
- **Band/Studio ($19.99/mo, 5 seats):** real-time collaboration, org library, shared version history.
- **Education (per-seat, discounted):** teacher dashboards, assignments, practice scoring. Soundslice proves educators pay per-student; Montana schools and tribal college partnerships are the natural beta cohort and align with the Community pillar.
- **API/embed (usage-based):** transcription API and embeddable player for course creators. This is also the cross-sell hook for CubCloud custom-development clients.

Every AI transcription runs on hardware we own. That is the margin story to put in front of investors and the sovereignty story to put in front of Montana.

## 6. Go-to-market

- **Beachhead:** guitar teachers and transcribers. They create content, they bring students, and Soundslice's pricing proves willingness to pay. Recruit 20 design partners before Phase 1 ships.
- **Switching campaign:** "Open your Guitar Pro library in the browser, free." Import fidelity is the ad.
- **Montana angle:** launch with Missoula/Bozeman music schools and UM/MSU music programs, workforce-literacy tie-in through CubCloud Community. Local proof, national rollout.
- **Content marketing:** the AI transcription demo is inherently viral (paste a riff, watch the tab appear). Short-form video does the selling.

## 7. Risks

| Risk | Mitigation |
|---|---|
| GP import fidelity is harder than it looks (25 years of format quirks) | Corpus-driven fuzz testing from week 1; alphaTab's importers as reference implementation |
| Sound quality below RSE loses power users | Ship soundfonts first, invest in WASM DSP as a dedicated Phase 5 workstream; power users are Phase 2+ targets, not MVP |
| Copyright exposure from user-uploaded tabs | Private-by-default library, DMCA process, no public catalog until licensing strategy is cleared by Joshua and counsel |
| AI transcription accuracy disappoints | Confidence overlay and review workflow sets honest expectations; 70 to 90% plus fast correction beats 100% promises |
| Muse Group (owns MuseScore + Ultimate Guitar) bundles a competitor | Speed and collaboration are our moat; their assets are desktop engraving and a licensed catalog, neither of which becomes Google-Docs-for-tabs quickly |
| Scope creep toward DAW features | Out-of-scope list above is enforced at review |

## 8. Team and next steps

Suggested staffing from current bench: Brandon owns architecture and the core/notation engine, Justin owns the web app and player, inference work is a hire (the open AI developer seat) or a scoped CubLabs engagement, Bryce advises on infra networking, John and Mac start design-partner outreach once the Phase 1 demo exists. Interns (May 2026 cohort) fit the file-format corpus and QA work.

Immediate next steps:
1. Approve or adjust this plan and the pricing hypothesis.
2. Legal check on alphaTab's current license terms.
3. Assemble the .gp test corpus (public-domain and original scores).
4. Phase 0 kickoff: monorepo scaffold plus alphaTab spike.
5. Name check and trademark search on "CubGuitar."

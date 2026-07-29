# CubScore Product Plan

**Name: CubScore** (decided July 2026; repo predates the decision and keeps the CubScore slug for now). Instrument-first but multi-instrument, so the name leaves room beyond guitar. Trademark search before launch.

**The tab editor the market should have built ten years ago.**

CubScore is a web-first, AI-native music notation editor, player, and practice platform built and hosted on CubCloud sovereign infrastructure in Missoula. It targets the seat Guitar Pro has held since the late 90s and takes it by doing the three things no incumbent does: run everywhere with full parity, transcribe audio to editable tab in one click, and let two people edit the same score at the same time.

---

## 1. Market Landscape (verified July 2026)

### Direct competitors

| Product | Model | Price | Strength | Weakness |
|---|---|---|---|---|
| Guitar Pro 8 (Arobas) | Desktop, one-time | $69 ($58 street), 50% upgrades | Industry-standard editor, RSE soundbanks, de facto file format | Desktop-only workflow, iPad app missing desktop features, no collaboration, mobile app still a NAMM 2025 prototype |
| Songsterr | Web/mobile subscription | $9.99/mo | Huge community tab catalog, instant web playback, AI tab generation for subscribers | Player, not an editor. You learn there, you don't create there |
| Soundslice | Web subscription | Teacher-oriented per-seat pricing | Best-in-class synced audio+notation player, click-to-seek, loop, slowdown, embed business | Learning tool, not a composition tool |
| MuseScore 4 (Muse Group) | Desktop, free | Free | Opens Guitar Pro files, linked standard/tab staves, strong engraving, musescore.com sharing community | General notation first, guitar second. No guitar-native workflow, playback below RSE quality |
| Ultimate Guitar Pro (Muse Group) | Web/mobile subscription | Subscription | Largest catalog, official licensed tabs, publisher deals, community ratings on versioned tabs | Content business, weak creation tools |
| Klangio / Songscription / Moises | AI transcription SaaS | Per-transcription or subscription | Audio-to-tab at 70 to 90% usable accuracy, stem separation | Standalone tools. Output lands in someone else's editor |
| Flat.io / Noteflight | Web notation subscription | Freemium | True simultaneous editing (Flat), cross-device sync, education workflows | Not guitar-first, weak tab articulation support |
| Rocksmith+ (Ubisoft) / Yousician | Learning app subscription | $20/mo / $30/mo | Real-time pitch detection scores your actual playing, gamified progression, pitch shifter for altered tunings | Closed catalogs, no creation tools at all |

### The gaps nobody fills

1. **No serious editor lives on the web.** Guitar Pro is desktop. MuseScore is desktop. The web products (Songsterr, Soundslice) are players. Flat.io is web and collaborative but not guitar-first. The person who wants Google-Docs-grade editing of tablature in a browser has nothing.
2. **No guitar editor has real-time collaboration.** Bands, teachers with students, co-writers, transcription teams: all of them email .gp files back and forth in 2026.
3. **AI transcription and editing are separate products.** Klangio gets you 80% of a tab, then you export and fix it elsewhere. The obvious product is transcription inside the editor with a review-and-correct workflow.
4. **Creation and practice are separate products.** Rocksmith and Yousician prove people pay $20 to $30 a month for software that listens and scores their playing, but neither lets you create. No product closes the loop: transcribe it, edit it, practice it, get scored on it.
5. **Mobile parity is unsolved.** Guitar Pro's iPad app ships without desktop features and users complain about it publicly. A web-first architecture gets parity for free.
6. **Version history and cloud library are absent.** Every serious creator tool (Figma, Notion, Google Docs) has undo across sessions, named versions, and sharing links. Tab software has files on disk.

### Why CubCloud wins this

The AI features (transcription, stem separation, arrangement generation, practice feedback) need GPU inference. Competitors rent that from hyperscalers and price accordingly. We run H200/H100/RTX PRO 6000 capacity in Missoula, so inference is a cost we control, not a margin leak. CubScore also becomes a public proof point for the product-development pillar: a consumer-grade app built end to end on CubCloud metal, and a natural cross-sell surface for CubSound and CubLabs work.

---

## 2. Feature Imports from Adjacent Creator Tools

Five platforms outside the guitar-software lane, each with one proven mechanic we adopt. These are not competitors to beat; they are R&D other companies already paid for.

### 2.1 Band-in-a-Box + iReal Pro (auto-accompaniment)

Band-in-a-Box turns a typed chord progression plus a style pick into a full band arrangement (piano, bass, drums, guitar, horns) in seconds, including audio recordings of real session players. iReal Pro does a lighter version on mobile with 50+ styles and endless organic variation, and it owns the jam-session and jazz-education market.

**Import: the Instant Band.** Enter a chord chart in CubScore, pick a style, and our AI generates a full backing arrangement as editable tracks in the score. Practice mode plays it with organic variation so it never loops stale. This runs as a generation workload on our GPUs and turns every chord chart in a user's library into a practice band. Nobody in the tab world has this; it collapses Band-in-a-Box, iReal Pro, and Guitar Pro into one screen.

### 2.2 BandLab (social creation and forking)

BandLab is a free browser DAW with a social layer: fork any published project into your own editable copy, trace lineage through revision history, collaborate in real time, comment on specific sections, and distribute finished tracks to streaming platforms from inside the app.

**Import: forking and score lineage.** Any publicly shared CubScore score can be forked. Forks keep a visible lineage chain (this arrangement descends from that one), which is how transcription communities actually work: someone posts a base transcription, others refine it. GitHub culture applied to tabs. Our op-log architecture makes this nearly free to build. Also import their "publish from inside the app" instinct: one-click share to an embeddable player is our version of their streaming distribution.

### 2.3 Dorico (semantic notation, separation of content and layout)

Steinberg built Dorico around one idea: the music is data, the layout is a projection of it. Write mode edits musical meaning; Engrave mode adjusts presentation; the engine applies professional engraving rules automatically so users almost never hand-format.

**Import: the same separation, enforced from day one.** Our `packages/core` score model stays purely semantic and `packages/notation` owns all layout decisions. Users get automatic professional engraving with zero manual spacing work, and the same score projects cleanly to phone, desktop, PDF, and embed. This is an architecture commitment, not a feature, and it is the reason MuseScore-quality print output and phone-width responsive rendering can come from one engine.

### 2.4 Hookpad / Hooktheory (theory-aware composition)

Hookpad colors notes by scale degree, suggests the next chord based on what actually follows in real songs, and teaches through TheoryTab, a database of thousands of analyzed hit songs you can study interactively.

**Import: the theory assistant.** Optional overlay in the editor: scale-degree coloring, chord-function labels, and next-chord suggestions ranked by our models. Aimed at the songwriter and student segments, and it deepens the education tier: teachers assign analysis, not just performance. Long-term, an analyzed-score library becomes our TheoryTab, built from original and licensed content.

### 2.5 Splice (creator marketplace economics)

Splice built a subscription business around a searchable marketplace of sounds where creators get paid when their packs get used. The lesson is the economic loop, not the samples: supply-side creators earn money, which recruits more supply, which makes the subscription worth more.

**Import: the creator marketplace, Phase 5+.** Sell soundbanks, style packs for the Instant Band, lesson packs, and original artist transcriptions, with a revenue share to creators. Teachers selling course material through our embed player is the wedge (Soundslice proves the demand, Splice proves the payout model). This is also the eventual answer to Ultimate Guitar's catalog moat: we don't license their back catalog, we make original creator content economically attractive on our platform. Lawyer-gated like everything content-related.

### 2.6 forScore / OnSong / Planning Center Music Stand (live performance reading)

Gigging and worship musicians run their shows from tablet reading apps: setlists, annotations in rehearsal, Bluetooth pedal page turns, dark stage-friendly display, and leader-pushed setlists that sync to every band member's device. These apps read static PDFs and chord charts; none of them render living, playable scores.

**Import: Perform mode.** A distraction-free reading view for live use: setlist builder, half-page turns via Bluetooth pedal or auto-scroll at tempo, stage-dark theme, per-member annotation layers, and band-synced setlists where the leader's changes land on everyone's device before downbeat. Because our scores are semantic rather than PDFs, Perform mode adds what the reading apps cannot: transpose the whole setlist for a capo or a horn player in one tap, and follow-along highlighting if playback runs. This is the "music reading platform" half of the vision and the feature that makes CubScore a daily tool for working musicians, not just a practice-room tool.

### Also adopted from the direct competitor pass

- **Pitch shifter playback** (Rocksmith+): play songs written in altered tunings without retuning the instrument. Trivial for us since we own the synth engine.
- **Gamified practice progression** (Yousician): streaks, levels, structured curriculum for the beginner segment.
- **Stem-mute play-along** (Moises): mute the guitar inside the original recording and play its part against the real band. Falls out of the stem-separation pipeline we already build for transcription.
- **Player interactions** (Soundslice): click any note to seek, drag-to-loop, tempo change without pitch change.
- **Collaboration on the free tier** (Flat.io): acquisition hook, not a paywall feature.

---

## 3. Product Definition

### One-liner

Compose, transcribe, practice, and collaborate on music from any device, with AI that turns recordings into editable scores in seconds and a band that plays whatever you write.

### Core pillars

**P1. Editor.** Full multitrack tablature and standard notation editing: guitar, bass, drums, keys, vocals. Everything Guitar Pro 8 does (bends, slides, harmonics, tapping, tremolo, vibrato, dead notes, palm mutes, let ring, grace notes, tuplets, time/key signature changes, repeats and codas, slash notation, multi-voice) plus modern editing ergonomics: command palette, contextual toolbars, infinite undo with session-spanning history, keyboard-first entry that matches Guitar Pro's shortcuts so switchers feel at home day one, and Dorico-style automatic engraving so nobody hand-formats a score. Optional theory assistant overlay (scale-degree coloring, chord-function labels, next-chord suggestions).

**P2. Playback.** A sound engine good enough that people practice against it. SF2/SFZ soundfont synthesis at MVP, then a WASM DSP pipeline (amp sim, cabinet IRs, effects rack modeled as a virtual pedalboard) to compete with Guitar Pro's RSE. Speed trainer (loop a section, ramp tempo), count-in, metronome, per-track mute/solo/pan, pitch-shifted playback for altered tunings, audio track sync for playing along with the original recording, and stem-mute play-along (mute the guitar in the real recording, play its part yourself).

**P3. AI (the moat).** All inference on CubCloud GPUs:
- **Audio-to-tab transcription.** Upload audio or record in-browser, get an editable multitrack score with a confidence overlay. Low-confidence bars are flagged for human review. This is the feature that collapses the Klangio-plus-Guitar-Pro two-tool workflow into one product.
- **Instant Band.** Chord chart plus style pick generates a full editable backing arrangement with organic variation in practice mode. Band-in-a-Box for the browser, integrated with the editor.
- **Stem separation** as a preprocessing stage for transcription and as the engine behind stem-mute practice.
- **Practice feedback.** User plays along on mic input; we score timing and pitch accuracy per note and show a heatmap over the tab. Gamified progression (streaks, levels, curriculum) sits on top for the beginner segment.
- **Smart fingering.** Given notes, suggest playable fret positions using a cost model of hand movement, with player-level presets (beginner-friendly vs. economy-of-motion).

**P4. Collaboration and cloud.** CRDT-based real-time co-editing, presence cursors, comments anchored to bars, share links with view/comment/edit roles, named version history, organizations (bands, studios, schools), and forking of public scores with visible lineage. This is the feature set no incumbent can bolt onto a 25-year-old desktop codebase.

**P5. Perform and publish (artists and working musicians).** Perform mode for live reading: setlists, pedal page turns, auto-scroll, stage-dark theme, one-tap setlist transposition, band-synced setlists with per-member annotation layers. Artist storefronts for publishing: an artist posts official interactive tabs and charts of their own songs, sells them or bundles them with lessons, and embeds the player on their own site. This is the direct hook for CubCloud artist clients: every artist site or app CubLabs builds gets a CubScore-powered tab store as a line item, and every storefront artist becomes a distribution channel for the platform.

**P6. Compatibility.** Import .gp3/.gp4/.gp5/.gpx/.gp, MusicXML, and MIDI. Export .gp, MusicXML, MIDI, PDF, PNG, and audio (WAV/MP3 render). Perfect Guitar Pro import is table stakes: the world's tabs live in that format, and switching cost is zero only if their back catalog opens flawlessly.

### Explicitly out of scope for v1

- Hosting a public catalog of copyrighted song tabs. Ultimate Guitar spent years on publisher licensing deals. We ship a private-library product first; the forking/marketplace features apply to original and licensed content only until Joshua signs off on the licensing strategy. User files are private by default and we stay a tool, not a content host.
- Native DAW features (multitrack audio recording, mixing). We sync one backing audio track per score; we do not become a DAW. BandLab already exists.

---

## 4. Architecture

### Stack

- **Monorepo** (pnpm + Turborepo), TypeScript end to end.
- **`packages/core`**: the score model. Immutable document tree, operation-based edits (every edit is a serializable op, which gives us undo, version history, forking lineage, and CRDT sync from one design decision). Purely semantic, Dorico-style: no layout data lives here.
- **`packages/formats`**: importers/exporters for GP3 through GP8, MusicXML, MIDI. Pure functions, fuzz-tested against a corpus of thousands of real .gp files.
- **`packages/notation`**: layout and rendering engine. Canvas/WebGL renderer with a layout pass modeled on music engraving rules. Owns all presentation decisions. Same engine renders the editor, print PDFs, thumbnails server-side, and the embed player.
- **`packages/audio`**: playback engine. Web Audio + AudioWorklet, soundfont synth first, WASM effects pipeline second, pitch-shift and time-stretch DSP for practice features.
- **`apps/web`**: React app. The product.
- **`apps/desktop`**: Tauri wrapper (file associations for .gp files, offline mode, low-latency audio). Thin shell, same web codebase.
- **`apps/mobile`**: Capacitor or PWA at first; parity comes from the architecture, not a second codebase.
- **`services/api`**: Node/TypeScript API, Postgres, S3-compatible object storage, all on CubCloud infra.
- **`services/sync`**: WebSocket CRDT sync server (Yjs or a purpose-built CRDT over the op log).
- **`services/inference`**: Python, GPU-backed. Transcription (basic-pitch-class models fine-tuned for guitar, plus stem separation via Demucs-class models), Instant Band arrangement generation, fingering optimizer, practice scoring. Queued jobs with progress streaming to the client.

### Build vs. buy: the rendering engine

alphaTab (open source, reads GP3 through GP7, renders and plays in the browser) is the fastest path to a working player and would cut months off Phase 1. Search results report it as LGPL; legal must verify the current license and its implications before it touches the codebase. Recommended posture: use alphaTab to ship the Phase 1 player fast, build our own `notation` engine in parallel, and swap it in by Phase 2. Owning the engine is what makes "best in the market" possible; renting it is what makes "shipped this quarter" possible. We do both, in that order.

### The one decision that matters most

Every edit is an operation in a log. That single choice gives us undo, autosave, version history, real-time sync, forking with lineage, and audit trails without retrofitting. It costs discipline in `packages/core` up front and pays for itself in every pillar.

---

## 5. Roadmap

**Status, July 2026.** Phase 0 complete: the corpus harness enforces pitch-exact import fidelity across eight original fixtures and real Guitar Pro transcriptions (Led Zeppelin .gp3 files, 270+ bars, 8k+ notes), including alternate tunings, capos, 32nd runs, and 5:4 tuplets. Phase 1 functionally complete: player, local-first library, accounts, cloud library sync, revocable share links with save-to-library for recipients, exports (.gp/alphaTex/MIDI/print), verified function at phone width. Landed early from Phase 2: the op-log editor on the semantic model, .gp export, and editable imports. Landed early from Phase 4: realtime collaboration with presence and verified convergence.

Quality gates in CI on every push: unit tests including the convergence contract the collaboration feature rests on, the corpus fidelity suite, and seven browser-driven end-to-end journeys. See UI-DESIGN.md for the interface overhaul's phase status.

Billing rails, email verification, collaborative undo, offline CRDT merge, and every AI feature remain.

### Phase 0: Foundations (weeks 1 to 4)
- Monorepo, CI, deploy pipeline to CubCloud infra.
- Score data model and op-log design finalized and documented.
- GP5/GP file importer working against a test corpus.
- alphaTab spike: embed, load a .gp file, play it. Decision memo on license and integration depth.

**Exit test:** open any of 50 corpus .gp files in the browser and hear them play.

### Phase 1: Player (weeks 5 to 12)
- Cloud library: upload, organize, share view-only links.
- Player UX that beats Soundslice: click-to-seek, loop regions, speed trainer, pitch-shifted playback, per-track mixer, count-in, dark mode, responsive down to phone width.
- Accounts, orgs, billing rails (Stripe), free tier limits.
- PDF/PNG export.

**Exit test:** a guitar teacher can run a full lesson from a phone and a laptop with nothing installed.

### Phase 2: Editor (weeks 13 to 28)
- Own rendering engine replaces alphaTab.
- Full note entry and articulation editing, Guitar Pro keyboard-shortcut compatibility mode, automatic engraving.
- MusicXML and MIDI import/export, .gp export.
- Named versions, session-spanning undo.

**Exit test:** transcribe a full 5-track song start to finish without touching Guitar Pro, and a GP8 power user rates the editing speed as equal or better.

### Phase 3: AI (weeks 20 to 36, overlaps Phase 2; inference team runs parallel)
- Stem separation and audio-to-tab pipeline on Missoula GPUs, confidence-scored output opening directly in the editor.
- Review workflow: flagged bars, accept/correct loop that also generates training data with user consent.
- Instant Band v1: chord chart plus style generates a backing arrangement.
- Smart fingering suggestions.

**Exit test:** a clean solo-guitar recording becomes a tab a player calls "usable with light edits" in under two minutes, and a typed 12-bar chord chart becomes a playable band in one click.

### Phase 4: Collaboration and practice (weeks 29 to 44)
- Real-time co-editing, presence, comments, roles.
- Forking with lineage for shared scores.
- Band/school organizations, assignment workflows for teachers.
- Practice feedback (mic input scoring) beta, stem-mute play-along, gamified progression v1.
- Perform mode v1: setlists, pedal page turns, auto-scroll, stage-dark theme, one-tap setlist transposition, band-synced setlists.

**Exit test:** two people in different states edit one score simultaneously with no conflicts and sub-second latency, a student completes a scored practice session from a phone, and a band plays a full gig from synced tablets without touching paper.

### Phase 5: Polish and expansion (post-launch)
- WASM effects rack / amp sim to close the RSE gap.
- Desktop (Tauri) and mobile packaging.
- Theory assistant overlay and analyzed-score education library.
- Creator marketplace (soundbanks, style packs, lesson packs, original artist transcriptions, revenue share). Legal review first.
- Artist storefronts and white-label embed for CubCloud clients.
- Public API and embed player (Soundslice's embed business validates demand; schools and course platforms pay for this).

---

## 6. Business Model

- **Free:** 5 scores, full player, real-time collaboration included (Flat.io proves this drives acquisition), watermarked PDF export, 3 AI transcriptions total.
- **Pro ($7.99/mo or $79/yr):** unlimited scores, full editor, all exports, 20 AI transcriptions/mo, Instant Band, version history. Priced under Songsterr's $9.99 while doing far more, and one year costs about what Guitar Pro 8 costs once.
- **Practice add-on or Premium tier (pricing TBD, test $14.99/mo):** mic-input practice scoring, gamified curriculum, stem-mute play-along. Rocksmith+ ($20/mo) and Yousician ($30/mo) prove practice feedback commands its own price point well above our Pro tier; it should not be given away inside Pro.
- **Band/Studio ($19.99/mo, 5 seats):** real-time collaboration at org scale, shared library, shared version history.
- **Education (per-seat, discounted):** teacher dashboards, assignments, practice scoring, theory-analysis assignments. Soundslice proves educators pay per-student; Montana schools and tribal college partnerships are the natural beta cohort and align with the Community pillar.
- **API/embed (usage-based):** transcription API and embeddable player for course creators. This is also the cross-sell hook for CubCloud custom-development clients.
- **Marketplace (Phase 5+):** revenue share on creator content, Splice-style. Supply-side payouts recruit the content that makes the subscription worth more.
- **Artist storefronts (Phase 5+):** artists sell official interactive tabs and lesson bundles of their own material, we take a platform cut. Self-owned material sidesteps most of the publisher-licensing problem, and artist storefronts are the natural upsell inside every CubLabs artist-site engagement.
- **White-label embed for clients:** music schools, churches, and course platforms get the player and Perform mode under their own brand, priced as a CubCloud services engagement plus usage. This is the clearest cross-sell from the existing client base.

Every AI job runs on hardware we own. That is the margin story to put in front of investors and the sovereignty story to put in front of Montana.

## 7. Go-to-market

- **Beachhead:** guitar teachers and transcribers. They create content, they bring students, and Soundslice's pricing proves willingness to pay. Recruit 20 design partners before Phase 1 ships.
- **Switching campaign:** "Open your Guitar Pro library in the browser, free." Import fidelity is the ad.
- **Montana angle:** launch with Missoula/Bozeman music schools and UM/MSU music programs, workforce-literacy tie-in through CubCloud Community. Local proof, national rollout.
- **Content marketing:** the AI transcription demo is inherently viral (paste a riff, watch the tab appear), and the Instant Band demo is its equal (type four chords, hear a band). Short-form video does the selling.
- **Artists as ambassadors:** recruit a handful of Montana and regional artists for founding storefronts. Their official tabs live only here, their fans create accounts, and each CubLabs artist client is a warm lead for a storefront. Worship teams and cover bands adopt through Perform mode, which spreads one band at a time by nature (the leader syncs the setlist, four more people install it).

## 8. Risks

| Risk | Mitigation |
|---|---|
| GP import fidelity is harder than it looks (25 years of format quirks) | Corpus-driven fuzz testing from week 1; alphaTab's importers as reference implementation |
| Sound quality below RSE loses power users | Ship soundfonts first, invest in WASM DSP as a dedicated Phase 5 workstream; power users are Phase 2+ targets, not MVP |
| Copyright exposure from user-uploaded tabs | Private-by-default library, DMCA process, no public catalog until licensing strategy is cleared by Joshua and counsel |
| AI transcription accuracy disappoints | Confidence overlay and review workflow sets honest expectations; 70 to 90% plus fast correction beats 100% promises |
| Instant Band quality below Band-in-a-Box's real-player recordings | Launch with MIDI-plus-synth arrangements and honest positioning; style packs from session players are a marketplace item later |
| Muse Group (owns MuseScore + Ultimate Guitar) bundles a competitor | Speed and collaboration are our moat; their assets are desktop engraving and a licensed catalog, neither of which becomes Google-Docs-for-tabs quickly |
| Feature breadth dilutes focus (editor, practice, marketplace, theory) | Phases are strictly ordered; nothing from a later phase starts before the prior phase's exit test passes |
| Scope creep toward DAW features | Out-of-scope list above is enforced at review |

## 9. Team and next steps

Suggested staffing from current bench: Brandon owns architecture and the core/notation engine, Justin owns the web app and player, inference work is a hire (the open AI developer seat) or a scoped CubLabs engagement, Bryce advises on infra networking, John and Mac start design-partner outreach once the Phase 1 demo exists. Interns (May 2026 cohort) fit the file-format corpus and QA work.

Immediate next steps:
1. Approve or adjust this plan, the pricing hypothesis, and the practice-tier question.
2. Legal check on alphaTab's current license terms.
3. Assemble the .gp test corpus (public-domain and original scores).
4. Phase 0 kickoff: monorepo scaffold plus alphaTab spike.
5. Naming decision and trademark search (candidates above; guitar-bound name not required).

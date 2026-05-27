# aurameter

A moderation signal layer for Reddit drama communities. Scores every new post on four
signals, surfaces them as link flair, and gives moderators a triage dashboard for the
ones worth a closer look.

Built for the **Reddit Mod Tools Hackathon** on Devvit (Reddit's app platform).

---

## What it does

Every new post is scored on four signals, 0–5 each:

| Signal | Meaning |
|---|---|
| ☕ **Tea** | Drama / stakes density — named cast, high-stakes vocabulary, cliffhanger framing |
| ⏰ **Time** | Urgency — deadlines, "tomorrow," crisis-now language |
| 🤡 **Bias** | One-sided / bad-faith framing — strawmanning, self-justification, asymmetric narrative |
| 🤖 **Slop** | Synthetic-text likelihood — stylometric features of AI-generated writing |

Scores become link flair (e.g. `☕3 ⏰2 🤖2`), and the mod dashboard gives you:

- **Queue** — posts a rule sent to triage, ranked by composite priority, with the post
  title for identification.
- **Signals** — per-signal sparklines + per-signal visibility (Off / Mod-only / Public).
- **Log** — attributed history of every action, rule fire, and config change. 90-day
  retention.
- **Settings** — aggressiveness, presets, the custom rule builder (with a dry-run preview
  showing what a candidate rule would have caught in the last 7 days before you save it),
  AutoMod YAML export, and the Slop spot-check opt-in.

---

## Install + first run

1. Add aurameter to your subreddit from the Devvit app directory.
2. The **"Open aurameter"** mod menu item appears under the subreddit ••• menu. Open it
   to reach the dashboard.
3. The first **7 days run in observe mode** — aurameter scores silently, no public flair,
   no rule actions. This lets it learn your sub's distribution before driving anything.
   After 7 days it auto-flips to live mode.
4. In **Settings**, choose your aggressiveness, optionally switch presets, set per-signal
   visibility, and add custom rules. The rule builder's dry-run preview replays your
   candidate rule over the last 7 days so you see what it would catch before saving.
5. Use **Export AutoMod YAML** in Settings to make your aurameter rules survive uninstall
   — they continue working as native AutoMod rules.

---

## The design stance

aurameter is a **dismiss-and-handoff workstation**, not a read-only lens and not an
auto-actor.

- It owns the **safe, reversible** action: **Dismiss** clears a post from the queue when
  you've judged it fine.
- It **hands off** the destructive action: **Take action** opens the post in Reddit's
  native mod tools, where you remove/ban using Reddit's own controls. aurameter never
  calls `reddit.remove()` itself.
- It **reconciles**: when a queued post gets handled on Reddit (by anyone), aurameter
  detects it's no longer actionable and clears it from the queue.

Why this matters: aurameter can never misfire a removal — the moderator is always the
actor on irreversible actions. The Reddit mod log records the real moderator who acted,
not the app. The cost is one extra click on destructive actions; that's the *right* amount
of friction.

---

## Privacy posture

aurameter is built to be honest about what it stores and what leaves the install.

**Stored:**
- **Moderator usernames** on action and config-change log entries — team accountability,
  same as Reddit's native mod log.
- **Post titles** — snapshot at score time, used for identification in the queue and log.
  Mod-only surface.
- **Signal scores** per post (the 0–5 integers + the calibrated reading).
- **Anonymous Slop feature-vectors + binary labels** — see "How Slop learns" below.

**Never stored:**
- Post **body** content.
- Author identity, username, reputation, or any cross-post profiling.

**What leaves the install:**
- Anonymous Slop feature-vectors (numbers) + a single binary label (0/1) — no text, no
  users, no subreddit name. Pooled across installs to retrain the global Slop detector
  between versions.

**Retention:**
- Action log: 90 days, purged daily.
- Per-post score hash: 30-day TTL.
- Queue reason + Slop feature vector: 90 days.

---

## How Slop learns (without adding mod work)

The Slop detector is a stylometric model that improves over time. Two feedback paths
contribute, both designed to require zero or near-zero extra mod effort:

**Passive harvesting** — when a moderator removes or approves a post that aurameter sent
to the modqueue for high Slop (`slop >= 2`), the verdict becomes a training label. Removed
→ confirmed AI (label 1), approved → confirmed not-AI (label 0). The first human verdict
on a post wins and locks it, so a later opposite action can't double-label the same
example. Purity filter: only posts queued *because* of high Slop are eligible, so a
Tea- or Bias-routed post doesn't pollute the corpus.

**Opt-in spot-check** — in Settings, mods can opt into a small weekly or monthly batch of
borderline + high-confidence Slop posts to label AI / not-AI explicitly. ~10 posts per
batch. Verdicts feed both the global corpus and the sub's local Slop threshold, so the
2↔3 detection boundary self-sharpens.

Retraining happens **outside the app** — Devvit has no model-training runtime. The app
flags when the global corpus is large enough and old enough to warrant a retrain; a
maintainer pulls the corpus, retrains offline, and ships new model coefficients in the
next release.

A known limitation: aurameter's `Take action` handoff currently doesn't feed the corpus
(only direct Reddit-native removes/approves do). Posts you action via the dashboard get
moderated correctly; they just don't contribute a training example. This is the next
hardening item.

---

## Per-signal customization

Each signal has three visibility modes:
- **Off** — not scored, not displayed.
- **Mod-only** — scored, visible to mods in the dashboard, not in public flair.
- **Public** — included in the link flair (`☕3 ⏰2 🤖2` format).

Two things you **cannot** do (by design): create new signals (they're trained models,
not configuration), or change what a signal means (visibility is the only public dial).

---

## Custom rules + dry-run preview

The rule builder composes IF/AND conditions over the four signals plus an action:

- `slop >= 3` → Send to mod queue with reason "likely synthetic"
- `tea >= 4 AND time >= 3` → Set flair "drama incoming"
- `bias >= 4` → Ping modmail

While you edit a rule, a **dry-run preview** replays your candidate conditions over the
last 7 days of scored posts and tells you the fire rate before you save. If it would
have fired on 100+ posts, it flags the rule as too broad — the safest way to write
moderation rules.

Rules can be exported to AutoMod YAML and pasted into your sub's `config/automoderator`
wiki page so they survive uninstalling aurameter.

---

## What's deliberately not in here

- **No public auto-posting** (weekly digests, "post of the week" features). aurameter
  doesn't speak in the community feed.
- **No user-facing dashboard** — this is a mod tool. Public surface is limited to the
  link flair (and only the signals the mod team set to Public).
- **No author-side reputation, scoring, or profiling.** A new mod joining a sub running
  aurameter can't filter the log by "posters by clown score" — that surface doesn't
  exist, by design.
- **No `reddit.remove()` calls from the app.** Destructive actions are handed off to
  Reddit native UI; aurameter is never the actor on an irreversible action.

---

## Tech notes

Built with TypeScript on Devvit Web 0.12.23 — Hono for server-side routes, Preact for
the dashboard webview, Vite for the build, Vitest for unit tests. Storage is Devvit's
provided Redis; no external database. Offline Slop trainer is Python.

86 unit tests passing (calibration, corpus, spotcheck, rules, rule-validate).

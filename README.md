# aurameter

A moderation signal layer for Reddit drama subs. It scores every new post on four signals, puts the scores in the link flair, and gives mods a triage dashboard for the ones worth a second look.

Built for the Reddit Mod Tools Hackathon on Devvit.

---

## What it does

Every new post gets four scores, 0 to 5:

| Signal | What it measures |
|---|---|
| ☕ Tea | Drama density. Named cast, stakes, cliffhanger endings. |
| ⏰ Time | Urgency. Deadlines, "tomorrow," crisis-now language. |
| 🤡 Bias | One-sided framing. Strawmanning, heavy self-justification. |
| 🤖 Slop | Likelihood the post is AI-generated. Stylometric. |

Those become link flair, e.g. `☕3 ⏰2 🤖2`. The mod dashboard gives you four tabs:

- **Queue.** Posts a rule sent to triage, ranked by composite priority, with titles so you know what you're looking at.
- **Signals.** Per-signal sparklines, plus a visibility toggle for each one (Off / Mod-only / Public).
- **Log.** Attributed history of every action, rule fire, and config change. Kept 90 days.
- **Settings.** Aggressiveness, presets, the custom rule builder (with a dry-run preview that replays the rule over the last 7 days before you save it), AutoMod YAML export, and the Slop spot-check opt-in.

---

## Install + first run

1. Add aurameter to your subreddit from the Devvit app directory.
2. Open the subreddit's ••• menu. "Open aurameter" is in there. That's the dashboard.
3. The first 7 days are observe mode. aurameter scores silently, no public flair, no rule actions, while it learns your sub's distribution. After 7 days it flips to live on its own.
4. In Settings, pick your aggressiveness, switch presets if you want, set per-signal visibility, add custom rules. The rule builder's dry-run preview replays your candidate rule over the last 7 days, so you can see what it would catch before you save it.
5. The "Export AutoMod YAML" button in Settings is your insurance policy. Your aurameter rules become native AutoMod rules in your sub's wiki. They keep working if you ever uninstall.

---

## How it's designed

aurameter is a dismiss-and-handoff workstation. It is not a read-only lens, and it is not an auto-actor.

The safe, reversible action is aurameter's. **Dismiss** clears a post from the queue when you've judged it fine.

The destructive action is Reddit's. **Take action** opens the post in Reddit's own mod tools, and you remove or ban using Reddit's controls. aurameter never calls `reddit.remove()` itself.

If a queued post gets handled on Reddit by anyone (you, another mod, AutoMod), aurameter notices it's no longer actionable and quietly drops it from the queue.

The point of all that: aurameter can't misfire a removal. The real moderator is always on the record. Reddit's mod log shows who actually acted, not "aurameter did it." The cost is one extra click on destructive actions, which is the right amount of friction for things you can't undo.

---

## Privacy

I tried to be honest about what aurameter stores. The rule I followed: this is a tool for mods, not for profiling anyone.

**What it stores:**
- Mod usernames on action and config-change log entries. Same posture as Reddit's native mod log. Team accountability needs attribution.
- Post titles. Snapshot at score time, used to identify posts in the queue and log. Mod-only.
- Signal scores per post (the four integers, plus the calibrated reading).
- Anonymous Slop feature-vectors and a binary label. See the next section.

**What it doesn't store:**
- Post body content.
- Author identity, username, or any cross-post profile.
- Author reputation. There's no "show me posters by Clown score" surface. That was a deliberate cut.

**What leaves the install:**
- Anonymous Slop feature-vectors (numbers) and one binary label (0/1). No text, no users, no subreddit name. These get pooled across installs to retrain the global Slop detector between versions.

**Retention:**
- Action log: 90 days, purged daily.
- Per-post score hash: 30-day TTL.
- Queue reason and Slop feature vector: 90 days.

---

## How Slop learns

The Slop detector is stylometric, and it has to keep up as AI writing drifts. Two feedback paths feed it, both designed to add roughly zero work for mods.

**Passive harvesting.** When a mod removes or approves a post that aurameter routed to the modqueue *because of high Slop* (`slop >= 2`), the verdict becomes a training label. Remove means confirmed AI, label 1. Approve means confirmed not-AI, label 0. The first human verdict wins and locks the post, so a later opposite action can't double-label the same example. Only posts routed for Slop count, which is what keeps the corpus clean. A Tea- or Bias-routed post that happened to be removed doesn't pollute the AI/not-AI label pool.

**Opt-in spot-check.** In Settings, mods can opt into a small batch of borderline-and-high-confidence Slop posts to label as AI / not-AI. Around 10 posts per batch, weekly or monthly. Verdicts feed both the global corpus and your sub's local Slop threshold, so the 2-vs-3 boundary self-sharpens on your community's writing.

Retraining happens outside the app. Devvit has no model-training runtime, and that's fine. The app flags when the global corpus is big enough and old enough to retrain. I pull the corpus, retrain offline, and ship new model coefficients in the next release.

One known limitation: aurameter's `Take action` handoff doesn't currently feed the corpus. Only direct Reddit-native removes and approves do. Posts you action via the dashboard get moderated correctly, they just don't contribute a training example. That's the next hardening item.

---

## Per-signal customization

Each signal has three visibility modes:

- **Off.** Not scored, not displayed.
- **Mod-only.** Scored, visible to mods in the dashboard, not in the public flair.
- **Public.** Included in the link flair (the `☕3 ⏰2 🤖2` strip).

Two things you can't do, on purpose: add a new signal (signals are trained models, not a config field), or change what a signal means. Visibility is the only public-facing dial.

---

## Custom rules and the dry-run preview

The rule builder composes IF/AND conditions over the four signals, plus an action:

- `slop >= 3` → send to mod queue with reason "likely synthetic"
- `tea >= 4 AND time >= 3` → set flair "drama incoming"
- `bias >= 4` → ping modmail

While you're editing a rule, the dry-run preview replays your conditions over the last 7 days of scored posts and tells you how often it would have fired. If it would have caught 100+ posts, it flags the rule as too broad. Writing a rule that nukes more posts than you meant to is the most common moderation-tool failure mode, and it's the easiest one to catch before going live.

Rules can be exported to AutoMod YAML and pasted into your sub's `config/automoderator` wiki page, so they outlive aurameter if you ever uninstall.

---

## What aurameter deliberately doesn't do

- No public auto-posting. No weekly digests, no "post of the week" features. aurameter doesn't speak in the community feed.
- No user-facing dashboard. This is a mod tool. The public surface is the link flair, and only for signals the mod team set to Public.
- No author scoring. There's no view that lets a mod sort posters by Clown score, because that view doesn't exist.
- No `reddit.remove()` calls from the app. Destructive actions are handed off to Reddit's UI. aurameter is never the actor on an irreversible action.

---

## Tech notes

TypeScript on Devvit Web 0.12.23. Hono for server routes, Preact for the dashboard webview, Vite for the build, Vitest for tests. Storage is Devvit's Redis, no external database. The offline Slop trainer is Python.

86 unit tests passing across calibration, corpus, spotcheck, rules, and rule-validate. If any of that sounds wrong in the live install, open an issue — I'd rather hear about it than not.
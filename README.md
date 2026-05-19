# aurameter

A configurable moderation signal layer for Reddit drama communities.

Built on [Devvit Web](https://developers.reddit.com/docs) for the Reddit Mod Tools and Migrated Apps Hackathon (deadline 27 May 2026).

## What this is

aurameter reads every new post the moment it's submitted and computes four lightweight signals locally:

- ☕ **Tea** : drama intensity (1 to 5)
- ⏰ **Time** : urgency (0 to 3)
- 🤡 **Clown** : one-sided framing (0 to 3)
- 🤖 **Slop** : synthetic-text likelihood (0 to 3)

These get encoded into the post's link flair so they render inline in the feed before any reader clicks. Mods get a dashboard with a triage queue, per-signal toggles, custom automation rules, and one-click AutoMod YAML export.

Full design doc: [`aurameter-plan.md`](./aurameter-plan.md)

## Project structure

```
aurameter/
├── devvit.json              # Devvit app config (triggers, menus, scheduler)
├── package.json
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── index.ts             # Server bootstrap; mounts all sub-routers
│   ├── core/
│   │   ├── signals/         # Four modular signal extractors
│   │   │   ├── types.ts     # SignalExtractor interface
│   │   │   ├── tea.ts
│   │   │   ├── time.ts
│   │   │   ├── clown.ts
│   │   │   └── slop.ts
│   │   ├── config/          # Per-subreddit configuration
│   │   │   ├── types.ts     # SubConfig, RuleConfig
│   │   │   └── presets.ts   # Six install-day presets
│   │   ├── engine/          # Pipeline orchestration
│   │   │   ├── score.ts     # Run extractors, build composite score
│   │   │   ├── flair.ts     # Compose emoji flair string with caps
│   │   │   ├── rules.ts     # Custom automation rule evaluator + AutoMod export
│   │   │   └── storage.ts   # Redis schemas and helpers
│   │   └── lib/
│   │       └── text.ts      # Shared text utilities (sentence split, regex helpers)
│   └── routes/
│       ├── triggers.ts      # Trigger handlers (post submit, deletes, install)
│       ├── menu.ts          # Menu item handlers
│       ├── forms.ts         # Form handlers (empty stub; Day 6 dashboard forms)
│       ├── scheduler.ts     # Scheduler handlers (daily rollup)
│       └── api.ts           # Dashboard read/write endpoints
└── README.md
```

## Design principles

1. **Modular signals** : each extractor implements the same interface; disable any without breaking the rest.
2. **Per-subreddit config** : six presets, every signal individually toggleable as off / mod-only / public, with per-sub emoji and scale overrides.
3. **No LLMs, no external fetch** : runs entirely on Devvit Web with local stylometry. Lower latency, fewer policy gates, no per-user profiling.
4. **Mod-action layer** : every signal maps to a concrete moderator workflow: AutoMod export, triage queue, modmail ping, flair routing.
5. **Reputation-free** : only post-level state. Never user profiles. Required by Reddit's Public Content Policy.

## Build status

This is foundational scaffolding. The four extractors have working but minimal heuristics; per-sub calibration, the logistic regression Slop classifier weights, the dashboard UI, and the rule builder UI are intentionally stubbed for the build sprint described in `aurameter-plan.md` Section 9.

## Commands

- `npm run dev` : starts development mode with live reload on the playtest subreddit (`aurameter_dev` by default; change in `devvit.json`).
- `npm run build` : builds for production.
- `npm run deploy` : type-check, lint, test, then upload to Reddit's dev portal.
- `npm run launch` : deploy and submit for app review.
- `npm run type-check` : TypeScript build check.
- `npm run lint` : ESLint.
- `npm run test` : Vitest.

## Day 1 critical verification

Before building anything else, confirm in the r/Devvit Discord that **bulk autonomous flair application on every new post** is allowed under current Devvit Rules. FlairAssistant proves programmatic flair-setting works, but it sets flair in response to a mod action, not autonomously on every submission. Fallback ready: the "Check vibe" mod-context-menu button scores on demand.

## License

BSD-3-Clause (inherited from the Devvit Mod Tool template).

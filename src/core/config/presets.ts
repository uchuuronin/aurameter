/**
 * Install-day presets.
 *
 * Mods pick one of six on install. Each preset encodes a reasonable default
 * for that subreddit archetype.
 *
 * The presets are NOT a straitjacket: every individual setting can be
 * overridden after install. Their job is to get from zero to useful in
 * about sixty seconds.
 */

import type { SubConfig, SignalConfig } from './types.js';
import type { SignalName } from '../signals/types.js';

/** Helper: build a complete signals record from per-signal overrides. */
function buildSignals(overrides: Partial<Record<SignalName, SignalConfig>>): Record<SignalName, SignalConfig> {
  const defaults: SignalConfig = { visibility: 'mod-only' };
  return {
    tea: overrides.tea ?? defaults,
    time: overrides.time ?? defaults,
    clown: overrides.clown ?? defaults,
    slop: overrides.slop ?? defaults,
  };
}

/**
 * The six presets. Order matters: this is the order they appear in the install
 * dropdown, so the most common archetype (drama) comes first.
 */
export const PRESETS = {
  /**
   * Drama subs: AITAH, JustNoMIL, AmItheAsshole-adjacent.
   * Tea + Time public for browse-helpful triage; Slop public to make AI-flood
   * visible; Clown mod-only because public bias-shaming is harassment-adjacent.
   */
  drama: {
    name: 'Drama subs',
    description: 'r/AITAH, r/JustNoMIL, drama-text storytelling',
    targetSubs: ['AITAH', 'JustNoMIL', 'AmItheAsshole'],
    config: (subreddit: string): SubConfig => ({
      subreddit,
      presetName: 'drama',
      observeOnly: true,
      aggressiveness: 'balanced',
      signals: buildSignals({
        tea: { visibility: 'public' },
        time: { visibility: 'public' },
        clown: { visibility: 'mod-only' },
        slop: { visibility: 'public' },
      }),
      rules: [
        {
          id: 'auto-slop-queue',
          label: 'Send likely-synthetic posts to mod queue',
          conditions: [{ signal: 'slop', comparator: '>=', threshold: 2 }],
          action: { type: 'send_to_modqueue', reason: 'aurameter: suspected synthetic content' },
          enabled: true,
        },
      ],
      installedAt: Date.now(),
    }),
  },

  /**
   * Advice subs: relationship_advice and similar.
   * Heavy AutoMod culture, strict word filters, low tolerance for vent posts.
   * Time public because urgent posts deserve fast response; Slop mod-only;
   * Tea and Clown OFF because they add noise to a sub that wants serious advice.
   */
  advice: {
    name: 'Advice subs',
    description: 'r/relationship_advice, advice-focused communities',
    targetSubs: ['relationship_advice'],
    config: (subreddit: string): SubConfig => ({
      subreddit,
      presetName: 'advice',
      observeOnly: true,
      aggressiveness: 'conservative',
      signals: buildSignals({
        tea: { visibility: 'off' },
        time: { visibility: 'public' },
        clown: { visibility: 'off' },
        slop: { visibility: 'mod-only' },
      }),
      rules: [
        {
          id: 'urgent-modmail',
          label: 'Ping modmail for urgent posts',
          conditions: [{ signal: 'time', comparator: '=', threshold: 3 }],
          action: { type: 'ping_modmail', subject: 'Urgent post', body: 'aurameter flagged a post with max urgency.' },
          enabled: true,
        },
      ],
      installedAt: Date.now(),
    }),
  },

  /**
   * Legal/medical subs: legaladvice and similar.
   * Templated culture, mod-heavy, no drama overlay wanted.
   * Time only public surface; everything else mod-only or off.
   */
  legal: {
    name: 'Legal / medical advice',
    description: 'r/legaladvice, r/AskDocs, professional-advice subs',
    targetSubs: ['legaladvice', 'AskDocs'],
    config: (subreddit: string): SubConfig => ({
      subreddit,
      presetName: 'legal',
      observeOnly: true,
      aggressiveness: 'conservative',
      signals: buildSignals({
        tea: { visibility: 'off' },
        time: { visibility: 'public' },
        clown: { visibility: 'mod-only' },
        slop: { visibility: 'mod-only' },
      }),
      rules: [],
      installedAt: Date.now(),
    }),
  },

  /**
   * Support subs: communities where members come for help, not entertainment.
   * Minimal surface: Time only public, Slop mod-only, everything else off.
   */
  support: {
    name: 'Support communities',
    description: 'Mental-health, recovery, grief support subs',
    targetSubs: [],
    config: (subreddit: string): SubConfig => ({
      subreddit,
      presetName: 'support',
      observeOnly: true,
      aggressiveness: 'conservative',
      signals: buildSignals({
        tea: { visibility: 'off' },
        time: { visibility: 'public' },
        clown: { visibility: 'off' },
        slop: { visibility: 'mod-only' },
      }),
      rules: [],
      installedAt: Date.now(),
    }),
  },

  /**
   * Meme subs: text-heavy meme communities where Slop is the main concern.
   * Slop mod-only by default; mods opt into public if they want.
   */
  meme: {
    name: 'Meme communities',
    description: 'Subs focused on text-meme content',
    targetSubs: [],
    config: (subreddit: string): SubConfig => ({
      subreddit,
      presetName: 'meme',
      observeOnly: true,
      aggressiveness: 'balanced',
      signals: buildSignals({
        tea: { visibility: 'off' },
        time: { visibility: 'off' },
        clown: { visibility: 'off' },
        slop: { visibility: 'mod-only' },
      }),
      rules: [],
      installedAt: Date.now(),
    }),
  },

  /**
   * Storytelling subs: r/TIFU, r/MaliciousCompliance, narrative-driven communities.
   * Tea public for discoverability; Slop public because AI-stories are the
   * main moderation pain; Time off; Clown mod-only.
   */
  storytelling: {
    name: 'Storytelling subs',
    description: 'r/TIFU, r/MaliciousCompliance, narrative communities',
    targetSubs: ['tifu', 'MaliciousCompliance'],
    config: (subreddit: string): SubConfig => ({
      subreddit,
      presetName: 'storytelling',
      observeOnly: true,
      aggressiveness: 'balanced',
      signals: buildSignals({
        tea: { visibility: 'public' },
        time: { visibility: 'off' },
        clown: { visibility: 'mod-only' },
        slop: { visibility: 'public' },
      }),
      rules: [
        {
          id: 'auto-slop-queue',
          label: 'Send likely-synthetic posts to mod queue',
          conditions: [{ signal: 'slop', comparator: '>=', threshold: 2 }],
          action: { type: 'send_to_modqueue', reason: 'aurameter: suspected synthetic content' },
          enabled: true,
        },
      ],
      installedAt: Date.now(),
    }),
  },
} as const;

export type PresetName = keyof typeof PRESETS;

/**
 * Best-effort preset suggestion for a subreddit, by exact-match on the
 * targetSubs list. Falls back to 'drama' which is the most common archetype
 * in the hackathon's target audience.
 */
export function suggestPreset(subreddit: string): PresetName {
  const sub = subreddit.toLowerCase();
  for (const [name, preset] of Object.entries(PRESETS)) {
    if (preset.targetSubs.some((t) => t.toLowerCase() === sub)) {
      return name as PresetName;
    }
  }
  return 'drama';
}

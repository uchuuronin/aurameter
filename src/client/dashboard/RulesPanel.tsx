// src/client/dashboard/RulesPanel.tsx
/**
 * rules panel — lists all custom + preset rules, with delete, and an entry point
 * to the add-rule drawer. The list mirrors config.rules exactly (including preset
 * rules using '='), so it stays consistent with the AutoMod YAML export.
 */

import { useState } from 'preact/hooks';
import type { SubConfig } from '../../core/config/types.js';
import { describeRule } from '../../core/engine/rules.js';
import { bridge } from './bridge.js';
import { RuleBuilderDrawer } from './RuleBuilderDrawer.js';

interface Props {
  config: SubConfig;
  onConfigUpdate: (config: SubConfig) => void;
}

export function RulesPanel({ config, onConfigUpdate }: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function remove(id: string) {
    setDeletingId(id);
    try {
      const { config: updated } = await bridge.deleteRule(id);
      onConfigUpdate(updated);
    } catch (err) {
      console.error('deleteRule failed:', err);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontWeight: 600 }}>Automation rules</div>
        <button onClick={() => setDrawerOpen(true)} style={{ fontSize: '13px', padding: '6px 12px', border: 'none', borderRadius: 'var(--radius)', background: 'var(--accent)', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>+ New rule</button>
      </div>

      {config.rules.length === 0 ? (
        <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--fg-muted)', fontSize: '13px' }}>
          no rules yet — add one to automate triage on new posts
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {config.rules.map((rule) => (
            <div key={rule.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--surface-2)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '13px' }}>{rule.label}</div>
                <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginTop: '2px' }}>{describeRule(rule)}</div>
              </div>
              <button onClick={() => remove(rule.id)} disabled={deletingId === rule.id} style={{ fontSize: '12px', padding: '4px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--surface)', color: 'var(--clown)', cursor: deletingId === rule.id ? 'wait' : 'pointer' }}>
                {deletingId === rule.id ? '…' : 'delete'}
              </button>
            </div>
          ))}
        </div>
      )}

      {drawerOpen && (
        <RuleBuilderDrawer
          onAdded={onConfigUpdate}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </div>
  );
}

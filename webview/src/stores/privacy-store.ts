/**
 * The chat-view censoring state (menu: **Privacy mode**).
 *
 * Two halves live here, and both are host-owned: the switch is `amulet.privacyMode` and the rules are
 * `amulet.privacyRules` plus the built-ins, all pushed in the `config` HostMessage. The webview never
 * edits rules — a new case to cover is a settings edit, not a code change.
 *
 * It is a store rather than chat state because it is not conversation data: censoring must survive a
 * session switch and a history reload, and must never reach the runtime. So it sits beside the
 * transcript instead of inside it, and text leaves it only through {@link useRedact} /
 * {@link redactText} at the moment of painting.
 */
import { useCallback } from 'react';
import { create } from 'zustand';
import type { WebviewConfig } from '../../../shared/protocol';
import {
  compilePrivacyRules,
  redactWithRules,
  type CompiledPrivacyRule,
} from '../../../shared/privacy';

interface PrivacyState {
  enabled: boolean;
  /** Bumped on every accepted config push, so a text leaf knows to paint again. */
  version: number;
  rules: CompiledPrivacyRule[];
  /** Fingerprint of the declared rules, so an equal re-push never re-renders the transcript. */
  fingerprint: string;
  /** Rules the host reported as unusable, kept so a debug session can see them. */
  issues: string[];
}

/** Exported for the tests and for anything that needs the raw snapshot (e.g. a status line). */
export const usePrivacyStore = create<PrivacyState>(() => ({
  enabled: false,
  version: 0,
  rules: [],
  fingerprint: '',
  issues: [],
}));

/** The declared form of a rule list — the only part worth comparing across pushes. */
function fingerprintOf(rules: CompiledPrivacyRule[]): string {
  return rules.map((rule) => JSON.stringify(rule.source)).join('\u0000');
}

/** Apply the privacy half of a `config` push; ignores anything that did not change. */
export function applyPrivacyConfig(config: WebviewConfig): void {
  const { rules } = compilePrivacyRules(config.privacyRules ?? []);
  const next = {
    enabled: config.privacyMode,
    rules,
    fingerprint: fingerprintOf(rules),
    issues: config.privacyRuleIssues ?? [],
  };
  const current = usePrivacyStore.getState();
  // The same settings are pushed on every connect, restart and unrelated toggle, and a version bump
  // re-renders the whole transcript's text: compare before writing.
  if (
    current.enabled === next.enabled &&
    current.fingerprint === next.fingerprint &&
    current.issues.join('|') === next.issues.join('|')
  ) {
    return;
  }
  usePrivacyStore.setState({
    ...next,
    version: current.version + 1,
  });
}

/**
 * Censor one display string. Safe to call from a pure helper — it reads the store directly, so a
 * formatter with no hook access (`toolPreview`, a tooltip) censors exactly like a component does.
 */
export function redactText(text: string): string {
  const state = usePrivacyStore.getState();
  return state.enabled && state.rules.length > 0
    ? redactWithRules(text, state.rules)
    : text;
}

/** Whether Privacy mode is on (menu checkmark, and anything else that shows the switch). */
export function usePrivacyMode(): boolean {
  return usePrivacyStore((s) => s.enabled);
}

/**
 * The censoring helper, subscribed to the config.
 *
 * Text is derived from state at render time, so a component that calls {@link redactText} without
 * subscribing would keep showing uncensored output after the menu flips the switch. Every leaf that
 * paints a string from chat state takes its `redact` from here.
 */
export function useRedact(): (text: string) => string {
  const version = usePrivacyStore((s) => s.version);
  // A fresh identity per config push, so a `useMemo`'d menu or preview that closes over `redact`
  // recomputes when the switch or the rules change instead of serving text censoring was off for.
  return useCallback((text: string) => redactText(text), [version]);
}

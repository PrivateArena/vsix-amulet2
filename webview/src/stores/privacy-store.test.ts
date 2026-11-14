import { describe, expect, it } from 'vitest';
import type { WebviewConfig } from '../../../shared/protocol';
import {
  applyPrivacyConfig,
  redactText,
  usePrivacyStore,
} from './privacy-store';

const config = (over: Partial<WebviewConfig> = {}): WebviewConfig => ({
  expandThinking: false,
  preserveLineBreaks: true,
  notifySticky: false,
  privacyMode: true,
  privacyRules: [
    { search: '/media/jang/home', replace: '/media/user/home' },
    { label: 'tokens', pattern: 'sk-[0-9a-f]{8}', replace: 'sk-REDACTED' },
  ],
  ...over,
});

const path = '/media/jang/home/PortableApp/rustdesk';

describe('privacy-store', () => {
  it('censors nothing until the host turns the switch on', () => {
    applyPrivacyConfig(config({ privacyMode: false }));
    expect(redactText(path)).toBe(path);
    applyPrivacyConfig(config());
    expect(redactText(path)).toBe('/media/user/home/PortableApp/rustdesk');
  });

  it('applies every rule of the push, in order', () => {
    applyPrivacyConfig(config());
    expect(redactText('key sk-01234567 and /media/jang/home')).toBe(
      'key sk-REDACTED and /media/user/home',
    );
  });

  it('bumps the version only when the push says something new', () => {
    applyPrivacyConfig(config());
    const before = usePrivacyStore.getState().version;
    // The same settings arrive again on every connect, restart and unrelated toggle.
    applyPrivacyConfig(config());
    expect(usePrivacyStore.getState().version).toBe(before);
    applyPrivacyConfig(config({ privacyMode: false }));
    expect(usePrivacyStore.getState().version).toBe(before + 1);
  });

  it('drops a rule the host could not compile instead of the whole list', () => {
    applyPrivacyConfig(
      config({
        privacyRules: [
          { pattern: '([broken', replace: 'x' },
          { search: 'jang', replace: 'user' },
        ],
        privacyRuleIssues: ['/(broken/: invalid pattern'],
      }),
    );
    expect(redactText('/media/jang/home')).toBe('/media/user/home');
    expect(usePrivacyStore.getState().issues).toEqual([
      '/(broken/: invalid pattern',
    ]);
  });

  it('leaves text untouched when no rule was sent', () => {
    applyPrivacyConfig(config({ privacyRules: [] }));
    expect(redactText(path)).toBe(path);
    expect(redactText('')).toBe('');
  });
});

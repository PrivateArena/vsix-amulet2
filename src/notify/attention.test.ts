import { describe, expect, it } from 'vitest';
import {
  approvalStatusLabel,
  quotedSubject,
  MAX_BODY_CHARS,
  needsSystemNotification,
  projectLabel,
  summarize,
  toastText,
} from './attention';

describe('summarize', () => {
  it('collapses a multi-line wire title into one line', () => {
    expect(
      summarize(
        'pi-gate: bash — `git push`\nno rule can close this question\n',
      ),
    ).toBe('pi-gate: bash — `git push` no rule can close this question');
  });

  it('trims surrounding whitespace', () => {
    expect(summarize('   done   \n  ')).toBe('done');
  });

  it('caps the body and marks the cut', () => {
    const long = 'x'.repeat(MAX_BODY_CHARS + 40);
    const out = summarize(long);
    expect(out.length).toBe(MAX_BODY_CHARS);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('x'.repeat(MAX_BODY_CHARS - 2))).toBe(true);
  });

  it('leaves a body exactly at the cap untouched', () => {
    const exact = 'y'.repeat(MAX_BODY_CHARS);
    expect(summarize(exact)).toBe(exact);
  });
});

describe('quotedSubject', () => {
  it('lifts the quoted command out of a gate heading', () => {
    expect(
      quotedSubject(
        'pi-gate: bash — `git push origin main` [floor: protected_path]',
      ),
    ).toBe('git push origin main');
  });

  it('gives up when the heading quotes nothing', () => {
    expect(
      quotedSubject('pi-subagent: explore — reached its limit of 10 turns'),
    ).toBeUndefined();
    expect(quotedSubject('`   `')).toBeUndefined();
    expect(quotedSubject('deploy?')).toBeUndefined();
  });
});

describe('toastText', () => {
  it('joins title and body with an em dash', () => {
    expect(
      toastText({
        title: 'repo: report ready',
        body: 'Fixed the bug.',
        critical: false,
      }),
    ).toBe('repo: report ready — Fixed the bug.');
  });

  it('does not repeat a body the title already contains', () => {
    expect(
      toastText({
        title: 'pi is waiting',
        body: 'pi is waiting',
        critical: true,
      }),
    ).toBe('pi is waiting');
  });

  it('caps the toast line', () => {
    const text = toastText(
      { title: 'x'.repeat(60), body: 'y'.repeat(60), critical: false },
      40,
    );
    expect(text.length).toBe(40);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('needsSystemNotification', () => {
  it('reaches out of VS Code only while the window is unfocused', () => {
    expect(
      needsSystemNotification({ enabled: true, windowFocused: false }),
    ).toBe(true);
    expect(
      needsSystemNotification({ enabled: true, windowFocused: true }),
    ).toBe(false);
  });

  it('never fires with the setting off, focused or not', () => {
    expect(
      needsSystemNotification({ enabled: false, windowFocused: false }),
    ).toBe(false);
  });
});

describe('approvalStatusLabel', () => {
  it('is absent when nothing is waiting', () => {
    expect(approvalStatusLabel(0)).toBeNull();
  });

  it('reads as one approval, then as a count', () => {
    expect(approvalStatusLabel(1)).toContain('approval waiting');
    expect(approvalStatusLabel(3)).toContain('3 approvals waiting');
  });
});

describe('projectLabel', () => {
  it('uses the folder name, not the whole path', () => {
    expect(projectLabel('/home/dev/work/vsix-amulet2')).toBe('vsix-amulet2');
    expect(projectLabel('C:\\Users\\dev\\proj')).toBe('proj');
  });

  it('ignores trailing separators', () => {
    expect(projectLabel('/home/dev/work/proj/')).toBe('proj');
  });

  it('falls back to something readable for a root path', () => {
    expect(projectLabel('/')).toBe('chat');
  });
});

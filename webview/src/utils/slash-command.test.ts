import { describe, expect, it } from 'vitest';
import {
  commandName,
  highlightQuery,
  invocationOf,
  isSkillCommandName,
  matchesSlashQuery,
  parseSlashToken,
  skillNameOf,
} from './slash-command';

describe('parseSlashToken', () => {
  it('detects a plain command token at the end of the input', () => {
    expect(parseSlashToken('/compac')).toEqual({
      query: 'compac',
      start: 0,
      end: 7,
    });
    expect(parseSlashToken('apply /compac')).toEqual({
      query: 'compac',
      start: 6,
      end: 13,
    });
  });

  it('keeps the skill namespace inside the token', () => {
    // The whole `/skill:name` is the invocation pi matches, so the colon and the
    // hyphenated name must stay in the token being completed.
    expect(parseSlashToken('/skill:turn-based-strategy')).toEqual({
      query: 'skill:turn-based-strategy',
      start: 0,
      end: 26,
    });
    expect(parseSlashToken('/sk')).toEqual({
      query: 'sk',
      start: 0,
      end: 3,
    });
  });

  it('still ends a skill token at a slash so chains complete one name', () => {
    expect(parseSlashToken('/skill:research /skill:g')).toEqual({
      query: 'skill:g',
      start: 16,
      end: 24,
    });
    // A path argument is not a command name.
    expect(parseSlashToken('/skill:research/docs')).toBeNull();
  });

  it('ignores tokens that are not at the end or not at a word start', () => {
    expect(parseSlashToken('/compact now')).toBeNull();
    expect(parseSlashToken('and/or')).toBeNull();
    // `/sk` after a path separator is not a command position.
    expect(parseSlashToken('docs/sk')).toBeNull();
    expect(parseSlashToken('fix the build')).toBeNull();
    expect(parseSlashToken('')).toBeNull();
  });
});

describe('commandName / invocationOf', () => {
  it('strips leading slashes and rebuilds the invocation', () => {
    expect(commandName('//compact')).toBe('compact');
    expect(invocationOf('compact')).toBe('/compact');
    expect(invocationOf('skill:game-ai')).toBe('/skill:game-ai');
    expect(invocationOf('/skill:game-ai')).toBe('/skill:game-ai');
  });

  it('recognises skill names and exposes the bare name', () => {
    expect(isSkillCommandName('skill:game-ai')).toBe(true);
    expect(isSkillCommandName('game-ai')).toBe(false);
    expect(skillNameOf('skill:turn-based-strategy')).toBe(
      'turn-based-strategy',
    );
  });
});

describe('matchesSlashQuery', () => {
  it('matches a skill by namespace and by bare name', () => {
    expect(matchesSlashQuery('skill:turn-based-strategy', 'skill:turn')).toBe(
      true,
    );
    expect(matchesSlashQuery('skill:turn-based-strategy', 'turn-based')).toBe(
      true,
    );
    expect(matchesSlashQuery('skill:turn-based-strategy', 'STRATEGY')).toBe(
      true,
    );
    expect(matchesSlashQuery('skill:audio-design', 'turn')).toBe(false);
  });

  it('does not let a skill swallow a prompt template that contains its text', () => {
    expect(matchesSlashQuery('audio-design', 'audio')).toBe(true);
    expect(matchesSlashQuery('skill:audio-design', 'audio')).toBe(true);
  });

  it('matches commands as before and treats an empty query as a match', () => {
    expect(matchesSlashQuery('compact', '')).toBe(true);
    expect(matchesSlashQuery('compact', 'comp')).toBe(true);
    expect(matchesSlashQuery('model', 'comp')).toBe(false);
  });
});

describe('highlightQuery', () => {
  it('drops the namespace it already rendered for a skill', () => {
    expect(highlightQuery(true, 'skill:turn')).toBe('turn');
    expect(highlightQuery(true, 'turn')).toBe('turn');
    expect(highlightQuery(false, 'skill:turn')).toBe('skill:turn');
  });
});

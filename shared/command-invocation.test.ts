import { describe, expect, it } from 'vitest';
import { parseCommandInvocation } from './command-invocation';

/**
 * These cases are pinned to pi 1.5.0's `_tryExecuteExtensionCommand`
 * (dist/core/agent-session.js:1716-1724). If pi loosens its matcher, the client
 * cache must loosen with it — a divergence here silently turns a `/command` into
 * a model prompt.
 */
describe('parseCommandInvocation', () => {
  it('splits the name at the first space and keeps the args verbatim', () => {
    expect(parseCommandInvocation('/gatec status')).toEqual({
      name: 'gatec',
      args: 'status',
    });
    expect(parseCommandInvocation('/gatec  allow 5min')).toEqual({
      name: 'gatec',
      args: ' allow 5min',
    });
    expect(parseCommandInvocation('/login')).toEqual({
      name: 'login',
      args: '',
    });
  });

  it('requires the slash at offset 0', () => {
    expect(parseCommandInvocation(' /gatec status')).toBeNull();
    expect(parseCommandInvocation('run /gatec status')).toBeNull();
  });

  it('treats a non-space separator as part of the name', () => {
    expect(parseCommandInvocation('/gatec\tstatus')).toEqual({
      name: 'gatec\tstatus',
      args: '',
    });
    expect(parseCommandInvocation('/gatec\nstatus')).toEqual({
      name: 'gatec\nstatus',
      args: '',
    });
  });

  it('name nothing an empty invocation', () => {
    expect(parseCommandInvocation('/')).toBeNull();
    expect(parseCommandInvocation('')).toBeNull();
    expect(parseCommandInvocation('plain text')).toBeNull();
  });

  it('keeps pi skill namespaces inside the name', () => {
    expect(parseCommandInvocation('/skill:pdf-tools draft')).toEqual({
      name: 'skill:pdf-tools',
      args: 'draft',
    });
  });
});

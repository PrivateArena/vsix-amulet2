import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { POSIX_SEP, toProjectPaths } from './project-paths';

const at = (...parts: string[]) => path.resolve(path.join(...parts));

describe('toProjectPaths', () => {
  it('rewrites absolute paths as project-relative POSIX paths', () => {
    const cwd = at('home', 'dev', 'app');
    expect(
      toProjectPaths(
        [at(cwd, 'src', 'webview', 'chat-bridge.ts'), at(cwd, 'README.md')],
        cwd,
      ),
    ).toEqual([
      'README.md',
      path
        .join('src', 'webview', 'chat-bridge.ts')
        .split(path.sep)
        .join(POSIX_SEP),
    ]);
  });

  it('drops anything outside the working directory', () => {
    const cwd = at('home', 'dev', 'app');
    expect(
      toProjectPaths(
        [at('home', 'dev', 'other', 'secret.txt'), at('home', 'other.ts')],
        cwd,
      ),
    ).toEqual([]);
  });

  it('drops the directory itself and de-duplicates repeated hits', () => {
    const cwd = at('home', 'dev', 'app');
    const file = at(cwd, 'src', 'a.ts');
    expect(toProjectPaths([cwd, file, file], cwd)).toEqual(['src/a.ts']);
  });

  it('orders shallowest first so a capped listing keeps the top of the tree', () => {
    const cwd = at('home', 'dev', 'app');
    expect(
      toProjectPaths(
        [at(cwd, 'z', 'b.ts'), at(cwd, 'a.ts'), at(cwd, 'z', 'a.ts')],
        cwd,
      ),
    ).toEqual([
      'a.ts',
      path.join('z', 'a.ts').split(path.sep).join(POSIX_SEP),
      'z/b.ts',
    ]);
  });
});

import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandInfo } from '../../shared/protocol';
import { MAX_PROMPT_RESOURCE_BYTES, readPromptResource } from './prompt-resource';

/**
 * The dialog's only view of the filesystem, so the interesting cases are the refusals:
 * a name that is not a file-backed command, a file that is not there, and a path that
 * points outside the folders pi reports resources from.
 */

const agentDir = resolve(join(realpathSync(tmpdir()), 'amulet-agent'));
const cwd = resolve(join(realpathSync(tmpdir()), 'amulet-project'));
const roots = { agentDir, cwd };

const promptFile = join(agentDir, 'prompts', 'architect.md');
const skillFile = join(agentDir, 'skills', 'pdf-tools', 'SKILL.md');

const row = (over: Partial<CommandInfo> & { name: string }): CommandInfo => ({
  source: 'prompt',
  ...over,
});

beforeAll(() => {
  mkdirSync(join(agentDir, 'prompts'), { recursive: true });
  mkdirSync(join(agentDir, 'skills', 'pdf-tools'), { recursive: true });
  mkdirSync(join(cwd, '.pi', 'prompts'), { recursive: true });
  writeFileSync(
    promptFile,
    '---\ndescription: "Plan a thing"\nargument-hint: <idea>\n---\nDraft a plan for: \'$1\'.\n',
  );
  writeFileSync(
    skillFile,
    '---\nname: pdf-tools\ndescription: Read pdfs\n---\nUse `pdftotext`.\n',
  );
  writeFileSync(join(cwd, '.pi', 'prompts', 'local.md'), 'Project prompt $@\n');
  writeFileSync(join(agentDir, 'prompts', 'huge.md'), 'x'.repeat(MAX_PROMPT_RESOURCE_BYTES + 10));
});

afterAll(() => {
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe('readPromptResource', () => {
  it('reads a user-scope template and strips its frontmatter', () => {
    const result = readPromptResource(
      row({
        name: 'architect',
        sourceInfo: { path: promptFile, baseDir: join(agentDir, 'prompts'), scope: 'user' },
      }),
      roots,
    );
    expect(result).toEqual({
      resource: {
        name: 'architect',
        kind: 'prompt',
        path: promptFile,
        hint: '<idea>',
        body: "Draft a plan for: '$1'.",
      },
    });
  });

  it('accepts a project-scope template under <cwd>/.pi/prompts', () => {
    const result = readPromptResource(
      row({ name: 'local', sourceInfo: { path: join(cwd, '.pi', 'prompts', 'local.md') } }),
      roots,
    );
    expect(result).toEqual({
      // No frontmatter fence, so pi keeps the file's own trailing newline in the body too.
      resource: expect.objectContaining({ body: 'Project prompt $@\n' }),
    });
  });

  it('carries a skill directory so the block can name it', () => {
    const result = readPromptResource(
      row({
        name: 'skill:pdf-tools',
        source: 'skill',
        sourceInfo: { path: skillFile },
      }),
      roots,
    );
    if (!('resource' in result)) throw new Error('expected the skill to read');
    expect(result.resource).toMatchObject({
      kind: 'skill',
      baseDir: join(agentDir, 'skills', 'pdf-tools'),
      body: 'Use `pdftotext`.',
    });
  });

  it('refuses an extension command, which runs code instead of expanding a file', () => {
    expect(
      readPromptResource(
        row({
          name: 'gatec',
          source: 'extension',
          sourceInfo: { path: '/home/u/.pi/agent/npm/x/index.ts' },
        }),
        roots,
      ),
    ).toEqual({ error: expect.stringContaining('extension command') });
  });

  it('refuses a name the runtime never reported', () => {
    expect(readPromptResource(undefined, roots)).toEqual({
      error: 'No such command in this runtime.',
    });
  });

  it('refuses a pseudo-path and a non-markdown one', () => {
    expect(
      readPromptResource(
        row({ name: 'llama', sourceInfo: { path: 'builtin:llama.cpp', scope: 'temporary' } }),
        roots,
      ),
    ).toEqual({ error: expect.stringContaining('builtin:llama.cpp') });
    expect(
      readPromptResource(
        row({ name: 'x', sourceInfo: { path: join(agentDir, 'prompts', 'architect.md.bak') } }),
        roots,
      ),
    ).toEqual({ error: expect.stringContaining('Not a markdown prompt file') });
  });

  it('refuses a path outside the folder pi said it came from', () => {
    expect(
      readPromptResource(
        row({ name: 'etc', sourceInfo: { path: '/etc/readme.md', baseDir: '/etc/ssl' } }),
        roots,
      ),
    ).toEqual({ error: expect.stringContaining("outside pi's prompt folders") });
  });

  it('refuses a file pi listed but that is no longer on disk', () => {
    expect(
      readPromptResource(
        row({
          name: 'gone',
          sourceInfo: { path: join(agentDir, 'prompts', 'gone.md'), baseDir: join(agentDir, 'prompts') },
        }),
        roots,
      ),
    ).toEqual({ error: expect.stringContaining('not there') });
  });

  it('refuses a file over the read budget instead of shipping it whole', () => {
    expect(
      readPromptResource(
        row({
          name: 'huge',
          sourceInfo: { path: join(agentDir, 'prompts', 'huge.md'), baseDir: join(agentDir, 'prompts') },
        }),
        roots,
      ),
    ).toEqual({ error: expect.stringContaining('read budget') });
  });
});

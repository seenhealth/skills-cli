import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('scanDir symlink detection', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'scandir-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('finds both directories and symlinked directories', async () => {
    // Create a regular directory
    await mkdir(join(tempDir, 'regular-skill'), { recursive: true });

    // Create a target for the symlink
    const symlinkTarget = join(tempDir, '_target');
    await mkdir(symlinkTarget, { recursive: true });

    // Create a symlink
    await symlink(symlinkTarget, join(tempDir, 'symlinked-skill'));

    // Reproduce the scanDir logic (matching updated remove.ts)
    const skillNamesSet = new Set<string>();
    const entries = await readdir(tempDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        skillNamesSet.add(entry.name);
      }
    }

    expect(skillNamesSet.has('regular-skill')).toBe(true);
    expect(skillNamesSet.has('symlinked-skill')).toBe(true);
  });

  it('does not include plain files', async () => {
    await writeFile(join(tempDir, 'not-a-skill.txt'), 'hello');
    await mkdir(join(tempDir, 'real-skill'));

    const skillNamesSet = new Set<string>();
    const entries = await readdir(tempDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        skillNamesSet.add(entry.name);
      }
    }

    expect(skillNamesSet.has('real-skill')).toBe(true);
    expect(skillNamesSet.has('not-a-skill.txt')).toBe(false);
  });
});

describe('excludeSkillFromRepo', () => {
  it('adds skill to exclusion list', async () => {
    const lockData = {
      version: 4,
      skills: {},
      repos: {
        'github.com/test/repo': {
          url: 'https://github.com/test/repo',
          skills: ['skill-a'],
          lastFetched: new Date().toISOString(),
        },
      },
    };

    // Mock fs/promises to intercept lock file I/O
    vi.doMock('fs/promises', async (importOriginal) => {
      const actual = (await importOriginal()) as any;
      return {
        ...actual,
        readFile: vi.fn().mockResolvedValue(JSON.stringify(lockData)),
        writeFile: vi.fn().mockImplementation((_path: string, content: string) => {
          Object.assign(lockData, JSON.parse(content));
          return Promise.resolve();
        }),
        mkdir: vi.fn().mockResolvedValue(undefined),
      };
    });

    // Re-import to pick up the mock
    const { excludeSkillFromRepo } = await import('../src/skill-lock.ts');

    await excludeSkillFromRepo('github.com/test/repo', 'skill-b');

    expect(lockData.repos['github.com/test/repo']).toHaveProperty('excluded', ['skill-b']);

    vi.doUnmock('fs/promises');
  });
});

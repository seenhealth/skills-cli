/**
 * Tests for gc-related lock file operations and repo-symlink skill entries.
 *
 * NOTE: These tests share the real ~/.agents/.skill-lock.json file.
 * Each test must carefully save/restore the original content.
 * Run this file individually or ensure no parallel test modifies the same file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import {
  addRepoToLock,
  removeSkillFromRepo,
  getOrphanedRepos,
  removeRepoFromLock,
  readSkillLock,
  type SkillLockFile,
} from '../src/skill-lock.ts';

// Use a shared save/restore mechanism
const lockPath = join(homedir(), '.agents', '.skill-lock.json');
let savedContent: string | null = null;

async function saveLockFile() {
  try {
    savedContent = await readFile(lockPath, 'utf-8').catch(() => null);
  } catch {
    savedContent = null;
  }
}

async function restoreLockFile() {
  if (savedContent) {
    await writeFile(lockPath, savedContent, 'utf-8');
  } else {
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

async function writeLock(lock: SkillLockFile) {
  await mkdir(join(homedir(), '.agents'), { recursive: true });
  await writeFile(lockPath, JSON.stringify(lock), 'utf-8');
}

describe('gc-related lock file operations', () => {
  beforeEach(async () => {
    await saveLockFile();
    await writeLock({
      version: 4,
      skills: {},
      repos: {
        'github.com/owner/used-repo': {
          url: 'https://github.com/owner/used-repo.git',
          skills: ['skill-a'],
          lastFetched: '2024-01-01T00:00:00.000Z',
        },
        'github.com/owner/orphaned-repo': {
          url: 'https://github.com/owner/orphaned-repo.git',
          skills: [],
          lastFetched: '2024-01-01T00:00:00.000Z',
        },
      },
    });
  });

  afterEach(restoreLockFile);

  it('getOrphanedRepos returns only repos with no skills', async () => {
    const orphaned = await getOrphanedRepos();
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].key).toBe('github.com/owner/orphaned-repo');
    expect(orphaned[0].entry.skills).toEqual([]);
  });

  it('removeRepoFromLock removes repo entry', async () => {
    await removeRepoFromLock('github.com/owner/orphaned-repo');

    const lock = await readSkillLock();
    expect(lock.repos?.['github.com/owner/orphaned-repo']).toBeUndefined();
    expect(lock.repos?.['github.com/owner/used-repo']).toBeDefined();
  });

  it('flow: remove skill creates orphan, gc finds it', async () => {
    await addRepoToLock(
      'github.com/owner/single-skill-repo',
      { url: 'https://github.com/owner/single-skill-repo.git' },
      ['only-skill']
    );

    await removeSkillFromRepo('github.com/owner/single-skill-repo', 'only-skill');

    const orphaned = await getOrphanedRepos();
    const found = orphaned.find((o) => o.key === 'github.com/owner/single-skill-repo');
    expect(found).toBeDefined();
    expect(found!.entry.skills).toEqual([]);
  });
});

describe('repo-symlink skill lock entries', () => {
  beforeEach(async () => {
    await saveLockFile();
    await writeLock({
      version: 4,
      skills: {
        'repo-skill': {
          source: 'owner/repo',
          sourceType: 'github',
          sourceUrl: 'https://github.com/owner/repo.git',
          skillFolderHash: 'abc123',
          installedAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          installMethod: 'repo-symlink',
          repoPath: 'github.com/owner/repo',
          ref: 'main',
        },
        'legacy-skill': {
          source: 'other/repo',
          sourceType: 'github',
          sourceUrl: 'https://github.com/other/repo.git',
          skillPath: 'skills/legacy/SKILL.md',
          skillFolderHash: 'def456',
          installedAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      },
      repos: {},
    });
  });

  afterEach(restoreLockFile);

  it('can distinguish repo-symlink from legacy skills', async () => {
    const lock = await readSkillLock();

    const repoSkill = lock.skills['repo-skill'];
    expect(repoSkill.installMethod).toBe('repo-symlink');
    expect(repoSkill.repoPath).toBe('github.com/owner/repo');
    expect(repoSkill.ref).toBe('main');

    const legacySkill = lock.skills['legacy-skill'];
    expect(legacySkill.installMethod).toBeUndefined();
    expect(legacySkill.repoPath).toBeUndefined();
  });
});

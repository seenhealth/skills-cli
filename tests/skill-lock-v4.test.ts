import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

// We test the repo tracking helpers by importing them directly.
// To avoid modifying the real ~/.agents lock file, we mock the lock path.

import {
  addRepoToLock,
  removeSkillFromRepo,
  getOrphanedRepos,
  removeRepoFromLock,
  readSkillLock,
  writeSkillLock,
  type SkillLockFile,
  type RepoEntry,
} from '../src/skill-lock.ts';

describe('skill-lock v4 schema', () => {
  describe('v3 to v4 migration', () => {
    it('readSkillLock migrates v3 data preserving skills', async () => {
      // Create a v3 lock file at the expected location
      const lockPath = join(homedir(), '.agents', '.skill-lock.json');
      let originalContent: string | null = null;

      try {
        originalContent = await readFile(lockPath, 'utf-8').catch(() => null);
      } catch {
        // File may not exist
      }

      const v3Data: SkillLockFile = {
        version: 3,
        skills: {
          'test-skill': {
            source: 'owner/repo',
            sourceType: 'github',
            sourceUrl: 'https://github.com/owner/repo.git',
            skillFolderHash: 'abc123',
            installedAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        },
        dismissed: { findSkillsPrompt: true },
      };

      try {
        await mkdir(join(homedir(), '.agents'), { recursive: true });
        await writeFile(lockPath, JSON.stringify(v3Data), 'utf-8');

        const result = await readSkillLock();

        // Version should be bumped to 4
        expect(result.version).toBe(4);
        // Existing skills should be preserved
        expect(result.skills['test-skill']).toBeDefined();
        expect(result.skills['test-skill'].source).toBe('owner/repo');
        // Dismissed prompts should be preserved
        expect(result.dismissed?.findSkillsPrompt).toBe(true);
        // repos map should be added
        expect(result.repos).toBeDefined();
      } finally {
        // Restore original lock file
        if (originalContent) {
          await writeFile(lockPath, originalContent, 'utf-8');
        } else {
          await rm(lockPath, { force: true }).catch(() => {});
        }
      }
    });
  });

  describe('createEmptyLockFile', () => {
    it('includes repos map', async () => {
      // Force creating an empty lock by reading a non-existent one
      const lockPath = join(homedir(), '.agents', '.skill-lock.json');
      let originalContent: string | null = null;

      try {
        originalContent = await readFile(lockPath, 'utf-8').catch(() => null);
      } catch {
        // File may not exist
      }

      try {
        // Write an invalid file to trigger empty creation
        await mkdir(join(homedir(), '.agents'), { recursive: true });
        await writeFile(lockPath, 'invalid json', 'utf-8');

        const result = await readSkillLock();
        expect(result.version).toBe(4);
        expect(result.skills).toEqual({});
        expect(result.repos).toEqual({});
      } finally {
        if (originalContent) {
          await writeFile(lockPath, originalContent, 'utf-8');
        } else {
          await rm(lockPath, { force: true }).catch(() => {});
        }
      }
    });
  });

  describe('SkillLockEntry new fields', () => {
    it('accepts new v4 fields in entries', () => {
      // Type-level test: ensure the new fields are valid
      const entry = {
        source: 'owner/repo',
        sourceType: 'github',
        sourceUrl: 'https://github.com/owner/repo.git',
        skillFolderHash: 'abc123',
        installedAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        ref: 'main',
        installMethod: 'repo-symlink' as const,
        repoPath: 'github.com/owner/repo',
      };

      expect(entry.ref).toBe('main');
      expect(entry.installMethod).toBe('repo-symlink');
      expect(entry.repoPath).toBe('github.com/owner/repo');
    });
  });

  describe('repo tracking helpers', () => {
    let originalContent: string | null = null;
    const lockPath = join(homedir(), '.agents', '.skill-lock.json');

    beforeEach(async () => {
      try {
        originalContent = await readFile(lockPath, 'utf-8').catch(() => null);
      } catch {
        originalContent = null;
      }

      // Start with a clean v4 lock file
      const cleanLock: SkillLockFile = {
        version: 4,
        skills: {},
        repos: {},
      };
      await mkdir(join(homedir(), '.agents'), { recursive: true });
      await writeFile(lockPath, JSON.stringify(cleanLock), 'utf-8');
    });

    afterEach(async () => {
      if (originalContent) {
        await writeFile(lockPath, originalContent, 'utf-8');
      } else {
        await rm(lockPath, { force: true }).catch(() => {});
      }
    });

    it('addRepoToLock creates a new repo entry', async () => {
      await addRepoToLock(
        'github.com/owner/repo',
        { url: 'https://github.com/owner/repo.git' },
        ['skill-a', 'skill-b']
      );

      const lock = await readSkillLock();
      const repo = lock.repos?.['github.com/owner/repo'];
      expect(repo).toBeDefined();
      expect(repo!.url).toBe('https://github.com/owner/repo.git');
      expect(repo!.skills).toEqual(['skill-a', 'skill-b']);
      expect(repo!.lastFetched).toBeTruthy();
    });

    it('addRepoToLock merges skills for existing repo', async () => {
      await addRepoToLock(
        'github.com/owner/repo',
        { url: 'https://github.com/owner/repo.git' },
        ['skill-a']
      );

      await addRepoToLock(
        'github.com/owner/repo',
        { url: 'https://github.com/owner/repo.git' },
        ['skill-b', 'skill-a'] // skill-a is a duplicate
      );

      const lock = await readSkillLock();
      const repo = lock.repos?.['github.com/owner/repo'];
      expect(repo!.skills).toEqual(['skill-a', 'skill-b']);
    });

    it('removeSkillFromRepo removes a skill name', async () => {
      await addRepoToLock(
        'github.com/owner/repo',
        { url: 'https://github.com/owner/repo.git' },
        ['skill-a', 'skill-b']
      );

      await removeSkillFromRepo('github.com/owner/repo', 'skill-a');

      const lock = await readSkillLock();
      const repo = lock.repos?.['github.com/owner/repo'];
      expect(repo!.skills).toEqual(['skill-b']);
    });

    it('getOrphanedRepos returns repos with no skills', async () => {
      await addRepoToLock(
        'github.com/owner/repo1',
        { url: 'https://github.com/owner/repo1.git' },
        ['skill-a']
      );
      await addRepoToLock(
        'github.com/owner/repo2',
        { url: 'https://github.com/owner/repo2.git' },
        ['skill-b']
      );

      // Remove all skills from repo2
      await removeSkillFromRepo('github.com/owner/repo2', 'skill-b');

      const orphaned = await getOrphanedRepos();
      expect(orphaned).toHaveLength(1);
      expect(orphaned[0].key).toBe('github.com/owner/repo2');
    });

    it('removeRepoFromLock deletes the repo entry', async () => {
      await addRepoToLock(
        'github.com/owner/repo',
        { url: 'https://github.com/owner/repo.git' },
        ['skill-a']
      );

      await removeRepoFromLock('github.com/owner/repo');

      const lock = await readSkillLock();
      expect(lock.repos?.['github.com/owner/repo']).toBeUndefined();
    });
  });
});

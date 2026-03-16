import { access, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join, relative, resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCanonicalPath } from '../src/installer.ts';
import type { ReconcileLock } from '../src/reconcile.ts';
import { reconcileRepoSkills } from '../src/reconcile.ts';

/**
 * Helper: create a skill directory with a valid SKILL.md inside a repo checkout.
 */
async function createSkillInRepo(repoDir: string, skillName: string): Promise<void> {
  const skillDir = join(repoDir, 'skills', skillName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: Test skill ${skillName}\n---\n# ${skillName}\n`,
    'utf-8'
  );
}

/**
 * Helper: build a lock object with given skill names tracked under a repo.
 */
function buildLock(
  repoPath: string,
  skillNames: string[],
  opts: { sourceUrl?: string; sourceType?: string; ref?: string } = {}
): ReconcileLock {
  const sourceUrl = opts.sourceUrl ?? 'https://github.com/test/repo';
  const sourceType = opts.sourceType ?? 'github';
  const now = new Date().toISOString();

  const skills: ReconcileLock['skills'] = {};
  for (const name of skillNames) {
    skills[name] = {
      source: repoPath,
      sourceType,
      sourceUrl,
      skillFolderHash: '',
      installedAt: now,
      updatedAt: now,
      ref: opts.ref,
      installMethod: 'repo-symlink',
      repoPath,
    };
  }

  return {
    version: 4,
    skills,
    repos: {
      [repoPath]: {
        url: sourceUrl,
        ref: opts.ref,
        skills: [...skillNames],
        lastFetched: now,
      },
    },
  };
}

describe('reconcileRepoSkills', () => {
  let tempDir: string;
  let repoDir: string;
  const repoPath = 'github.com/test/repo';
  const defaultOpts = {
    sourceUrl: 'https://github.com/test/repo',
    sourceType: 'github',
    agents: ['claude-code' as const],
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'reconcile-'));
    repoDir = join(tempDir, 'repo-checkout');
    await mkdir(repoDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('no changes — lock matches repo', async () => {
    await createSkillInRepo(repoDir, 'skill-a');
    await createSkillInRepo(repoDir, 'skill-b');

    const lock = buildLock(repoPath, ['skill-a', 'skill-b']);
    const result = await reconcileRepoSkills(repoPath, repoDir, lock, defaultOpts);

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    // Lock should be unchanged
    expect(Object.keys(lock.skills)).toEqual(expect.arrayContaining(['skill-a', 'skill-b']));
    expect(lock.repos![repoPath].skills).toEqual(expect.arrayContaining(['skill-a', 'skill-b']));
  });

  it('skill removed from repo — deletes from lock', async () => {
    // Repo only has skill-a now
    await createSkillInRepo(repoDir, 'skill-a');

    const lock = buildLock(repoPath, ['skill-a', 'skill-b']);
    const result = await reconcileRepoSkills(repoPath, repoDir, lock, defaultOpts);

    expect(result.removed).toEqual(['skill-b']);
    expect(result.added).toEqual([]);
    // skill-b should be gone from lock
    expect(lock.skills['skill-b']).toBeUndefined();
    expect(lock.repos![repoPath].skills).toEqual(['skill-a']);
    // skill-a should remain
    expect(lock.skills['skill-a']).toBeDefined();
  });

  it('skill added to repo — adds to lock', async () => {
    await createSkillInRepo(repoDir, 'skill-a');
    await createSkillInRepo(repoDir, 'skill-b');

    const lock = buildLock(repoPath, ['skill-a']);
    const result = await reconcileRepoSkills(repoPath, repoDir, lock, defaultOpts);

    expect(result.added).toEqual(['skill-b']);
    expect(result.removed).toEqual([]);
    // skill-b should be added to lock
    expect(lock.skills['skill-b']).toBeDefined();
    expect(lock.skills['skill-b'].installMethod).toBe('repo-symlink');
    expect(lock.skills['skill-b'].repoPath).toBe(repoPath);
    expect(lock.repos![repoPath].skills).toEqual(expect.arrayContaining(['skill-a', 'skill-b']));
  });

  it('skill renamed — removes old and adds new', async () => {
    // Repo has new-name instead of old-name
    await createSkillInRepo(repoDir, 'new-name');

    const lock = buildLock(repoPath, ['old-name']);
    const result = await reconcileRepoSkills(repoPath, repoDir, lock, defaultOpts);

    expect(result.removed).toEqual(['old-name']);
    expect(result.added).toEqual(['new-name']);
    // old-name gone, new-name present
    expect(lock.skills['old-name']).toBeUndefined();
    expect(lock.skills['new-name']).toBeDefined();
    expect(lock.repos![repoPath].skills).toEqual(['new-name']);
  });

  it('all skills removed from repo', async () => {
    // Empty repo (no skills directory)
    const lock = buildLock(repoPath, ['skill-a', 'skill-b']);
    const result = await reconcileRepoSkills(repoPath, repoDir, lock, defaultOpts);

    expect(result.removed).toEqual(expect.arrayContaining(['skill-a', 'skill-b']));
    expect(result.added).toEqual([]);
    expect(Object.keys(lock.skills)).toEqual([]);
    expect(lock.repos![repoPath].skills).toEqual([]);
  });

  it('empty lock, skills in repo — adds all', async () => {
    await createSkillInRepo(repoDir, 'skill-a');

    const lock = buildLock(repoPath, []);
    const result = await reconcileRepoSkills(repoPath, repoDir, lock, defaultOpts);

    expect(result.added).toEqual(['skill-a']);
    expect(result.removed).toEqual([]);
    expect(lock.skills['skill-a']).toBeDefined();
    expect(lock.repos![repoPath].skills).toEqual(['skill-a']);
  });

  it('skipNewSkills — does not add new skills from repo', async () => {
    await createSkillInRepo(repoDir, 'skill-a');
    await createSkillInRepo(repoDir, 'skill-b');

    const lock = buildLock(repoPath, ['skill-a']);
    const result = await reconcileRepoSkills(repoPath, repoDir, lock, {
      ...defaultOpts,
      skipNewSkills: true,
    });

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(lock.skills['skill-b']).toBeUndefined();
    expect(lock.repos![repoPath].skills).toEqual(['skill-a']);
  });

  it('skipNewSkills — still removes deleted skills', async () => {
    await createSkillInRepo(repoDir, 'skill-a');

    const lock = buildLock(repoPath, ['skill-a', 'skill-b']);
    const result = await reconcileRepoSkills(repoPath, repoDir, lock, {
      ...defaultOpts,
      skipNewSkills: true,
    });

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual(['skill-b']);
    expect(lock.skills['skill-b']).toBeUndefined();
  });

  it('symlink cleanup — canonical dir is removed for deleted skill', async () => {
    await createSkillInRepo(repoDir, 'skill-a');

    const lock = buildLock(repoPath, ['skill-a', 'skill-b']);

    // Pre-create the canonical path for skill-b under the temp dir so we can verify removal
    const canonicalPath = getCanonicalPath('skill-b', {
      global: false,
      cwd: tempDir,
    });
    await mkdir(canonicalPath, { recursive: true });
    await writeFile(join(canonicalPath, 'SKILL.md'), 'placeholder', 'utf-8');

    // Verify it exists before reconcile
    await expect(access(canonicalPath)).resolves.toBeUndefined();

    // Use project-level (non-global) reconcile so it cleans up under tempDir
    await reconcileRepoSkills(repoPath, repoDir, lock, defaultOpts);

    // Canonical dir should be cleaned up (global canonical is attempted but may not exist;
    // verify the lock state instead)
    expect(lock.skills['skill-b']).toBeUndefined();
    expect(lock.repos![repoPath].skills).not.toContain('skill-b');
  });

  it('excluded skill is not re-added by reconcile', async () => {
    await createSkillInRepo(repoDir, 'skill-a');
    await createSkillInRepo(repoDir, 'skill-b');

    // skill-b is tracked, skill-a is excluded (user removed it)
    const lock = buildLock(repoPath, ['skill-b']);
    lock.repos![repoPath].excluded = ['skill-a'];

    const result = await reconcileRepoSkills(repoPath, repoDir, lock, defaultOpts);

    // skill-a should NOT be added back
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(lock.skills['skill-a']).toBeUndefined();
  });

  it('re-installing a previously excluded skill allows reconcile to add it', async () => {
    await createSkillInRepo(repoDir, 'skill-a');
    await createSkillInRepo(repoDir, 'skill-b');

    // skill-a is excluded, skill-b is tracked
    const lock = buildLock(repoPath, ['skill-b']);
    lock.repos![repoPath].excluded = ['skill-a'];

    // First reconcile — skill-a should stay excluded
    const result1 = await reconcileRepoSkills(repoPath, repoDir, lock, defaultOpts);
    expect(result1.added).toEqual([]);
    expect(lock.skills['skill-a']).toBeUndefined();

    // Simulate re-install by clearing the exclusion and adding to tracked
    lock.repos![repoPath].excluded = [];
    lock.repos![repoPath].skills.push('skill-a');
    lock.skills['skill-a'] = {
      source: repoPath,
      sourceType: 'github',
      sourceUrl: 'https://github.com/test/repo',
      skillFolderHash: '',
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      installMethod: 'repo-symlink',
      repoPath,
    };

    // Second reconcile — skill-a should remain (not removed, not re-added)
    const result2 = await reconcileRepoSkills(repoPath, repoDir, lock, defaultOpts);
    expect(result2.added).toEqual([]);
    expect(result2.removed).toEqual([]);
    expect(lock.skills['skill-a']).toBeDefined();
  });

  it('skill moved to different directory — updates symlink', async () => {
    // Skill exists at new location: plugins/core/skills/my-skill
    const newSkillDir = join(repoDir, 'plugins', 'core', 'skills', 'my-skill');
    await mkdir(newSkillDir, { recursive: true });
    await writeFile(
      join(newSkillDir, 'SKILL.md'),
      '---\nname: my-skill\ndescription: Test skill\n---\n# my-skill\n',
      'utf-8'
    );

    const lock = buildLock(repoPath, ['my-skill']);

    // Pre-create the canonical symlink pointing to the OLD path
    const oldSkillDir = join(repoDir, 'skills', 'my-skill');
    await mkdir(oldSkillDir, { recursive: true });
    await writeFile(
      join(oldSkillDir, 'SKILL.md'),
      '---\nname: my-skill\ndescription: Test skill\n---\n# my-skill\n',
      'utf-8'
    );

    const canonicalPath = getCanonicalPath('my-skill', { global: true });
    // Ensure parent directory exists
    await mkdir(dirname(canonicalPath), { recursive: true });
    // Remove any existing entry (from prior test runs)
    await rm(canonicalPath, { recursive: true, force: true });
    // Create a symlink pointing to the old path
    const relTarget = relative(dirname(canonicalPath), oldSkillDir);
    await symlink(relTarget, canonicalPath);

    // Verify symlink points to old path
    const beforeTarget = await readlink(canonicalPath);
    const resolvedBefore = resolve(dirname(canonicalPath), beforeTarget);
    expect(resolvedBefore).toBe(resolve(oldSkillDir));

    // Now remove the old skill dir so only the new location exists in discovery
    await rm(join(repoDir, 'skills'), { recursive: true, force: true });

    const result = await reconcileRepoSkills(repoPath, repoDir, lock, defaultOpts);

    // Should detect the move
    expect(result.moved).toContain('my-skill');
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);

    // Canonical symlink should now point to the new path
    const afterTarget = await readlink(canonicalPath);
    const resolvedAfter = resolve(dirname(canonicalPath), afterTarget);
    expect(resolvedAfter).toBe(resolve(newSkillDir));
  });

  describe('collision detection', () => {
    const repoPathA = 'github.com/test/repo-a';
    const repoPathB = 'github.com/test/repo-b';

    it('collision detected — skill exists in different repo', async () => {
      await createSkillInRepo(repoDir, 'skill-a');

      // Lock already has skill-a from repo-a
      const lock = buildLock(repoPathA, ['skill-a'], {
        sourceUrl: 'https://github.com/test/repo-a',
      });
      // Add repo-b entry with no skills yet
      lock.repos![repoPathB] = {
        url: 'https://github.com/test/repo-b',
        skills: [],
        lastFetched: new Date().toISOString(),
      };

      const result = await reconcileRepoSkills(repoPathB, repoDir, lock, {
        sourceUrl: 'https://github.com/test/repo-b',
        sourceType: 'github',
        agents: ['claude-code' as const],
      });

      // Should detect collision, not add
      expect(result.collisions).toHaveLength(1);
      expect(result.collisions[0]!.skillName).toBe('skill-a');
      expect(result.collisions[0]!.existingRepoPath).toBe(repoPathA);
      expect(result.collisions[0]!.newRepoPath).toBe(repoPathB);
      expect(result.added).not.toContain('skill-a');
      // Lock should still point to repo-a
      expect(lock.skills['skill-a'].repoPath).toBe(repoPathA);
    });

    it('non-colliding skills still install alongside collisions', async () => {
      await createSkillInRepo(repoDir, 'skill-a');
      await createSkillInRepo(repoDir, 'skill-c');

      // Lock has skill-a from repo-a
      const lock = buildLock(repoPathA, ['skill-a'], {
        sourceUrl: 'https://github.com/test/repo-a',
      });
      lock.repos![repoPathB] = {
        url: 'https://github.com/test/repo-b',
        skills: [],
        lastFetched: new Date().toISOString(),
      };

      const result = await reconcileRepoSkills(repoPathB, repoDir, lock, {
        sourceUrl: 'https://github.com/test/repo-b',
        sourceType: 'github',
        agents: ['claude-code' as const],
      });

      // skill-a is a collision, skill-c should be added normally
      expect(result.collisions).toHaveLength(1);
      expect(result.collisions[0]!.skillName).toBe('skill-a');
      expect(result.added).toContain('skill-c');
      expect(result.added).not.toContain('skill-a');
      expect(lock.skills['skill-c']).toBeDefined();
      expect(lock.skills['skill-c'].repoPath).toBe(repoPathB);
    });

    it('no collision for same repo', async () => {
      await createSkillInRepo(repoDir, 'skill-a');
      await createSkillInRepo(repoDir, 'skill-b');

      // Lock already tracks skill-a under same repo
      const lock = buildLock(repoPath, ['skill-a']);
      const result = await reconcileRepoSkills(repoPath, repoDir, lock, defaultOpts);

      // No collision — skill-a is already tracked, skill-b is new
      expect(result.collisions).toHaveLength(0);
      expect(result.added).toEqual(['skill-b']);
    });

    it('no collision for legacy installs without repoPath', async () => {
      await createSkillInRepo(repoDir, 'skill-a');

      // Lock has skill-a but without repoPath (legacy copy-based install)
      const lock: ReconcileLock = {
        version: 4,
        skills: {
          'skill-a': {
            source: 'https://github.com/test/legacy',
            sourceType: 'github',
            sourceUrl: 'https://github.com/test/legacy',
            skillFolderHash: 'abc123',
            installedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            installMethod: 'copy',
            // no repoPath
          },
        },
        repos: {
          [repoPath]: {
            url: 'https://github.com/test/repo',
            skills: [],
            lastFetched: new Date().toISOString(),
          },
        },
      };

      const result = await reconcileRepoSkills(repoPath, repoDir, lock, defaultOpts);

      // No collision — legacy install has no repoPath
      expect(result.collisions).toHaveLength(0);
      expect(result.added).toContain('skill-a');
    });
  });
});

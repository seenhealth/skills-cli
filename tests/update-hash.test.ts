import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { reconcileRepoSkills } from '../src/reconcile.ts';
import type { ReconcileLock } from '../src/reconcile.ts';
import { getRepoHeadHash } from '../src/git.ts';

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
  opts: { headHash?: string } = {}
): ReconcileLock {
  const sourceUrl = 'https://github.com/test/repo';
  const now = new Date().toISOString();

  const skills: ReconcileLock['skills'] = {};
  for (const name of skillNames) {
    skills[name] = {
      source: repoPath,
      sourceType: 'github',
      sourceUrl,
      skillFolderHash: '',
      installedAt: now,
      updatedAt: now,
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
        skills: [...skillNames],
        lastFetched: now,
        headHash: opts.headHash,
      },
    },
  };
}

/**
 * Initialize a git repo with skills and return the HEAD hash.
 */
async function initGitRepo(repoDir: string, skillNames: string[]): Promise<string> {
  await mkdir(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'pipe' });

  for (const name of skillNames) {
    await createSkillInRepo(repoDir, name);
  }

  execSync('git add .', { cwd: repoDir, stdio: 'pipe' });
  execSync('git commit -m "initial"', { cwd: repoDir, stdio: 'pipe' });
  return execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf-8' }).trim();
}

describe('update hash-based change detection', () => {
  let tempDir: string;
  let repoDir: string;
  const repoPath = 'github.com/test/repo';
  const defaultOpts = {
    sourceUrl: 'https://github.com/test/repo',
    sourceType: 'github',
    agents: ['claude-code' as const],
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'update-hash-'));
    repoDir = join(tempDir, 'repo');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('no stored headHash — treats as changed (migration path)', async () => {
    const hash = await initGitRepo(repoDir, ['skill-a']);

    // Lock has no headHash (pre-migration state)
    const lock = buildLock(repoPath, ['skill-a']);
    const storedHash = lock.repos![repoPath].headHash;
    const currentHash = await getRepoHeadHash(repoDir);

    // Should be treated as changed since there's no stored hash
    const repoChanged = !storedHash || storedHash !== currentHash;
    expect(storedHash).toBeUndefined();
    expect(repoChanged).toBe(true);

    // Reconcile should still find no diffs since skills match
    const { added, removed } = await reconcileRepoSkills(repoPath, repoDir, lock, defaultOpts);
    expect(added).toEqual([]);
    expect(removed).toEqual([]);

    // After update, headHash should be stored
    lock.repos![repoPath].headHash = currentHash ?? undefined;
    expect(lock.repos![repoPath].headHash).toBe(hash);
  });

  it('stored hash matches current — no changes', async () => {
    const hash = await initGitRepo(repoDir, ['skill-a']);

    const lock = buildLock(repoPath, ['skill-a'], { headHash: hash });
    const currentHash = await getRepoHeadHash(repoDir);

    const repoChanged =
      !lock.repos![repoPath].headHash || lock.repos![repoPath].headHash !== currentHash;
    expect(repoChanged).toBe(false);
  });

  it('stored hash differs from current — detects repo change', async () => {
    await initGitRepo(repoDir, ['skill-a']);

    // Lock has a stale hash
    const lock = buildLock(repoPath, ['skill-a'], { headHash: 'stale-hash-from-before' });
    const currentHash = await getRepoHeadHash(repoDir);

    const repoChanged =
      !lock.repos![repoPath].headHash || lock.repos![repoPath].headHash !== currentHash;
    expect(repoChanged).toBe(true);
  });

  it('repo pulled externally with renamed skill — reconciles correctly', async () => {
    // Initial state: repo has "slack" skill
    const initialHash = await initGitRepo(repoDir, ['slack']);
    const lock = buildLock(repoPath, ['slack'], { headHash: initialHash });

    // Simulate external pull that renamed "slack" to "slack-extra"
    await rm(join(repoDir, 'skills', 'slack'), { recursive: true, force: true });
    await createSkillInRepo(repoDir, 'slack-extra');
    execSync('git add .', { cwd: repoDir, stdio: 'pipe' });
    execSync('git commit -m "rename slack to slack-extra"', { cwd: repoDir, stdio: 'pipe' });

    const currentHash = await getRepoHeadHash(repoDir);

    // Hash should differ — repo was updated externally
    const repoChanged = lock.repos![repoPath].headHash !== currentHash;
    expect(repoChanged).toBe(true);

    // Reconcile should detect the rename
    const { added, removed } = await reconcileRepoSkills(repoPath, repoDir, lock, defaultOpts);
    expect(removed).toEqual(['slack']);
    expect(added).toEqual(['slack-extra']);

    // Lock should be updated
    expect(lock.skills['slack']).toBeUndefined();
    expect(lock.skills['slack-extra']).toBeDefined();
    expect(lock.repos![repoPath].skills).toEqual(['slack-extra']);
  });

  it('repo pulled externally with no hash stored — still reconciles', async () => {
    // Initial state: lock tracks "slack" but has no headHash (migration scenario)
    await initGitRepo(repoDir, ['slack-extra']);

    // Lock was created before headHash existed, and repo was pulled externally
    // renaming "slack" → "slack-extra" — but pullRepo sees no change since
    // it was already pulled manually
    const lock = buildLock(repoPath, ['slack']); // no headHash

    const storedHash = lock.repos![repoPath].headHash;
    const currentHash = await getRepoHeadHash(repoDir);

    // No stored hash → always treated as changed
    const repoChanged = !storedHash || storedHash !== currentHash;
    expect(repoChanged).toBe(true);

    // Reconcile detects the rename even without git change detection
    const { added, removed } = await reconcileRepoSkills(repoPath, repoDir, lock, defaultOpts);
    expect(removed).toEqual(['slack']);
    expect(added).toEqual(['slack-extra']);
  });

  it('multiple skills — hash change triggers reconcile that finds new skill', async () => {
    const initialHash = await initGitRepo(repoDir, ['skill-a', 'skill-b']);
    const lock = buildLock(repoPath, ['skill-a', 'skill-b'], { headHash: initialHash });

    // Add a new skill to the repo
    await createSkillInRepo(repoDir, 'skill-c');
    execSync('git add .', { cwd: repoDir, stdio: 'pipe' });
    execSync('git commit -m "add skill-c"', { cwd: repoDir, stdio: 'pipe' });

    const currentHash = await getRepoHeadHash(repoDir);
    expect(currentHash).not.toBe(initialHash);

    const { added, removed } = await reconcileRepoSkills(repoPath, repoDir, lock, defaultOpts);
    expect(added).toEqual(['skill-c']);
    expect(removed).toEqual([]);
  });

  it('hash matches but lock is stale — reconcile still catches drift', async () => {
    // Edge case: hash somehow matches but lock has a skill that doesn't exist
    // (e.g. lock was manually edited, or a previous update was interrupted)
    const hash = await initGitRepo(repoDir, ['skill-a']);

    // Lock claims both skill-a and skill-b exist, but repo only has skill-a
    const lock = buildLock(repoPath, ['skill-a', 'skill-b'], { headHash: hash });
    const currentHash = await getRepoHeadHash(repoDir);

    // Hashes match — but that's ok, reconcile should still run
    const repoChanged = lock.repos![repoPath].headHash !== currentHash;
    expect(repoChanged).toBe(false);

    // Reconcile catches the drift regardless
    const { added, removed } = await reconcileRepoSkills(repoPath, repoDir, lock, defaultOpts);
    expect(removed).toEqual(['skill-b']);
    expect(added).toEqual([]);
  });
});

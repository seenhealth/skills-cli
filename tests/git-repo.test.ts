import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { normalizeGitUrl, getRepoCheckoutPath, getRepoHeadHash } from '../src/git.ts';

describe('normalizeGitUrl', () => {
  it('normalizes HTTPS GitHub URL', () => {
    expect(normalizeGitUrl('https://github.com/owner/repo.git')).toBe('github.com/owner/repo');
  });

  it('normalizes HTTPS GitHub URL without .git', () => {
    expect(normalizeGitUrl('https://github.com/owner/repo')).toBe('github.com/owner/repo');
  });

  it('normalizes SSH GitHub URL', () => {
    expect(normalizeGitUrl('git@github.com:owner/repo.git')).toBe('github.com/owner/repo');
  });

  it('normalizes SSH GitHub URL without .git', () => {
    expect(normalizeGitUrl('git@github.com:owner/repo')).toBe('github.com/owner/repo');
  });

  it('normalizes ssh:// protocol URL', () => {
    expect(normalizeGitUrl('ssh://git@github.com/owner/repo')).toBe('github.com/owner/repo');
  });

  it('normalizes git:// protocol URL', () => {
    expect(normalizeGitUrl('git://github.com/owner/repo.git')).toBe('github.com/owner/repo');
  });

  it('normalizes GitLab URL', () => {
    expect(normalizeGitUrl('https://gitlab.com/group/subgroup/repo.git')).toBe(
      'gitlab.com/group/subgroup/repo'
    );
  });

  it('strips trailing slashes', () => {
    expect(normalizeGitUrl('https://github.com/owner/repo/')).toBe('github.com/owner/repo');
  });

  it('handles URL with http://', () => {
    expect(normalizeGitUrl('http://github.com/owner/repo.git')).toBe('github.com/owner/repo');
  });
});

describe('getRepoCheckoutPath', () => {
  const originalEnv = process.env.SKILLS_REPOS_DIR;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SKILLS_REPOS_DIR;
    } else {
      process.env.SKILLS_REPOS_DIR = originalEnv;
    }
  });

  it('returns path under default repos dir', () => {
    delete process.env.SKILLS_REPOS_DIR;
    const result = getRepoCheckoutPath('https://github.com/owner/repo.git');
    expect(result).toBe(join(homedir(), '.agents', 'repos', 'github.com', 'owner', 'repo'));
  });

  it('appends ref when provided', () => {
    delete process.env.SKILLS_REPOS_DIR;
    const result = getRepoCheckoutPath('https://github.com/owner/repo.git', 'v2.0');
    expect(result).toBe(join(homedir(), '.agents', 'repos', 'github.com', 'owner', 'repo@v2.0'));
  });

  it('uses custom repos dir from env', () => {
    process.env.SKILLS_REPOS_DIR = '/custom/repos';
    const result = getRepoCheckoutPath('https://github.com/owner/repo.git');
    expect(result).toBe(join('/custom/repos', 'github.com', 'owner', 'repo'));
  });
});

describe('getRepoHeadHash', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'git-hash-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns HEAD hash for a valid git repo', async () => {
    // Initialize a real git repo with a commit
    execSync('git init', { cwd: tempDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'pipe' });
    await writeFile(join(tempDir, 'file.txt'), 'hello', 'utf-8');
    execSync('git add .', { cwd: tempDir, stdio: 'pipe' });
    execSync('git commit -m "initial"', { cwd: tempDir, stdio: 'pipe' });

    const expectedHash = execSync('git rev-parse HEAD', { cwd: tempDir, encoding: 'utf-8' }).trim();
    const hash = await getRepoHeadHash(tempDir);

    expect(hash).toBe(expectedHash);
    expect(hash).toMatch(/^[a-f0-9]{40}$/);
  });

  it('returns a different hash after a new commit', async () => {
    execSync('git init', { cwd: tempDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'pipe' });
    await writeFile(join(tempDir, 'file.txt'), 'hello', 'utf-8');
    execSync('git add .', { cwd: tempDir, stdio: 'pipe' });
    execSync('git commit -m "first"', { cwd: tempDir, stdio: 'pipe' });

    const hash1 = await getRepoHeadHash(tempDir);

    await writeFile(join(tempDir, 'file.txt'), 'world', 'utf-8');
    execSync('git add .', { cwd: tempDir, stdio: 'pipe' });
    execSync('git commit -m "second"', { cwd: tempDir, stdio: 'pipe' });

    const hash2 = await getRepoHeadHash(tempDir);

    expect(hash1).not.toBe(hash2);
  });

  it('returns null for a non-git directory', async () => {
    const hash = await getRepoHeadHash(tempDir);
    expect(hash).toBeNull();
  });

  it('returns null for a non-existent directory', async () => {
    const hash = await getRepoHeadHash(join(tempDir, 'does-not-exist'));
    expect(hash).toBeNull();
  });
});

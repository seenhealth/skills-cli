import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { normalizeGitUrl, getRepoCheckoutPath } from '../src/git.ts';

describe('normalizeGitUrl', () => {
  it('normalizes HTTPS GitHub URL', () => {
    expect(normalizeGitUrl('https://github.com/owner/repo.git')).toBe(
      'github.com/owner/repo'
    );
  });

  it('normalizes HTTPS GitHub URL without .git', () => {
    expect(normalizeGitUrl('https://github.com/owner/repo')).toBe(
      'github.com/owner/repo'
    );
  });

  it('normalizes SSH GitHub URL', () => {
    expect(normalizeGitUrl('git@github.com:owner/repo.git')).toBe(
      'github.com/owner/repo'
    );
  });

  it('normalizes SSH GitHub URL without .git', () => {
    expect(normalizeGitUrl('git@github.com:owner/repo')).toBe(
      'github.com/owner/repo'
    );
  });

  it('normalizes ssh:// protocol URL', () => {
    expect(normalizeGitUrl('ssh://git@github.com/owner/repo')).toBe(
      'github.com/owner/repo'
    );
  });

  it('normalizes git:// protocol URL', () => {
    expect(normalizeGitUrl('git://github.com/owner/repo.git')).toBe(
      'github.com/owner/repo'
    );
  });

  it('normalizes GitLab URL', () => {
    expect(normalizeGitUrl('https://gitlab.com/group/subgroup/repo.git')).toBe(
      'gitlab.com/group/subgroup/repo'
    );
  });

  it('strips trailing slashes', () => {
    expect(normalizeGitUrl('https://github.com/owner/repo/')).toBe(
      'github.com/owner/repo'
    );
  });

  it('handles URL with http://', () => {
    expect(normalizeGitUrl('http://github.com/owner/repo.git')).toBe(
      'github.com/owner/repo'
    );
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
    expect(result).toBe(
      join(homedir(), '.agents', 'repos', 'github.com', 'owner', 'repo')
    );
  });

  it('appends ref when provided', () => {
    delete process.env.SKILLS_REPOS_DIR;
    const result = getRepoCheckoutPath('https://github.com/owner/repo.git', 'v2.0');
    expect(result).toBe(
      join(homedir(), '.agents', 'repos', 'github.com', 'owner', 'repo@v2.0')
    );
  });

  it('uses custom repos dir from env', () => {
    process.env.SKILLS_REPOS_DIR = '/custom/repos';
    const result = getRepoCheckoutPath('https://github.com/owner/repo.git');
    expect(result).toBe(join('/custom/repos', 'github.com', 'owner', 'repo'));
  });
});

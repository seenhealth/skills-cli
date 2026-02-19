import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readlink, lstat, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { installSkillFromRepoForAgent } from '../src/installer.ts';
import type { Skill } from '../src/types.ts';

describe('installSkillFromRepoForAgent', () => {
  let tempDir: string;
  let repoSkillDir: string;
  let agentBase: string;
  let canonicalBase: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'installer-repo-'));

    // Simulate a repo checkout with a skill
    repoSkillDir = join(tempDir, 'repo', 'skills', 'test-skill');
    await mkdir(repoSkillDir, { recursive: true });
    await writeFile(
      join(repoSkillDir, 'SKILL.md'),
      '---\nname: test-skill\ndescription: A test skill\n---\n# Test Skill\n',
      'utf-8'
    );
    await writeFile(join(repoSkillDir, 'helper.md'), '# Helper', 'utf-8');

    // Create agent and canonical dirs
    agentBase = join(tempDir, '.claude', 'skills');
    canonicalBase = join(tempDir, '.agents', 'skills');
    await mkdir(agentBase, { recursive: true });
    await mkdir(canonicalBase, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates symlink from canonical to repo skill dir', async () => {
    const skill: Skill = {
      name: 'test-skill',
      description: 'A test skill',
      path: repoSkillDir,
    };

    const result = await installSkillFromRepoForAgent(skill, 'claude-code', {
      global: false,
      cwd: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.mode).toBe('symlink');

    // The canonical dir should be a symlink
    const canonicalDir = join(canonicalBase, 'test-skill');
    const stats = await lstat(canonicalDir);
    expect(stats.isSymbolicLink()).toBe(true);

    // Reading the SKILL.md should work through the symlink
    const content = await readFile(join(canonicalDir, 'SKILL.md'), 'utf-8');
    expect(content).toContain('test-skill');

    // Helper file should also be accessible (no exclusion filter with symlinks)
    const helperContent = await readFile(join(canonicalDir, 'helper.md'), 'utf-8');
    expect(helperContent).toContain('Helper');
  });

  it('creates agent symlink to canonical dir', async () => {
    const skill: Skill = {
      name: 'test-skill',
      description: 'A test skill',
      path: repoSkillDir,
    };

    const result = await installSkillFromRepoForAgent(skill, 'claude-code', {
      global: false,
      cwd: tempDir,
    });

    expect(result.success).toBe(true);

    // The agent dir should be a symlink to canonical
    const agentDir = join(agentBase, 'test-skill');
    const stats = await lstat(agentDir);
    expect(stats.isSymbolicLink()).toBe(true);

    // Should be able to read the skill through the full chain
    const content = await readFile(join(agentDir, 'SKILL.md'), 'utf-8');
    expect(content).toContain('test-skill');
  });

  it('uses copy mode when requested', async () => {
    const skill: Skill = {
      name: 'test-skill',
      description: 'A test skill',
      path: repoSkillDir,
    };

    const result = await installSkillFromRepoForAgent(skill, 'claude-code', {
      global: false,
      cwd: tempDir,
      mode: 'copy',
    });

    expect(result.success).toBe(true);
    expect(result.mode).toBe('copy');

    // The agent dir should NOT be a symlink
    const agentDir = join(agentBase, 'test-skill');
    const stats = await lstat(agentDir);
    expect(stats.isSymbolicLink()).toBe(false);
    expect(stats.isDirectory()).toBe(true);

    // SKILL.md should be copied
    const content = await readFile(join(agentDir, 'SKILL.md'), 'utf-8');
    expect(content).toContain('test-skill');
  });

  it('sanitizes skill name', async () => {
    const skill: Skill = {
      name: '../evil-traversal',
      description: 'A test skill',
      path: repoSkillDir,
    };

    const result = await installSkillFromRepoForAgent(skill, 'claude-code', {
      global: false,
      cwd: tempDir,
    });

    // Should succeed but with a sanitized name
    expect(result.success).toBe(true);
    // The path should not contain the traversal attempt
    expect(result.path).not.toContain('..');
  });

  it('replaces existing copy with symlink', async () => {
    const skill: Skill = {
      name: 'test-skill',
      description: 'A test skill',
      path: repoSkillDir,
    };

    // First install as copy (using regular installSkillForAgent behavior)
    const canonicalDir = join(canonicalBase, 'test-skill');
    await mkdir(canonicalDir, { recursive: true });
    await writeFile(join(canonicalDir, 'SKILL.md'), 'old content', 'utf-8');

    // Now install from repo (should replace with symlink)
    const result = await installSkillFromRepoForAgent(skill, 'claude-code', {
      global: false,
      cwd: tempDir,
    });

    expect(result.success).toBe(true);

    // Canonical should now be a symlink
    const stats = await lstat(canonicalDir);
    expect(stats.isSymbolicLink()).toBe(true);
  });
});

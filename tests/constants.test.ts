import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';
import { AGENTS_DIR, SKILLS_SUBDIR, REPOS_SUBDIR, UNIVERSAL_SKILLS_DIR, getReposDir } from '../src/constants.ts';

describe('constants', () => {
  it('exports expected directory constants', () => {
    expect(AGENTS_DIR).toBe('.agents');
    expect(SKILLS_SUBDIR).toBe('skills');
    expect(REPOS_SUBDIR).toBe('repos');
    expect(UNIVERSAL_SKILLS_DIR).toBe('.agents/skills');
  });

  describe('getReposDir', () => {
    const originalEnv = process.env.SKILLS_REPOS_DIR;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.SKILLS_REPOS_DIR;
      } else {
        process.env.SKILLS_REPOS_DIR = originalEnv;
      }
    });

    it('returns default path when env var is not set', () => {
      delete process.env.SKILLS_REPOS_DIR;
      expect(getReposDir()).toBe(join(homedir(), '.agents', 'repos'));
    });

    it('returns env var value when SKILLS_REPOS_DIR is set', () => {
      process.env.SKILLS_REPOS_DIR = '/custom/repos/path';
      expect(getReposDir()).toBe('/custom/repos/path');
    });
  });
});

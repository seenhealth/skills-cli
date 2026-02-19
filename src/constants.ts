import { join } from 'path';
import { homedir } from 'os';

export const AGENTS_DIR = '.agents';
export const SKILLS_SUBDIR = 'skills';
export const REPOS_SUBDIR = 'repos';
export const UNIVERSAL_SKILLS_DIR = '.agents/skills';

/**
 * Get the directory for persistent repo checkouts.
 * Checks SKILLS_REPOS_DIR env var, then defaults to ~/.agents/repos/
 */
export function getReposDir(): string {
  if (process.env.SKILLS_REPOS_DIR) {
    return process.env.SKILLS_REPOS_DIR;
  }
  return join(homedir(), AGENTS_DIR, REPOS_SUBDIR);
}

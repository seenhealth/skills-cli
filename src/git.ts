import simpleGit from 'simple-git';
import { join, normalize, resolve, sep } from 'path';
import { mkdtemp, rm, access, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { getReposDir } from './constants.ts';

const CLONE_TIMEOUT_MS = 60000; // 60 seconds

export class GitCloneError extends Error {
  readonly url: string;
  readonly isTimeout: boolean;
  readonly isAuthError: boolean;

  constructor(message: string, url: string, isTimeout = false, isAuthError = false) {
    super(message);
    this.name = 'GitCloneError';
    this.url = url;
    this.isTimeout = isTimeout;
    this.isAuthError = isAuthError;
  }
}

export async function cloneRepo(url: string, ref?: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'skills-'));
  const git = simpleGit({ timeout: { block: CLONE_TIMEOUT_MS } });
  const cloneOptions = ref ? ['--depth', '1', '--branch', ref] : ['--depth', '1'];

  try {
    await git.clone(url, tempDir, cloneOptions);
    return tempDir;
  } catch (error) {
    // Clean up temp dir on failure
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});

    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimeout = errorMessage.includes('block timeout') || errorMessage.includes('timed out');
    const isAuthError =
      errorMessage.includes('Authentication failed') ||
      errorMessage.includes('could not read Username') ||
      errorMessage.includes('Permission denied') ||
      errorMessage.includes('Repository not found');

    if (isTimeout) {
      throw new GitCloneError(
        `Clone timed out after 60s. This often happens with private repos that require authentication.\n` +
          `  Ensure you have access and your SSH keys or credentials are configured:\n` +
          `  - For SSH: ssh-add -l (to check loaded keys)\n` +
          `  - For HTTPS: gh auth status (if using GitHub CLI)`,
        url,
        true,
        false
      );
    }

    if (isAuthError) {
      throw new GitCloneError(
        `Authentication failed for ${url}.\n` +
          `  - For private repos, ensure you have access\n` +
          `  - For SSH: Check your keys with 'ssh -T git@github.com'\n` +
          `  - For HTTPS: Run 'gh auth login' or configure git credentials`,
        url,
        false,
        true
      );
    }

    throw new GitCloneError(`Failed to clone ${url}: ${errorMessage}`, url, false, false);
  }
}

export async function cleanupTempDir(dir: string): Promise<void> {
  // Validate that the directory path is within tmpdir to prevent deletion of arbitrary paths
  const normalizedDir = normalize(resolve(dir));
  const normalizedTmpDir = normalize(resolve(tmpdir()));

  if (!normalizedDir.startsWith(normalizedTmpDir + sep) && normalizedDir !== normalizedTmpDir) {
    throw new Error('Attempted to clean up directory outside of temp directory');
  }

  await rm(dir, { recursive: true, force: true });
}

// ─── Persistent Repo Management ───

/**
 * Normalize a git URL to a filesystem-safe path.
 * - https://github.com/owner/repo.git → github.com/owner/repo
 * - git@github.com:owner/repo.git → github.com/owner/repo
 * - ssh://git@github.com/owner/repo → github.com/owner/repo
 */
export function normalizeGitUrl(url: string): string {
  let normalized = url;

  // Handle SSH URLs: git@github.com:owner/repo.git
  const sshMatch = normalized.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    normalized = `${sshMatch[1]}/${sshMatch[2]}`;
  }

  // Handle protocol prefixes: https://, ssh://, git://
  normalized = normalized.replace(/^(?:https?|ssh|git):\/\//, '');

  // Remove userinfo (e.g., git@)
  normalized = normalized.replace(/^[^@]+@/, '');

  // Remove .git suffix
  normalized = normalized.replace(/\.git$/, '');

  // Remove trailing slashes
  normalized = normalized.replace(/\/+$/, '');

  return normalized;
}

/**
 * Get the local checkout path for a repo.
 * Returns ~/.agents/repos/<normalized> or ~/.agents/repos/<normalized>@<ref> if ref is specified.
 */
export function getRepoCheckoutPath(url: string, ref?: string): string {
  const normalized = normalizeGitUrl(url);
  return join(getReposDir(), ref ? `${normalized}@${ref}` : normalized);
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a repo is checked out and up to date.
 * - If the repo already exists locally, fetches and updates.
 * - If not, clones it with blobless filter for space efficiency.
 * Returns the local checkout path.
 */
export async function ensureRepoCheckout(url: string, options?: { ref?: string }): Promise<string> {
  const checkoutPath = getRepoCheckoutPath(url, options?.ref);

  if (await dirExists(join(checkoutPath, '.git'))) {
    const git = simpleGit(checkoutPath, { timeout: { block: CLONE_TIMEOUT_MS } });
    try {
      await git.fetch(['origin']);
      if (options?.ref) {
        await git.checkout(options.ref);
        try {
          await git.pull('origin', options.ref);
        } catch {
          // Detached HEAD or tag — checkout is sufficient
        }
      } else {
        await git.pull();
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isAuthError =
        errorMessage.includes('Authentication failed') ||
        errorMessage.includes('could not read Username') ||
        errorMessage.includes('Permission denied') ||
        errorMessage.includes('Repository not found');
      if (isAuthError) {
        throw new GitCloneError(`Authentication failed for ${url}.`, url, false, true);
      }
      // Network errors are acceptable — use existing checkout
    }
    return checkoutPath;
  }

  await mkdir(checkoutPath, { recursive: true });
  const git = simpleGit({ timeout: { block: CLONE_TIMEOUT_MS } });
  const cloneOptions = ['--filter=blob:none'];
  if (options?.ref) {
    cloneOptions.push('--branch', options.ref);
  }

  try {
    await git.clone(url, checkoutPath, cloneOptions);
    return checkoutPath;
  } catch (error) {
    // Clean up on failure
    await rm(checkoutPath, { recursive: true, force: true }).catch(() => {});

    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimeout = errorMessage.includes('block timeout') || errorMessage.includes('timed out');
    const isAuthError =
      errorMessage.includes('Authentication failed') ||
      errorMessage.includes('could not read Username') ||
      errorMessage.includes('Permission denied') ||
      errorMessage.includes('Repository not found');

    if (isTimeout) {
      throw new GitCloneError(
        `Clone timed out after 60s. This often happens with private repos that require authentication.\n` +
          `  Ensure you have access and your SSH keys or credentials are configured:\n` +
          `  - For SSH: ssh-add -l (to check loaded keys)\n` +
          `  - For HTTPS: gh auth status (if using GitHub CLI)`,
        url,
        true,
        false
      );
    }

    if (isAuthError) {
      throw new GitCloneError(
        `Authentication failed for ${url}.\n` +
          `  - For private repos, ensure you have access\n` +
          `  - For SSH: Check your keys with 'ssh -T git@github.com'\n` +
          `  - For HTTPS: Run 'gh auth login' or configure git credentials`,
        url,
        false,
        true
      );
    }

    throw new GitCloneError(`Failed to clone ${url}: ${errorMessage}`, url, false, false);
  }
}

/**
 * Pull latest changes for a persistent repo checkout.
 */
export async function pullRepo(repoDir: string): Promise<void> {
  const git = simpleGit(repoDir, { timeout: { block: CLONE_TIMEOUT_MS } });

  try {
    await git.fetch(['origin']);
    await git.pull();
  } catch {
    // If pull fails, repo is still usable locally
  }
}

/**
 * Get the current HEAD hash of a repo checkout.
 */
export async function getRepoHeadHash(repoDir: string): Promise<string | null> {
  try {
    const git = simpleGit(repoDir, { timeout: { block: CLONE_TIMEOUT_MS } });
    return (await git.revparse(['HEAD'])).trim();
  } catch {
    return null;
  }
}

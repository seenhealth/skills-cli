import { readlink, rm } from 'fs/promises';
import { dirname, resolve } from 'path';
import { agents } from './agents.ts';
import { getCanonicalPath, installSkillFromRepoForAgent } from './installer.ts';
import { discoverSkills } from './skills.ts';
import type { AgentType } from './types.ts';

/**
 * Minimal lock interfaces matching the shape used by cli.ts's synchronous types.
 * Avoids coupling to either cli.ts's sync types or skill-lock.ts's async types.
 */
export interface ReconcileLockEntry {
  source: string;
  sourceType: string;
  sourceUrl: string;
  skillPath?: string;
  skillFolderHash: string;
  installedAt: string;
  updatedAt: string;
  ref?: string;
  installMethod?: 'repo-symlink' | 'copy';
  repoPath?: string;
}

export interface ReconcileRepoEntry {
  url: string;
  ref?: string;
  skills: string[];
  lastFetched: string;
  headHash?: string;
  excluded?: string[];
}

export interface ReconcileLock {
  version: number;
  skills: Record<string, ReconcileLockEntry>;
  repos?: Record<string, ReconcileRepoEntry>;
}

export interface SkillCollision {
  skillName: string;
  existingRepoPath: string;
  existingSourceUrl: string;
  newRepoPath: string;
  newSourceUrl: string;
}

export interface ReconcileResult {
  added: string[];
  removed: string[];
  moved: string[];
  collisions: SkillCollision[];
}

/**
 * Reconcile lock file entries with actual skills discovered in a repo checkout.
 * Detects skills that were added, removed, or renamed since last install/update.
 *
 * Mutates `lock` in place (caller is responsible for persisting).
 */
export async function reconcileRepoSkills(
  repoPath: string,
  repoCheckoutPath: string,
  lock: ReconcileLock,
  options: {
    sourceUrl: string;
    sourceType: string;
    ref?: string;
    agents: AgentType[];
    /** When true, only reconcile tracked skills (removals/moves) — do not add new ones. */
    skipNewSkills?: boolean;
  }
): Promise<ReconcileResult> {
  // 1. Get tracked skill names from lock
  const trackedSkills = lock.repos?.[repoPath]?.skills ?? [];

  // 2. Discover actual skills in the repo checkout
  const discoveredSkills = await discoverSkills(repoCheckoutPath, undefined, {
    fullDepth: true,
  });
  const discoveredNames = new Set(discoveredSkills.map((s) => s.name));

  // 3. Compute diff
  const trackedSet = new Set(trackedSkills);
  const excludedSet = new Set(lock.repos?.[repoPath]?.excluded ?? []);
  const removed = trackedSkills.filter((name) => !discoveredNames.has(name));
  const added = options.skipNewSkills
    ? []
    : discoveredSkills
        .filter((s) => !trackedSet.has(s.name) && !excludedSet.has(s.name))
        .map((s) => s.name);

  // 4. Handle removed skills
  for (const skillName of removed) {
    // Remove canonical symlink
    try {
      const canonicalPath = getCanonicalPath(skillName, { global: true });
      await rm(canonicalPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    // Remove agent symlinks
    for (const agentType of options.agents) {
      const agent = agents[agentType];
      if (agent.globalSkillsDir) {
        try {
          const agentSkillDir = `${agent.globalSkillsDir}/${skillName}`;
          await rm(agentSkillDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    // Remove from lock.skills
    delete lock.skills[skillName];

    // Remove from lock.repos[repoPath].skills
    if (lock.repos?.[repoPath]) {
      lock.repos[repoPath].skills = lock.repos[repoPath].skills.filter((s) => s !== skillName);
    }
  }

  // 5. Handle added skills
  const collisions: SkillCollision[] = [];
  const installedAdded: string[] = [];
  const now = new Date().toISOString();
  for (const skillName of added) {
    // Check for collision: skill exists in lock under a different repo
    const existing = lock.skills[skillName];
    if (existing?.repoPath && existing.repoPath !== repoPath) {
      collisions.push({
        skillName,
        existingRepoPath: existing.repoPath,
        existingSourceUrl: existing.sourceUrl,
        newRepoPath: repoPath,
        newSourceUrl: options.sourceUrl,
      });
      continue;
    }

    const skill = discoveredSkills.find((s) => s.name === skillName)!;

    // Install for each agent
    for (const agentType of options.agents) {
      await installSkillFromRepoForAgent(skill, agentType, { global: true });
    }

    // Add to lock.skills
    lock.skills[skillName] = {
      source: repoPath,
      sourceType: options.sourceType,
      sourceUrl: options.sourceUrl,
      skillFolderHash: '',
      installedAt: now,
      updatedAt: now,
      ref: options.ref,
      installMethod: 'repo-symlink',
      repoPath,
    };

    // Add to lock.repos[repoPath].skills
    if (lock.repos?.[repoPath]) {
      if (!lock.repos[repoPath].skills.includes(skillName)) {
        lock.repos[repoPath].skills.push(skillName);
      }
    }

    installedAdded.push(skillName);
  }

  // 6. Handle moved skills (same name, different path in repo)
  const moved: string[] = [];
  for (const skill of discoveredSkills) {
    if (trackedSet.has(skill.name) && !removed.includes(skill.name)) {
      const canonicalPath = getCanonicalPath(skill.name, { global: true });
      try {
        const currentTarget = await readlink(canonicalPath);
        const resolvedCurrent = resolve(dirname(canonicalPath), currentTarget);
        const resolvedNew = resolve(skill.path);
        if (resolvedCurrent !== resolvedNew) {
          // Skill moved — reinstall to update symlink
          for (const agentType of options.agents) {
            await installSkillFromRepoForAgent(skill, agentType, {
              global: true,
            });
          }
          moved.push(skill.name);
        }
      } catch {
        // Symlink doesn't exist or can't be read — reinstall
        for (const agentType of options.agents) {
          await installSkillFromRepoForAgent(skill, agentType, { global: true });
        }
        moved.push(skill.name);
      }
    }
  }

  return { added: installedAdded, removed, moved, collisions };
}

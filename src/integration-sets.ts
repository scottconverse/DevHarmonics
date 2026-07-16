import path from "node:path";
import {
  WorktreeManager,
  type WorktreePreflight,
  type WorktreeStatus,
} from "./worktrees.js";

export interface IntegrationRepository {
  repositoryId: string;
  projectPath: string;
}

export interface IntegrationRepositoryPreflight extends WorktreePreflight {
  repositoryId: string;
}

export interface IntegrationRepositoryStatus extends WorktreeStatus {
  repositoryId: string;
}

interface ManagedRepository {
  repositoryId: string;
  manager: WorktreeManager;
}

export class IntegrationSetManager {
  private readonly repositories: ManagedRepository[];
  private readonly managers = new Map<string, WorktreeManager>();

  constructor(runId: string, repositories: readonly IntegrationRepository[]) {
    if (repositories.length === 0) throw new Error("An integration set requires at least one repository");

    const localRoots = new Map<string, string>();
    this.repositories = repositories.map((repository) => {
      const repositoryId = repository.repositoryId.trim();
      if (!repositoryId) throw new Error("Integration repository IDs cannot be empty");
      if (this.managers.has(repositoryId)) {
        throw new Error(`Duplicate integration repository ID '${repositoryId}'`);
      }

      const projectPath = path.resolve(repository.projectPath);
      const rootKey = comparablePath(projectPath);
      const existingRepositoryId = localRoots.get(rootKey);
      if (existingRepositoryId) {
        throw new Error(`Integration repositories '${existingRepositoryId}' and '${repositoryId}' resolve to the same local root`);
      }

      const manager = new WorktreeManager(projectPath, runId, repositoryId);
      this.managers.set(repositoryId, manager);
      localRoots.set(rootKey, repositoryId);
      return { repositoryId, manager };
    });
  }

  manager(repositoryId: string): WorktreeManager {
    const manager = this.managers.get(repositoryId);
    if (!manager) throw new Error(`Repository '${repositoryId}' is not part of this integration set`);
    return manager;
  }

  async preflight(): Promise<IntegrationRepositoryPreflight[]> {
    const results = await Promise.all(this.repositories.map(async ({ repositoryId, manager }) => ({
      repositoryId,
      ...await manager.preflight(),
    })));

    const roots = new Map<string, string>();
    for (const result of results) {
      const rootKey = comparablePath(result.repositoryRoot);
      const existingRepositoryId = roots.get(rootKey);
      if (existingRepositoryId) {
        throw new Error(
          `Integration repositories '${existingRepositoryId}' and '${result.repositoryId}' resolve to the same Git root`,
        );
      }
      roots.set(rootKey, result.repositoryId);
    }
    return results;
  }

  async initialize(): Promise<void> {
    const verified = await this.preflight();
    for (const repository of verified) {
      await this.manager(repository.repositoryId).initialize(repository);
    }
  }

  async status(): Promise<IntegrationRepositoryStatus[]> {
    return Promise.all(this.repositories.map(async ({ repositoryId, manager }) => ({
      repositoryId,
      ...await manager.status(),
    })));
  }
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

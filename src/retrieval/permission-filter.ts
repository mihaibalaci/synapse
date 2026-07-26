/**
 * Permission Filter
 *
 * Ensures users only see knowledge they are authorized to access.
 * Applied after candidate retrieval but before final ranking.
 *
 * Enforcement levels:
 *   1. Pre-filter: metadata filter in vector search query (fast, reduces candidate set)
 *   2. Post-filter: explicit ACL check on final results (guarantees correctness)
 *
 * Classification levels:
 *   - public: visible to entire organization
 *   - internal: visible to specified teams
 *   - confidential: visible to owner + specified individuals
 *   - restricted: visible only to owner + explicit grants
 */

import { createChildLogger } from '../utils/logger.js';
import { type Chunk } from '../models/index.js';

const logger = createChildLogger({ module: 'permission-filter' });

// ─── Permission Context ──────────────────────────────────────────────────────

export interface PermissionContext {
  userId: string;
  organizationId: string;
  teamIds?: string[];
  roles?: string[];
  repositoryAccess?: string[];
}

// ─── Permission Filter ───────────────────────────────────────────────────────

export class PermissionFilter {
  /**
   * Filter candidates based on user permissions.
   * Removes any candidates the user is not authorized to see.
   */
  async filter<T extends { chunk: Chunk }>(
    candidates: T[],
    context: PermissionContext,
  ): Promise<T[]> {
    const startCount = candidates.length;

    const filtered = candidates.filter(candidate => {
      return this.checkAccess(candidate.chunk, context);
    });

    const removedCount = startCount - filtered.length;
    if (removedCount > 0) {
      logger.debug({
        userId: context.userId,
        removed: removedCount,
        remaining: filtered.length,
      }, 'Permission filter applied');
    }

    return filtered;
  }

  /**
   * Check if a user has access to a specific chunk.
   */
  private checkAccess(chunk: Chunk, context: PermissionContext): boolean {
    if (chunk.organizationId !== context.organizationId) return false;
    if (context.roles?.includes('admin')) return true;
    if (chunk.authorId === context.userId) return true;

    const acl = chunk.acl;
    if (!acl) {
      if (chunk.teamId && !context.teamIds?.includes(chunk.teamId)) return false;
      if (chunk.repository && context.repositoryAccess?.length
        && !context.repositoryAccess.includes(chunk.repository)) return false;
      return true;
    }

    if (acl.organizationId !== context.organizationId || !acl.discoverable) return false;
    const explicitGrant = acl.sharedWith.some(grant => grant.userId === context.userId);
    if (explicitGrant) return true;

    const teamMatch = acl.teamIds.length === 0
      || acl.teamIds.some(teamId => context.teamIds?.includes(teamId));
    const repositoryMatch = acl.repositoryIds.length === 0
      || acl.repositoryIds.some(repository => context.repositoryAccess?.includes(repository));

    switch (acl.classification) {
      case 'public':
        return true;
      case 'internal':
        return teamMatch && repositoryMatch;
      case 'confidential':
        return Boolean(context.roles?.includes('team_lead') && teamMatch && repositoryMatch);
      case 'restricted':
        return false;
    }
  }

  /**
   * Build pre-filter conditions for vector search.
   * These are applied IN the database query for efficiency.
   */
  buildPreFilter(context: PermissionContext): {
    organizationId: string;
    excludeClassifications?: string[];
  } {
    return {
      organizationId: context.organizationId,
      // Don't show restricted content in search results unless explicitly granted
      excludeClassifications: ['restricted'],
    };
  }

  /**
   * Check if a user can modify/endorse a knowledge record.
   * More restrictive than read access.
   */
  canModify(chunk: Chunk, context: PermissionContext): boolean {
    // Only owner or team leads can modify
    if (chunk.authorId === context.userId) return true;
    if (context.roles?.includes('team_lead') || context.roles?.includes('admin')) return true;
    return false;
  }

  /**
   * Check if a user can delete a chunk.
   * Most restrictive permission level.
   */
  canDelete(chunk: Chunk, context: PermissionContext): boolean {
    // Only owner or admin
    if (chunk.authorId === context.userId) return true;
    if (context.roles?.includes('admin')) return true;
    return false;
  }
}

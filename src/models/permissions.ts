/**
 * Permissions & Access Control Models
 *
 * Every chunk and knowledge record has an ACL that controls
 * who can see it. This module defines the access control structures
 * and the query-time permission evaluation logic.
 */

import { z } from 'zod';

// ─── Security Classification ─────────────────────────────────────────────────

export const SecurityClassification = z.enum([
  'public',          // Visible to entire organization
  'internal',        // Visible to specified teams
  'confidential',    // Visible to specified individuals + team leads
  'restricted',      // Visible only to owner + explicit grants
]);
export type SecurityClassification = z.infer<typeof SecurityClassification>;

// ─── Access Control List ─────────────────────────────────────────────────────

export const ACLSchema = z.object({
  /** Owner always has full access */
  ownerId: z.string(),

  /** Organization scope (required — multi-tenant isolation) */
  organizationId: z.string(),

  /** Team-level access */
  teamIds: z.array(z.string()).default([]),

  /** Repository-level access (inherits repo permissions) */
  repositoryIds: z.array(z.string()).default([]),

  /** Individual grants */
  sharedWith: z.array(z.object({
    userId: z.string(),
    grantedAt: z.string().datetime(),
    grantedBy: z.string(),
    permission: z.enum(['read', 'write', 'admin']),
  })).default([]),

  /** Classification level */
  classification: SecurityClassification,

  /** Whether this can appear in org-wide search results */
  discoverable: z.boolean().default(true),

  /** PII/secret flags */
  containsPII: z.boolean().default(false),
  containsSecrets: z.boolean().default(false),
  redacted: z.boolean().default(false),
});
export type ACL = z.infer<typeof ACLSchema>;

// ─── Permission Check Request ────────────────────────────────────────────────

export const PermissionCheckSchema = z.object({
  userId: z.string(),
  organizationId: z.string(),
  teamIds: z.array(z.string()),        // Teams the user belongs to
  roles: z.array(z.string()),          // e.g. ['developer', 'team_lead']
  repositoryAccess: z.array(z.string()), // Repos user has access to
});
export type PermissionCheck = z.infer<typeof PermissionCheckSchema>;

// ─── Governance Policy ───────────────────────────────────────────────────────

export const GovernancePolicySchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string(),
  name: z.string(),

  /** Retention */
  retentionDays: z.number().int().optional(),   // Auto-archive after N days
  retentionPolicy: z.enum(['keep', 'archive', 'delete']).default('keep'),

  /** Content rules */
  requirePIIScan: z.boolean().default(true),
  requireSecretScan: z.boolean().default(true),
  autoRedactSecrets: z.boolean().default(true),
  blockExternalSharing: z.boolean().default(false),

  /** Quality gates */
  requireValidation: z.boolean().default(false),   // Must be validated before searchable
  minQualityScore: z.number().min(0).max(1).default(0.3),

  /** Audit */
  auditAccess: z.boolean().default(true),
  auditRetentionDays: z.number().int().default(365),

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type GovernancePolicy = z.infer<typeof GovernancePolicySchema>;

// ─── Audit Log Entry ─────────────────────────────────────────────────────────

export const AuditLogSchema = z.object({
  id: z.string().uuid(),
  timestamp: z.string().datetime(),
  userId: z.string(),
  organizationId: z.string(),
  action: z.enum([
    'search',
    'view',
    'copy',
    'download',
    'share',
    'modify',
    'delete',
    'export',
    'admin_override',
  ]),
  resourceType: z.enum(['session', 'chunk', 'knowledge', 'cluster']),
  resourceId: z.string(),
  metadata: z.record(z.unknown()).optional(),
  ipAddress: z.string().optional(),
  userAgent: z.string().optional(),
});
export type AuditLog = z.infer<typeof AuditLogSchema>;

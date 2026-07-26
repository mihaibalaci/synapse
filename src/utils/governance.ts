/**
 * Governance Layer
 *
 * Enforces organizational policies on knowledge before it becomes searchable.
 * Responsibilities:
 *   - PII detection and redaction
 *   - Secret scanning (AWS keys, tokens, passwords)
 *   - Content classification (public, internal, confidential, restricted)
 *   - Retention policy enforcement
 *   - Audit logging
 *   - Data export (GDPR-style right to deletion)
 *
 * This layer runs during ingestion (before indexing) and periodically
 * as a maintenance job to enforce changing policies retroactively.
 */

import { v4 as uuidv4 } from 'uuid';
import { createChildLogger } from './logger.js';
import {
  type Chunk,
  type GovernancePolicy,
  type AuditLog,
  type SecurityClassification,
} from '../models/index.js';

const logger = createChildLogger({ module: 'governance' });

// ─── PII Patterns ────────────────────────────────────────────────────────────

const PII_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  {
    name: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    replacement: '[REDACTED_EMAIL]',
  },
  {
    name: 'phone_us',
    pattern: /\b(\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    replacement: '[REDACTED_PHONE]',
  },
  {
    name: 'ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: '[REDACTED_SSN]',
  },
  {
    name: 'credit_card',
    pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
    replacement: '[REDACTED_CC]',
  },
  {
    name: 'ip_address',
    pattern: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
    replacement: '[REDACTED_IP]',
  },
];

// ─── Secret Patterns ─────────────────────────────────────────────────────────

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  {
    name: 'aws_access_key',
    pattern: /\b(AKIA[0-9A-Z]{16})\b/g,
    replacement: '[REDACTED_AWS_KEY]',
  },
  {
    name: 'aws_secret_key',
    pattern: /\b([A-Za-z0-9/+=]{40})\b/g,
    replacement: '[REDACTED_AWS_SECRET]',
  },
  {
    name: 'github_token',
    pattern: /\b(gh[ps]_[A-Za-z0-9_]{36,})\b/g,
    replacement: '[REDACTED_GH_TOKEN]',
  },
  {
    name: 'generic_api_key',
    pattern: /\b(api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*['"]?([A-Za-z0-9_\-]{20,})['"]?/gi,
    replacement: '$1=[REDACTED_API_KEY]',
  },
  {
    name: 'bearer_token',
    pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
    replacement: 'Bearer [REDACTED_TOKEN]',
  },
  {
    name: 'private_key',
    pattern: /-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |DSA )?PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  {
    name: 'password_assignment',
    pattern: /(password|passwd|pwd|secret)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/gi,
    replacement: '$1=[REDACTED_PASSWORD]',
  },
  {
    name: 'connection_string',
    pattern: /\b(postgres|mysql|mongodb|redis):\/\/[^\s"']+/gi,
    replacement: '[REDACTED_CONNECTION_STRING]',
  },
  {
    name: 'jwt_token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: '[REDACTED_JWT]',
  },
];

// ─── Governance Scanner ──────────────────────────────────────────────────────

export interface ScanResult {
  containsPII: boolean;
  containsSecrets: boolean;
  piiFindings: Array<{ type: string; count: number }>;
  secretFindings: Array<{ type: string; count: number }>;
  classification: SecurityClassification;
  redactedContent?: string;
}

export class GovernanceScanner {
  /**
   * Scan content for PII and secrets.
   * Returns findings and optionally redacted content.
   */
  scan(content: string, options?: { redact?: boolean }): ScanResult {
    const piiFindings: Array<{ type: string; count: number }> = [];
    const secretFindings: Array<{ type: string; count: number }> = [];
    let redactedContent = content;

    // Scan for PII
    for (const { name, pattern, replacement } of PII_PATTERNS) {
      const matches = content.match(pattern);
      if (matches && matches.length > 0) {
        piiFindings.push({ type: name, count: matches.length });
        if (options?.redact) {
          redactedContent = redactedContent.replace(pattern, replacement);
        }
      }
    }

    // Scan for secrets
    for (const { name, pattern, replacement } of SECRET_PATTERNS) {
      const matches = content.match(pattern);
      if (matches && matches.length > 0) {
        secretFindings.push({ type: name, count: matches.length });
        if (options?.redact) {
          redactedContent = redactedContent.replace(pattern, replacement);
        }
      }
    }

    const containsPII = piiFindings.length > 0;
    const containsSecrets = secretFindings.length > 0;

    // Auto-classify based on findings
    let classification: SecurityClassification = 'public';
    if (containsSecrets) {
      classification = 'restricted';
    } else if (containsPII) {
      classification = 'confidential';
    }

    const result: ScanResult = {
      containsPII,
      containsSecrets,
      piiFindings,
      secretFindings,
      classification,
    };

    if (options?.redact) {
      result.redactedContent = redactedContent;
    }

    if (containsPII || containsSecrets) {
      logger.warn({
        piiCount: piiFindings.length,
        secretCount: secretFindings.length,
        classification,
      }, 'Sensitive content detected');
    }

    return result;
  }

  /**
   * Scan and redact a chunk before indexing.
   * Modifies chunk content in-place and sets ACL flags.
   */
  scanChunk(chunk: Chunk): { chunk: Chunk; scanResult: ScanResult } {
    const findings: ScanResult[] = [];
    const redact = (value: string): string => {
      const result = this.scan(value, { redact: true });
      findings.push(result);
      return result.redactedContent ?? value;
    };

    chunk.title = redact(chunk.title);
    chunk.summary = redact(chunk.summary);
    chunk.content = redact(chunk.content);
    chunk.codeReferences = chunk.codeReferences.map(reference => ({
      ...reference,
      filePath: redact(reference.filePath),
      snippet: redact(reference.snippet),
      ...(reference.repository ? { repository: redact(reference.repository) } : {}),
    }));
    chunk.entities = chunk.entities.map(entity => ({
      ...entity,
      name: redact(entity.name),
      ...(entity.context ? { context: redact(entity.context) } : {}),
    }));

    const mergeFindings = (
      key: 'piiFindings' | 'secretFindings',
    ): Array<{ type: string; count: number }> => {
      const totals = new Map<string, number>();
      for (const result of findings) {
        for (const finding of result[key]) {
          totals.set(finding.type, (totals.get(finding.type) ?? 0) + finding.count);
        }
      }
      return [...totals].map(([type, count]) => ({ type, count }));
    };

    const containsPII = findings.some(result => result.containsPII);
    const containsSecrets = findings.some(result => result.containsSecrets);
    const classification: SecurityClassification = containsSecrets
      ? 'restricted'
      : containsPII
        ? 'confidential'
        : chunk.teamId || chunk.repository
          ? 'internal'
          : 'public';
    const scanResult: ScanResult = {
      containsPII,
      containsSecrets,
      piiFindings: mergeFindings('piiFindings'),
      secretFindings: mergeFindings('secretFindings'),
      classification,
    };

    chunk.acl = {
      ownerId: chunk.authorId,
      organizationId: chunk.organizationId,
      teamIds: chunk.teamId ? [chunk.teamId] : [],
      repositoryIds: chunk.repository ? [chunk.repository] : [],
      sharedWith: [],
      classification,
      discoverable: classification !== 'restricted',
      containsPII,
      containsSecrets,
      redacted: containsPII || containsSecrets,
    };

    return { chunk, scanResult };
  }
}

// ─── Audit Logger ────────────────────────────────────────────────────────────

export class AuditLogger {
  /**
   * Log an access event for compliance tracking.
   */
  async log(entry: Omit<AuditLog, 'id' | 'timestamp'>): Promise<void> {
    const auditEntry: AuditLog = {
      ...entry,
      id: uuidv4(),
      timestamp: new Date().toISOString(),
    };

    logger.info({
      action: auditEntry.action,
      userId: auditEntry.userId,
      resourceType: auditEntry.resourceType,
      resourceId: auditEntry.resourceId,
    }, 'Audit event');

    // TODO: Persist to audit_log table
    // await query(
    //   `INSERT INTO audit_log (id, timestamp, user_id, organization_id, action, resource_type, resource_id, metadata, ip_address, user_agent)
    //    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    //   [...]
    // );
  }

  /**
   * Get audit trail for a specific resource.
   */
  async getResourceHistory(
    resourceId: string,
    options?: { limit?: number; actions?: string[] },
  ): Promise<AuditLog[]> {
    // TODO: SELECT * FROM audit_log WHERE resource_id = $1 ORDER BY timestamp DESC LIMIT $2
    return [];
  }

  /**
   * Get audit trail for a specific user.
   */
  async getUserHistory(
    userId: string,
    options?: { limit?: number; from?: string; to?: string },
  ): Promise<AuditLog[]> {
    // TODO: SELECT * FROM audit_log WHERE user_id = $1 AND timestamp BETWEEN $2 AND $3
    return [];
  }

  /**
   * Generate compliance report for an organization.
   */
  async generateComplianceReport(organizationId: string, days: number = 30): Promise<{
    totalAccesses: number;
    uniqueUsers: number;
    sensitiveAccesses: number;
    exportRequests: number;
    deletionRequests: number;
  }> {
    // TODO: Aggregate queries
    return {
      totalAccesses: 0,
      uniqueUsers: 0,
      sensitiveAccesses: 0,
      exportRequests: 0,
      deletionRequests: 0,
    };
  }
}

// ─── Retention Policy Enforcer ───────────────────────────────────────────────

export class RetentionEnforcer {
  /**
   * Apply retention policies to chunks older than the policy threshold.
   * Runs as a nightly job.
   */
  async enforce(policy: GovernancePolicy): Promise<{
    archived: number;
    deleted: number;
  }> {
    if (!policy.retentionDays) return { archived: 0, deleted: 0 };

    logger.info({
      organizationId: policy.organizationId,
      retentionDays: policy.retentionDays,
      retentionPolicy: policy.retentionPolicy,
    }, 'Enforcing retention policy');

    // TODO: Find chunks older than retentionDays
    // and apply retentionPolicy (archive or delete)
    //
    // SELECT id FROM chunks
    // WHERE organization_id = $1
    //   AND created_at < NOW() - interval '$2 days'
    //   AND confidence != 'archived'

    return { archived: 0, deleted: 0 };
  }

  /**
   * Handle a data deletion request (GDPR Article 17 / right to erasure).
   * Removes all data associated with a developer.
   */
  async handleDeletionRequest(
    developerId: string,
    organizationId: string,
  ): Promise<{ sessionsDeleted: number; chunksDeleted: number; knowledgeDeleted: number }> {
    logger.info({ developerId, organizationId }, 'Processing data deletion request');

    // TODO:
    // 1. Delete from knowledge_records WHERE author_id = $1
    // 2. Delete from chunks WHERE author_id = $1
    // 3. Delete from sessions WHERE developer_id = $1
    // 4. Remove from graph (Neo4j)
    // 5. Remove from search index (OpenSearch)
    // 6. Remove from object storage (S3)
    // 7. Invalidate cache
    // 8. Log audit event

    return { sessionsDeleted: 0, chunksDeleted: 0, knowledgeDeleted: 0 };
  }

  /**
   * Handle a data export request (GDPR Article 20 / right to portability).
   * Returns all data associated with a developer in a portable format.
   */
  async handleExportRequest(
    developerId: string,
    organizationId: string,
  ): Promise<{ exportUrl: string; expiresAt: string }> {
    logger.info({ developerId, organizationId }, 'Processing data export request');

    // TODO:
    // 1. Query all sessions, chunks, knowledge for developer
    // 2. Package into JSON/ZIP
    // 3. Upload to S3 with presigned URL
    // 4. Return URL with expiry

    return {
      exportUrl: '',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
    };
  }
}

// ─── Staleness Detector ──────────────────────────────────────────────────────

export class StalenessDetector {
  /**
   * Check chunks linked to a repository for staleness.
   * Called when significant code changes are detected (webhooks from Git).
   */
  async checkRepository(
    repository: string,
    latestCommitSha: string,
  ): Promise<{ staleChunks: number; decayedChunks: number }> {
    logger.info({ repository, latestCommitSha }, 'Checking repository staleness');

    // TODO:
    // 1. Find all chunks linked to this repository
    // 2. Compare commit_sha with latestCommitSha
    // 3. If commit_sha is far behind, decay confidence
    // 4. If major refactor detected, flag for revalidation

    return { staleChunks: 0, decayedChunks: 0 };
  }

  /**
   * Periodic job: decay confidence for aging chunks.
   * Runs nightly.
   */
  async decayConfidence(): Promise<{ updated: number }> {
    // TODO:
    // UPDATE chunks SET confidence = 'medium'
    // WHERE confidence = 'high'
    //   AND updated_at < NOW() - interval '90 days'
    //
    // UPDATE chunks SET confidence = 'low'
    // WHERE confidence = 'medium'
    //   AND updated_at < NOW() - interval '180 days'

    return { updated: 0 };
  }
}

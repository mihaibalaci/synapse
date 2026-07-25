import { describe, it, expect } from 'vitest';
import { GovernanceScanner } from '../../src/utils/governance.js';

describe('GovernanceScanner', () => {
  const scanner = new GovernanceScanner();

  describe('PII Detection', () => {
    it('should detect email addresses', () => {
      const result = scanner.scan('Contact john.doe@company.com for details');
      expect(result.containsPII).toBe(true);
      expect(result.piiFindings.find(f => f.type === 'email')).toBeDefined();
    });

    it('should detect phone numbers', () => {
      const result = scanner.scan('Call me at +1 (555) 123-4567');
      expect(result.containsPII).toBe(true);
      expect(result.piiFindings.find(f => f.type === 'phone_us')).toBeDefined();
    });

    it('should detect credit card numbers', () => {
      const result = scanner.scan('Card: 4111 1111 1111 1111');
      expect(result.containsPII).toBe(true);
      expect(result.piiFindings.find(f => f.type === 'credit_card')).toBeDefined();
    });

    it('should not flag normal technical content', () => {
      const result = scanner.scan('Use port 5432 for PostgreSQL and configure max_connections=200');
      expect(result.containsPII).toBe(false);
    });
  });

  describe('Secret Detection', () => {
    it('should detect AWS access keys', () => {
      const result = scanner.scan('aws_access_key_id = AKIAIOSFODNN7EXAMPLE');
      expect(result.containsSecrets).toBe(true);
      expect(result.secretFindings.find(f => f.type === 'aws_access_key')).toBeDefined();
    });

    it('should detect GitHub tokens', () => {
      const result = scanner.scan('export GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz12');
      expect(result.containsSecrets).toBe(true);
      expect(result.secretFindings.find(f => f.type === 'github_token')).toBeDefined();
    });

    it('should detect bearer tokens', () => {
      const result = scanner.scan('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U');
      expect(result.containsSecrets).toBe(true);
    });

    it('should detect private keys', () => {
      const result = scanner.scan('-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKC\n-----END RSA PRIVATE KEY-----');
      expect(result.containsSecrets).toBe(true);
      expect(result.secretFindings.find(f => f.type === 'private_key')).toBeDefined();
    });

    it('should detect connection strings', () => {
      const result = scanner.scan('DATABASE_URL=postgres://admin:secretpass@db.example.com:5432/mydb');
      expect(result.containsSecrets).toBe(true);
    });

    it('should not flag normal code', () => {
      const result = scanner.scan('const client = new Redis({ host: "localhost", port: 6379 })');
      expect(result.containsSecrets).toBe(false);
    });
  });

  describe('Redaction', () => {
    it('should redact emails when requested', () => {
      const result = scanner.scan('Email: test@example.com', { redact: true });
      expect(result.redactedContent).toContain('[REDACTED_EMAIL]');
      expect(result.redactedContent).not.toContain('test@example.com');
    });

    it('should redact AWS keys when requested', () => {
      const result = scanner.scan('Key: AKIAIOSFODNN7EXAMPLE', { redact: true });
      expect(result.redactedContent).toContain('[REDACTED_AWS_KEY]');
    });

    it('should preserve non-sensitive content during redaction', () => {
      const result = scanner.scan('Use S3 multipart upload. Contact admin@co.com', { redact: true });
      expect(result.redactedContent).toContain('Use S3 multipart upload');
      expect(result.redactedContent).toContain('[REDACTED_EMAIL]');
    });
  });

  describe('Classification', () => {
    it('should classify as public when no sensitive content', () => {
      const result = scanner.scan('Use Docker multi-stage builds for smaller images');
      expect(result.classification).toBe('public');
    });

    it('should classify as confidential when PII is found', () => {
      const result = scanner.scan('User john@company.com reported the bug');
      expect(result.classification).toBe('confidential');
    });

    it('should classify as restricted when secrets are found', () => {
      const result = scanner.scan('Set token to ghp_abcdefghijklmnopqrstuvwxyz1234567890');
      expect(result.classification).toBe('restricted');
    });
  });
});

import jwt from '@fastify/jwt';
import { z } from 'zod';
import { type FastifyInstance } from 'fastify';
import { getConfig } from '../config/index.js';
import { enterDatabaseContext, type DatabaseSecurityContext } from '../storage/database.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'auth' });

const JwtClaimsSchema = z.object({
  sub: z.string().min(1),
  organization_id: z.string().min(1),
  team_ids: z.array(z.string()).default([]),
  roles: z.array(z.string()).default([]),
  repository_access: z.array(z.string()).default([]),
});

export type RecallJwtClaims = z.infer<typeof JwtClaimsSchema>;
export type AuthContext = DatabaseSecurityContext;

declare module 'fastify' {
  interface FastifyRequest {
    authContext: AuthContext;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: RecallJwtClaims;
    user: RecallJwtClaims;
  }
}

const DEVELOPMENT_SECRET = 'recall-development-secret-not-for-production-use';

export async function registerAuthentication(app: FastifyInstance): Promise<void> {
  const config = getConfig();
  if (config.NODE_ENV === 'production' && !config.AUTH_JWT_SECRET && !config.AUTH_JWT_PUBLIC_KEY) {
    throw new Error('AUTH_JWT_SECRET or AUTH_JWT_PUBLIC_KEY is required in production');
  }

  const publicKey = config.AUTH_JWT_PUBLIC_KEY?.replace(/\\n/g, '\n');
  const secret = publicKey ?? config.AUTH_JWT_SECRET ?? DEVELOPMENT_SECRET;
  if (!publicKey && !config.AUTH_JWT_SECRET) {
    logger.warn('Using development-only JWT secret');
  }

  await app.register(jwt, {
    secret,
    verify: {
      allowedIss: config.AUTH_ISSUER,
      allowedAud: config.AUTH_AUDIENCE,
      algorithms: [publicKey ? 'RS256' : 'HS256'],
    },
  });

  app.decorateRequest('authContext');
  app.addHook('onRequest', async request => {
    if (request.url === '/health' || request.url === '/health/ready') return;

    await request.jwtVerify();
    const parsed = JwtClaimsSchema.safeParse(request.user);
    if (!parsed.success) {
      const error = new Error('JWT is missing required Recall identity claims') as Error & { statusCode: number };
      error.statusCode = 401;
      throw error;
    }

    request.authContext = {
      userId: parsed.data.sub,
      organizationId: parsed.data.organization_id,
      teamIds: parsed.data.team_ids,
      roles: parsed.data.roles,
      repositoryAccess: parsed.data.repository_access,
    };
    enterDatabaseContext(request.authContext);
  });
}

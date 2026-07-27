/**
 * Logger
 *
 * Structured JSON logging with pino.
 * Includes request correlation IDs for tracing.
 */

import pino from 'pino';
import { getConfig } from '../config/index.js';

let _logger: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (_logger) return _logger;

  const config = getConfig();

  _logger = pino({
    level: config.LOG_LEVEL,
    transport: config.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
    base: {
      service: 'synapse',
      env: config.NODE_ENV,
    },
    serializers: {
      err: pino.stdSerializers.err,
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
    },
  });

  return _logger;
}

export function createChildLogger(bindings: Record<string, unknown>): pino.Logger {
  return getLogger().child(bindings);
}

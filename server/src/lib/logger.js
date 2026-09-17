// One shared structured logger.
//
// pino writes one JSON object per line: { level, time, msg, ...fields }.
// Structured logs can be searched and filtered by field in production
// (e.g. every line with callId=X), which console.log text cannot.
//
// Usage: logger.info({ callId, businessId }, 'call started');
//        logger.error({ err }, 'booking failed');   // `err` is serialised with its stack

import pino from 'pino';
import { config } from '../config.js';

export const logger = pino({
  level: config.logLevel,
  // Never log secrets even if a caller passes a whole config/headers object.
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token', '*.apiKey'],
  base: { service: 'callhand-server' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

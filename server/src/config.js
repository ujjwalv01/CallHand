// The single place that reads process.env.
//
// Every other module imports `config` from here instead of touching
// process.env directly. That gives us three things:
//   1. One schema that documents every variable the server understands.
//   2. Validation at startup: a missing or malformed value crashes the process
//      immediately with a readable message, instead of surfacing as a
//      confusing error deep inside a live phone call.
//   3. Typed, defaulted values (numbers are numbers, booleans are booleans).

import { z } from 'zod';

// z.coerce.* converts the raw string from .env into the right type.
// .default() supplies a value when the variable is absent or empty.
const optionalString = z.string().trim().optional().transform((v) => v || undefined);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:4000'),
  CLIENT_ORIGIN: z.string().url().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DATABASE_URL: z.string().url().refine((u) => /^postgres(ql)?:\/\//.test(u), {
    message: 'must be a postgres:// or postgresql:// URL',
  }),

  JWT_SECRET: z.string().min(32, 'must be at least 32 characters; generate one with crypto.randomBytes(32)'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  VAPI_API_KEY: optionalString,
  VAPI_ASSISTANT_ID: optionalString,
  VAPI_WEBHOOK_SECRET: optionalString,

  GROQ_API_KEY: optionalString,

  TWILIO_ACCOUNT_SID: optionalString,
  TWILIO_AUTH_TOKEN: optionalString,
  TWILIO_SMS_FROM: optionalString,
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Print one line per problem, then exit. process.exit here is intentional:
  // there is no meaningful way to run without valid config.
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

// Regroup flat env vars into a nested object so call sites read naturally:
// config.twilio.smsFrom rather than config.TWILIO_SMS_FROM.
export const config = Object.freeze({
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  port: env.PORT,
  publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/$/, ''),
  clientOrigin: env.CLIENT_ORIGIN,
  logLevel: env.LOG_LEVEL,

  databaseUrl: env.DATABASE_URL,

  jwt: {
    secret: env.JWT_SECRET,
    expiresIn: env.JWT_EXPIRES_IN,
  },

  vapi: {
    apiKey: env.VAPI_API_KEY,
    assistantId: env.VAPI_ASSISTANT_ID,
    webhookSecret: env.VAPI_WEBHOOK_SECRET,
    // "Is this integration switched on?" Call sites check this instead of the key itself.
    enabled: Boolean(env.VAPI_API_KEY),
  },

  groq: {
    apiKey: env.GROQ_API_KEY,
  },

  twilio: {
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    smsFrom: env.TWILIO_SMS_FROM,
    enabled: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_SMS_FROM),
  },
});

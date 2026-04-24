import pino from 'pino';

const transport =
  process.env['NODE_ENV'] !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined;

export const logger = pino(
  { level: process.env['NODE_ENV'] === 'production' ? 'info' : 'debug' },
  transport ? pino.transport(transport) : undefined,
);

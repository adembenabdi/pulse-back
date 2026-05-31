import 'dotenv/config';
import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { errorHandler } from './middleware/error.js';
import { requestLogger } from './middleware/requestLogger.js';
import { logger } from './lib/logger.js';
import { pool } from './lib/db.js';
import { authRouter }      from './routes/auth.js';
import { projectsRouter }  from './routes/projects.js';
import { tasksRouter }     from './routes/tasks.js';
import { calendarRouter }  from './routes/calendar.js';
import { prayerRouter }    from './routes/prayer.js';
import { ideasRouter }     from './routes/ideas.js';
import { assistantRouter } from './routes/assistant.js';
import { overviewRouter }  from './routes/overview.js';
import { settingsRouter }  from './routes/settings.js';
import { telegramRouter }  from './routes/telegram.js';
import { initTelegramBot } from './services/messaging/telegram.js';

const app: Express = express();

// ── Security & parsing ────────────────────────────────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: process.env['FRONTEND_URL'] ?? 'http://localhost:3000',
    credentials: true,
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(requestLogger);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',      authRouter);
app.use('/api/projects',  projectsRouter);
app.use('/api/tasks',     tasksRouter);
app.use('/api/calendar',  calendarRouter);
app.use('/api/prayer',    prayerRouter);
app.use('/api/ideas',     ideasRouter);
app.use('/api/assistant', assistantRouter);
app.use('/api/overview',  overviewRouter);
app.use('/api/settings',  settingsRouter);
app.use('/api/telegram',  telegramRouter);

// ── Error handler (must be last) ──────────────────────────────────────────────
app.use(errorHandler);

const PORT = Number(process.env['PORT'] ?? 4000);

// Don't auto-start the server when imported by tests (each test calls app.listen(0))
if (process.env['NODE_ENV'] !== 'test') {
  app.listen(PORT, async () => {
    logger.info(`pulse-backend listening on http://localhost:${PORT}`);

    try {
      const { rows } = await pool.query<{ now: Date; db: string }>(
        'SELECT NOW() AS now, current_database() AS db',
      );
      logger.info({ db: rows[0]?.db, time: rows[0]?.now }, '✓ Database connected');
    } catch (err) {
      logger.error({ err }, '✗ Database connection FAILED — check DATABASE_URL in .env');
    }

    initTelegramBot();
  });
}

export { app };

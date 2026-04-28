import 'dotenv/config';
import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { errorHandler } from './middleware/error.js';
import { requestLogger } from './middleware/requestLogger.js';
import { logger } from './lib/logger.js';
import { pool } from './lib/db.js';
import { authRouter } from './routes/auth.js';
import { connectionsRouter } from './routes/connections.js';
import { teamsRouter } from './routes/teams.js';
import { orgsRouter } from './routes/organizations.js';
import { sharesRouter } from './routes/shares.js';
import { notificationsRouter } from './routes/notifications.js';
import { rolesRouter } from './routes/roles.js';
import { itemsRouter } from './routes/items.js';
import { objectivesRouter } from './routes/objectives.js';
import { ideasRouter } from './routes/ideas.js';
import { calendarRouter } from './routes/calendar.js';
import { scheduleRouter } from './routes/schedule.js';
import { habitsRouter } from './routes/habits.js';
import { spiritualRouter } from './routes/spiritual.js';
import { healthRouter } from './routes/health.js';
import { distractionsRouter } from './routes/distractions.js';
import { foodRouter }        from './routes/food.js';
import { knowledgeRouter }   from './routes/knowledge.js';
import { moneyRouter }       from './routes/money.js';
import { freelanceRouter }   from './routes/freelance.js';
import { assistantRouter, telegramRouter, pushRouter } from './routes/assistant.js';
import { initTelegramBot }   from './services/messaging/telegram.js';
import { initCronJobs }      from './services/scheduler.js';
import { searchRouter }      from './routes/search.js';
import { overviewRouter }    from './routes/overview.js';
import { settingsRouter }    from './routes/settings.js';
import { linksRouter }       from './routes/links.js';

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
app.use('/api/auth',          authRouter);
app.use('/api/connections',   connectionsRouter);
app.use('/api/teams',         teamsRouter);
app.use('/api/organizations', orgsRouter);
app.use('/api/shares',        sharesRouter);
app.use('/api/notifications', notificationsRouter);
// Phase 3 — Productivity primitives
app.use('/api/roles',        rolesRouter);
app.use('/api/items',        itemsRouter);
app.use('/api/objectives',   objectivesRouter);
app.use('/api/ideas',        ideasRouter);
// Phase 4 — Scheduling
app.use('/api/calendar',     calendarRouter);
app.use('/api/schedule',     scheduleRouter);
// Phase 5 — Habits, Health, Spiritual
app.use('/api/habits',       habitsRouter);
app.use('/api/spiritual',    spiritualRouter);
app.use('/api/health',       healthRouter);
app.use('/api/distractions', distractionsRouter);
// Phase 6 — Food
app.use('/api/food',         foodRouter);
// Phase 7 — Knowledge & Study
app.use('/api/knowledge',    knowledgeRouter);
// Phase 8 — Money
app.use('/api/money',        moneyRouter);
app.use('/api/freelance',    freelanceRouter);
// Phase 9 — AI + Telegram + Push
app.use('/api/assistant',    assistantRouter);
app.use('/api/telegram',     telegramRouter);
app.use('/api/push',         pushRouter);
// Phase 10 — Polish
app.use('/api/search',       searchRouter);
app.use('/api/overview',     overviewRouter);
app.use('/api/settings',     settingsRouter);
// Graph — Universal Entity Relationship Layer
app.use('/api/links',        linksRouter);

// ── Error handler (must be last) ──────────────────────────────────────────────
app.use(errorHandler);

const PORT = Number(process.env['PORT'] ?? 4000);

// Don't auto-start the server when imported by tests (each test calls app.listen(0))
if (process.env['NODE_ENV'] !== 'test') {
  app.listen(PORT, async () => {
    logger.info(`pulse-backend listening on http://localhost:${PORT}`);

    // ── DB health check ─────────────────────────────────────────────────────────
    try {
      const { rows } = await pool.query<{ now: Date; db: string }>(
        'SELECT NOW() AS now, current_database() AS db',
      );
      logger.info(
        { db: rows[0]?.db, time: rows[0]?.now },
        '✓ Database connected',
      );
    } catch (err) {
      logger.error({ err }, '✗ Database connection FAILED — check DATABASE_URL in .env');
    }

    initTelegramBot();
    initCronJobs();
  });
}

export { app };

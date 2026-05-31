-- Migration 013: make user_id nullable on telegram_link_tokens
-- The link token is created by the bot before the user is known;
-- the user_id association happens in settings when the token is redeemed.
ALTER TABLE public.telegram_link_tokens
  ALTER COLUMN user_id DROP NOT NULL;

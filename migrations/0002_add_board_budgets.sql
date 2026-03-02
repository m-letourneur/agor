-- Migration: Add board_budgets table for cost tracking and budget limits
-- Date: 2026-03-02
-- Description: Add board_budgets table to support per-board cost tracking and budget limits.
--              This is Phase 1 foundation - enforcement will be added in Phase 2.
--              Schema supports both SQLite and PostgreSQL.

BEGIN TRANSACTION;

-- Create board_budgets table
CREATE TABLE board_budgets (
  board_id TEXT(36) PRIMARY KEY,

  -- Budget limits (NULL = no limit set)
  daily_limit_usd REAL,
  monthly_limit_usd REAL,

  -- Alert threshold (percentage, e.g., 80 = alert at 80% of limit)
  alert_threshold INTEGER DEFAULT 80,

  -- Enforcement (Phase 2 - when true, block sessions when limit exceeded)
  enforce INTEGER DEFAULT 0 NOT NULL, -- Boolean in SQLite (0 = false, 1 = true)

  -- Metadata
  created_at INTEGER NOT NULL, -- Unix timestamp in milliseconds
  updated_at INTEGER, -- Unix timestamp in milliseconds
  created_by TEXT(36), -- User ID who created the budget

  -- Foreign key constraint
  FOREIGN KEY (board_id) REFERENCES boards(board_id) ON DELETE CASCADE
);

-- Create index for efficient lookups
CREATE INDEX idx_board_budgets_board_id ON board_budgets(board_id);

COMMIT;

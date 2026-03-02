/**
 * Board Budgets Repository
 *
 * Type-safe CRUD operations for board budgets.
 * Phase 1: Basic storage, no enforcement logic.
 */

import type { BoardBudget, UUID } from '@agor/core/types';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { eq } from '../index';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import { boardBudgets } from '../schema';
import type { BoardBudgetInsert, BoardBudgetRow } from '../schema';
import { type BaseRepository, EntityNotFoundError, RepositoryError } from './base';

/**
 * Board Budget repository implementation
 */
export class BoardBudgetRepository
  implements BaseRepository<BoardBudget, Partial<BoardBudget>>
{
  constructor(private db: Database) {}

  /**
   * Convert database row to BoardBudget type
   */
  private rowToBudget(row: BoardBudgetRow): BoardBudget {
    return {
      board_id: row.board_id as UUID,
      daily_limit_usd: row.daily_limit_usd ?? undefined,
      monthly_limit_usd: row.monthly_limit_usd ?? undefined,
      alert_threshold: row.alert_threshold ?? 80,
      enforce: row.enforce ?? false,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
      created_by: row.created_by ?? undefined,
    };
  }

  /**
   * Convert BoardBudget to database insert format
   */
  private budgetToInsert(budget: Partial<BoardBudget>): BoardBudgetInsert {
    const now = Date.now();

    if (!budget.board_id) {
      throw new RepositoryError('board_id is required');
    }

    return {
      board_id: budget.board_id,
      daily_limit_usd: budget.daily_limit_usd ?? null,
      monthly_limit_usd: budget.monthly_limit_usd ?? null,
      alert_threshold: budget.alert_threshold ?? 80,
      enforce: budget.enforce ?? false,
      created_at: new Date(budget.created_at ?? now),
      updated_at: budget.updated_at ? new Date(budget.updated_at) : new Date(now),
      created_by: budget.created_by ?? null,
    };
  }

  /**
   * Find budget by board ID
   */
  async findById(boardId: string): Promise<BoardBudget | null> {
    try {
      const row = await select(this.db)
        .from(boardBudgets)
        .where(eq(boardBudgets.board_id, boardId))
        .one();

      if (!row) {
        return null;
      }

      return this.rowToBudget(row);
    } catch (error) {
      throw new RepositoryError(`Failed to find budget for board ${boardId}`, { cause: error });
    }
  }

  /**
   * Find all budgets (with optional limit)
   */
  async findAll(limit?: number): Promise<BoardBudget[]> {
    try {
      const query = select(this.db).from(boardBudgets);
      const rows = limit ? await query.limit(limit).all() : await query.all();

      return rows.map((row: BoardBudgetRow) => this.rowToBudget(row));
    } catch (error) {
      throw new RepositoryError('Failed to find budgets', { cause: error });
    }
  }

  /**
   * Create a new budget
   */
  async create(budget: Partial<BoardBudget>): Promise<BoardBudget> {
    try {
      const insertData = this.budgetToInsert(budget);
      await insert(this.db, boardBudgets).values(insertData).run();

      const created = await this.findById(insertData.board_id);
      if (!created) {
        throw new RepositoryError('Failed to retrieve created budget');
      }

      return created;
    } catch (error) {
      throw new RepositoryError('Failed to create budget', { cause: error });
    }
  }

  /**
   * Update an existing budget
   */
  async update(boardId: string, updates: Partial<BoardBudget>): Promise<BoardBudget> {
    try {
      const existing = await this.findById(boardId);
      if (!existing) {
        throw new EntityNotFoundError('BoardBudget', boardId);
      }

      const updateData: Partial<BoardBudgetInsert> = {
        ...(updates.daily_limit_usd !== undefined && { daily_limit_usd: updates.daily_limit_usd }),
        ...(updates.monthly_limit_usd !== undefined && {
          monthly_limit_usd: updates.monthly_limit_usd,
        }),
        ...(updates.alert_threshold !== undefined && {
          alert_threshold: updates.alert_threshold,
        }),
        ...(updates.enforce !== undefined && { enforce: updates.enforce }),
        updated_at: new Date(),
      };

      await update(this.db, boardBudgets)
        .set(updateData)
        .where(eq(boardBudgets.board_id, boardId))
        .run();

      const updated = await this.findById(boardId);
      if (!updated) {
        throw new RepositoryError('Failed to retrieve updated budget');
      }

      return updated;
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw error;
      }
      throw new RepositoryError(`Failed to update budget for board ${boardId}`, { cause: error });
    }
  }

  /**
   * Delete a budget
   */
  async delete(boardId: string): Promise<void> {
    try {
      const existing = await this.findById(boardId);
      if (!existing) {
        throw new EntityNotFoundError('BoardBudget', boardId);
      }

      await deleteFrom(this.db, boardBudgets).where(eq(boardBudgets.board_id, boardId)).run();
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw error;
      }
      throw new RepositoryError(`Failed to delete budget for board ${boardId}`, { cause: error });
    }
  }

  /**
   * Upsert (create or update) a budget
   */
  async upsert(budget: Partial<BoardBudget>): Promise<BoardBudget> {
    if (!budget.board_id) {
      throw new RepositoryError('board_id is required for upsert');
    }

    const existing = await this.findById(budget.board_id);

    if (existing) {
      return this.update(budget.board_id, budget);
    } else {
      return this.create(budget);
    }
  }
}

/**
 * React hook for fetching board cost data from the leaderboard service
 *
 * Fetches both total cost and period cost (default: last 7 days) for a board.
 * Refreshes on board change and polls periodically.
 */

import type { AgorClient } from '@agor/core/api';
import type { BoardID } from '@agor/core/types';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Cost data for a board */
export interface BoardCostData {
  /** Total cost across all time for this board (USD) */
  totalCost: number;
  /** Cost in the current period (USD) */
  periodCost: number;
  /** Total task count across all time */
  totalTaskCount: number;
  /** Task count in the current period */
  periodTaskCount: number;
  /** Period length in days */
  periodDays: number;
}

interface UseBoardCostResult {
  cost: BoardCostData | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/** Polling interval for cost refresh (60 seconds) */
const POLL_INTERVAL_MS = 60_000;

/**
 * Fetch and periodically refresh board cost data
 *
 * @param client - Agor client instance
 * @param boardId - Board ID to fetch cost for
 * @param periodDays - Number of days for the "recent" period (default: 7)
 * @returns Cost data, loading state, error, and refetch function
 */
export function useBoardCost(
  client: AgorClient | null,
  boardId: BoardID | null | undefined,
  periodDays = 7
): UseBoardCostResult {
  const [cost, setCost] = useState<BoardCostData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchCost = useCallback(async () => {
    if (!client || !boardId) {
      setCost(null);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // Calculate period start date
      const periodStart = new Date();
      periodStart.setDate(periodStart.getDate() - periodDays);

      // Fetch total cost and period cost in parallel
      // Use an empty groupBy-like approach: we just want aggregate totals, not per-worktree breakdown
      // The leaderboard returns aggregated results; with no groupBy dimensions we still get totals
      const [totalResult, periodResult] = await Promise.all([
        // Total cost (no date filter)
        client.service('leaderboard').find({
          query: {
            boardId,
            groupBy: 'worktree', // Group by worktree so we get results even with 1 worktree
            limit: 1000, // High limit to capture all worktrees
          },
        }),
        // Period cost (with start date filter)
        client.service('leaderboard').find({
          query: {
            boardId,
            startDate: periodStart.toISOString(),
            groupBy: 'worktree',
            limit: 1000,
          },
        }),
      ]);

      // DEBUG: trace response shape (remove after debugging)
      console.log('[useBoardCost] boardId:', boardId);
      console.log('[useBoardCost] totalResult:', JSON.stringify(totalResult).slice(0, 500));
      console.log('[useBoardCost] periodResult:', JSON.stringify(periodResult).slice(0, 500));

      // biome-ignore lint/suspicious/noExplicitAny: Leaderboard service returns untyped data
      const totalData = (totalResult as any)?.data || totalResult || [];
      // biome-ignore lint/suspicious/noExplicitAny: Leaderboard service returns untyped data
      const periodData = (periodResult as any)?.data || periodResult || [];

      // Sum across all worktrees
      // biome-ignore lint/suspicious/noExplicitAny: Leaderboard entries are untyped from generic service call
      const totalCost = totalData.reduce((sum: number, entry: any) => sum + (entry.totalCost || 0), 0);
      // biome-ignore lint/suspicious/noExplicitAny: Leaderboard entries are untyped from generic service call
      const totalTaskCount = totalData.reduce(
        // biome-ignore lint/suspicious/noExplicitAny: Leaderboard entries are untyped from generic service call
        (sum: number, entry: any) => sum + (entry.taskCount || 0),
        0
      );
      // biome-ignore lint/suspicious/noExplicitAny: Leaderboard entries are untyped from generic service call
      const periodCost = periodData.reduce((sum: number, entry: any) => sum + (entry.totalCost || 0), 0);
      // biome-ignore lint/suspicious/noExplicitAny: Leaderboard entries are untyped from generic service call
      const periodTaskCount = periodData.reduce(
        // biome-ignore lint/suspicious/noExplicitAny: Leaderboard entries are untyped from generic service call
        (sum: number, entry: any) => sum + (entry.taskCount || 0),
        0
      );

      setCost({
        totalCost,
        periodCost,
        totalTaskCount,
        periodTaskCount,
        periodDays,
      });
    } catch (err) {
      // DEBUG: trace errors (remove after debugging)
      console.error('[useBoardCost] error:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch board cost');
    } finally {
      setLoading(false);
    }
  }, [client, boardId, periodDays]);

  // Fetch on mount and when dependencies change
  useEffect(() => {
    fetchCost();

    // Set up polling
    pollRef.current = setInterval(fetchCost, POLL_INTERVAL_MS);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [fetchCost]);

  return {
    cost,
    loading,
    error,
    refetch: fetchCost,
  };
}

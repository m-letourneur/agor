/**
 * BoardCostPill - Compact cost display for the AppHeader
 *
 * Shows board cost for the current period with a tooltip for detailed breakdown.
 * Color-codes based on budget proximity when budget limits are set.
 */

import { DollarOutlined } from '@ant-design/icons';
import { Skeleton, Tag, Tooltip, theme } from 'antd';
import type React from 'react';
import type { BoardCostData } from '../../hooks/useBoardCost';

export interface BoardCostPillProps {
  /** Cost data from useBoardCost hook */
  cost: BoardCostData | null;
  /** Whether cost data is still loading */
  loading?: boolean;
  /** Daily budget limit in USD (null = no limit) */
  budgetDailyUsd?: number | null;
  /** Total budget limit in USD (null = no limit) */
  budgetTotalUsd?: number | null;
}

/**
 * Format a USD cost value for display
 * - Under $0.01: show "$0.00"
 * - Under $10: show 2 decimal places ("$1.23")
 * - $10+: show no decimals ("$42")
 */
function formatCost(cost: number): string {
  if (cost < 10) {
    return `$${cost.toFixed(2)}`;
  }
  return `$${Math.round(cost)}`;
}

/**
 * Determine pill color based on budget usage
 */
function getPillColor(
  cost: BoardCostData | null,
  budgetDailyUsd?: number | null,
  budgetTotalUsd?: number | null
): string {
  if (!cost) return 'default';

  // Check total budget
  if (budgetTotalUsd && budgetTotalUsd > 0) {
    const ratio = cost.totalCost / budgetTotalUsd;
    if (ratio >= 1) return 'red';
    if (ratio >= 0.8) return 'orange';
  }

  // Check daily budget against period cost (rough approximation)
  if (budgetDailyUsd && budgetDailyUsd > 0 && cost.periodDays > 0) {
    const dailyAvg = cost.periodCost / cost.periodDays;
    const ratio = dailyAvg / budgetDailyUsd;
    if (ratio >= 1) return 'red';
    if (ratio >= 0.8) return 'orange';
  }

  return 'default';
}

export const BoardCostPill: React.FC<BoardCostPillProps> = ({
  cost,
  loading = false,
  budgetDailyUsd,
  budgetTotalUsd,
}) => {
  const { token } = theme.useToken();

  if (loading && !cost) {
    return <Skeleton.Button active size="small" style={{ width: 60, height: 22 }} />;
  }

  // Show $0.00 when no cost data yet (makes it visible for testing / confirms wiring works)
  const displayCost: BoardCostData = cost ?? {
    totalCost: 0,
    periodCost: 0,
    totalTaskCount: 0,
    periodTaskCount: 0,
    periodDays: 7,
  };

  const pillColor = getPillColor(displayCost, budgetDailyUsd, budgetTotalUsd);

  const tooltipContent = (
    <div style={{ minWidth: 180 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Board Cost</div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 16,
        }}
      >
        <span>Last {displayCost.periodDays}d:</span>
        <span style={{ fontFamily: token.fontFamilyCode }}>
          {formatCost(displayCost.periodCost)}
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 16,
        }}
      >
        <span>Total:</span>
        <span style={{ fontFamily: token.fontFamilyCode }}>
          {formatCost(displayCost.totalCost)}
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 16,
          color: token.colorTextDescription,
          fontSize: token.fontSizeSM,
        }}
      >
        <span>Tasks ({displayCost.periodDays}d / total):</span>
        <span style={{ fontFamily: token.fontFamilyCode }}>
          {displayCost.periodTaskCount} / {displayCost.totalTaskCount}
        </span>
      </div>
      {budgetDailyUsd != null && budgetDailyUsd > 0 && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 16,
            marginTop: 4,
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            paddingTop: 4,
          }}
        >
          <span>Daily budget:</span>
          <span style={{ fontFamily: token.fontFamilyCode }}>
            {formatCost(budgetDailyUsd)}
          </span>
        </div>
      )}
      {budgetTotalUsd != null && budgetTotalUsd > 0 && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 16,
          }}
        >
          <span>Total budget:</span>
          <span style={{ fontFamily: token.fontFamilyCode }}>
            {formatCost(budgetTotalUsd)} ({Math.round((displayCost.totalCost / budgetTotalUsd) * 100)}%)
          </span>
        </div>
      )}
    </div>
  );

  return (
    <Tooltip title={tooltipContent} placement="bottom">
      <Tag
        icon={<DollarOutlined style={{ fontSize: 12 }} />}
        color={pillColor}
        style={{ cursor: 'default' }}
      >
        <span style={{ fontFamily: token.fontFamilyCode, lineHeight: 1 }}>
          {formatCost(displayCost.periodCost)} / {displayCost.periodDays}d
        </span>
      </Tag>
    </Tooltip>
  );
};

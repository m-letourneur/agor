/**
 * BoardCostPill - Compact cost display for the AppHeader
 *
 * Shows board cost for the current period with a tooltip for detailed breakdown.
 * Color-codes based on budget proximity when budget limits are set.
 */

import { CheckOutlined, DollarOutlined, DownOutlined } from '@ant-design/icons';
import { Dropdown, type MenuProps, Skeleton, Space, Tag, Tooltip, theme } from 'antd';
import type React from 'react';
import type { BoardCostData } from '../../hooks/useBoardCost';

/** Period options for cost filtering */
export interface PeriodOption {
  label: string;
  days: number | null; // null = all time
  key: string;
}

export const PERIOD_OPTIONS: PeriodOption[] = [
  { label: 'Today', days: 1, key: 'today' },
  { label: 'Last 7 days', days: 7, key: '7d' },
  { label: 'Last 30 days', days: 30, key: '30d' },
  { label: 'All time', days: null, key: 'all' },
];

export interface BoardCostPillProps {
  /** Cost data from useBoardCost hook */
  cost: BoardCostData | null;
  /** Whether cost data is still loading */
  loading?: boolean;
  /** Daily budget limit in USD (null = no limit) */
  budgetDailyUsd?: number | null;
  /** Total budget limit in USD (null = no limit) */
  budgetTotalUsd?: number | null;
  /** Selected period in days (null = all time) */
  selectedPeriodDays: number | null;
  /** Callback when period selection changes */
  onPeriodChange: (days: number | null) => void;
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
 * Format period label for display in pill
 * - 1 day: "today"
 * - 7+ days: "7d", "30d"
 * - null (all time): "all"
 */
function getPeriodLabel(days: number | null): string {
  if (days === null) return 'all';
  if (days === 1) return 'today';
  return `${days}d`;
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
  selectedPeriodDays,
  onPeriodChange,
}) => {
  const { token } = theme.useToken();
  const [dropdownOpen, setDropdownOpen] = React.useState(false);

  // Build dropdown menu items with checkmark on selected period
  const periodMenuItems: MenuProps['items'] = PERIOD_OPTIONS.map((option) => ({
    key: option.key,
    label: option.label,
    icon: selectedPeriodDays === option.days ? <CheckOutlined /> : null,
    onClick: () => onPeriodChange(option.days),
  }));

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

  // Determine if showing all-time data (no period filter)
  const isAllTime = selectedPeriodDays === null;

  const tooltipContent = (
    <div style={{ minWidth: 180 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Board Cost</div>
      {!isAllTime && (
        <>
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
        </>
      )}
      {isAllTime && (
        <>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 16,
            }}
          >
            <span>Total cost:</span>
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
            <span>Total tasks:</span>
            <span style={{ fontFamily: token.fontFamilyCode }}>{displayCost.totalTaskCount}</span>
          </div>
        </>
      )}
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
          <span style={{ fontFamily: token.fontFamilyCode }}>{formatCost(budgetDailyUsd)}</span>
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
            {formatCost(budgetTotalUsd)} (
            {Math.round((displayCost.totalCost / budgetTotalUsd) * 100)}%)
          </span>
        </div>
      )}
    </div>
  );

  return (
    <Tooltip title={tooltipContent} placement="bottom" open={dropdownOpen ? false : undefined}>
      <Dropdown
        menu={{ items: periodMenuItems }}
        trigger={['click']}
        placement="bottomLeft"
        onOpenChange={setDropdownOpen}
      >
        <Tag
          icon={<DollarOutlined style={{ fontSize: 12 }} />}
          color={pillColor}
          style={{ cursor: 'pointer' }}
        >
          <Space size={4}>
            <span style={{ fontFamily: token.fontFamilyCode, lineHeight: 1 }}>
              {formatCost(isAllTime ? displayCost.totalCost : displayCost.periodCost)} /{' '}
              {getPeriodLabel(selectedPeriodDays)}
            </span>
            <DownOutlined style={{ fontSize: 10, opacity: 0.6 }} />
          </Space>
        </Tag>
      </Dropdown>
    </Tooltip>
  );
};

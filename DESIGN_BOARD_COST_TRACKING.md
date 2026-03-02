# Board-Level Cost Tracking - Design Document

**Status:** Design Phase
**Branch:** `design-board-cost-tracking`
**Author:** Claude Code (Design Agent)
**Date:** 2026-03-02

---

## Executive Summary

Add board-level cost tracking and analytics to provide visibility into AI agent usage costs at the project/sprint level. This feature enables developer awareness and PM-level tracking, with a foundation for future budget constraints.

### Key Decisions

1. **Query-time aggregation** - Leverage existing leaderboard service, no materialized views
2. **Worktree-centric** - Filter via `worktrees.board_id` (canonical relationship)
3. **Time period presets** - Today, Week, Month, Sprint (from board custom context)
4. **Phase 2 preparation** - Add `board_budgets` schema now for future enforcement

---

## Use Cases

### Primary (P0)

1. **Developer Awareness** - "How much am I spending on this feature?"
   - See cost badges on worktree cards
   - Quick summary in board header
   - Track personal usage patterns

2. **PM-Level Tracking** - "What's the AI cost for this sprint/project?"
   - Board analytics dashboard
   - Cost breakdown by worktree/user
   - Export reports for stakeholders

### Future (P1)

3. **Budget Constraints** - "Limit spending to $X/day or $Y/month"
   - Set board-level budgets
   - Alert at threshold (e.g., 80%)
   - Optional enforcement (block new sessions)

---

## Architecture

### Data Flow

```
boards (board_id)
  ↓ FK
worktrees (board_id, worktree_id)
  ↓ FK
sessions (worktree_id, session_id)
  ↓ FK
tasks (session_id)
  ↓ Contains
normalized_sdk_response { tokenUsage, costUsd }
```

**Key Insight:** Both `sessions` and `worktrees` have `board_id` columns, enabling efficient filtering without JSON parsing.

### Query Strategy

**Recommended approach:** Filter via `worktrees.board_id` (more accurate than stale `sessions.board_id`)

```sql
SELECT
  SUM(CAST(json_extract(tasks.data, '$.normalized_sdk_response.tokenUsage.totalTokens') AS INTEGER)) as total_tokens,
  SUM(CAST(json_extract(tasks.data, '$.normalized_sdk_response.costUsd') AS REAL)) as total_cost,
  COUNT(DISTINCT tasks.task_id) as task_count
FROM tasks
JOIN sessions ON tasks.session_id = sessions.session_id
JOIN worktrees ON sessions.worktree_id = worktrees.worktree_id
WHERE worktrees.board_id = ?
  AND tasks.created_at >= ?
  AND tasks.created_at <= ?
GROUP BY worktrees.worktree_id;
```

---

## API Specification

### Extend Leaderboard Service

**File:** `apps/agor-daemon/src/services/leaderboard.ts`

**New query parameters:**

```typescript
export interface LeaderboardQuery {
  // Existing filters
  userId?: string;
  worktreeId?: string;
  repoId?: string;

  // NEW: Board filter
  boardId?: string;  // Filter by board (joins through worktrees.board_id)

  // Enhanced time filters
  startDate?: string; // ISO timestamp (existing)
  endDate?: string;   // ISO timestamp (existing)
  period?: 'today' | 'week' | 'month' | 'all'; // NEW: Convenience presets

  // Existing grouping/sorting/pagination
  groupBy?: 'user' | 'worktree' | 'repo' | 'user,worktree' | 'user,repo' | 'worktree,repo' | 'user,worktree,repo';
  sortBy?: 'tokens' | 'cost';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}
```

**Implementation notes:**

1. Add `boardId` filter to WHERE clause:
   ```typescript
   if (boardId) {
     conditions.push(eq(worktrees.board_id, boardId));
   }
   ```

2. Convert period presets to date ranges:
   ```typescript
   function parsePeriod(period?: string): { startDate?: Date; endDate?: Date } {
     const now = new Date();
     switch (period) {
       case 'today':
         return { startDate: new Date(now.setHours(0,0,0,0)), endDate: new Date() };
       case 'week':
         return { startDate: new Date(now.setDate(now.getDate()-7)), endDate: new Date() };
       case 'month':
         return { startDate: new Date(now.setMonth(now.getMonth()-1)), endDate: new Date() };
       default:
         return {};
     }
   }
   ```

### Convenience Endpoint (Optional)

**Route:** `GET /boards/:id/analytics`

**Implementation:** Add hook to boards service:

```typescript
// apps/agor-daemon/src/index.ts
app.service('boards').hooks({
  after: {
    get: [
      async (context) => {
        if (context.params.query?.include_analytics) {
          const analytics = await app.service('leaderboard').find({
            query: {
              boardId: context.result.board_id,
              period: 'all',
              groupBy: 'worktree',
              sortBy: 'cost',
              limit: 10,
            }
          });
          context.result.analytics = analytics;
        }
        return context;
      }
    ]
  }
});
```

**Usage:**
```typescript
const board = await client.service('boards').get(boardId, {
  query: { include_analytics: true }
});
// board.analytics contains top 10 worktrees by cost
```

---

## UI Design

### 1. Board Header Cost Display

**Component:** `BoardCostSummary.tsx`
**Location:** Board header, next to board name/emoji
**File:** `apps/agor-ui/src/components/BoardHeader/BoardCostSummary.tsx`

**Visual Design:**
```
🧠 Update Agor    💰 $2.34 today | $12.56 this sprint   [80%]
                  └─ Click to open analytics drawer ─┘
```

**Props:**
```typescript
interface BoardCostSummaryProps {
  boardId: string;
  period: 'today' | 'week' | 'month' | 'sprint' | 'all';
  onPeriodChange?: (period: string) => void;
  onClick?: () => void; // Open analytics drawer
}
```

**Data fetching:**
```typescript
const { data: analytics } = useQuery({
  queryKey: ['board-analytics', boardId, period],
  queryFn: () => client.service('leaderboard').find({
    query: { boardId, period, groupBy: 'worktree', sortBy: 'cost', limit: 100 }
  }),
  refetchInterval: 30000, // Refresh every 30s
});
```

**Real-time updates:**
```typescript
useEffect(() => {
  const handleTaskUpdate = (task: Task) => {
    // Invalidate cache when task completes on this board
    const session = sessionsMap.get(task.session_id);
    if (session?.board_id === boardId) {
      queryClient.invalidateQueries(['board-analytics', boardId]);
    }
  };

  client.service('tasks').on('patched', handleTaskUpdate);
  return () => client.service('tasks').removeListener('patched', handleTaskUpdate);
}, [boardId]);
```

---

### 2. Board Analytics Drawer

**Component:** `BoardAnalyticsDrawer.tsx`
**Location:** Right-side drawer (like conversation panel)
**File:** `apps/agor-ui/src/components/BoardAnalyticsDrawer/BoardAnalyticsDrawer.tsx`

**Trigger:** Click cost display in board header OR "Analytics" button in board menu

**Structure:**

```tsx
<Drawer
  title="📊 Board Analytics"
  placement="right"
  width={480}
  open={open}
  onClose={onClose}
>
  <Space direction="vertical" size="large" style={{ width: '100%' }}>

    {/* Time Period Selector */}
    <Select
      value={period}
      onChange={setPeriod}
      options={[
        { label: 'Today', value: 'today' },
        { label: 'This Week', value: 'week' },
        { label: 'This Month', value: 'month' },
        { label: 'All Time', value: 'all' },
        // Dynamic sprint option if board.custom_context.sprint exists
        ...(sprintDates ? [{ label: `Sprint ${sprintDates.number}`, value: 'sprint' }] : [])
      ]}
    />

    {/* Summary Cards */}
    <Row gutter={16}>
      <Col span={12}>
        <Statistic title="Total Cost" value={totalCost} prefix="$" precision={2} />
      </Col>
      <Col span={12}>
        <Statistic title="Total Tokens" value={totalTokens} formatter={v => v.toLocaleString()} />
      </Col>
    </Row>

    {/* Cost Trend Chart (recharts) */}
    <Card title="Cost Trend (Last 7 Days)">
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={dailyCosts}>
          <XAxis dataKey="date" />
          <YAxis />
          <Tooltip />
          <Line type="monotone" dataKey="cost" stroke={token.colorPrimary} />
        </LineChart>
      </ResponsiveContainer>
    </Card>

    {/* Top Worktrees by Cost */}
    <Card title="🏆 Top Worktrees by Cost">
      <List
        dataSource={topWorktrees}
        renderItem={(item) => (
          <List.Item>
            <List.Item.Meta
              title={item.worktreeName}
              description={`${item.totalTokens.toLocaleString()} tokens`}
            />
            <Space direction="vertical" align="end">
              <Text strong>${item.totalCost.toFixed(2)}</Text>
              <Progress
                percent={Math.round((item.totalCost / totalCost) * 100)}
                size="small"
                showInfo={false}
              />
            </Space>
          </List.Item>
        )}
      />
    </Card>

    {/* Top Users by Cost */}
    <Card title="👥 Top Users by Cost">
      {/* Similar structure to Top Worktrees */}
    </Card>

    {/* Actions */}
    <Space>
      <Button icon={<DownloadOutlined />} onClick={exportCSV}>
        Export CSV
      </Button>
      <Button icon={<SettingOutlined />} onClick={openBudgetSettings}>
        Budget Settings
      </Button>
    </Space>

  </Space>
</Drawer>
```

**Data fetching:**
```typescript
// Multiple queries for different groupings
const { data: worktreeBreakdown } = useQuery({
  queryKey: ['board-analytics', boardId, period, 'worktree'],
  queryFn: () => client.service('leaderboard').find({
    query: { boardId, period, groupBy: 'worktree', sortBy: 'cost', limit: 10 }
  }),
});

const { data: userBreakdown } = useQuery({
  queryKey: ['board-analytics', boardId, period, 'user'],
  queryFn: () => client.service('leaderboard').find({
    query: { boardId, period, groupBy: 'user', sortBy: 'cost', limit: 10 }
  }),
});
```

---

### 3. Worktree Card Cost Badge

**Component:** Update existing `WorktreeCard.tsx`
**File:** `apps/agor-ui/src/components/WorktreeCard/WorktreeCard.tsx`

**Addition to card header:**
```tsx
<Space size="small">
  {/* Existing content: name, status, etc. */}

  {/* NEW: Cost badge */}
  {worktreeCost > 0 && (
    <Tooltip
      title={`${totalTokens.toLocaleString()} tokens across ${sessionCount} sessions`}
    >
      <Tag icon={<DollarOutlined />} color="success">
        ${worktreeCost.toFixed(2)}
      </Tag>
    </Tooltip>
  )}
</Space>
```

**Data fetching:**
```typescript
// In WorktreeCard or parent component
const { data: worktreeAnalytics } = useQuery({
  queryKey: ['worktree-cost', worktreeId],
  queryFn: () => client.service('leaderboard').find({
    query: {
      worktreeId,
      groupBy: 'worktree',
      limit: 1,
    }
  }),
  staleTime: 60000, // Cache for 1 minute
});

const worktreeCost = worktreeAnalytics?.data[0]?.totalCost || 0;
const totalTokens = worktreeAnalytics?.data[0]?.totalTokens || 0;
```

---

## Time Period Handling

### Sprint Support

Boards can define sprint dates in custom context:

```typescript
// Board.custom_context
{
  "sprint": {
    "number": 42,
    "startDate": "2026-03-01T00:00:00Z",
    "endDate": "2026-03-14T23:59:59Z"
  }
}
```

**UI Integration:**
```typescript
// In BoardAnalyticsDrawer
const sprintDates = board?.custom_context?.sprint;

const periodOptions = [
  { label: 'Today', value: 'today' },
  { label: 'This Week', value: 'week' },
  { label: 'This Month', value: 'month' },
  { label: 'All Time', value: 'all' },
];

if (sprintDates) {
  periodOptions.push({
    label: `Sprint ${sprintDates.number}`,
    value: 'sprint',
    // Pass custom dates to API
    startDate: sprintDates.startDate,
    endDate: sprintDates.endDate,
  });
}
```

**Backend handling:**
```typescript
// In LeaderboardService
if (period === 'sprint') {
  // Check board custom_context for sprint dates
  const board = await boardsRepo.findById(boardId);
  const sprintDates = board?.custom_context?.sprint;
  if (sprintDates) {
    startDate = sprintDates.startDate;
    endDate = sprintDates.endDate;
  }
}
```

---

## Budget Schema (Phase 2 Foundation)

Add schema now to inform UI design, implement enforcement in Phase 2.

**New table:** `board_budgets`

```typescript
// packages/core/src/db/schema.sqlite.ts (and .postgres.ts)

export const boardBudgets = sqliteTable('board_budgets', {
  board_id: text('board_id', { length: 36 })
    .primaryKey()
    .references(() => boards.board_id, { onDelete: 'cascade' }),

  // Budget limits (null = no limit set)
  daily_limit_usd: real('daily_limit_usd'),
  monthly_limit_usd: real('monthly_limit_usd'),

  // Alert threshold (percentage, e.g., 80 = alert at 80% of limit)
  alert_threshold: integer('alert_threshold').default(80),

  // Enforcement (Phase 2 - when true, block sessions when limit exceeded)
  enforce: t.bool('enforce').notNull().default(false),

  // Metadata
  created_at: t.timestamp('created_at').notNull(),
  updated_at: t.timestamp('updated_at'),
  created_by: text('created_by', { length: 36 }),
});
```

**Migration:**
```sql
-- migrations/0XXX_add_board_budgets.sql
CREATE TABLE board_budgets (
  board_id TEXT PRIMARY KEY REFERENCES boards(board_id) ON DELETE CASCADE,
  daily_limit_usd REAL,
  monthly_limit_usd REAL,
  alert_threshold INTEGER DEFAULT 80,
  enforce INTEGER DEFAULT 0 NOT NULL,  -- Boolean in SQLite
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  created_by TEXT
);

CREATE INDEX idx_board_budgets_board_id ON board_budgets(board_id);
```

**Type definition:**
```typescript
// packages/core/src/types/board.ts

export interface BoardBudget {
  board_id: BoardID;
  daily_limit_usd?: number;
  monthly_limit_usd?: number;
  alert_threshold: number; // Percentage (0-100)
  enforce: boolean;
  created_at: string;
  updated_at?: string;
  created_by?: string;
}
```

**Service (Phase 2):**
```typescript
// apps/agor-daemon/src/services/board-budgets.ts
import { createDrizzleService } from '@agor/core/db';
import { boardBudgets } from '@agor/core/db/schema';

export const createBoardBudgetsService = (db: Database) => {
  return createDrizzleService(db, boardBudgets, {
    primaryKey: 'board_id',
  });
};
```

---

## MCP Integration

### Extend Existing Tool

**File:** `apps/agor-daemon/src/mcp/routes.ts`

**Update `agor_analytics_leaderboard` description and schema:**

```typescript
{
  name: 'agor_analytics_leaderboard',
  description:
    'Get usage analytics leaderboard showing token and cost breakdown. ' +
    'Supports dynamic grouping by user, worktree, repo, or board. ' +
    'Use boardId parameter to scope to a specific board. ' +
    'Use period parameter for convenient time ranges (today, week, month).',
  inputSchema: {
    type: 'object',
    properties: {
      // ... existing properties (userId, worktreeId, repoId, startDate, endDate, groupBy, sortBy, sortOrder, limit, offset) ...

      // NEW
      boardId: {
        type: 'string',
        description: 'Filter by board ID (UUIDv7 or short ID)',
      },
      period: {
        type: 'string',
        enum: ['today', 'week', 'month', 'all'],
        description: 'Convenience time period preset (overrides startDate/endDate if provided)',
      },
    },
  },
}
```

**Implementation:**
```typescript
case 'agor_analytics_leaderboard': {
  const {
    userId,
    worktreeId,
    repoId,
    boardId, // NEW
    startDate,
    endDate,
    period, // NEW
    groupBy = 'user,worktree,repo',
    sortBy = 'cost',
    sortOrder = 'desc',
    limit = 50,
    offset = 0,
  } = args;

  // Parse period into date range
  let finalStartDate = startDate;
  let finalEndDate = endDate;
  if (period && period !== 'all') {
    const dates = parsePeriod(period);
    finalStartDate = dates.startDate?.toISOString();
    finalEndDate = dates.endDate?.toISOString();
  }

  const leaderboard = await app.service('leaderboard').find({
    query: {
      userId,
      worktreeId,
      repoId,
      boardId, // NEW
      startDate: finalStartDate,
      endDate: finalEndDate,
      groupBy,
      sortBy,
      sortOrder,
      limit,
      offset,
    },
  });

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(leaderboard, null, 2),
    }],
  };
}
```

### Add Helper Tool (Optional)

**New tool:** `agor_boards_get_cost_summary`

```typescript
{
  name: 'agor_boards_get_cost_summary',
  description:
    'Get cost summary for a board. Convenience wrapper around analytics leaderboard. ' +
    'Returns aggregated totals and top worktrees/users by cost.',
  inputSchema: {
    type: 'object',
    properties: {
      boardId: {
        type: 'string',
        description: 'Board ID (required)',
      },
      period: {
        type: 'string',
        enum: ['today', 'week', 'month', 'all'],
        default: 'all',
        description: 'Time period for cost calculation',
      },
      topN: {
        type: 'number',
        default: 5,
        description: 'Number of top worktrees/users to include',
      },
    },
    required: ['boardId'],
  },
}
```

**Implementation:**
```typescript
case 'agor_boards_get_cost_summary': {
  const { boardId, period = 'all', topN = 5 } = args;

  // Fetch worktree breakdown
  const worktreeBreakdown = await app.service('leaderboard').find({
    query: {
      boardId,
      period,
      groupBy: 'worktree',
      sortBy: 'cost',
      limit: topN,
    }
  });

  // Fetch user breakdown
  const userBreakdown = await app.service('leaderboard').find({
    query: {
      boardId,
      period,
      groupBy: 'user',
      sortBy: 'cost',
      limit: topN,
    }
  });

  // Calculate totals
  const totalCost = worktreeBreakdown.data.reduce((sum, row) => sum + row.totalCost, 0);
  const totalTokens = worktreeBreakdown.data.reduce((sum, row) => sum + row.totalTokens, 0);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        boardId,
        period,
        summary: {
          totalCost,
          totalTokens,
          taskCount: worktreeBreakdown.data.reduce((sum, row) => sum + row.taskCount, 0),
        },
        topWorktrees: worktreeBreakdown.data,
        topUsers: userBreakdown.data,
      }, null, 2),
    }],
  };
}
```

**Usage example (for agents):**
```typescript
// Claude Code agent querying board costs
const summary = await mcp.call('agor_boards_get_cost_summary', {
  boardId: 'current', // Special value: current board
  period: 'week',
  topN: 3,
});

console.log(`This board has spent $${summary.totalCost} this week`);
```

---

## Implementation Phases

### Phase 1: Backend Foundation (3-4 hours)

1. **Extend LeaderboardService** (1.5h)
   - Add `boardId` filter to WHERE clause
   - Add `period` preset parsing
   - Write unit tests for board filtering
   - Test with various groupBy combinations

2. **Add board_budgets schema** (1h)
   - Create migration files (SQLite + Postgres)
   - Add types to `@agor/core/types`
   - Create board-budgets service (basic CRUD)
   - Register service in daemon

3. **MCP Integration** (0.5h)
   - Update `agor_analytics_leaderboard` schema
   - Add `agor_boards_get_cost_summary` helper
   - Update MCP documentation

4. **Testing** (1h)
   - Integration tests for board cost queries
   - Test time period presets
   - Verify cross-database compatibility (SQLite + Postgres)

---

### Phase 2: UI Components (4-5 hours)

1. **BoardCostSummary Component** (1.5h)
   - Create component with period selector
   - Add real-time updates via WebSocket
   - Integrate with board header
   - Add loading/error states

2. **BoardAnalyticsDrawer Component** (2h)
   - Create drawer with all sections
   - Add cost trend chart (recharts)
   - Implement top worktrees/users lists
   - Add export to CSV functionality

3. **WorktreeCard Cost Badge** (0.5h)
   - Add cost badge to card header
   - Implement tooltip with breakdown
   - Add cost query hook

4. **Testing & Polish** (1h)
   - Test responsive layouts
   - Verify Ant Design token usage
   - Check dark mode compatibility
   - Test real-time updates

---

### Phase 3: Budget Settings UI (2-3 hours) - Phase 2 Feature Foundation

1. **BudgetSettingsModal Component** (1.5h)
   - Form for daily/monthly limits
   - Alert threshold slider
   - Enforcement toggle (disabled with tooltip: "Coming in Phase 2")
   - Save/cancel buttons

2. **Budget Indicator in BoardCostSummary** (0.5h)
   - Show percentage of budget used
   - Color-code based on threshold (green/yellow/red)
   - Tooltip with remaining budget

3. **Alert System (stub)** (1h)
   - Create alert service (no-op for now)
   - Add hooks for budget threshold checks
   - Log warnings (don't enforce yet)
   - UI notification when threshold exceeded

---

### Phase 4: Future Enhancements (Phase 2+)

**Budget Enforcement:**
- Block session creation when budget exceeded
- Grace period settings
- Override permissions for admins

**Advanced Analytics:**
- Cost forecasting (trend-based)
- Comparative analytics (board vs board)
- Historical snapshots for point-in-time analysis
- Cost allocation by zone

**Integrations:**
- Slack notifications for budget alerts
- CSV/PDF export with charts
- Webhook for cost events

---

## Edge Cases & Considerations

### 1. Archived Worktrees

**Question:** Should archived worktrees' costs count toward board totals?

**Decision:** Yes, with filter toggle
- Default: Include archived (shows true project cost)
- Optional: Exclude archived (shows only active work)
- UI: Checkbox in analytics drawer "Include archived worktrees"

**Implementation:**
```typescript
// Add filter to leaderboard query
if (!includeArchived) {
  conditions.push(eq(worktrees.archived, false));
}
```

---

### 2. Worktrees Moved Between Boards

**Question:** How to attribute costs when worktree moves from Board A to Board B?

**Decision:** Costs stay with task creation time, not current board position

**Rationale:**
- Tasks are immutable once created
- Historical accuracy matters for reporting
- Moving a worktree shouldn't change past spending

**Implication:**
- Board A will retain costs for tasks created when worktree was on Board A
- Board B will only show costs for tasks created after worktree moved to Board B
- This is correct behavior (tracks actual work done on each board)

**Edge case:** If user wants to see "all costs for worktree X regardless of board":
```typescript
// Query by worktreeId instead of boardId
const costs = await leaderboard.find({
  query: { worktreeId, groupBy: 'worktree' }
});
```

---

### 3. Sessions Without Boards

**Question:** What if session has no board_id?

**Decision:** Exclude from board-scoped queries

**Implementation:** Already handled by WHERE clause
```sql
WHERE worktrees.board_id = ?  -- NULL worktrees.board_id won't match
```

**UI:** No impact (board analytics only shows work done on that board)

---

### 4. Multiple Boards Displaying Same Worktree

**Question:** Can a worktree appear on multiple boards? How does cost attribution work?

**Decision:** Worktrees have ONE canonical board (via `worktrees.board_id`)

**Rationale:**
- Worktree table has single `board_id` column (not many-to-many)
- A worktree belongs to one board at a time
- Moving worktree updates `board_id` to new board

**Note:** This is different from sessions, which can be pinned to zones. Worktrees are the board's primary entities.

---

### 5. Real-time Updates Performance

**Question:** Will real-time cost updates cause performance issues on large boards?

**Mitigation strategies:**
1. **Debouncing:** Batch invalidations (max 1 refetch per 5 seconds)
2. **Selective invalidation:** Only invalidate if task's session is on current board
3. **Stale-while-revalidate:** Show cached data while fetching updates
4. **Query caching:** React Query deduplicates parallel requests

**Implementation:**
```typescript
// In BoardCostSummary
const { data } = useQuery({
  queryKey: ['board-analytics', boardId, period],
  queryFn: fetchAnalytics,
  staleTime: 5000, // Consider data fresh for 5 seconds
  refetchInterval: 30000, // Auto-refetch every 30s
});

// Debounced invalidation
const invalidateAnalytics = useDebouncedCallback(
  () => queryClient.invalidateQueries(['board-analytics', boardId]),
  5000 // Wait 5s after last task update
);

useEffect(() => {
  client.service('tasks').on('patched', invalidateAnalytics);
  return () => client.service('tasks').removeListener('patched', invalidateAnalytics);
}, []);
```

---

### 6. Time Zone Handling

**Question:** How do we handle "today" for users in different time zones?

**Decision:** Use server time zone (UTC) for consistency

**Rationale:**
- Cost tracking is for administrative purposes (not user-facing deadlines)
- Consistent reporting across all users on a board
- Simplifies implementation (no per-user time zone conversion)

**Alternative (Phase 2):** Allow board-level time zone setting
```typescript
// Board custom_context
{
  "timezone": "America/New_York"
}
```

---

### 7. CSV Export Format

**Question:** What should the CSV export include?

**Decision:** Include all breakdown dimensions with metadata

**Format:**
```csv
Date Exported,Board Name,Time Period,Total Cost,Total Tokens
2026-03-02,Update Agor,This Week,$12.56,420000

Breakdown by Worktree
Worktree Name,Tokens,Cost,Task Count,% of Total
design-board-cost-tracking,150000,$5.23,12,42%
bugfix-login,100000,$3.12,8,25%
...

Breakdown by User
User,Email,Tokens,Cost,Task Count,% of Total
Alice,alice@example.com,200000,$6.78,15,54%
Bob,bob@example.com,150000,$4.23,10,34%
...
```

**Implementation:**
```typescript
function exportToCSV(boardName: string, period: string, data: LeaderboardResult) {
  const totalCost = data.data.reduce((sum, r) => sum + r.totalCost, 0);
  const totalTokens = data.data.reduce((sum, r) => sum + r.totalTokens, 0);

  let csv = `Date Exported,Board Name,Time Period,Total Cost,Total Tokens\n`;
  csv += `${new Date().toISOString()},${boardName},${period},$${totalCost},${totalTokens}\n\n`;

  csv += `Breakdown\n`;
  csv += `Name,Tokens,Cost,Task Count,% of Total\n`;
  data.data.forEach(row => {
    const pct = ((row.totalCost / totalCost) * 100).toFixed(1);
    csv += `${row.worktreeName || row.userName},${row.totalTokens},$${row.totalCost},${row.taskCount},${pct}%\n`;
  });

  return csv;
}

// Trigger download
const blob = new Blob([csv], { type: 'text/csv' });
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = `board-analytics-${boardId}-${period}-${Date.now()}.csv`;
a.click();
```

---

## Testing Strategy

### Backend Tests

1. **Leaderboard Service with boardId filter**
   ```typescript
   test('filters tasks by board via worktrees', async () => {
     // Create board, worktrees, sessions, tasks
     const result = await leaderboard.find({
       query: { boardId: board1.board_id }
     });
     expect(result.data.length).toBe(2); // Only worktrees on board1
   });
   ```

2. **Time period presets**
   ```typescript
   test('period=today returns tasks from today only', async () => {
     // Create tasks yesterday and today
     const result = await leaderboard.find({
       query: { boardId, period: 'today' }
     });
     // Assert only today's tasks included
   });
   ```

3. **Cross-database compatibility**
   ```typescript
   test('board filtering works in PostgreSQL', async () => {
     // Run same tests with AGOR_DB_DIALECT=postgresql
   });
   ```

---

### UI Tests (Storybook + Manual)

1. **BoardCostSummary States**
   - Loading state
   - Error state
   - Zero cost
   - High cost (>$100)
   - Near budget limit (85%, 95%, 100%)

2. **BoardAnalyticsDrawer**
   - Empty state (no tasks)
   - With data (charts render correctly)
   - Period switching
   - Export CSV functionality

3. **WorktreeCard Cost Badge**
   - Hidden when cost = 0
   - Tooltip shows breakdown
   - Updates in real-time

---

### Integration Tests

1. **Real-time updates**
   - Complete a task → verify board cost updates
   - Multiple tasks in rapid succession → verify debouncing

2. **Board movement**
   - Move worktree from Board A to Board B
   - Verify costs attributed to correct board by time period

3. **Performance**
   - Large board (100+ worktrees)
   - Verify query performance <200ms
   - Verify UI remains responsive

---

## Success Metrics

### Phase 1 (Implementation)

- ✅ Leaderboard service accepts `boardId` parameter
- ✅ Period presets work correctly (today, week, month)
- ✅ Board cost queries return accurate data
- ✅ MCP tools support board-scoped queries
- ✅ All tests passing (unit + integration)

### Phase 2 (Adoption)

- 📈 % of boards with cost tracking viewed weekly
- 📈 % of users who open analytics drawer
- 📈 % of boards with budget settings configured
- 📈 Average time to discover cost overruns (target: <24h)

### Phase 3 (Value)

- 💰 Reduction in unexpected AI spend
- 💰 % of boards staying within budget
- 💰 PM satisfaction with cost visibility (survey)
- 💰 Developer awareness of personal usage patterns

---

## Open Questions for Implementation

### 1. Budget Alert Mechanism (Phase 2)

**Options:**
- A) In-app notification only
- B) Email alerts
- C) Slack webhooks
- D) All of the above

**Recommendation:** Start with A (in-app), add B/C based on user feedback

---

### 2. Cost Forecast Feature (Future)

**Options:**
- A) Linear trend-based ("At this rate, you'll spend $X this month")
- B) ML-based prediction (analyze historical patterns)
- C) None (just show current spend)

**Recommendation:** Start with C (current spend), add A in Phase 3 if requested

---

### 3. Zone-Based Cost Tracking (Future)

**Idea:** Track costs per zone (Design, In Progress, etc.)

**Use case:** "How much does code review cost vs initial development?"

**Implementation:** Add `zone_id` grouping dimension to leaderboard service

**Priority:** Low (zones are workflow stages, not cost centers)

---

### 4. Privacy Settings

**Question:** Should individual user costs be visible to all board members?

**Options:**
- A) Fully visible (default, aligns with multiplayer transparency)
- B) Admins only
- C) Configurable per board

**Recommendation:** Start with A (fully visible), add privacy controls if users request

**Rationale:**
- Agor is built for collaboration and transparency
- Knowing who's spending what can help balance workload
- Users can already see who's working on what (session attribution)

---

## Documentation Updates Needed

### User-Facing Docs

1. **Feature announcement**
   - Blog post: "Introducing Board-Level Cost Tracking"
   - What's new in release notes

2. **User guide**
   - How to view board analytics
   - Setting up budgets
   - Understanding cost breakdowns
   - Exporting reports

3. **Admin guide**
   - Configuring budget enforcement (Phase 2)
   - Best practices for cost management
   - Interpreting analytics data

### Developer Docs

1. **API reference**
   - Leaderboard service query parameters
   - Board budgets API

2. **MCP tools**
   - `agor_analytics_leaderboard` updated docs
   - `agor_boards_get_cost_summary` usage examples

3. **Database schema**
   - `board_budgets` table documentation
   - Migration guide

---

## Rollout Plan

### Phase 1: Internal Testing (Week 1)

- Deploy to staging environment
- Internal team uses feature for 1 week
- Gather feedback on UX and accuracy
- Fix any bugs or performance issues

### Phase 2: Beta Release (Week 2)

- Announce feature to beta users
- Monitor usage patterns
- Collect feedback via in-app survey
- Iterate on UI based on feedback

### Phase 3: General Availability (Week 3)

- Announce feature to all users
- Publish blog post + docs
- Monitor analytics (adoption metrics)
- Plan Phase 2 (budget enforcement) based on feedback

---

## Related Documentation

- [agent-accounting.md](./context/concepts/agent-accounting.md) - Token tracking architecture
- [board-objects.md](./context/concepts/board-objects.md) - Board data model
- [models.md](./context/concepts/models.md) - Core data models
- [frontend-guidelines.md](./context/concepts/frontend-guidelines.md) - UI patterns

---

## Conclusion

This design provides a solid foundation for board-level cost tracking that:

1. **Leverages existing infrastructure** - No major refactoring needed
2. **Scales with usage** - Query-time aggregation is sufficient for current scale
3. **Prepares for future features** - Budget schema lays groundwork for enforcement
4. **Aligns with user mental model** - Boards are the unit users think about

**Key success factors:**
- Simple, intuitive UI (one-click access to analytics)
- Real-time updates (immediate feedback on spending)
- Actionable insights (not just data, but guidance)

**Next steps:**
- Get approval on design decisions
- Begin Phase 1 implementation (backend)
- Iterate on UI based on user feedback

---

**Design Status:** ✅ Complete - Ready for implementation approval

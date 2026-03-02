# Board Cost Tracking - Manual Test Plan

## Backend Implementation Testing

### ✅ Phase 1 Completion Checklist

#### 1. LeaderboardService - Board Filter
- [x] `boardId` parameter added to interface
- [x] `period` parameter added to interface
- [x] `parsePeriod()` helper function created
- [x] Board filter applied in WHERE clause
- [x] Period preset parsing implemented
- [x] TypeScript compilation passes

#### 2. Board Budgets Schema
- [x] Migration file created (0002_add_board_budgets.sql)
- [x] SQLite schema updated
- [x] PostgreSQL schema updated
- [x] Table exports added to schema.ts
- [x] Type exports added (BoardBudgetRow, BoardBudgetInsert)

#### 3. BoardBudget Repository
- [x] Repository class created
- [x] CRUD methods implemented (findById, findAll, create, update, delete, upsert)
- [x] Proper error handling
- [x] Type-safe conversions (rowToBudget, budgetToInsert)
- [x] Exported from repositories/index.ts

#### 4. MCP Integration
- [x] Tool schema updated with boardId parameter
- [x] Tool schema updated with period parameter
- [x] Handler updated to pass new parameters
- [x] Tool description updated

---

## Manual Testing Steps

### Test 1: LeaderboardService - Period Presets

**Setup:**
```bash
# Start daemon in dev mode
cd apps/agor-daemon
pnpm dev
```

**Test via MCP (when daemon is running):**
```typescript
// In a Claude Code session with Agor MCP enabled:
await mcp.call('agor_analytics_leaderboard', {
  period: 'today',
  groupBy: 'worktree',
  sortBy: 'cost',
  limit: 10
});
```

**Expected Result:**
- Returns leaderboard data filtered to today's date range
- No TypeScript errors
- Proper date range calculation

---

### Test 2: LeaderboardService - Board Filter

**Test via API:**
```bash
# Assuming you have a board_id
curl http://localhost:3030/leaderboard?boardId=YOUR_BOARD_ID&period=week
```

**Expected Result:**
- Returns only costs for worktrees on that board
- Grouped and sorted correctly
- Period preset applied

---

### Test 3: BoardBudget Repository - CRUD Operations

**Test via Node REPL (when daemon is running):**
```typescript
// Connect to the database
const { createDatabase } = require('@agor/core/db');
const { BoardBudgetRepository } = require('@agor/core/db');

const db = createDatabase();
const budgetRepo = new BoardBudgetRepository(db);

// Test create
const budget = await budgetRepo.create({
  board_id: 'test-board-id',
  daily_limit_usd: 10.00,
  monthly_limit_usd: 200.00,
  alert_threshold: 80,
  enforce: false,
  created_by: 'test-user'
});

console.log('Created:', budget);

// Test findById
const found = await budgetRepo.findById('test-board-id');
console.log('Found:', found);

// Test update
const updated = await budgetRepo.update('test-board-id', {
  daily_limit_usd: 15.00
});
console.log('Updated:', updated);

// Test delete
await budgetRepo.delete('test-board-id');
console.log('Deleted successfully');
```

**Expected Result:**
- All CRUD operations succeed
- Proper type conversions
- Timestamps populated correctly
- No database errors

---

### Test 4: Database Migration

**Run migration:**
```bash
# Check if migration needs to run
sqlite3 ~/.agor/agor.db ".schema board_budgets"
```

**Expected Result:**
- Table doesn't exist yet (migration not run)
- Migration file is ready to be applied
- Schema matches design spec

**To apply migration (when ready):**
```bash
# This will be done by the daemon on next startup
# or manually via migration script
```

---

## Integration Testing Scenarios

### Scenario 1: Board with Multiple Worktrees
1. Create a board with 3 worktrees
2. Create sessions in each worktree
3. Complete tasks with token usage
4. Query leaderboard with `boardId` and `period=today`
5. Verify costs aggregate correctly

### Scenario 2: Period Preset Accuracy
1. Create tasks at different times:
   - Yesterday
   - Today
   - This week
   - Last month
2. Query with different period presets
3. Verify correct date filtering

### Scenario 3: Board Budget Lifecycle
1. Create a board
2. Set daily budget: $10
3. Set monthly budget: $200
4. Set alert threshold: 80%
5. Query budget
6. Update budget
7. Delete budget

---

## Known Limitations (Phase 1)

- ✅ Budget enforcement is NOT active (enforce flag is no-op)
- ✅ No UI components yet (Phase 2)
- ✅ No real-time alerts at threshold (Phase 2)
- ✅ No automatic session blocking when over budget (Phase 2)

---

## Success Criteria

All of the following must be true:

1. ✅ TypeScript compiles without errors related to our changes
2. ⏳ LeaderboardService accepts and processes boardId parameter
3. ⏳ LeaderboardService accepts and processes period parameter
4. ⏳ Period presets calculate correct date ranges
5. ✅ board_budgets table schema is defined
6. ✅ BoardBudgetRepository implements all CRUD operations
7. ⏳ MCP tool accepts new parameters
8. ⏳ Database migration is ready to apply

### Status Legend
- ✅ Verified (static analysis)
- ⏳ Ready to test (requires running daemon)
- ❌ Failed (needs fix)

---

## Next Steps for Full Testing

To complete the testing:

1. **Start the daemon**: `cd apps/agor-daemon && pnpm dev`
2. **Apply migration**: The daemon should auto-apply on startup, or run manually
3. **Create test data**: Create boards, worktrees, sessions with tasks
4. **Run MCP queries**: Test via Claude Code with Agor MCP
5. **Verify results**: Check that filtering and aggregation work correctly

---

## Notes for Reviewers

- All backend code follows existing patterns (BoardRepository, etc.)
- Type safety maintained throughout
- No breaking changes to existing APIs
- Schema changes are additive only (backward compatible)
- Ready for Phase 2 (UI implementation)

# Lanceglass UI state gallery

Captured from the production UI for `v26.9.1-alpha.1401` at 1600×1000. Every
image uses synthetic data. The routes shown here are durable and refresh-safe;
query parameters preserve the selected workspace, filters, period, date, and
vector inspector state.

## Public static fixture deployment

The [live Cloudflare demo](https://lanceglass-fixture-demo.laris.workers.dev/)
serves this exact React application and a complete mock of its HTTP API. All
1,000 events are synthetic and compiled into the Worker. There is no KV, D1,
R2, database binding, filesystem access, secret, or persistence layer.

### Events and live intake

The header states the storage boundary continuously. Events, facets, source
switching, intake polling, visualization, and the responsive shell use the
same components as the local LanceDB application.

![Cloudflare static demo events workspace](./screenshots/cloudflare-static-events.png)

### Read-only import inspection

Fast Inspect exercises the real modal and plan controls against a deterministic
fixture response. Import confirmation and Jobs can be explored, but the demo
never writes or retains state.

![Cloudflare static demo import plan](./screenshots/cloudflare-static-plan.png)

### History

The fixture API reconstructs a week of session rows across Claude, Codex, four
projects, and four synthetic directories, including expandable session detail
and deterministic vector projections.

![Cloudflare static demo history workspace](./screenshots/cloudflare-static-history.png)

### Jobs

Jobs exposes one completed simulation whose terminal explicitly records the
no-storage boundary. Reloading always returns the same fixture run.

![Cloudflare static demo jobs workspace](./screenshots/cloudflare-static-jobs.png)

## Events workspace

### Stream with pending intake

The left rail explains the selected source, one file that needs attention,
stored row counts, the equivalent CLI command, and the read-only plan state.
The main pane shows normalized canonical blocks and provenance filters.

![Events stream with one pending JSONL file](./screenshots/events-stream-dark.png)

### Visualization and paper theme

The same event scope can switch to chronological activity, block type,
semantic role, project, and directory summaries. Theme changes do not alter
the route or data scope.

![Event visualization in paper theme](./screenshots/events-visualize-paper.png)

## Import states

### Fast metadata plan

Fast Inspect compares tracked file metadata and opens only the actionable
files. It is read-only and keeps the write action inside the plan.

![Fast import plan](./screenshots/import-plan-dark.png)

### Explicit write confirmation

The final confirmation repeats the exact batch size and reminds the operator
that source JSONL files remain unchanged.

![Import confirmation](./screenshots/import-confirm-dark.png)

### Full content-hash inspection

Jobs owns the slower audit path. It verifies every discovered file hash and
shows that both fixture files are already indexed.

![Full source inspection](./screenshots/full-inspection-dark.png)

## Jobs workspace

### Empty state

Before the first UI import, the terminal explains how to create a job instead
of displaying an inert blank panel.

![Empty jobs workspace](./screenshots/jobs-empty-dark.png)

### Completed background import

The job view keeps the selected run, exit state, elapsed time, inserted and
duplicate counts, and the streamed importer output together. A successful run
links directly back to its imported events.

![Completed import job with terminal output](./screenshots/jobs-complete-dark.png)

## History workspace

### Day

Day view is the densest session ledger: date and time first, numbered source,
project and directory, session identity, event count, evidence preview, and
actions remain in one row.

![History day view](./screenshots/history-day-dark.png)

### Week

Week view groups the same rows under large day boundaries so active and empty
days remain easy to scan.

![History week view](./screenshots/history-week-dark.png)

### Month

Month view preserves the day separators and zero-work days while keeping the
selected date as the navigation anchor.

![History month view](./screenshots/history-month-dark.png)

### Expanded session evidence

`View contents` opens the normalized human and agent blocks in place without
losing the day or filter context.

![Expanded history session](./screenshots/history-session-expanded-dark.png)

### Project quick search

`⌘K` focuses the project combobox. Typing narrows the visible project facets
and reports the matching canonical-event count.

![Project quick search](./screenshots/project-quick-search-dark.png)

## Vector-map states

### No vector store connected

The inspector is still useful before embedding: it identifies the requested
deployment, model, dimensions, evidence filters, and the exact missing-store
condition instead of failing the History workspace.

![Vector inspector without a connected store](./screenshots/history-vector-empty-dark.png)

### Atlas 3D plugin

After an explicit embedding run, the inspector reports embedded, mapped,
eligible, and missing counts. The 3D plugin projects only the selected session
and keeps its evidence list keyboard accessible.

![Atlas 3D vector projection](./screenshots/history-vector-3d-dark.png)

### Flat 2D plugin

The same provider result can be rendered by another registered visualization
plugin without changing the backend response or mixing embedding spaces.

![Flat 2D vector projection](./screenshots/history-vector-2d-dark.png)

## State coverage

| Surface | Durable states shown | Transient states implemented |
| --- | --- | --- |
| Events | stream, visualization, pending, aligned | loading, refreshing, live import |
| Import plan | actionable, confirm, fully indexed | inspecting, starting, stale-plan error |
| Jobs | empty, succeeded, terminal output | queued, running, cancelling, cancelled, failed |
| History | day, week, month, expanded session | loading, empty range, retryable error |
| Vector map | unavailable, 3D, 2D | projecting, provider error, mixed-provider comparison |

Transient states intentionally keep the same layout shell, so polling or a
fast fixture job does not resize the action row. Their behavior is covered by
the focused UI and job tests; the screenshots above document every stable
screen an operator returns to after the transition settles.

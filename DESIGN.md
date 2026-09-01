---
name: Lanceglass
description: A dense local console for inspecting bounded JSONL imports and reading indexed conversation events.
themes:
  default: dark
  alternatives:
    - paper
typography:
  interface: "IBM Plex Mono, monospace"
  headings: "IBM Plex Sans Variable, sans-serif"
layout:
  desktop: "control rail + event workspace"
  mobile: "events first, controls second"
---

# Design System: Lanceglass

## Overview

**Creative North Star: “The Local Indexing Console”**

Lanceglass is a dense operational interface for a local database, not a marketing dashboard. It keeps import controls, database evidence, an inspectable plan, canonical events, and aggregate views in one compact workspace. The visual language borrows from terminals and data tools: restrained color, monospaced readings, fine rules, compact controls, and explicit system state.

The interface must remain honest about the boundary between inspection and mutation. Inspecting a plan is read-only. Importing writes only the selected bounded batch. Counts, progress, errors, disabled reasons, paths, and filter scope come from the application rather than decorative placeholder data.

**Key characteristics:**

- Dense, local-first indexing console with event data as the main workspace.
- Dark theme by default, with a persistent Paper theme using the same layout and hierarchy.
- One workspace scroll owner; nested page regions do not compete for scrolling.
- Server-backed event facets for source, Project / Oracle, and Directory / Folder.
- Stream and visualization modes over the same filtered event window.
- A centered, read-only import-plan modal for large file inventories.
- A local live-intake reading that observes files outside LanceDB without mutating the imported event workspace.
- A background Jobs workspace that preserves the CLI's live terminal evidence.
- A calendar History workspace for source/project/folder/session evidence by day.
- Responsive event-first order on mobile.

## Themes and Color

Dark and Paper are equal presentations of one system. Theme changes may alter tokens, contrast, and code surfaces, but must not alter content, layout, interaction order, or information density. The selected theme persists locally and Dark is the fallback when no preference has been saved.

### Dark default

- Near-black background (`#090b0d`) with dark panel, rail, and raised-control surfaces.
- Pale neutral text, muted gray metadata, and fine low-contrast separators.
- Green accent for connection, progress, active selections, and primary actions.
- Blue, amber, violet, and gray distinguish human, assistant, tool-use, and tool-result data.
- Yellow focus, amber warning, and red danger remain functional signals.

### Paper theme

- Warm paper background (`#ebe7dc`) with light panel and rail surfaces.
- Graphite text and rules retain the same density and measured hierarchy as Dark.
- Deep teal replaces bright green while role, warning, danger, and focus colors retain their semantic meaning.
- Dark code blocks preserve command readability and separation from editable fields.

### Named rules

**The Same Instrument Rule.** A theme switch changes tokens, never structure or capability.

**The Operational Color Rule.** Reserve strong color for state, role, focus, progress, errors, and active controls; do not use it as decoration.

## Typography

IBM Plex Mono is the default interface face. Use it for labels, fields, paths, commands, states, timestamps, counts, filters, and event metadata. IBM Plex Sans Variable is limited to the brand and content headings so the few structural titles remain easy to scan.

- Body and control text stays compact, generally 9–13px.
- Section labels use small uppercase mono with increased tracking.
- Headings use compact, high-weight sans rather than oversized display type.
- Counts use tabular numerals.
- Exact paths may truncate visually, but preserve the full value through titles or expanded presentation where implemented.

**The Data Stays Measured Rule.** Exact operational values use mono; sans identifies structure.

## Layout and Scrolling

The application fills the viewport beneath a compact command bar. At desktop widths, the workspace uses a 280–330px control rail beside a fluid event pane. The rail contains import configuration, stored-row totals, the last-import report, the CLI twin, and the summarized import plan. The event pane owns the dominant width and keeps its toolbar near the data.

`html`, `body`, the root, and the application shell remain fixed to the viewport. The workspace is the single page-level vertical scroll owner, with contained overscroll and a stable scrollbar gutter. The control rail and event pane grow inside that shared scroll rather than creating independent columns with competing wheel behavior.

The event toolbar is sticky on wide screens. It holds the event title and scope,
a compact Live intake/import strip, Stream / Visualize switch, server-backed
Source, searchable Project / Oracle, Directory / Folder, and Refresh. The live
strip keeps New / Changed / Indexed / Reconcile visible when idle and switches
to file progress while a writer runs. At narrower desktop widths the filters
wrap to a second toolbar row without losing their order.

The command bar switches between Events, History, and Jobs without creating
another page shell. Jobs uses the same workspace scroll owner: bounded history sits beside a
selected terminal on desktop, while mobile puts the selected terminal before
history so output is never hidden below dozens of earlier runs.

**The One Scroll Owner Rule.** Use the workspace as the sole page scroll region. A modal may temporarily replace it with one internal scroll region; ordinary panels, rails, charts, and event lists do not add vertical scrollers.

## Import Plan Modal

Inspect plan opens a centered, read-only dialog only after the server returns a plan. The background workspace is hidden from assistive technology and its scrolling is disabled while the dialog is open.

The dialog has four fixed regions: header, filter toolbar, file body, and pager. Only the file body scrolls. This keeps the title, read-only status, filters, range, and navigation visible while reviewing large inventories.

- Show 40 files per page.
- Filter by case-insensitive Directory / File path text.
- Filter by all, actionable, new, changed, unchanged, or shrunk state.
- Open each newly inspected plan on `Needs attention` when work exists, otherwise show the complete inventory. Reopening an existing plan preserves the operator's selected state.
- Put live state totals in the dialog and include counts in state options so an empty filter never contradicts the plan summary without explanation.
- Reset to the first page when the path or state filter changes.
- Show filename, parent path, state, and size for every row.
- Use state color as a narrow reading aid, not a full-row wash.
- Support Close, Escape, backdrop dismissal, initial focus on Close, focus containment, and return focus to the trigger.
- At mobile widths, expand to nearly the full viewport and stack the two filters.

**The Inspection Is Not Import Rule.** The modal describes what the importer sees; viewing and filtering never write data. Its footer may continue into the existing import confirmation, but no modal action bypasses that confirmation or writes directly.

Batch size belongs to the plan footer, where the operator can choose it with the pending files visible. Import confirmation replaces that footer in place; it does not send the operator back to the source rail.

Live Claude/Codex JSONL may append between inspection and worker startup. UI jobs therefore disclose and use a single fresh job-start plan; exact-plan validation remains the API default. Per-file prefix snapshots and shrink detection remain the write-safety boundary.

## Background Imports and Jobs

Import next N remains the primary bounded action. It always fetches a fresh
read-only plan, then requires an inline second step that repeats the bounded
count, new/changed split, source/root, and read-only treatment of source JSONL.
Import all appears only when the pending count exceeds N and uses the same
confirmation shape. Both modes submit the plan revision and count to the job
runner for authoritative revalidation before schema or row writes.

Starting a job opens Jobs immediately. History is newest-first and bounded;
every row exposes state and elapsed time. The selected terminal incrementally
polls absolute log cursors, distinguishes stderr progress, follows only while the
operator is already near the bottom, pauses in hidden tabs, and caps rendered
history to the backend ring. Running jobs expose Cancel and Copy log; successful
jobs link to imported events, while failed/cancelled jobs link back to a fresh
plan review. All terminal transitions refresh plan, intake, ledger, last-import
evidence, and events because cancelled or failed work may have committed
idempotent batches.

**The CLI Is the Evidence Rule.** The browser does not invent progress; it shows
the same fixed-argument CLI process and structured completion report as maw.

## Live Intake

The Import rail carries a compact reading beneath the existing form. It polls
the metadata-only intake endpoint every 30 seconds, pauses while the document is
hidden or while an import writer is active, refreshes immediately when visibility
returns or an import completes, and offers a manual Refresh action. Polling owns local busy and error state; it
must never refresh, clear, or shift the imported event workspace.

Blue identifies JSONL files that are new outside LanceDB. Green identifies an
aligned source with zero new files. The reading also exposes indexed and found
counts, scan timing, invalid-input pause, and retry state through text—not color
alone. An always-visible New / Changed / Indexed / Reconcile strip makes the
current intake split readable before opening the exact plan. It is a flat
one-pixel-bordered instrument with no shadow.

## Event Workspace

### Server-backed filters

Source, Project / Oracle, and Directory / Folder filters are part of the query
scope rather than client-only decoration. Project and folder options come from
returned facets and include counts. Project / Oracle is an ARIA combobox with
substring search and a global `⌘K` / `Ctrl+K` shortcut. Changing source clears
the dependent project and folder selections. The visible scope appears beside
the event total so users can tell which result set they are reading. Workspace,
job, source, project, folder, and view are URL state, not reload-fragile memory.

### Stream

Stream is the default view. Desktop rows align time, source / block type, project / semantic role / folder, and canonical text in a dense grid. Role and block metadata use consistent semantic colors. Long canonical blocks clamp for scanning and expand in place through a button that exposes its expanded state.

Loading, retryable errors, empty results, and active filter scope remain explicit. Never replace these states with invented rows or charts.

During an active import, the toolbar and progressbar update from the incremental
job log once per second. When no folder filter is active, a bounded physical-tail
query refreshes committed event rows without recomputing facets or global status;
folder-filtered scopes wait for the authoritative completion refresh. Full rows,
paths, facets, and ledger totals synchronize once at the terminal transition.

**The Writer Gets the Fast Lane Rule.** Live progress may read only bounded job
state and bounded event windows; it never repeats the heavyweight full-corpus
status/facet path while LanceDB is writing.

### Visualize

Visualize summarizes the same visible, filtered event window; it is not a separate analytics dataset.

- **Activity pulse:** events distributed across 12 chronological buckets.
- **Block type:** distribution of text, summary, tool use, tool result, and any returned types.
- **Semantic role:** distribution of normalized roles.
- **Project / Oracle:** distribution across returned project identities.
- **Directory / Folder:** distribution across returned folder paths.

Charts use compact bars, counts, and the shared accent tokens. At reduced widths the two-column visualization grid becomes one column.

**The Visible Window Rule.** Charts summarize only the currently returned event window and must say so.

## History Workspace

History is a full-width forensic ledger over imported canonical events. It does
not infer work from filesystem modification times and does not create another
analytics store. Day, week, and month views use `Asia/Bangkok`: weeks run Monday
through Sunday, current periods stop at today, and every elapsed calendar date
is rendered even when it contains zero indexed work.

Each active day is a compact primary ledger of exact
Source/Project/Oracle/provenance-directory/session records. The left-most field
is always the calendar date and observed time range (`DD Mon · HH:mm–HH:mm`),
so an operator can recall work by day without having to infer it from a page
heading. Source is the only honest answer to “who” in the current schema, but
the repeated display name is deliberately compressed to a stable two-digit
`Src #`, assigned from the complete database source catalogue rather than the
current filter/window; its full value remains in the accessible name and tooltip. A provenance
folder is not presented as authoritative process `cwd`.

The remaining dense row shows Oracle/folder, stable session ID, daily canonical
event count, a one-line evidence preview, continuation before/after the selected
day, and View/Copy actions. This removes a group-disclosure click from the
primary reading path while preserving the exact source/project/folder identity.
Rows default to latest observed activity within the day and can be reordered by
first activity, Oracle name, event count, or the size of their provenance group
without changing newest-first day order. Date and time always mean events
observed in that selected calendar day—never a fabricated filesystem mutation
timestamp. Range and day event totals count unique canonical events; because one
canonical event can have provenance in more than one directory, directory counts
overlap and must never be summed. Records missing occurrence provenance remain
visible under an explicit unknown-provenance folder. Opening a session loads its
whole chronological canonical contents for that exact
source/project/directory/session identity while naming how many events belong to
the selected day. The whole-session result paginates without duplicating
occurrence rows.

At wide desktop widths, spare horizontal room scales type, controls, and row
breathing before it adds more columns. This gives the relaxed readability of a
modest browser zoom while preserving the same fields, sort order, and mobile
ledger structure.

Source, Project / Oracle, Directory / JSONL Folder, period, and anchor date are
URL state. History links survive reload and workspace back/forward navigation.
The toolbar names `GMT+7`, navigation prevents future anchors, and API errors
remain retryable. On mobile the ledger stacks without horizontal page overflow
or an additional vertical scroll owner.

**The Calendar Is Evidence Rule.** Zero-work days remain visible; absence is a
finding, not a gap to remove from the timeline.

**The Drill-down Stays Lazy Rule.** Range summaries and session identities load
first; full block contents load only for the session the operator opens.

Each session row also opens a vector inspector without replacing View contents.
The inspector can select the local dual-4090 index, the managed Cloudflare
index, or both. Incompatible embedding spaces remain separate labeled maps with
independent model, dimension, coverage, loading, missing-store, and error
evidence; matching `event_id` values coordinate selection, never coordinates.
Human and Agent tick filters apply before sampling and projection. Visualizers
cross a typed, declarative plugin boundary: `Atlas 3D` is the lazily loaded
Three.js default with optional motion-aware spin, while `Flat 2D` is the stable
SVG fallback. The host owns data, vector-space separation, configuration,
selection, errors, and the shared roving-tabindex evidence list; a plugin only
renders the supplied points and emits a stable `event_id`. New visualizers can
be registered without changing the History workspace.

**The Spaces Never Blur Rule.** Compare multiple engines side by side, but never
overlay or silently fall back across embedding-space identity.

## Components

### Controls

- Inputs, selects, and buttons use compact heights, 4–5px radii, one-pixel borders, and mono labels.
- Primary actions use the accent surface; secondary and quiet actions remain neutral.
- Active segmented controls use `aria-pressed` and the accent surface.
- Disabled actions become visually quiet and pair with a textual reason when the blocked operation needs explanation.
- Hover changes border, text, or surface without moving the control.

### Status and progress

- The command bar reports LanceDB connection state and truncates long database paths safely.
- The import rail reports stored event, provenance, and source-file counts.
- The live-intake reading reports metadata-only new/indexed file state and its next scan without changing event rows.
- The Jobs workspace reports running, cancelling, succeeded, failed, and cancelled states with text as well as color.
- The plan progress bar exposes progressbar semantics and uses the server plan as its source.
- Loading appears as a thin animated rule; reduced-motion mode removes the traversal.
- Errors use alert semantics, a danger rule, and a restrained wash.

### Surfaces

Panels remain flat and are separated mainly by rules and background steps. Small radii soften controls and the modal without turning the interface into a rounded-card dashboard. Shadow is reserved for connection halos and the modal overlay, where depth communicates status or modality.

## Responsive Behavior

At 720px and below, the workspace becomes one column with **events first and controls second**. This intentionally differs from desktop visual order: a returning user reaches indexed evidence and filters before import administration.

- The event toolbar stops sticking and wraps title, view switch, and filters.
- The selected job terminal precedes job history and neither region creates a nested vertical scroller.
- Event table headers disappear; each row becomes a readable stacked record.
- Time, source/type, project/role/folder, and canonical text retain their semantic order.
- Visualizations become a single column with a shorter activity chart.
- The control rail follows the event workspace and loses its desktop side border.
- The plan dialog uses nearly the full viewport while keeping its header, toolbar, and pager fixed around the sole scrolling body.

**The Evidence First on Mobile Rule.** Responsive order follows the primary reading task, not the desktop column order.

## Accessibility and Motion

- Preserve the global two-pixel `:focus-visible` outline with offset in both themes.
- Use native buttons, inputs, selects, labels, headings, time elements, lists, alerts, and progress semantics.
- Segmented theme and view controls expose pressed state; expandable event text exposes expanded state.
- Job history keeps native button semantics, while a short live status announces only new terminal state/output rather than replaying the full log.
- Active import progress exposes progressbar values; its polite announcement names the transition rather than reading every tick.
- The import plan identifies itself as an `aria-modal` dialog, receives initial focus, closes with Escape, and hides the background workspace while open.
- Loading event data exposes busy state; visual activity buckets provide list semantics and descriptive labels.
- Never encode state only by color: pair it with text, position, count, or control state.
- Under `prefers-reduced-motion: reduce`, remove animation, make transitions effectively immediate, and show a static loading rule.

## Do’s and Don’ts

### Do

- Keep local paths, counts, plan states, query scope, and write results visible.
- Keep Dark and Paper structurally identical and persist the selected theme.
- Treat all three event filters as server-backed scope controls.
- Keep event Stream and Visualize modes tied to the same returned window.
- Preserve one page scroll owner and one modal-body scroll owner.
- Preserve event-first mobile ordering, keyboard focus, dialog semantics, and reduced-motion behavior.

### Don’t

- Don’t restore a spacious warm-paper-only landing-page layout.
- Don’t turn controls or panels into oversized cards, pills, or decorative metrics.
- Don’t add independent vertical scrolling to the control rail, event list, or visualization panels.
- Don’t imply that plan inspection writes data.
- Don’t present client-invented facets or charts as complete database totals.
- Don’t hide errors, disabled reasons, empty states, or the active query scope.

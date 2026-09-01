# 04 — Normalize JSONL

## Goal

Turn raw JSONL envelopes into a small canonical event shape before any database write.

Normalization is the boundary between inconsistent source records and stable stored rows. It should parse line by line, keep meaningful user/assistant/tool/summary content, skip irrelevant telemetry, and report malformed lines without making the entire fixture unusable.

## Fixture first

Use only the bundled fixture at this stage. A tiny fixture makes it possible to see every normalized row and understand why it was kept or skipped.

```bash
just smoke
```

During the smoke output, identify the normalization phase before the import phase. The same normalized identity must be produced every time the same fixture is read; otherwise Lesson 05 cannot distinguish new content from known content.

## Stop condition

The fixture is converted into deterministic typed rows, malformed or irrelevant
input is handled visibly, and no private archive is needed to prove normalization.

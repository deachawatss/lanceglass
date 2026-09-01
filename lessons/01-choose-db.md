# 01 — Choose the database

## Goal

Choose a local database that can store typed rows now and leave room for vector search later.

Lab 2 uses **LanceDB** because it is local, Arrow-native, and can support both ordinary typed tables and a future vector table. It is not a relational ORM. We will add a small typed Repository/Data Mapper boundary in Lesson 03 instead of pretending LanceDB provides joins, foreign keys, or transactions like a relational database.

## Decision checklist

- local and disposable for a learning lab
- explicit Arrow schemas
- TypeScript/Bun support
- no server or account required
- vector search can be added later without changing databases

The trade-off is that relationships and invariants live in our application boundary rather than in SQL constraints.

## Do

Read `package.json` and locate the LanceDB and Arrow dependencies. Then run the cumulative verification:

```bash
just smoke
```

## Stop condition

You can explain why LanceDB fits this lab, why it is not an ORM, and why the database remains isolated at `.data/lancedb`.

# Query Manager #

THIS IS ALL SPECULATIVE FOR PLANNING PURPOSES FOR TOC METADATA.  BUT THIS IS HOW
THINGS WILL BE.  OH, YES, THIS IS HOW THINGS WILL BE.

## Background ##

Querying a database boils down to three steps:
- Find the indices we possess that allow us to quickly reduce the set of records
  that we need to consider.
- If we had more than one index, intersect the indices.
- Fetch those records and then perform filtering by looking at the contents of
  the records.

On balance, everyone wins when the logic for querying is centralized rather than
distributed throughout the code-base in an ad-hoc fashion.  There's fewer places
for bugs to exist and efforts to optimize can potentially yield fruit
everywhere.

The query manager provides this centralized logic.

## General Operation ##

Our entire strategy for scaling is based on having indices ordered by time so
we only need to have the data surrounding the time range the user is looking at
loaded at any given time.

Our query manager is generalized to support this usage model.  Specifically,
it supports:
- Issuing a limit-bounded query starting from a given point in time against
  the database.
- Providing live updates to the query results as the state of the database
  changes.
- Growing the query time region in a race-safe way.  (Roughly: issuing the
  database query at the same time we start listening for database changes so
  that we can buffer any mutations.)

## Potential Optimizations ##

These are things we could do in the future:

### Cached Queries ###

If we see the same query being issued a lot, we can promote it to what amounts
to a materialized view where we persist it in the database and keep it
up-to-date even when there is no active consumer of the query.

# Search #

## Overview ##

### Background ###

Querying a database boils down to three steps:
- Find the indices we possess that allow us to quickly reduce the set of records
  that we need to consider.
- If we had more than one index, intersect the indices.
- Fetch those records and then perform filtering by looking at the contents of
  the records.

Maintaining a live query of a database adds the following:
- Listen to changes
- See if the changed thing is something we already know about (and whether it
  still matches), or whether its new state now matches the query criteria.

On balance, everyone wins when the logic for querying is centralized rather than
distributed throughout the code-base in an ad-hoc fashion.  There's fewer places
for bugs to exist and efforts to optimize can potentially yield fruit
everywhere.  The search logic and query manager provide this centralization
and some extensibility and other fun stuff.

### The Filtering Pipeline ###

- Establish the query index to be used.
- Load some subset of the query index.  (We will fetch more as-needed.)  Track
  these as the active candidate set so that while the next asynchronous steps
  happen, we can ensure that we can handle vanished conversations/etc.
- Feed those id's into a stream that loads the records as-needed (including
  pre-fetch support).
- That stream is optionally piped into another stream that loads dependent data
  as-needed.  For example, fetching the contents of message bodies out of their
  Blobs, performing contact lookups, querying network resources, etc.
- With all data for a potential match fully available in a synchronous fashion,
  we run the synchronous filters and save off matches as appropriate.
- We also invoke any faceters or summarizers we might have.  They store their
  data in separate TOC structures, so this is just an efficiency thing to let
  them do their thing.
- The matching items are checked against the tracking set to make sure they are
  still relevant.  If so, they are added to the TOC.

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

## Faceting, Match Details, other Visitor Byproducts and State Representation ##

Filtering and searching is inherently a deterministic process.  The decision
trade-offs have to do with (re-)computation time and memory cost, with potential
I/O dominating.

### Background, Goals ###

For gloda's faceted search implementation, faceting was strictly in-memory on
a bounded result set size (we used a LIMIT of 400 or 500 or something, now
relaxed via preference.)  Similarly, Thunderbird's quick filter mechanism and
its limited faceting logic was able to rely on the entire message store being in
memory.  (There were XPConnect garbage-generation overheads, however.)

For gelam, we in general aspire to keep most data on disk and try and maintain
a reasonable memory profile.  Our bias towards reasonable memory profile
unfortunately also can translate into "bias towards potentially needing to ask
the database for a lot of things".  While OS and IndexeDB/SQLite caching can
save us a bit, it means we want to choose our representations for efficiency.

### Use Cases ###

The following things are pretty sweet in general:
- Simple histogram-level summaries of currently displayed/available information.
  - Ex: Sparkline of message activity in a folder/label/list.
  - Ex: Breakdown of participation by authors in a single conversation for
    quick access filtering.
- Filtered conversation / message lists.
  - Match info: being able to see where the search match occurred in the
    conversation / message list.
- "Brushing" where hovering over a message author, subject, date bin, etc. will
  cause (partial) painting of other information displays to show they are part
  of the set being brushed, or show which portion of them is a member of the
  intersecting set.

### Representation Choices ###

Because we allocate permanent identifiers for all conversations/messages/etc. we
can use their ids as a persisted, stable identifier in any computed results we
have.

#### Match Info and Caching ####

Although we never want to throw away the knowledge of the matched items that we
put in a TOC, how they matched is not particularly important.  The TOC and
database in fact are designed to try and forget about the data once they have
told the front-end, leaving anything more up to a hand-wavey future smart
caching layer.

In some cases, cache hits may be expensive or at least a little annoying to
compute.  For example, message body hits require asynchronously fetching a Blob
and possibly parsing HTML.  If the search is over conversations but we're
matching on its constituent messages, getting the search hits may actually be
a non-trivial I/O load even before fetching body Blobs.

And for TOC purposes, there is a good chance that the user will scroll down to
our hit "soon".  While this is an argument for also caching the underlying
conversation/message, again in the case of a search over conversations but where
message matching was performed, the match info will be independent from the
ConversationInfo we return.

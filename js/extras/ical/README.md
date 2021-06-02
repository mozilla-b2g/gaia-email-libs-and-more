# The Plan

This is currently speculative.

## Use Case

This ical account type is intended to serve as a least-common-denominator
calendar mechanism for one-way (read) synchronization of a calendar stored
externally, presumably by private URL (AKA a URL with a bearer token embedded
where knowing the URL is the authentication that grants access).

This implementation is currently being developed against a gmail ical calendar
for pragmatism in the base case, but is likely to not be representative of the
worst situations out there.

## Data Model

### Conversation / Message Hierarchy

#### Recurring Calendar Events as Conversations (per UID)

Recurring events are conceptually similar to conversations in that:
- There's a containment relationship and through-line; a shared subject, if you
  will.
- There's specific times/dates associated with each recurrence, as well as
  specific metadata.

There are some differences too:
- Recurrences frequently are characterized to infinity, although one would never
  want to extrapolate them out that far.
- Many recurring events may simply be pointers to the recurring event and don't
  have any distinct characteristics of their own.
  - This differs from messages which are all real, independently interesting
    authoritative pieces of data.

## Sync Strategy

### Network

Because the unit of synchronization is the entire ical file, our sync state is
a map from the calendar `UID` to [our local identifier, `LAST-MODIFIED` value].
This allows us to detect new UIDs, UIDs which have been changed (different
`LAST-MODIFIED`), and UIDs which have been removed.

When new/modified UIDs are detected, all of the VEVENTs for the given UID will
be accumulated.

### Recurring Event Expansion / Sync Horizons

An interesting outgrowth of our general concept of having a sync horizon is that
this also aligns with the idea of materializing recurrences to a given horizon.

We can think of having 3 classes of data:
- Explicit, non-recurring events which also includes RECURRENCE-ID instances
  (which are specific, fixed instances of an existing recurrence that was
  modified in a one-off fashion).
- Recurrences.  The rule definitions.
- Materialized recurrences.  The events that are derived from the recurrences
  and for which there wasn't a specific RECURRENCE-ID that super

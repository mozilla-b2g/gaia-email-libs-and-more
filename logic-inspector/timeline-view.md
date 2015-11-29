# Timeline View

## Root Decisions

* The timeline view is a horizontal timeline display where time advances from
  left to right.  Contrast with the ArbPL viewer which tried to do things
  vertically and frequently lost for it.
* Uniformity of time is not as important as showing the relative ordering of
  events.
* Hierarchical.  Although logic uses a simplified implementation that does not
  explicitly mandate hierarchy, we support it and want it.
* Multiple levels of collapsing and coalescing.  Because horizontal display with
  horizontal writing fundamentally fights itself, we need to elide as much data
  or coalesce things that can logically be clustered, with expansion/zooming
  as a subsequent option.  (We want to avoid the SIMILIE vertical scattering
  phenomenon as much as possible.)
* Extensive use of vertical regions/swim-lanes with bucketing.  This also
  plays into coalescing.  The user should be able to collapse a logger/swim-lane
  and still be able to see that activity is happening there without having to
  be overwhelmed by it.

## Goals

### Birds Eye View

We want to be able to understand where activity is happening in terms of:
* Sub-systems.

### Incremental customization

We should be able to usefully view logs without having to do any customization.

Customization should let us help re-interpret and style the display without
having to make structural changes to the logging calls.  Obviously, the logging
calls need to include the information required for display and at least enough
information for

## Implementation

### Time-streams

All log events belong to a time-stream.  Within a given time-stream we are able
to impose a total-ordering on the events that occur in there.

Different time-streams will usually occur in the cases of JS execution on the
main thread versus JS execution on a worker.  In most cases we can establish a
"good enough" relative ordering sync-up between time-streams based on
Date.now(), or with slightly more effort do even better by using a
high-resolution timer and capturing the translation factor (with spec changes
workers will no longer use the same base as their parent).

The intent of having a concept of time-streams is primarily to make it explicit
when we're dealing with different threads and event ordering may not be fully
representative.

It's also potentially somewhat necessary since if we're not relying on dump()
and atomic writes to stdout, then we do need to be clever enough to understand
we're dealing with different streams.

Most of this is currently future work.

### Hierarchy via nesting

As previously noted, in loggest, all loggers explicitly had a parent and
explicitly had a lifetime.  Whereas in logic everything is simplified and
mechanisms exist to make using an idiom that supports hierarchy possible, but
also not required.  A nice outgrowth of this is by just relying on convention,
we allow singleton objects using their own scope like MailDB or ParallelIMAP
instances to mix-in the "ctxId" or other arbitrary identifier provided by their
caller without having to use the TaskContext scope instead of their own, etc.

Since everything is convention, we rely on our configuration logic to help us
establish when it's appropriate to nest things and how to nest them.

All hierarchy nodes have one or more lanes.  Lanes exist in a flat namespace,
although we allow for the UI to make path-like things look like the lanes have
their own hierarchy.  (Ex: "a/1" and "a/2" are different, but we would display
the lanes adjacently and could make it seem like there is an "a" with two
children, "1" and "2".)

All hierarchy nodes have an associated start and stop time characterized by
a starting log entry and an ending log entry.  Except the root node which is

### Layout

# Table of Contents #

## Overview ##

We have various TOC implementations.  These are the "models" the backs our list
views.  They present an ordered list of a data-type that the
EntireListProxy/EntireListView or WindowedListProxy/WindowedListView subscribe
to.

Examples:
- AccountsTOC: The list of accounts.
- FoldersTOC: The (flattened) folder hierarchy for a given account.
- FolderConversationsTOC: The list of conversations in a given folder in a given
  account.
- ConversationTOC: The list of messages in a given conversation.

### Core List Semantics ###

TOCs do:
- Issue reads to the database to load the list of items in the TOC when the TOC
  is first acquired.
- Listen to events from the database to update in real-time as the database
  state changes.  The TOC is responsible for filtering a potentially much more
  chatty event stream for a given type down to what the TOC itself cares about.
- Emit changes to the TOC when it occurs for the benefit of its proxies.

TOCs do NOT:
- Have a stateful concept of what (windowed) lists are interested in.  The proxy
  implementations track these and filter the events they receive to the window
  of data they currently care about.
- Have any concept of batching.  The proxy implementations and the BatchManager
  mechanism deal with this.

TOCs may:
- Expose API surface for use by the back-end without the involvement of a proxy.
  For example, the AccountsTOC and per-account FoldersTOC instances are intended
  to be used by the back-end.

TOCs currently do the following, but this may get fancier in the future:
- Load the entire list of item id's and critical ordering keys and coordinate
  space values at startup and keep them in memory.  This is done for
  implementation simplicity and based on current expected item cardinalities.
  - It is conceivable in the future that the synchronized set of conversations
    for a folder/etc. may become so large that more of it should be stored
    offline.  In that case the WindowedListProxy-TOC protocol may be enhanced
    or we may grow a new LazyWindowedListProxy mechanism with its own protocol.

## TOC Metadata ##

### Rationale ###

When dealing with our TOCs, the items that they list are usually not the only
interesting thing going on.  As evidenced by our examples, at its simplest,
our data model involves a fair amount of hierarchy.  The container for the items
is usually just as interesting as the items themselves.

For example, when viewing conversations in a folder, all of the following
attributes about the folder itself are relevant to the UI we present:
- When was this folder last synchronized?
- Is this folder currently synchronizing?  If not, could we ask it to
  synchronize right now and expect it to work?
- Are there more conversations/messages that could be synchronized in this list?
  Can we synchronize them now, or is there something preventing that?

Our API is already capable of letting bridge clients express interest in a
single folder and receive (live-updating) answers to these questions.  We could
just ensure that the WindowedListView for a FolderConversationsTOC has the
relevant MailFolder attached to it.  In fact, during early development, this is
what we made our callers do themselves.

But we run into these problems:
- It requires us to have an explicit object with a global name that
  characterizes what is being displayed.  We already have this for folders,
  but when we get into search views, unified folder views, and other ephemeral
  dynamically configured views, this becomes a potentially very awkward and
  complex burden.
- Batching.  Batching operates on a per-proxy/view granularity.  Although we can
  do things to coordinate updates into transactions with explicit notification
  phases, it's easier and saner to not do this.  If we can include metadata
  updates for a view at the same time we update its items, things are inherently
  simpler.

Thus we introduce the concept of TOC metadata.

### Implementation ###

The semantics are all the same as with the core list.  The proxies handle
batching, including the metadata.  Usually this takes the form of dirtying the
proxy at metadata change time and then snapshotting the metadata at flush time.

The responsibility for actually populating and updating the tocMeta falls to
helpers that are provided as a list at TOC instantiation time.   These currently
live in db/toc_meta.  They are inspired by the data overlay system but much
simpler.

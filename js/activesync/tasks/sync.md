## Overview ##

For ActiveSync we pick a filter size and then the server effectively controls
the set of messages that we see.  This greatly simplifies our sync logic, since
each sync_refresh task just needs to process the inflow of deltas.

### Unavoidable Limitations: No Conversations! ###

Unfortunately, conversations are beyond ActiveSync without major engineering
effort.  Specifically, the protocol does not provide us with a way to gain
access to the References or In-Reply-To headers without downloading the entirety
of the MIME message.  We've investigated this a fair bit, see
https://bugzilla.mozilla.org/show_bug.cgi?id=804909 for more info.

For protocol version 14.0 and higher (see
https://msdn.microsoft.com/en-us/library/ee159339%28v=exchg.80%29.aspx), there
is a ConversationId element that is understood, but 2.5 and 12.x servers are the
ones we really care about.

We might be able to do some type of subject-based threading, but the potential
for that to go wrong means that we probably want some further content analysis
or recipient list equivalency first.  Since we also plan to move
hotmail.com/outlook.com/live.com to IMAP with this release, we currently cop
out and put every message in a single-message conversation.  Luckily our gaia
UX knows how to handle this.

### UniqueMessageIds are used like in IMAP ###

For folder-centric IMAP we use umid's to contend with

### sync_refresh cascade ###

All sync is sync_refresh!

- Get the set of deltas
  - New messages:
  - Changed messages:
  - Removed messages:

### syncKey invalidation ###

If a syncKey is bad the options are, as ever:
1. Act like every message got deleted followed by a normal sync step.
2. Create a specialized job that reconstructs pairings.

The second thing is never going to happen because ActiveSync is not a priority
protocol.  The first thing could eventually be specialized if we have general
deletion logic that temporarily places the messages in limbo.


### sync_grow is a no-op ###

It could increase the filter size, but no.

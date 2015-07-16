## Overview ##

For ActiveSync we pick a filter size and then the server effectively controls
the set of messages that we see.  This greatly simplifies our sync logic, since
each sync_refresh task just needs to process the inflow of deltas.

### Abstraction Structuring ###

Here's the stack of what code lives where.

- Raw wire protocol: jswbxml (under js/ext/)
- Low level ActiveSync protocol: jsas (under js/ext/)
- Higher level protocol: our code under js/activesync/protocol.  We try and
  keep all code that deals in WBXML in this directory and broken out into
  separate files for each WBXML request and broken out by version number.
  Previously much of this logic was in account.js and folder.js and jobs.js.
  The lower level things might want to be folded back into jsas someday.  The
  higher level things necessarily are bound to GELAM's representation and chosen
  libraries for things like because

  logically could otherwise be not tightly coupled to GELAM's representations
  and semantics.  We, however, won't introduce other intermediary
  representations for the sake of having one.  The hard rule is in mucking with
  WBXML.
- Semantic operations / tasks: our code under js/activesync/tasks calls out to
  our protocol helpers and deals with database manipulations and back-end
  representations and all that.  We have no problem if these tasks are
  ridiculously concise because the protocol does most of the work.  (And the
  tasks may also be built on mix-ins that result in the task file just being
  glue to hook things up to the protocol helpers.)

### Unavoidable Limitations: No Conversations! ###

Unfortunately, conversations are beyond ActiveSync without major engineering
effort.  Specifically, the protocol does not provide us with a way to gain
access to the References or In-Reply-To headers without downloading the entirety
of the MIME message.  We've investigated this a fair bit, see
https://bugzilla.mozilla.org/show_bug.cgi?id=804909 for more info.  It might be
okay on more recent versions (allowing us to truncate), but...

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

### Trying not to rule out conversations... ###

In the interest of not having to rewrite ActiveSync sync in the case it becomes
feasible due to additional engineering resources, someone with a better
understanding of ActiveSync showing, someone with access to a variety of
servers we can test against showing up, the aforementioned alternate threading
algorithms, etc. we don't want to hardcode the one-message-per-conversation
thing.

Between vanilla and gmail IMAP the big difference is that for gmail we can bin
tasks by conversation because we know the conversationId at sync_refresh time.
But for vanilla IMAP we can't know the conversation until we sync the message.
(Noting that we obviously could just make sync_refresh subsume sync_message but
this results in all kinds of train wrecks.)

Unfortunately, a straight-up Vanilla IMAP sync_message data-flow doesn't quite
work because we find out about the messages during the necessarily atomic
sync_refresh step and that implies stashing the message envelope state in a
form of limbo where they don't properly exist as messages.

Random thoughts on this:

- There is an advantage to a limbo state for messages where we haven't really
  processed them fully and showing them in an intermediate UI state is just
  going to annoy and confuse the user.  For example, in Thunderbird when
  messages would show up only to disappear fractional seconds later as the
  bodies got downloaded and the spam filter ran.  Although we want spam to be a
  server problem, we effectively do not have a limbo solution yet.

- Limbo options:
  - Cram the state in tasks.  This limbos them but makes it impossible for other
    tasks to act on them for processing.  Really this implies a fix pipeline,
    and for sync_message it's just delaying.
  - Create an explicit limbo table which relaxes invariants on messages.  Like
    they don't have to belong to conversations yet.
  - Maintain invariants but play folderId games where a message does not
    formally admit to being in a folder.  The presumption would also be that it
    belongs to a conversation that exists only to contain it.
  - Have a formal "inLimbo" flag on messages which causes conversation churns to
    ignore them and causes the conv_toc not report the existence of the message.
- Limbo early feelings: None.  They all seem dubious and we don't have a
  use-case yet.  They all also can be made to appear the same to front-end
  using code, so I don't think it matters yet.

Ideally the game-plan would just be to have sync_refresh be effectively like
Vanilla IMAP's sync_refresh smooshed together with its sync_message.  We'd
literally use the resolver helper even though it will always claim there are no
references.  *Unfortunately*, we don't even have a message-id for the message,
so this doesn't actually work.

So I give up and we will:
- Assign UniqueMessageIds like we do for IMAP because moves can change server
  id's for messages so we need indirection there.
- Use the UniqueMessageId as the (currently stable) ConversationId.  This means
  the conversation id component ends up being the same as the message id
  component.

Future enhancements could be:
- Follow-on processing that results in merge tasks being triggered
- Magic smarts in sync_refresh if we can get the server to tell us conversation
  id's off the bat.  This would likely result in the message being inserted into
  the conversation name-wise in the messages table, but mandating a follow-up
  sync_conv task that would actually churn the conversation.  (For resource
  reasons because we just can't go loading all the conversations.)

### Vanilla IMAP code re-use ###

Since we're sticking with the vanilla IMAP umid model, we find ourselves able
to reuse a lot of code.  In general this means code that solely deals with the
"local" side of the house through umid's can be reused verbatim, usually in
mix-ins.  Things that interact with server state are more likely to just look
the same.  I'm currently optimizing for control flow simplicity with the aim of
making my head not hurt if I read the code.  This may mean that
copy-paste-modify may be used if the resulting code is shorter and more
readable.  We'll see, eh?

Module-wise, mix-ins will live under the vanilla IMAP tree hierarchy with
ActiveSync requiring from there.  The idea is that if we ever get a chance to
be rid of ActiveSync, we can largely just rm -rf it.  More practically, new
contributors can ideally pretend that the ActiveSync directory does not exist.

### sync_refresh cascade ###

All sync is sync_refresh, there is no sync_grow.

Cases:
- new messages: message, conversation, umidNameMap, and umidLocationMap writes
  are issued directly.  There is no potential for conversations to link up, so
  we don't need to consult anything.
- changes: umidNameMap reads are issued, binning changes by conversation
  (although we expect each message to be in its own conversation), and which
  generate sync_conv tasks.
- deletions: same deal as with changes.  We get the umid's, we group by
  conversation, we put the deletion in the sync_conv task.

### syncKey invalidation ###

If a syncKey is bad the options are, as ever:
1. Act like every message got deleted followed by a normal sync step.
2. Create a specialized job that reconstructs pairings.

The second thing is never going to happen because ActiveSync is not a priority
protocol.  The first thing could eventually be specialized to accomplish the
second thing incidentally if we have general deletion logic that temporarily
places the messages in limbo.  However, this assumes the server issues messages
with consistent server id's or that we have access to message-id headers or
other reliably consistent identifiers.  The former can't be assumed.  The latter
 we might eventually get.

### sync_grow is a no-op ###

It could increase the filter size, but no.

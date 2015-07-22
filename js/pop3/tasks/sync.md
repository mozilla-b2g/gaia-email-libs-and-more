## Overview ##

We reuse the vanilla IMAP logic through common mixin roots for conversations
logic.

### Sync Cascades and Connections ###

How does POP3 work?  Very badly, hahaha, but enough about the protocol:
- Establish a connection
- Get an updated message number/UIDL mapping/reverse-mapping.  This is only
  valid for the duration of the connection and with an inbox with a large number
  of messages, this can be very expensive unless you can rely on their being a
  consistent-ish mapping and have logic to be lazy-but-verify.  As such, any
  time you're doing this you really want to keep the connection open.
- Use TOP or RETR to fetch data *by message number*, or use DELE for mutation,
  literally the only mutation you can do.

This creates a natural bias towards having complex task/sync routines that try
and do as much as possible in one bite while holding onto the connection.
However, in that direction lies pain.

Happily for us, our v1 Pop3Client implementation was already clever about
caching the UIDL mappings and fetching it on demand.  So our implementation
approach for sync is to ignore the high connection setup costs, mitigating by
holding onto the connection until we idle out after a few seconds or explicitly
teardown the account.

The tasks we use are:
- sync_refresh: Steady state sync.  Detect new UIDLs and for a bounded amount of
  them generate sync_message tasks, putting the rest in overflow.
- sync_grow: Do not detect new UIDLs.  Just take some messages off of overflow
  and generate sync_message tasks for them.
- sync_message: Initial sync of a message using TOP, snippet fetched.
  Automatically created by sync_refresh/sync_grow.
- sync_body: The entirety of the message is fetched if sync_message didn't
  already get it all because it was small enough.  Currently requires implicit
  user activity to want to display the body to cause it to be invoked.

### Code Reuse, umids, and UIDLs ###

tl;dr: Everything is like in vanilla IMAP and ActiveSync, mainly in the name of
consistency, but I have some various rationalizations and thoughts below.

Since POP3 has no notion of multiple folders, we don't really need the
indirection capabilities provided to us by the umidLocation map.  The UIDL, as
far as we concered, is eternal.  The issues with UIDLs are that they are
potentially 70 characters long with a very generous character range constraint
with id's not issued by us so it can't be safely embedded into our aggregate
id strings without potentially a lot of encoding overhead.

And since UIDLs already need to be translated to message numbers and used in a
context where it's expected for us to have our SyncStateHelper instantiated with
its persisted state, well, there's not a lot of advantage to flinging around
full UIDLs.  So the umid is useful.  But what about those indirection maps...?

The umidName indirection is only needed for logic that does not want to load the
sync state and deal with it.  This mainly means reused code, since POP3 specific
sync code will always need the sync state.  But we do want the reused logic,
especially for the eventual conversation merging task and any content-based
threading.  And it's okay to make POP3 pay this price because we're not
specializing for such a limited protocol.

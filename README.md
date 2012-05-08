E-mail libraries for the gaia e-mail client.  A bunch of node and AMD modules
get r.js optimized into a single JS file that gets loaded into the Gaia email
client.  The library can also potentially be used for other clients too, as
long as you are cool with our design decisions.

== Design Decisions

We are targeting B2G phone devices where resources are relatively precious.
We:

- Optimize for only synchronizing a subset of (recent) messages in each folder.
- Try and cache as much as possible for latency and network utilization reasons.
- Present messages to the UI as part of a "view slice" where the UI asks for
  the most recent set of messages for a folder and we provide that in a slice.
  If the users wants to scroll further back in time, the UI asks the backend
  for more messages which may in turn trigger the synchronization logic as
  needed.  The takeaway is that the UI is presented with a stream as opposed
  to some random access database that contains the fully replicated state of
  the entire IMAP folder.
- Use IndexedDB for storage, optimizing for Firefox's specific SQLite-backed
  implementation that uses 32K pages with snappy compression on a per-value
  basis.
- Support the UI running in a separate thread/JS context from the back-end with
  only JSON or structured-clone communication possible between the two.
- Are targeting Yahoo and GMail IMAP for good support which means we need to
  work on relatively bare-bones IMAP implementations.  For example, Yahoo
  does not support IDLE and GMail barely supports it.  Neither support CONDSTORE
  or QRESYNC, etc.

== What Works

- Bare-bones account creation.  We eventually want to support autoconfiguration
  derived from Thunderbird's implementation, but right now we just try the
  exact settings we are given and things either work or they don't.
- Provide the list of folders, including identification of folder types.
- Initial IMAP folder 'sync' of the most recent messages in a folder.  State
  is not persisted and refreshing is not possible.  (Although much of the logic
  is in place; it's just disabled.)

== What Will Eventually Work

See: https://wiki.mozilla.org/Gaia/Email

== New Code

This repo provides:

- "Client daemon" logic that is the backend.  It does the IMAP protocol talking,
  storage maintenance, etc.  It communicates over a JSON bridge with the
  front-end which provides the:
- MailAPI, for use by the UI/front-end.  It communicates asynchronously with
  the back-end over the JSON bridge.

Currently, the client daemon and the MailAPI live in the same page and we are
not round-tripping the data through JSON because it would needlessly create
garbage and slow things down.  But the idea is that the client daemon can
live in a background page or a (sufficiently powerful) worker, etc.

== Code Reuse

We are aggressively attempting to use existing JS libraries.  Currently, these
are mainly node libraries.  We use a combination of slightly-forked versions,
shims, and AMD-wrappings (using volo) to get this to work.  We use MIT-licensed
code from the following projects or converted projects:

- util, Stream shims from https://github.com/substack/node-browserify
   which is frequently modified node.js source code.
- MIME parsing/rfc822 logic from: https://github.com/andris9/mailparser
- MIME composition from: https://github.com/andris9/mailcomposer
- MIME types, helper functions from: https://github.com/andris9/mimelib
- String encoding/character set conversion from http://code.google.com/p/stringencoding/

We shim the following ourselves to the minimum required:
- node's Buffer implementation
- node's crypto module, for crypto.createHash('md5") to support hash.update and
   hash.digest("hex").

We fork the following:
- node-imap from https://github.com/mscdex/node-imap because the goal is to
   have an example that uses the TCP WebAPI directly rather than going
   through node shims.  If you want to do node.js network stuff from inside
   Firefox, check out https://github.com/Gozala/jetpack-net

== The "And More" bit

This repo started out life as a restartless Jetpack extensionf or Firefox to
provide a restartless version of the TCP WebAPI with permissions.  There was
also an intent to provide a more desktop friendly development UI.  Code for
this stuff is still in here in various states of workingness, but is not a
priority or goal.


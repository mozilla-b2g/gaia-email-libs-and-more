CURRENTLY GETTING STOOD UP: THE BELOW STUFF IS SPECULATIVE

A prototype/demo IMAP client for Firefox.  Key bits and pieces:

- An implementation of the proposed TCP WebAPI shimmed so it can be used in a
   restartless extension like ourselves.  This necessarily avoids using IDL /
   XPConnect because restartless extensions can't provide .xpt files.

- An offline IMAP protocol implementation that requires QRESYNC support and
   other niceties.  A somewhat recent Dovecot or Cyrus implementation will do
   nicely.  Gmail is not compatible which is just as well because it needs a
   custom mapping because of its unusual semantics and IMAP extensions.

- A conversation model and query API based on deuxdrop.

- A simple/ugly UI based on the deuxdrop development UI.


Things it definitely does not do right now:

- Manipulate IMAP state.

- Send e-mails.


== Code Reuse

We are aggressively attempting to use existing JS libraries.  Currently, these
are mainly node libraries.  We use a combination of slightly-forked versions,
shims, and AMD-wrappings (using volo) to get this to work.  We use MIT-licensed
code from the following projects or converted projects:

- Buffer, util, Stream shims from https://github.com/substack/node-browserify
   which is frequently modified node.js source code.
- MIME parsing/rfc822 logic from: https://github.com/andris9/mailparser
- MIME types from: https://github.com/andris9/mimelib
- Charset conversion from https://github.com/ashtuchkin/iconv-lite

We shim the following ourselves to the minimum required:
- node's crypto module, for crypto.createHash('md5") to support hash.update and
   hash.digest("hex").

We fork the following:
- node-imap from https://github.com/mscdex/node-imap because the goal is to
   have an example that uses the TCP WebAPI directly rather than going
   through node shims.  If you want to do node.js network stuff from inside
   Firefox, check out https://github.com/Gozala/jetpack-net

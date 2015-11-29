This directory contains helpers that know how to extract logic style logs from
various textual log formats.

The stuffs:
- simple_logic_prefixed.js: Find log lines of the form "logic: JSON\n"

NB: I would love to use WHATWG streams, but npm doesn't know how to install
https://github.com/whatwg/streams/tree/master/reference-implementation
because it's a subdirectory and https://github.com/whatwg/streams/issues/406
makes it pretty clear it's intentionally not published on npm right now.  We
are using a variant on it in the GELAM backend, but that's also a more
compelling use-case than line-oriented file parsing.

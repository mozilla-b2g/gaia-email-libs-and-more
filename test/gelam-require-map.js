console.log('about to issue require setup call');
require({
  catchError: {
    define: true,
  },
  // test/unit/resources/messageGenerator.js still needs this
  scriptType: 'text/javascript;version=1.8',
  baseUrl: '../',
  paths: {
    // - test stuff!
    "loggest-runner": "test/loggest-runner",

    "tests": "test/unit",

    // - map similar to the one in copy-to-gaia.js

    // NOP's
    "http": "data/lib/nop",
    "https": "data/lib/nop2",
    "url": "data/lib/nop3",
    "fs": "data/lib/nop4",
    "child_process": "data/lib/nop5",
    "xoauth2": "data/lib/nop6",

    "q": "data/lib/q",
    "text": "data/lib/text",
    // silly shim
    "event-queue": "data/lib/js-shims/event-queue",
    "microtime": "data/lib/js-shims/microtime",
    "path": "data/lib/js-shims/path",

    "wbxml": "deps/activesync/wbxml/wbxml",
    "activesync": "deps/activesync",

    "bleach": "deps/bleach.js/lib/bleach",

    "imap": "data/lib/imap",

    "rdplat": "data/lib/rdplat",
    "rdcommon": "data/lib/rdcommon",
    "mailapi": "data/lib/mailapi",

    "buffer": "data/lib/node-buffer",
    "crypto": "data/lib/node-crypto",
    "net": "data/lib/node-net",
    "tls": "data/lib/node-tls",
    "os": "data/lib/node-os",
    "timers": "data/lib/web-timers",

    "iconv": "data/lib/js-shims/faux-iconv",
    "encoding": "data/lib/js-shims/faux-encoding",

    "assert": "data/deps/browserify-builtins/assert",
    "events": "data/deps/browserify-builtins/events",
    "stream": "data/deps/browserify-builtins/stream",
    "util": "data/deps/browserify-builtins/util",

    // These used to be packages but we have AMD shims for their mains where
    // appropriate, so we can just use paths.
    "addressparser": "data/deps/addressparser",
    "mimelib": "data/deps/mimelib",
    "mailparser": "data/deps/mailparser/lib",
    "simplesmtp": "data/deps/simplesmtp",
    "mailcomposer": "data/deps/mailcomposer",
  },
});
require(['loggest-runner.js'], function() {});


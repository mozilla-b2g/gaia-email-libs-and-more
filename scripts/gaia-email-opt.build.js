({
  baseUrl: "../",
  optimize: "none", //"uglify",
  paths: {
    "almond": "deps/almond",

    // NOP's
    "http": "data/lib/nop",
    "https": "data/lib/nop2",
    "url": "data/lib/nop3",
    "fs": "data/lib/nop4",

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
    "rdimap": "data/lib/rdimap",

    "buffer": "data/lib/node-buffer",
    "crypto": "data/lib/node-crypto",
    "net": "data/lib/node-net",
    "tls": "data/lib/node-tls",
    "os": "data/lib/node-os",

    "iconv": "data/lib/js-shims/faux-iconv",
    "iconv-lite": "data/libs/js-shims/faux-iconx",

    "assert": "data/deps/browserify-builtins/assert",
    "events": "data/deps/browserify-builtins/events",
    "stream": "data/deps/browserify-builtins/stream",
    "util": "data/deps/browserify-builtins/util",

    // These used to be packages but we have AMD shims for their mains where
    // appropriate, so we can just use paths.
    "mimelib": "data/deps/mimelib",
    "mailparser": "data/deps/mailparser/lib",
    "simplesmtp": "data/deps/simplesmtp",
    "mailcomposer": "data/deps/mailcomposer",
  },
  include: ["event-queue", "deps/stringencoding/encoding-indexes.js", "deps/stringencoding/encoding.js", "rdimap/imapclient/same-frame-setup"],
  name: "almond",
  out: "../gaia-email-opt.js",
  wrap: {
    startFile: "optStart.frag",
    endFile: "optEnd.frag"
  },
  onBuildRead: function (id, path, contents) {
    // Remove destructuring and yields so parsing works.
    // Do this until esprima has a fix for this, among other things:
    // http://code.google.com/p/esprima/issues/detail?id=241

    var destructRe  = /((?:var|let|const)\s*)(\{[^\}]+\})(\s*(?:=|in\b))/g;
    var destructRe2 = /((?:var|let|const)\s*)(\[[^\]]+\])(\s*(?:=|in\b))/g;
    var destructRe3 = /\n(\s*)(\[[^\]]+\])(\s*(?:=|in\b))/g;
    var yieldRe     = /\byield\b/g;
    return contents.replace(destructRe,  '$1/*DESTRUCT$2DESTRUCT*/_$3')
                   .replace(destructRe2, '$1/*DESTRUCT$2DESTRUCT*/_$3')
                   .replace(destructRe3, '$1/*DESTRUCT$2DESTRUCT*/_$3')
                   .replace(yieldRe,     'return YIELD+');
  },
  onBuildWrite: function (id, path, contents) {
    // Restore destructuring and yields.

    var restructRe = /\/\*DESTRUCT(.*?)DESTRUCT\*\/_/g;
    var yieldRe    = /return YIELD\+/g;
    return contents.replace(restructRe, '$1')
                   .replace(yieldRe,    'yield');
  }
})

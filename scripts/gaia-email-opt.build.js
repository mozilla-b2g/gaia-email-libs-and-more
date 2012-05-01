({
  baseUrl: "../",
  optimize: "none", //"uglify",
  paths: {
    "almond": "deps/almond",

    "q": "data/lib/q",
    "text": "data/lib/text",
    // silly shim
    "event-queue": "data/lib/js-shims/event-queue",
    "microtime": "data/lib/js-shims/microtime",
    "path": "data/lib/js-shims/path",

    "imap": "data/lib/imap",

    "rdplat": "data/lib/rdplat",
    "rdcommon": "data/lib/rdcommon",
    "rdimap": "data/lib/rdimap",

    "buffer": "data/lib/node-buffer",
    "crypto": "data/lib/node-crypto",

    "assert": "data/deps/browserify-builtins/assert",
    "events": "data/deps/browserify-builtins/events",
    "stream": "data/deps/browserify-builtins/stream",
    "util": "data/deps/browserify-builtins/util",
  },
  packages: [
    { name: "mimelib", location: "data/deps/mimelib", main: "index" },
    { name: "iconv", location: "data/deps/iconv-lite", main: "index" },
    { name: "mailparser", location: "data/deps/mailparser/lib" },
  ],
  include: ["event-queue", "deps/stringencoding/encoding.js", "rdimap/imapclient/same-frame-setup"],
  name: "almond",
  out: "../gaia-email-opt.js",
  wrap: {
    startFile: "optStart.frag",
    endFile: "optEnd.frag"
  }
})

/*jslint node: true, nomen: true, evil: true, indent: 2*/
'use strict';

var jsPath, currentConfig, indexPath, buildOptions,
  requirejs = require('./r'),
  fs = require('fs'),
  path = require('path'),
  exists = fs.existsSync || path.existsSync,
  dest = process.argv[2];

if (!dest || !exists(dest)) {
  console.log('Pass path to gaia destination (should be the apps/email dir ' +
      'inside a gaia directory).');
  process.exit(1);
}

jsPath = path.join(dest, 'js', 'ext');
indexPath = path.join(dest, 'index.html');

buildOptions = {
  baseUrl: path.join(__dirname, '..'),
  optimize: 'none', //'uglify',
  //Keep any "use strict" in the built code.
  useStrict: true,
  paths: {
    'alameda': 'deps/alameda',
    'config': 'scripts/config',

    // front end of mail supplies its own evt
    'evt': 'empty:',

    // NOP's
    'prim': 'empty:',
    'http': 'data/lib/nop',
    'https': 'data/lib/nop2',
    'url': 'data/lib/nop3',
    'fs': 'data/lib/nop4',
    'xoauth2': 'data/lib/nop6',

    'q': 'empty:',
    'text': 'data/lib/text',
    // silly shim
    'event-queue': 'data/lib/js-shims/event-queue',
    'microtime': 'data/lib/js-shims/microtime',
    'path': 'data/lib/js-shims/path',

    'wbxml': 'deps/activesync/wbxml/wbxml',
    'activesync': 'deps/activesync',

    'bleach': 'deps/bleach.js/lib/bleach',

    'imap': 'data/lib/imap',
    'pop3': 'data/lib/pop3',

    'rdplat': 'data/lib/rdplat',
    'rdcommon': 'data/lib/rdcommon',
    'mailapi': 'data/lib/mailapi',

    'buffer': 'data/lib/node-buffer',
    'crypto': 'data/lib/node-crypto',
    'net': 'data/lib/node-net',
    'tls': 'data/lib/node-tls',
    'os': 'data/lib/node-os',

    'iconv': 'data/lib/js-shims/faux-iconv',
    'iconv-lite': 'data/libs/js-shims/faux-iconx',
    'encoding': 'data/lib/js-shims/faux-encoding',

    'assert': 'data/deps/browserify-builtins/assert',
    'events': 'data/deps/browserify-builtins/events',
    'stream': 'data/deps/browserify-builtins/stream',
    'util': 'data/deps/browserify-builtins/util',

    // These used to be packages but we have AMD shims for their mains where
    // appropriate, so we can just use paths.
    'addressparser': 'data/deps/addressparser',
    'mimelib': 'data/deps/mimelib',
    'mailparser': 'data/deps/mailparser/lib',
    'simplesmtp': 'data/deps/simplesmtp',
    'mailcomposer': 'data/deps/mailcomposer'
  }
};

var bootstrapIncludes = ['alameda', 'config', 'mailapi/shim-sham',
  'event-queue', 'mailapi/mailslice', 'mailapi/searchfilter',
  'mailapi/jobmixins', 'mailapi/accountmixins', 'util', 'stream', 'crypto',
  'encoding', 'mailapi/worker-setup'];
var standardExcludes = [].concat(bootstrapIncludes);
var standardPlusComposerExcludes = ['mailapi/composer'].concat(standardExcludes);

var configs = [
  // root aggregate loaded in worker context
  {
    name: 'mailapi/worker-bootstrap',
    include: bootstrapIncludes,
    insertRequire: ['mailapi/worker-setup'],
    out: jsPath + '/mailapi/worker-bootstrap.js'
  },

  // root aggregate loaded in main frame context
  {
    name: 'mailapi/main-frame-setup',
    out: jsPath + '/mailapi/main-frame-setup.js'
  },

  // needed by all kinds of different layers, so broken out on its own:
  // - mailparser/mailparser
  // - mailapi/composer (specifically mailcomposer)
  // - mailapi/chewlayer (specifically mailapi/imap/imapchew statically)
  // - activesync (specifically mailapi/activesync/folder dynamically)
  {
    name: 'mimelib',
    exclude: standardExcludes,
    out: jsPath + '/mimelib.js'
  },

  // text/plain and text/html logic, needed by both IMAP and ActiveSync.
  // It's not clear why imapchew is in this layer; seems like it could be in
  // imap/protocollayer.
  {
    name: 'mailapi/chewlayer',
    create: true,
    include: ['mailapi/quotechew', 'mailapi/htmlchew', 'mailapi/mailchew',
              'mailapi/imap/imapchew'],
    exclude: standardExcludes.concat(['mimelib']),
    out: jsPath + '/mailapi/chewlayer.js'
  },

  // mailparser lib and deps sans mimelib
  {
    name: 'mailparser/mailparser',
    exclude: standardExcludes.concat(['mimelib']),
    out: jsPath + '/mailparser/mailparser.js'
  },

  // our composition abstraction and its deps
  {
    name: 'mailapi/composer',
    exclude: standardExcludes.concat(['mailparser/mailparser',
                                      'mailapi/quotechew',
                                      'mailapi/htmlchew',
                                      'mailapi/imap/imapchew',
                                      'mimelib']),
    out: jsPath + '/mailapi/composer.js'
  },

  // imap protocol and probing support
  {
    name: 'mailapi/imap/probe',
    exclude: standardPlusComposerExcludes.concat(['mailparser/mailparser']),
    out: jsPath + '/mailapi/imap/probe.js'
  },

  // pop3 protocol and probing support
  {
    name: 'mailapi/pop3/probe',
    exclude: standardPlusComposerExcludes.concat(['mailparser/mailparser']),
    out: jsPath + '/mailapi/pop3/probe.js'
  },

  // imap online support
  {
    name: 'mailapi/imap/protocollayer',
    exclude: standardPlusComposerExcludes.concat(
      ['mailparser/mailparser', 'mimelib', 'mailapi/imap/imapchew']
    ),
    include: [
      'mailapi/imap/protocol/sync',
      'mailapi/imap/protocol/bodyfetcher',
      'mailapi/imap/protocol/textparser',
      'mailapi/imap/protocol/snippetparser'
    ],
    out: jsPath + '/mailapi/imap/protocollayer.js',
    create: true
  },
  // smtp online support
  {
    name: 'mailapi/smtp/probe',
    exclude: standardPlusComposerExcludes,
    out: jsPath + '/mailapi/smtp/probe.js'
  },

  // activesync configurator, offline support
  {
    name: 'mailapi/activesync/configurator',
    exclude: standardPlusComposerExcludes,
    out: jsPath + '/mailapi/activesync/configurator.js'
  },

  // activesync configurator, offline support
  {
    name: 'pop3/pop3',
    exclude: standardPlusComposerExcludes,
    out: jsPath + '/pop3/pop3.js'
  },

  // activesync online support
  {
    name: 'mailapi/activesync/protocollayer',
    create: true,
    include: ['wbxml', 'activesync/protocol'],
    exclude: standardExcludes.concat(['mailapi/activesync/configurator']),
    out: jsPath + '/mailapi/activesync/protocollayer.js'
  },

  // imap/smtp configuration, offline support
  {
    name: 'mailapi/composite/configurator',
    exclude: standardPlusComposerExcludes,
    out: jsPath + '/mailapi/composite/configurator.js'
  }
];

// Function used to mix in buildOptions to a new config target
function mix(target) {
  for (var prop in buildOptions) {
    if (buildOptions.hasOwnProperty(prop) && !target.hasOwnProperty(prop)) {
      target[prop] = buildOptions[prop];
    }
  }
  return target;
}

function onError(err) {
  console.error(err);
  process.exit(1);
}

//Create a runner that will run a separate build for each item
//in the configs array.
var runner = configs.reduceRight(function (prev, cfg) {
  return function (buildReportText) {
    if (buildReportText)
      console.log(buildReportText);

    currentConfig = mix(cfg);

    requirejs.optimize(currentConfig, prev, onError);
  };
}, function (buildReportText) {
  console.log(buildReportText);
});

//Run the builds
runner();

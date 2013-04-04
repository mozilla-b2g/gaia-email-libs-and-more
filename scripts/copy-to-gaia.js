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
  {
    name: 'mailapi/worker-bootstrap',
    include: bootstrapIncludes,
    insertRequire: ['mailapi/worker-setup'],
    out: jsPath + '/mailapi/worker-bootstrap.js'
  },

  {
    name: 'mailapi/main-frame-setup',
    include: [],
    out: jsPath + '/mailapi/main-frame-setup.js'
  },

  {
    name: 'mimelib',
    exclude: standardExcludes,
    out: jsPath + '/mimelib.js'
  },

  {
    name: 'mailapi/chewlayer',
    create: true,
    include: ['mailapi/quotechew', 'mailapi/htmlchew', 'mailapi/imap/imapchew'],
    exclude: standardExcludes,
    out: jsPath + '/mailapi/chewlayer.js'
  },

  {
    name: 'mailparser/mailparser',
    exclude: standardExcludes.concat(['mimelib']),
    out: jsPath + '/mailparser/mailparser.js'
  },

  {
    name: 'mailapi/composer',
    exclude: standardExcludes.concat(['mailparser/mailparser',
                                      'mailapi/quotechew',
                                      'mailapi/htmlchew',
                                      'mailapi/imap/imapchew',
                                      'mimelib']),
    out: jsPath + '/mailapi/composer.js'
  },

  {
    name: 'mailapi/imap/probe',
    exclude: standardPlusComposerExcludes.concat(['mailparser/mailparser']),
    out: jsPath + '/mailapi/imap/probe.js'
  },

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

  {
    name: 'mailapi/smtp/probe',
    exclude: standardPlusComposerExcludes,
    out: jsPath + '/mailapi/smtp/probe.js'
  },

  {
    name: 'mailapi/activesync/configurator',
    exclude: standardPlusComposerExcludes,
    out: jsPath + '/mailapi/activesync/configurator.js'
  },

  {
    name: 'mailapi/activesync/protocollayer',
    create: true,
    include: ['wbxml', 'activesync/protocol'],
    exclude: standardExcludes.concat(['mailapi/activesync/configurator']),
    out: jsPath + '/mailapi/activesync/protocollayer.js'
  },

  {
    name: 'mailapi/composite/configurator',
    exclude: standardPlusComposerExcludes,
    out: jsPath + '/mailapi/composite/configurator.js'
  },

  {
    name: 'mailapi/fake/configurator',
    exclude: standardPlusComposerExcludes,
    out: jsPath + '/mailapi/fake/configurator.js'
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

  try {
    var scriptText,
      endPath = path.join(jsPath, 'end.js'),
      indexContents = fs.readFileSync(indexPath, 'utf8'),
      startComment = '<!-- START BACKEND INJECT - do not modify -->',
      endComment = '<!-- END BACKEND INJECT -->',
      startIndex = indexContents.indexOf(startComment),
      endIndex = indexContents.indexOf(endComment),
      indent = '  ';

    // Write out the script tags in gaia email index.html
    if (startIndex === -1 || endIndex === -1) {
      console.log('Updating email index.html failed. Cannot find insertion comments.');
      process.exit(1);
    }

    // List of tags used in gaia
    var indexPaths = [
      'alameda',
      'end'
    ];

    // Copy some bootstrap scripts over to gaia
    fs.writeFileSync(path.join(jsPath, 'alameda.js'),
      fs.readFileSync(path.join(__dirname, '..', 'deps', 'alameda.js')),
      'utf8');
    fs.writeFileSync(endPath,
      fs.readFileSync(path.join(__dirname, 'end.js')),
      'utf8');

    // Modify end.js to include config.js
    var configContents = fs.readFileSync(path.join(__dirname, 'config.js'),
                                         'utf8');
    fs.writeFile(endPath, configContents + fs.readFileSync(endPath, 'utf8'));

    // Update gaia email index.html with the right script tags.
    scriptText = startComment + '\n' +
      indexPaths.map(function (name) {

        return indent + '<script type="application/javascript;version=1.8" ' +
          'defer src="' +
          'js/ext/' + name + '.js' +
          '"></script>';
      }).join('\n') + '\n' + indent;

    indexContents = indexContents.substring(0, startIndex) +
      scriptText +
      indexContents.substring(endIndex);

    fs.writeFileSync(indexPath, indexContents, 'utf8');

  } catch (e) {
    console.error(e);
    process.exit(1);
  }
});

//Run the builds
runner();

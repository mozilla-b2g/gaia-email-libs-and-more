
'use strict';

var window = self;

function debug(str) {
  dump('Worker: ' + str + '\n');
}

var console = {
  log: function (str) {
    debug('console.log: ' + str);
  },

  warn: function(str) {
    debug('console.warn: ' + str);
  },

  error: function(str) {
    debug('console.error: ' + str);
  }
}

var scripts = [
  'almond.js',
  'event-queue.js',
  'buffer.js',
  'mailapi/shim-sham.js',
  'q.js',
  'microtime.js',
  'rdcommon/extransform.js',
  'rdcommon/log.js',
  'mailapi/util.js',
  'mailapi/quotechew.js',
  'bleach.js',
  'mailapi/htmlchew.js',
  'mailapi/mailchew.js',
  'events.js',
  'util.js',
  'stream.js',
  'encoding.js',
  'addressparser/index.js',
  'addressparser.js',
  'mimelib/lib/mimelib.js',
  'mimelib/lib/content-types.js',
  'mimelib/lib/content-types-reversed.js',
  'mimelib/index.js',
  'mimelib.js',
  'mailcomposer/lib/punycode.js',
  'crypto.js',
  'mailcomposer/lib/dkim.js',
  'http.js',
  'https.js',
  'url.js',
  'mailcomposer/lib/urlfetch.js',
  'fs.js',
  'mailcomposer/lib/mailcomposer.js',
  'mailcomposer.js',
  'mailapi/composer.js',
  'mailapi/mailbridge.js',
  'rdcommon/logreaper.js',
  'mailapi/a64.js',
  'mailapi/date.js',
  'mailapi/syncbase.js',
  'mailapi/maildb.js',
  'mailapi/allback.js',
  'mailapi/cronsync.js',
  'net.js',
  'tls.js',
  'mailparser/datetime.js',
  'mailparser/streams.js',
  'mailparser/mailparser.js',
  'imap.js',
  'mailapi/imap/probe.js',
  'os.js',
  'simplesmtp/lib/starttls.js',
  'xoauth2.js',
  'simplesmtp/lib/client.js',
  'mailapi/smtp/probe.js',
  'wbxml.js',
  'activesync/codepages.js',
  'activesync/protocol.js',
  'mailapi/accountmixins.js',
  'mailapi/errbackoff.js',
  'mailapi/mailslice.js',
  'mailapi/searchfilter.js',
  'mailapi/imap/imapchew.js',
  'mailapi/imap/folder.js',
  'mailapi/jobmixins.js',
  'mailapi/imap/jobs.js',
  'mailapi/imap/account.js',
  'mailapi/smtp/account.js',
  'mailapi/fake/account.js',
  'mailapi/activesync/folder.js',
  'mailapi/activesync/jobs.js',
  'mailapi/activesync/account.js',
  'mailapi/accountcommon.js',
  'mailapi/mailuniverse.js',
  'mailapi/same-frame-setup.js',
  'end.js',
];

scripts.forEach(function loadScript(path) {
  importScripts('../' + path);
});


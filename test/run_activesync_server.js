/**
 * This file runs a standalone ActiveSync server.
 *
 * It is meant to be executed with an xpcshell.
 *
 * The Makefile in the root directory contains a target to run it:
 *
 *   $ make activesync-server
 */

'use strict';

load('js/ext/activesync-lib/wbxml/wbxml.js');

load('js/ext/activesync-lib/codepages/AirSyncBase.js');
load('js/ext/activesync-lib/codepages/AirSync.js');
load('js/ext/activesync-lib/codepages/Calendar.js');
load('js/ext/activesync-lib/codepages/Common.js');
load('js/ext/activesync-lib/codepages/ComposeMail.js');
load('js/ext/activesync-lib/codepages/Contacts2.js');
load('js/ext/activesync-lib/codepages/Contacts.js');
load('js/ext/activesync-lib/codepages/DocumentLibrary.js');
load('js/ext/activesync-lib/codepages/Email2.js');
load('js/ext/activesync-lib/codepages/Email.js');
load('js/ext/activesync-lib/codepages/FolderHierarchy.js');
load('js/ext/activesync-lib/codepages/GAL.js');
load('js/ext/activesync-lib/codepages/ItemEstimate.js');
load('js/ext/activesync-lib/codepages/ItemOperations.js');
load('js/ext/activesync-lib/codepages/MeetingResponse.js');
load('js/ext/activesync-lib/codepages/Move.js');
load('js/ext/activesync-lib/codepages/Notes.js');
load('js/ext/activesync-lib/codepages/Ping.js');
load('js/ext/activesync-lib/codepages/Provision.js');
load('js/ext/activesync-lib/codepages/ResolveRecipients.js');
load('js/ext/activesync-lib/codepages/RightsManagement.js');
load('js/ext/activesync-lib/codepages/Search.js');
load('js/ext/activesync-lib/codepages/Settings.js');
load('js/ext/activesync-lib/codepages/Tasks.js');
load('js/ext/activesync-lib/codepages/ValidateCert.js');
load('js/ext/activesync-lib/codepages.js');

// Prefixing since we are running in the global scope and we don't want modules
// under test that use $wbxml without requiring/defining it to accidentally
// work.
const $_wbxml = WBXML;
const $_ascp = ActiveSyncCodepages;

load('test/unit/resources/messageGenerator.js');
const $msgGen = MsgGen;

load('test/activesync_server.js');

let server = new ActiveSyncServer();

server.logRequest = function(request, body) {
  let path = request.path;
  if (request.queryString)
    path += '?' + request.queryString;
  dump('>>> ' + path + '\n');
  if (body) {
    if (body instanceof $_wbxml.Reader) {
      dump(body.dump());
      body.rewind();
    }
    else {
      dump(JSON.stringify(body, null, 2) + '\n');
    }
  }
  dump('\n');
};

server.logResponse = function(request, response, body) {
  dump('<<<\n');
  if (body) {
    if (body instanceof $_wbxml.Writer) {
      dump(new $_wbxml.Reader(body, $_ascp).dump());
    }
    else {
      dump(JSON.stringify(body, null, 2) + '\n');
    }
  }
  dump('\n');
};

server.logResponseError = function(err) {
  dump("ERR " + err + '\n\n');
};

server.start(SERVER_PORT);

_do_main();

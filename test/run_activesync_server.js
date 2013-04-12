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

load('deps/activesync/wbxml/wbxml.js');

load('deps/activesync/codepages/AirSyncBase.js');
load('deps/activesync/codepages/AirSync.js');
load('deps/activesync/codepages/Calendar.js');
load('deps/activesync/codepages/Common.js');
load('deps/activesync/codepages/ComposeMail.js');
load('deps/activesync/codepages/Contacts2.js');
load('deps/activesync/codepages/Contacts.js');
load('deps/activesync/codepages/DocumentLibrary.js');
load('deps/activesync/codepages/Email2.js');
load('deps/activesync/codepages/Email.js');
load('deps/activesync/codepages/FolderHierarchy.js');
load('deps/activesync/codepages/GAL.js');
load('deps/activesync/codepages/ItemEstimate.js');
load('deps/activesync/codepages/ItemOperations.js');
load('deps/activesync/codepages/MeetingResponse.js');
load('deps/activesync/codepages/Move.js');
load('deps/activesync/codepages/Notes.js');
load('deps/activesync/codepages/Ping.js');
load('deps/activesync/codepages/Provision.js');
load('deps/activesync/codepages/ResolveRecipients.js');
load('deps/activesync/codepages/RightsManagement.js');
load('deps/activesync/codepages/Search.js');
load('deps/activesync/codepages/Settings.js');
load('deps/activesync/codepages/Tasks.js');
load('deps/activesync/codepages/ValidateCert.js');
load('deps/activesync/codepages.js');

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

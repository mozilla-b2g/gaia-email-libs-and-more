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
load('deps/activesync/codepages.js');
load('test/unit/resources/messageGenerator.js');
// Prefixing since we are running in the global scope and we don't want modules
// under test that use $wbxml without requiring/defining it to accidentally
// work.
const $_wbxml = WBXML;
const $_ascp = ActiveSyncCodepages;

load('test/activesync_server.js');



let server = new ActiveSyncServer();
server.start(SERVER_PORT);

_do_main();

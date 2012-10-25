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

load('test/activesync_server.js');

let server = new ActiveSyncServer();
server.start(SERVER_PORT);

_do_main();

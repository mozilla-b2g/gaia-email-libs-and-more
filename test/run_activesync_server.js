'use strict';

load('test/activesync_server.js');

let server = new ActiveSyncServer();
server.start(8080);

_do_main();

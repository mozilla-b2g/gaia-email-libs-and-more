'use strict';

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import('resource://testing-common/httpd.js');
load('deps/activesync/wbxml/wbxml.js');

let server = new HttpServer();
server.registerPathHandler('/test', {
  handle: function(request, response) {
    response.setStatusLine('1.0', 200, 'OK');
    response.setHeader('Content-Type', 'text/plain');
    response.write('hi');
  }
});
server.start(8080);

_do_main();

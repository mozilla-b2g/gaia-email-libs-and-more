define(function() {
  'use strict';

  function debug(str) {
    //dump('NetSocket: ' + str + '\n');
  }

  // Maintain a list of active sockets
  var socks = {};

  function open(uid, host, port, options) {
    var socket = navigator.mozTCPSocket;
    var sock = socks[uid] = socket.open(host, port, options);

    sock.onopen = function(evt) {
      //debug('onopen ' + uid + ": " + evt.data.toString());
      self.sendMessage(uid, 'onopen', [evt.data.toString()]);
    };

    sock.onerror = function(evt) {
      //debug('onerror ' + uid + ": " + new Uint8Array(evt.data));
      self.sendMessage(uid, 'onerror', [new Uint8Array(evt.data)]);
    };

    sock.ondata = function(evt) {
      /*
      try {
        var str = '';
        for (var i = 0; i < evt.data.byteLength; i++) {
          str += String.fromCharCode(evt.data[i]);
        }
        debug(str + '\n');
      } catch(e) {}
      debug('ondata ' + uid + ": " + new Uint8Array(evt.data));
      */
      self.sendMessage(uid, 'ondata', [new Uint8Array(evt.data)]);
    };

    sock.onclose = function(evt) {
      //debug('onclose ' + uid + ": " + evt.data.toString());
      self.sendMessage(uid, 'onclose', [evt.data.toString()]);
    };
  }

  function close(uid) {
    socks[uid].close();
    delete socks[uid];
  }

  function write(uid, data) {
    socks[uid].send(new Uint8Array(data));
  }

  var self = {
    name: 'netsocket',
    sendMessage: null,
    process: function(uid, cmd, args) {
      debug('process ' + cmd);
      switch (cmd) {
        case 'open':
          open(uid, args[0], args[1], args[2]);
          break;
        case 'close':
          close(uid);
          break;
        case 'write':
          write(uid, args[0]);
          break;
      }
    }
  };
  return self;
});

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
      self.sendMessage(uid, 'onopen');
    };

    sock.onerror = function(evt) {
      //debug('onerror ' + uid + ": " + new Uint8Array(evt.data));
      var err = evt.data;
      var wrappedErr;
      if (err && typeof(err) === 'object') {
        wrappedErr = {
          name: err.name,
          message: err.message
        };
        // Propagate the SSL error detecting heuristic used elsewhere.  This is
        // an XPCOM interface that we do not expect to structured clone across
        // so well.
        if ('isNotValidAtThisTime' in err) {
          wrappedErr.isNotValidAtThisTime = err.isNotValidAtThisTime;
        }
      }
      else {
        wrappedErr = err;
      }
      self.sendMessage(uid, 'onerror', wrappedErr);
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
      // XXX why are we doing this? ask Vivien or try to remove...
      self.sendMessage(uid, 'ondata', new Uint8Array(evt.data));
    };

    sock.onclose = function(evt) {
      //debug('onclose ' + uid + ": " + evt.data.toString());
      self.sendMessage(uid, 'onclose');
    };
  }

  function close(uid) {
    var sock = socks[uid];
    if (!sock)
      return;
    sock.close();
    sock.onopen = null;
    sock.onerror = null;
    sock.ondata = null;
    sock.onclose = null;
    delete socks[uid];
  }

  function write(uid, data) {
    // XXX why are we doing this? ask Vivien or try to remove...
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

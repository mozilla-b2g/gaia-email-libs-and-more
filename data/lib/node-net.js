/**
 * Make our TCPSocket implementation look like node's net library.
 *
 * We make sure to support:
 *
 * Attributes:
 * - encrypted (false, this is not the tls byproduct)
 * - destroyed
 *
 * Methods:
 * - setKeepAlive(Boolean)
 * - write(Buffer)
 * - end
 *
 * Events:
 * - "connect"
 * - "close"
 * - "end"
 * - "data"
 * - "error"
 **/
define(function(require, exports, module) {

function debug(str) {
  //dump("NetSocket: (" + Date.now() + ") :" + str + "\n");
}

var util = require('util'),
    EventEmitter = require('events').EventEmitter;

function sendMessage(cmd, uid, args, callback) {
  if (!Array.isArray(args)) {
    args = args ? [args] : [];
  }

  self.postMessage({ type: 'netsocket', uid: uid, cmd: cmd, args: args });
}

var socketId = 0;

function NetSocket(port, host, crypto) {
  var uid = this.uid = socketId++;

  var args = [host, port, { useSSL: crypto, binaryType: 'arraybuffer' }];
  sendMessage('open', uid, args);

  self.addEventListener('message', function(evt) {
    var data = evt.data;
    if (data.type != 'netsocket')
      return;

    if (data.uid != uid)
      return;

    var callback = callbacks[data.cmd];
    if (!callback)
      return;

    callback.call(callback, { data: data.args[0] });
  });

  var callbacks = {
    onopen: this._onconnect.bind(this),
    onerror: this._onerror.bind(this),
    ondata: this._ondata.bind(this),
    onclose: this._onclose.bind(this)
  };
  
  EventEmitter.call(this);

  this.destroyed = false;
}
exports.NetSocket = NetSocket;
util.inherits(NetSocket, EventEmitter);
NetSocket.prototype.setTimeout = function() {
};
NetSocket.prototype.setKeepAlive = function(shouldKeepAlive) {
};
NetSocket.prototype.write = function(buffer) {
  sendMessage('write', this.uid, [buffer]);
};
NetSocket.prototype.end = function() {
  sendMessage('end', this.uid);
  this.destroyed = true;
};

NetSocket.prototype._onconnect = function(event) {
  this.emit('connect', event.data);
};
NetSocket.prototype._onerror = function(event) {
  this.emit('error', event.data);
};
NetSocket.prototype._ondata = function(event) {
  var buffer = Buffer(event.data);
  this.emit('data', buffer);
};
NetSocket.prototype._onclose = function(event) {
  this.emit('close', event.data);
  this.emit('end', event.data);
};


exports.connect = function(port, host) {
  return new NetSocket(port, host, false);
};

}); // end define

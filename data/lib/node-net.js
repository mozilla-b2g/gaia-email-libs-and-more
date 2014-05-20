/**
 * Remoted network API that tries to look like node.js's "net" API.  We are
 * expected/required to run in a worker thread where we don't have direct
 * access to mozTCPSocket so everything has to get remitted to the main thread.
 * Our counterpart is mailapi/worker-support/net-main.js
 *
 *
 * ## Sending lots of data: flow control, Blobs ##
 *
 * mozTCPSocket provides a flow-control mechanism (the return value to send
 * indicates whether we've crossed a buffering boundary and 'ondrain' tells us
 * when all buffered data has been sent), but does not yet support enqueueing
 * Blobs for processing (which is part of the proposed standard at
 * http://www.w3.org/2012/sysapps/raw-sockets/).  Also, the raw-sockets spec
 * calls for generating the 'drain' event once our buffered amount goes back
 * under the internal buffer target rather than waiting for it to hit zero like
 * mozTCPSocket.
 *
 * Our main desire right now for flow-control is to avoid using a lot of memory
 * and getting killed by the OOM-killer.  As such, flow control is not important
 * to us if we're just sending something that we're already keeping in memory.
 * The things that will kill us are giant things like attachments (or message
 * bodies we are quoting/repeating, potentially) that we are keeping as Blobs.
 *
 * As such, rather than echoing the flow-control mechanisms over to this worker
 * context, we just allow ourselves to write() a Blob and have the net-main.js
 * side take care of streaming the Blobs over the network.
 *
 * Note that successfully sending a lot of data may entail holding a wake-lock
 * to avoid having the network device we are using turned off in the middle of
 * our sending.  The network-connection abstraction is not currently directly
 * involved with the wake-lock management, but I could see it needing to beef up
 * its error inference in terms of timeouts/detecting disconnections so we can
 * avoid grabbing a wi-fi wake-lock, having our connection quietly die, and then
 * we keep holding the wi-fi wake-lock for much longer than we should.
 *
 * ## Supported API Surface ##
 *
 * We make sure to expose the following subset of the node.js API because we
 * have consumers that get upset if these do not exist:
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
    EventEmitter = require('events').EventEmitter,
    router = require('mailapi/worker-router');

var routerMaker = router.registerInstanceType('netsocket');

function NetSocket(port, host, crypto) {
  var cmdMap = {
    onopen: this._onconnect.bind(this),
    onerror: this._onerror.bind(this),
    ondata: this._ondata.bind(this),
    onprogress: this._onprogress.bind(this),
    onclose: this._onclose.bind(this)
  };
  var routerInfo = routerMaker.register(function(data) {
    cmdMap[data.cmd](data.args);
  });
  this._sendMessage = routerInfo.sendMessage;
  this._unregisterWithRouter = routerInfo.unregister;

  var args = [host, port,
              {
                // Bug 784816 is changing useSSL into useSecureTransport for
                // spec compliance.  Use both during the transition period.
                useSSL: crypto, useSecureTransport: crypto,
                binaryType: 'arraybuffer'
              }];
  this._sendMessage('open', args);

  EventEmitter.call(this);

  this.destroyed = false;
}
exports.NetSocket = NetSocket;
util.inherits(NetSocket, EventEmitter);
NetSocket.prototype.setTimeout = function() {
};
NetSocket.prototype.setKeepAlive = function(shouldKeepAlive) {
};
// The semantics of node.js's socket.write does not take ownership and that's
// how our code uses it, so we can't use transferrables by default.  However,
// there is an optimization we want to perform related to Uint8Array.subarray().
//
// All the subarray does is create a view on the underlying buffer.  This is
// important and notable because the structured clone implementation for typed
// arrays and array buffers is *not* clever; it just serializes the entire
// underlying buffer and the typed array as a view on that.  (This does have
// the upside that you can transfer a whole bunch of typed arrays and only one
// copy of the buffer.)  The good news is that ArrayBuffer.slice() does create
// an entirely new copy of the buffer, so that works with our semantics and we
// can use that to transfer only what needs to be transferred.
NetSocket.prototype.write = function(u8array) {
  if (u8array instanceof Blob) {
    // We always send blobs in their entirety; you should slice the blob and
    // give us that if that's what you want.
    this._sendMessage('write', [u8array]);
    return;
  }

  var sendArgs;
  // Slice the underlying buffer and transfer it if the array is a subarray
  if (u8array.byteOffset !== 0 ||
      u8array.length !== u8array.buffer.byteLength) {
    var buf = u8array.buffer.slice(u8array.byteOffset,
                                   u8array.byteOffset + u8array.length);
    this._sendMessage('write',
                      [buf, 0, buf.byteLength],
                      [buf]);
  }
  else {
    this._sendMessage('write',
                      [u8array.buffer, u8array.byteOffset, u8array.length]);
  }
};
NetSocket.prototype.upgradeToSecure = function() {
  this._sendMessage('upgradeToSecure', []);
};
NetSocket.prototype.end = function() {
  if (this.destroyed)
    return;
  this._sendMessage('end');
  this.destroyed = true;
  this._unregisterWithRouter();
};

NetSocket.prototype._onconnect = function() {
  this.emit('connect');
};
NetSocket.prototype._onerror = function(err) {
  this.emit('error', err);
};
NetSocket.prototype._ondata = function(data) {
  var buffer = Buffer(data);
  this.emit('data', buffer);
};
NetSocket.prototype._onprogress = function() {
  this.emit('progress');
};
NetSocket.prototype._onclose = function() {
  this.emit('close');
  this.emit('end');
};

exports.connect = function(port, host, crypto) {
  return new NetSocket(port, host, !!crypto);
};

}); // end define

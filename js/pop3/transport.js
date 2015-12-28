define(function(require, exports) {

var mimefuncs = require('mimefuncs');
var streams = require('streams');
var mimeStreams = require('mime-streams');
var evt = require('evt');
var setTimeout = window.setTimeout.bind(window);
var clearTimeout = window.clearTimeout.bind(window);

var CR = '\r'.charCodeAt(0);
var LF = '\n'.charCodeAt(0);
var PERIOD = '.'.charCodeAt(0);
var PLUS = '+'.charCodeAt(0);
var MINUS = '-'.charCodeAt(0);
var SPACE = ' '.charCodeAt(0);

var textEncoder = new TextEncoder('utf-8', { fatal: false });

exports.Pop3RequestStream = function(socket, greetingRequest) {
  var { readable, writable } = new mimeStreams.SocketStream(socket);

  var requestsAwaitingResponse = [greetingRequest];

  var writableRequestStream = new streams.WritableStream({
    write: function(request) {
      if (socket.readyState === 'closed') {
        request._respondWithError('(connection closed before send)');
        return;
      }
      requestsAwaitingResponse.push(request);
      // Only process one request at a time, i.e. no pipelining. Subsequent
      // requests will be sent upon receiving a complete response.
      if (requestsAwaitingResponse.length === 1) {
        writable.write(request.toByteArray());
      }
    },
    close: function() {
      for (var request; request = requestsAwaitingResponse.shift(); ) {
        request._respondWithError('(connection closed, no response)');
      };
    }
  })

  readable
    .pipeThrough(new mimeStreams.LineTransformStream())
    .pipeTo(new streams.WritableStream({
      write: function(line) {
        var currentRequest = requestsAwaitingResponse[0];
        if (!currentRequest) {
          return;
        }

        var isResponseComplete = currentRequest.processResponseLine(line);

        if (isResponseComplete) {
          requestsAwaitingResponse.shift();
          // If more requests are pending, send the next one over the socket.
          if (requestsAwaitingResponse.length > 0) {
            var nextRequest = requestsAwaitingResponse[0];
            writable.write(nextRequest.toByteArray());
          }
        }
      },
      close: function() {
        // Close the request stream when we lose the socket.
        writableRequestStream.close();
      }
    }))


  return writableRequestStream;
}

var Request = exports.Request = function(command, args, expectMultiline) {
  this.command = command;
  this.args = args || [];
  this.expectMultiline = !!expectMultiline;

  this.statusLine = null;
  this._dataLineStreamController = null;
  this.dataLineStream = new streams.ReadableStream({
    start: (controller) => {
      this._dataLineStreamController = controller;
    }
  });
}

Request.prototype = {
  /**
   * Encode the request into a byte array suitable for transport over
   * a socket.
   */
  toByteArray: function() {
    return textEncoder.encode(
      this.command +
      (this.args.length ? ' ' + this.args.join(' ') : '') + '\r\n');
  },

  processResponseLine: function(line) {
    if (!this.statusLine) {
      this.statusLine = line;
      // Negative responses are never multiline.
      if (line[0] !== PLUS) {
        this.expectMultiline = false;
      }
      if (!this.expectMultiline) {
        if (this._dataLineStreamController) {
          if (line[0] !== PLUS) {
            this._dataLineStreamController.error({
              statusLine: mimefuncs.fromTypedArray(line)
            });
          } else {
            this._dataLineStreamController.close();
          }
        }
        return true; // done!
      }
    }
    // Otherwise, this is a data continuation line.
    else {
      if (line.byteLength === 3 &&
          line[0] === PERIOD && line[1] === CR && line[2] === LF) {
        if (this._dataLineStreamController) {
          this._dataLineStreamController.close();
        }
        return true;
      } else {
        if (line[0] === PERIOD) {
          line = line.subarray(1); // Un-period-stuff this line.
        }
        // If anyone is listening (which they should be),
        // push this line onto the data stream.
        if (this._dataLineStreamController) {
          this._dataLineStreamController.enqueue(line);
        }
      }
    }
  },

  _respondWithError: function(desc) {
    this.processResponseLine(
      textEncoder.encode('-ERR ' + desc + '\r\n'));
  },

  then: function(thenFn, catchFn) {
    return mimeStreams.readAllChunks(this.dataLineStream)
      .then(thenFn, catchFn);
  },

  /**
   * Return the status line as a string.
   */
  getStatusLine: function() {
    return mimefuncs.fromTypedArray(this.statusLine);
  },

  toString: function() {
    return this.command + ' => ' + this.getStatusLine();
  },
}

});

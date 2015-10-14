(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.Streams = f()}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});
exports.assert = assert;

function assert(val, msg) {
  if (!val) {
    throw new Error('AssertionError: ' + msg);
  }
}

},{}],2:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

var _createClass = (function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ('value' in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

var _helpers = require('./helpers');

var ByteLengthQueuingStrategy = (function () {
  function ByteLengthQueuingStrategy(_ref) {
    var highWaterMark = _ref.highWaterMark;

    _classCallCheck(this, ByteLengthQueuingStrategy);

    (0, _helpers.createDataProperty)(this, 'highWaterMark', highWaterMark);
  }

  _createClass(ByteLengthQueuingStrategy, [{
    key: 'size',
    value: function size(chunk) {
      return chunk.byteLength;
    }
  }]);

  return ByteLengthQueuingStrategy;
})();

exports['default'] = ByteLengthQueuingStrategy;
module.exports = exports['default'];

},{"./helpers":4}],3:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

var _createClass = (function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ('value' in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

var _helpers = require('./helpers');

var CountQueuingStrategy = (function () {
  function CountQueuingStrategy(_ref) {
    var highWaterMark = _ref.highWaterMark;

    _classCallCheck(this, CountQueuingStrategy);

    (0, _helpers.createDataProperty)(this, 'highWaterMark', highWaterMark);
  }

  _createClass(CountQueuingStrategy, [{
    key: 'size',
    value: function size(chunk) {
      return 1;
    }
  }]);

  return CountQueuingStrategy;
})();

exports['default'] = CountQueuingStrategy;
module.exports = exports['default'];

},{"./helpers":4}],4:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});
exports.promiseCall = promiseCall;
exports.typeIsObject = typeIsObject;
exports.toInteger = toInteger;
exports.createDataProperty = createDataProperty;
exports.createArrayFromList = createArrayFromList;
exports.CreateIterResultObject = CreateIterResultObject;
exports.InvokeOrNoop = InvokeOrNoop;
exports.PromiseInvokeOrNoop = PromiseInvokeOrNoop;
exports.PromiseInvokeOrFallbackOrNoop = PromiseInvokeOrFallbackOrNoop;
exports.ValidateAndNormalizeQueuingStrategy = ValidateAndNormalizeQueuingStrategy;

var _assert = require('./assert');

function promiseCall(func) {
  for (var _len = arguments.length, args = Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
    args[_key - 1] = arguments[_key];
  }

  try {
    return Promise.resolve(func.apply(undefined, args));
  } catch (e) {
    return Promise.reject(e);
  }
}

function typeIsObject(x) {
  return typeof x === 'object' && x !== null || typeof x === 'function';
}

function toInteger(v) {
  v = Number(v);
  if (isNaN(v)) {
    return 0;
  }

  if (v < 0) {
    return -1 * Math.floor(Math.abs(v));
  }

  return Math.floor(Math.abs(v));
}

function createDataProperty(o, p, v) {
  (0, _assert.assert)(typeIsObject(o));
  Object.defineProperty(o, p, { value: v, writable: true, enumerable: true, configurable: true });
}

function createArrayFromList(elements) {
  // We use arrays to represent lists, so this is basically a no-op.
  // Do a slice though just in case we happen to depend on the unique-ness.
  return elements.slice();
}

function CreateIterResultObject(value, done) {
  (0, _assert.assert)(typeof done === 'boolean');
  var obj = {};
  Object.defineProperty(obj, 'value', { value: value, enumerable: true, writable: true, configurable: true });
  Object.defineProperty(obj, 'done', { value: done, enumerable: true, writable: true, configurable: true });
  return obj;
}

function InvokeOrNoop(O, P, args) {
  var method = O[P];
  if (method === undefined) {
    return undefined;
  }
  return method.apply(O, args);
}

function PromiseInvokeOrNoop(O, P, args) {
  var method = undefined;
  try {
    method = O[P];
  } catch (methodE) {
    return Promise.reject(methodE);
  }

  if (method === undefined) {
    return Promise.resolve(undefined);
  }

  try {
    return Promise.resolve(method.apply(O, args));
  } catch (e) {
    return Promise.reject(e);
  }
}

function PromiseInvokeOrFallbackOrNoop(O, P1, args1, P2, args2) {
  var method = undefined;
  try {
    method = O[P1];
  } catch (methodE) {
    return Promise.reject(methodE);
  }

  if (method === undefined) {
    return PromiseInvokeOrNoop(O, P2, args2);
  }

  try {
    return Promise.resolve(method.apply(O, args1));
  } catch (e) {
    return Promise.reject(e);
  }
}

function ValidateAndNormalizeQueuingStrategy(size, highWaterMark) {
  if (size !== undefined && typeof size !== 'function') {
    throw new TypeError('size property of a queuing strategy must be a function');
  }

  highWaterMark = Number(highWaterMark);
  if (Number.isNaN(highWaterMark)) {
    throw new TypeError('highWaterMark property of a queuing strategy must be convertible to a non-NaN number');
  }
  if (highWaterMark < 0) {
    throw new RangeError('highWaterMark property of a queuing strategy must be nonnegative');
  }

  return { size: size, highWaterMark: highWaterMark };
}

},{"./assert":1}],5:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _byteLengthQueuingStrategyJs = require('./byte-length-queuing-strategy.js');

var _byteLengthQueuingStrategyJs2 = _interopRequireDefault(_byteLengthQueuingStrategyJs);

var _countQueuingStrategyJs = require('./count-queuing-strategy.js');

var _countQueuingStrategyJs2 = _interopRequireDefault(_countQueuingStrategyJs);

var _readableStreamJs = require('./readable-stream.js');

var _readableStreamJs2 = _interopRequireDefault(_readableStreamJs);

var _transformStreamJs = require('./transform-stream.js');

var _transformStreamJs2 = _interopRequireDefault(_transformStreamJs);

var _writableStreamJs = require('./writable-stream.js');

var _writableStreamJs2 = _interopRequireDefault(_writableStreamJs);

var Streams = {
  ByteLengthQueuingStrategy: _byteLengthQueuingStrategyJs2['default'],
  CountQueuingStrategy: _countQueuingStrategyJs2['default'],
  ReadableStream: _readableStreamJs2['default'],
  TransformStream: _transformStreamJs2['default'],
  WritableStream: _writableStreamJs2['default']
};
exports['default'] = Streams;
module.exports = exports['default'];

},{"./byte-length-queuing-strategy.js":2,"./count-queuing-strategy.js":3,"./readable-stream.js":7,"./transform-stream.js":8,"./writable-stream.js":10}],6:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});
exports.DequeueValue = DequeueValue;
exports.EnqueueValueWithSize = EnqueueValueWithSize;
exports.GetTotalQueueSize = GetTotalQueueSize;
exports.PeekQueueValue = PeekQueueValue;

var _assert = require('./assert');

function DequeueValue(queue) {
  (0, _assert.assert)(queue.length > 0, 'Spec-level failure: should never dequeue from an empty queue.');
  var pair = queue.shift();
  return pair.value;
}

function EnqueueValueWithSize(queue, value, size) {
  size = Number(size);
  if (Number.isNaN(size) || size === +Infinity || size === -Infinity) {
    throw new RangeError('Size must be a finite, non-NaN number.');
  }

  queue.push({ value: value, size: size });
}

function GetTotalQueueSize(queue) {
  var totalSize = 0;

  queue.forEach(function (pair) {
    (0, _assert.assert)(typeof pair.size === 'number' && !Number.isNaN(pair.size) && pair.size !== +Infinity && pair.size !== -Infinity, 'Spec-level failure: should never find an invalid size in the queue.');
    totalSize += pair.size;
  });

  return totalSize;
}

function PeekQueueValue(queue) {
  (0, _assert.assert)(queue.length > 0, 'Spec-level failure: should never peek at an empty queue.');
  var pair = queue[0];
  return pair.value;
}

},{"./assert":1}],7:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

var _createClass = (function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ('value' in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

function _slicedToArray(arr, i) { if (Array.isArray(arr)) { return arr; } else if (Symbol.iterator in Object(arr)) { var _arr = []; var _n = true; var _d = false; var _e = undefined; try { for (var _i = arr[Symbol.iterator](), _s; !(_n = (_s = _i.next()).done); _n = true) { _arr.push(_s.value); if (i && _arr.length === i) break; } } catch (err) { _d = true; _e = err; } finally { try { if (!_n && _i['return']) _i['return'](); } finally { if (_d) throw _e; } } return _arr; } else { throw new TypeError('Invalid attempt to destructure non-iterable instance'); } }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

var _assert = require('./assert');

var _helpers = require('./helpers');

var _utils = require('./utils');

var _queueWithSizes = require('./queue-with-sizes');

var ReadableStream = (function () {
  function ReadableStream() {
    var _this = this;

    var underlyingSource = arguments[0] === undefined ? {} : arguments[0];

    var _ref = arguments[1] === undefined ? {} : arguments[1];

    var size = _ref.size;
    var _ref$highWaterMark = _ref.highWaterMark;
    var highWaterMark = _ref$highWaterMark === undefined ? 1 : _ref$highWaterMark;

    _classCallCheck(this, ReadableStream);

    this._underlyingSource = underlyingSource;
    this._queue = [];
    this._state = 'readable';
    this._started = false;
    this._closeRequested = false;
    this._pulling = false;
    this._pullAgain = false;
    this._reader = undefined;
    this._storedError = undefined;

    var normalizedStrategy = (0, _helpers.ValidateAndNormalizeQueuingStrategy)(size, highWaterMark);
    this._strategySize = normalizedStrategy.size;
    this._strategyHWM = normalizedStrategy.highWaterMark;

    this._controller = new ReadableStreamController(this);

    var startResult = (0, _helpers.InvokeOrNoop)(underlyingSource, 'start', [this._controller]);
    Promise.resolve(startResult).then(function () {
      _this._started = true;
      RequestReadableStreamPull(_this);
    }, function (r) {
      if (_this._state === 'readable') {
        return ErrorReadableStream(_this, r);
      }
    })['catch'](_utils.rethrowAssertionErrorRejection);
  }

  _createClass(ReadableStream, [{
    key: 'cancel',
    value: function cancel(reason) {
      if (IsReadableStream(this) === false) {
        return Promise.reject(new TypeError('ReadableStream.prototype.cancel can only be used on a ReadableStream'));
      }

      if (IsReadableStreamLocked(this) === true) {
        return Promise.reject(new TypeError('Cannot cancel a stream that already has a reader'));
      }

      return CancelReadableStream(this, reason);
    }
  }, {
    key: 'getReader',
    value: function getReader() {
      if (IsReadableStream(this) === false) {
        throw new TypeError('ReadableStream.prototype.getReader can only be used on a ReadableStream');
      }

      return AcquireReadableStreamReader(this);
    }
  }, {
    key: 'pipeThrough',
    value: function pipeThrough(_ref2, options) {
      var writable = _ref2.writable;
      var readable = _ref2.readable;

      this.pipeTo(writable, options);
      return readable;
    }
  }, {
    key: 'pipeTo',
    value: function pipeTo(dest) {
      var _ref3 = arguments[1] === undefined ? {} : arguments[1];

      var preventClose = _ref3.preventClose;
      var preventAbort = _ref3.preventAbort;
      var preventCancel = _ref3.preventCancel;

      preventClose = Boolean(preventClose);
      preventAbort = Boolean(preventAbort);
      preventCancel = Boolean(preventCancel);

      var source = this;

      var reader = undefined;
      var lastRead = undefined;
      var lastWrite = undefined;
      var closedPurposefully = false;
      var resolvePipeToPromise = undefined;
      var rejectPipeToPromise = undefined;

      return new Promise(function (resolve, reject) {
        resolvePipeToPromise = resolve;
        rejectPipeToPromise = reject;

        reader = source.getReader();

        reader.closed['catch'](abortDest);
        dest.closed.then(function () {
          if (!closedPurposefully) {
            cancelSource(new TypeError('destination is closing or closed and cannot be piped to anymore'));
          }
        }, cancelSource);

        doPipe();
      });

      function doPipe() {
        lastRead = reader.read();
        Promise.all([lastRead, dest.ready]).then(function (_ref4) {
          var _ref42 = _slicedToArray(_ref4, 1);

          var _ref42$0 = _ref42[0];
          var value = _ref42$0.value;
          var done = _ref42$0.done;

          if (Boolean(done) === true) {
            closeDest();
          } else if (dest.state === 'writable') {
            lastWrite = dest.write(value);
            doPipe();
          }
        });

        // Any failures will be handled by listening to reader.closed and dest.closed above.
        // TODO: handle malicious dest.write/dest.close?
      }

      function cancelSource(reason) {
        if (preventCancel === false) {
          // cancelling automatically releases the lock (and that doesn't fail, since source is then closed)
          reader.cancel(reason);
          rejectPipeToPromise(reason);
        } else {
          // If we don't cancel, we need to wait for lastRead to finish before we're allowed to release.
          // We don't need to handle lastRead failing because that will trigger abortDest which takes care of
          // both of these.
          lastRead.then(function () {
            reader.releaseLock();
            rejectPipeToPromise(reason);
          });
        }
      }

      function closeDest() {
        // Does not need to wait for lastRead since it occurs only on source closed.

        reader.releaseLock();

        var destState = dest.state;
        if (preventClose === false && (destState === 'waiting' || destState === 'writable')) {
          closedPurposefully = true;
          dest.close().then(resolvePipeToPromise, rejectPipeToPromise);
        } else if (lastWrite !== undefined) {
          lastWrite.then(resolvePipeToPromise, rejectPipeToPromise);
        } else {
          resolvePipeToPromise();
        }
      }

      function abortDest(reason) {
        // Does not need to wait for lastRead since it only occurs on source errored.

        reader.releaseLock();

        if (preventAbort === false) {
          dest.abort(reason);
        }
        rejectPipeToPromise(reason);
      }
    }
  }, {
    key: 'tee',
    value: function tee() {
      if (IsReadableStream(this) === false) {
        throw new TypeError('ReadableStream.prototype.tee can only be used on a ReadableStream');
      }

      var branches = TeeReadableStream(this, false);
      return (0, _helpers.createArrayFromList)(branches);
    }
  }]);

  return ReadableStream;
})();

exports['default'] = ReadableStream;

var ReadableStreamController = (function () {
  function ReadableStreamController(stream) {
    _classCallCheck(this, ReadableStreamController);

    if (IsReadableStream(stream) === false) {
      throw new TypeError('ReadableStreamController can only be constructed with a ReadableStream instance');
    }

    if (stream._controller !== undefined) {
      throw new TypeError('ReadableStreamController instances can only be created by the ReadableStream constructor');
    }

    this._controlledReadableStream = stream;
  }

  _createClass(ReadableStreamController, [{
    key: 'desiredSize',
    get: function () {
      if (IsReadableStreamController(this) === false) {
        throw new TypeError('ReadableStreamController.prototype.desiredSize can only be used on a ReadableStreamController');
      }

      return GetReadableStreamDesiredSize(this._controlledReadableStream);
    }
  }, {
    key: 'close',
    value: function close() {
      if (IsReadableStreamController(this) === false) {
        throw new TypeError('ReadableStreamController.prototype.close can only be used on a ReadableStreamController');
      }

      var stream = this._controlledReadableStream;

      if (stream._closeRequested === true) {
        throw new TypeError('The stream has already been closed; do not close it again! ' + new Error().stack);
      }
      if (stream._state === 'errored') {
        throw new TypeError('The stream is in an errored state and cannot be closed');
      }

      return CloseReadableStream(stream);
    }
  }, {
    key: 'enqueue',
    value: function enqueue(chunk) {
      if (IsReadableStreamController(this) === false) {
        throw new TypeError('ReadableStreamController.prototype.enqueue can only be used on a ReadableStreamController');
      }

      var stream = this._controlledReadableStream;

      if (stream._state === 'errored') {
        throw stream._storedError;
      }

      if (stream._closeRequested === true) {
        throw new TypeError('stream is closed or draining'+new Error().stack);
      }

      return EnqueueInReadableStream(stream, chunk);
    }
  }, {
    key: 'error',
    value: function error(e) {
      if (IsReadableStreamController(this) === false) {
        throw new TypeError('ReadableStreamController.prototype.error can only be used on a ReadableStreamController');
      }

      if (this._controlledReadableStream._state !== 'readable') {
        throw new TypeError('The stream is ' + this._controlledReadableStream._state + ' and so cannot be errored');
      }

      return ErrorReadableStream(this._controlledReadableStream, e);
    }
  }]);

  return ReadableStreamController;
})();

var ReadableStreamReader = (function () {
  function ReadableStreamReader(stream) {
    var _this2 = this;

    _classCallCheck(this, ReadableStreamReader);

    if (IsReadableStream(stream) === false) {
      throw new TypeError('ReadableStreamReader can only be constructed with a ReadableStream instance');
    }
    if (IsReadableStreamLocked(stream) === true) {
      throw new TypeError('This stream has already been locked for exclusive reading by another reader');
    }

    stream._reader = this;
    this._ownerReadableStream = stream;
    this._state = 'readable';
    this._storedError = undefined;

    this._readRequests = [];

    this._closedPromise = new Promise(function (resolve, reject) {
      _this2._closedPromise_resolve = resolve;
      _this2._closedPromise_reject = reject;
    });

    if (stream._state === 'closed' || stream._state === 'errored') {
      ReleaseReadableStreamReader(this);
    }
  }

  _createClass(ReadableStreamReader, [{
    key: 'closed',
    get: function () {
      if (IsReadableStreamReader(this) === false) {
        return Promise.reject(new TypeError('ReadableStreamReader.prototype.closed can only be used on a ReadableStreamReader'));
      }

      return this._closedPromise;
    }
  }, {
    key: 'cancel',
    value: function cancel(reason) {
      if (IsReadableStreamReader(this) === false) {
        return Promise.reject(new TypeError('ReadableStreamReader.prototype.cancel can only be used on a ReadableStreamReader'));
      }

      if (this._state === 'closed') {
        return Promise.resolve(undefined);
      }

      if (this._state === 'errored') {
        return Promise.reject(this._storedError);
      }

      (0, _assert.assert)(this._ownerReadableStream !== undefined);
      (0, _assert.assert)(this._ownerReadableStream._state === 'readable');

      return CancelReadableStream(this._ownerReadableStream, reason);
    }
  }, {
    key: 'read',
    value: function read() {
      if (IsReadableStreamReader(this) === false) {
        return Promise.reject(new TypeError('ReadableStreamReader.prototype.read can only be used on a ReadableStreamReader'));
      }

      return ReadFromReadableStreamReader(this);
    }
  }, {
    key: 'releaseLock',
    value: function releaseLock() {
      if (IsReadableStreamReader(this) === false) {
        throw new TypeError('ReadableStreamReader.prototype.releaseLock can only be used on a ReadableStreamReader');
      }

      if (this._ownerReadableStream === undefined) {
        return undefined;
      }

      if (this._readRequests.length > 0) {
        throw new TypeError('Tried to release a reader lock when that reader has pending read() calls un-settled');
      }

      return ReleaseReadableStreamReader(this);
    }
  }]);

  return ReadableStreamReader;
})();

function AcquireReadableStreamReader(stream) {
  return new ReadableStreamReader(stream);
}

function CancelReadableStream(stream, reason) {
  if (stream._state === 'closed') {
    return Promise.resolve(undefined);
  }
  if (stream._state === 'errored') {
    return Promise.reject(stream._storedError);
  }

  stream._queue = [];
  FinishClosingReadableStream(stream);

  var sourceCancelPromise = (0, _helpers.PromiseInvokeOrNoop)(stream._underlyingSource, 'cancel', [reason]);
  return sourceCancelPromise.then(function () {
    return undefined;
  });
}

function CloseReadableStream(stream) {
  (0, _assert.assert)(stream._closeRequested === false);
  (0, _assert.assert)(stream._state !== 'errored');

  if (stream._state === 'closed') {
    // This will happen if the stream was closed without calling its controller's close() method, i.e. if it was closed
    // via cancellation.
    return undefined;
  }

  stream._closeRequested = true;

  if (stream._queue.length === 0) {
    return FinishClosingReadableStream(stream);
  }
}

function EnqueueInReadableStream(stream, chunk) {
  (0, _assert.assert)(stream._closeRequested === false);
  (0, _assert.assert)(stream._state !== 'errored');

  if (stream._state === 'closed') {
    // This will happen if the stream was closed without calling its controller's close() method, i.e. if it was closed
    // via cancellation.
    return undefined;
  }

  if (IsReadableStreamLocked(stream) === true && stream._reader._readRequests.length > 0) {
    var readRequest = stream._reader._readRequests.shift();
    readRequest._resolve((0, _helpers.CreateIterResultObject)(chunk, false));
  } else {
    var chunkSize = 1;

    if (stream._strategySize !== undefined) {
      try {
        chunkSize = stream._strategySize(chunk);
      } catch (chunkSizeE) {
        ErrorReadableStream(stream, chunkSizeE);
        throw chunkSizeE;
      }
    }

    try {
      (0, _queueWithSizes.EnqueueValueWithSize)(stream._queue, chunk, chunkSize);
    } catch (enqueueE) {
      ErrorReadableStream(stream, enqueueE);
      throw enqueueE;
    }
  }

  RequestReadableStreamPull(stream);

  return undefined;
}

function ErrorReadableStream(stream, e) {
  (0, _assert.assert)(stream._state === 'readable');

  stream._queue = [];
  stream._storedError = e;
  stream._state = 'errored';

  if (IsReadableStreamLocked(stream) === true) {
    return ReleaseReadableStreamReader(stream._reader);
  }
}

function FinishClosingReadableStream(stream) {
  (0, _assert.assert)(stream._state === 'readable');

  stream._state = 'closed';

  if (IsReadableStreamLocked(stream) === true) {
    return ReleaseReadableStreamReader(stream._reader);
  }

  return undefined;
}

function GetReadableStreamDesiredSize(stream) {
  var queueSize = (0, _queueWithSizes.GetTotalQueueSize)(stream._queue);
  return stream._strategyHWM - queueSize;
}

function IsReadableStream(x) {
  if (!(0, _helpers.typeIsObject)(x)) {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(x, '_underlyingSource')) {
    return false;
  }

  return true;
}

function IsReadableStreamLocked(stream) {
  (0, _assert.assert)(IsReadableStream(stream) === true, 'IsReadableStreamLocked should only be used on known readable streams');

  if (stream._reader === undefined) {
    return false;
  }

  return true;
}

function IsReadableStreamController(x) {
  if (!(0, _helpers.typeIsObject)(x)) {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(x, '_controlledReadableStream')) {
    return false;
  }

  return true;
}

function IsReadableStreamReader(x) {
  if (!(0, _helpers.typeIsObject)(x)) {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(x, '_ownerReadableStream')) {
    return false;
  }

  return true;
}

function ReadFromReadableStreamReader(reader) {
  if (reader._state === 'closed') {
    return Promise.resolve((0, _helpers.CreateIterResultObject)(undefined, true));
  }

  if (reader._state === 'errored') {
    return Promise.reject(reader._storedError);
  }

  (0, _assert.assert)(reader._ownerReadableStream !== undefined);
  (0, _assert.assert)(reader._ownerReadableStream._state === 'readable');

  if (reader._ownerReadableStream._queue.length > 0) {
    var chunk = (0, _queueWithSizes.DequeueValue)(reader._ownerReadableStream._queue);

    if (reader._ownerReadableStream._closeRequested === true && reader._ownerReadableStream._queue.length === 0) {
      FinishClosingReadableStream(reader._ownerReadableStream);
    } else {
      RequestReadableStreamPull(reader._ownerReadableStream);
    }

    return Promise.resolve((0, _helpers.CreateIterResultObject)(chunk, false));
  } else {
    var _ret = (function () {
      var readRequest = {};
      readRequest.promise = new Promise(function (resolve, reject) {
        readRequest._resolve = resolve;
        readRequest._reject = reject;
      });

      reader._readRequests.push(readRequest);
      RequestReadableStreamPull(reader._ownerReadableStream);
      return {
        v: readRequest.promise
      };
    })();

    if (typeof _ret === 'object') return _ret.v;
  }
}

function ReleaseReadableStreamReader(reader) {
  (0, _assert.assert)(reader._ownerReadableStream !== undefined);

  if (reader._ownerReadableStream._state === 'errored') {
    reader._state = 'errored';

    var e = reader._ownerReadableStream._storedError;
    reader._storedError = e;
    reader._closedPromise_reject(e);

    var _iteratorNormalCompletion = true;
    var _didIteratorError = false;
    var _iteratorError = undefined;

    try {
      for (var _iterator = reader._readRequests[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
        var _reject = _step.value._reject;

        _reject(e);
      }
    } catch (err) {
      _didIteratorError = true;
      _iteratorError = err;
    } finally {
      try {
        if (!_iteratorNormalCompletion && _iterator['return']) {
          _iterator['return']();
        }
      } finally {
        if (_didIteratorError) {
          throw _iteratorError;
        }
      }
    }
  } else {
    reader._state = 'closed';
    reader._closedPromise_resolve(undefined);

    var _iteratorNormalCompletion2 = true;
    var _didIteratorError2 = false;
    var _iteratorError2 = undefined;

    try {
      for (var _iterator2 = reader._readRequests[Symbol.iterator](), _step2; !(_iteratorNormalCompletion2 = (_step2 = _iterator2.next()).done); _iteratorNormalCompletion2 = true) {
        var _resolve = _step2.value._resolve;

        _resolve((0, _helpers.CreateIterResultObject)(undefined, true));
      }
    } catch (err) {
      _didIteratorError2 = true;
      _iteratorError2 = err;
    } finally {
      try {
        if (!_iteratorNormalCompletion2 && _iterator2['return']) {
          _iterator2['return']();
        }
      } finally {
        if (_didIteratorError2) {
          throw _iteratorError2;
        }
      }
    }
  }

  reader._readRequests = [];
  reader._ownerReadableStream._reader = undefined;
  reader._ownerReadableStream = undefined;
}

function RequestReadableStreamPull(stream) {
  var shouldPull = ShouldReadableStreamPull(stream);
  if (shouldPull === false) {
    return undefined;
  }

  if (stream._pulling === true) {
    stream._pullAgain = true;
    return undefined;
  }

  stream._pulling = true;
  var pullPromise = (0, _helpers.PromiseInvokeOrNoop)(stream._underlyingSource, 'pull', [stream._controller]);
  pullPromise.then(function () {
    stream._pulling = false;

    if (stream._pullAgain === true) {
      stream._pullAgain = false;
      return RequestReadableStreamPull(stream);
    }
  }, function (e) {
    if (stream._state === 'readable') {
      return ErrorReadableStream(stream, e);
    }
  })['catch'](_utils.rethrowAssertionErrorRejection);

  return undefined;
}

function ShouldReadableStreamPull(stream) {
  if (stream._state === 'closed' || stream._state === 'errored') {
    return false;
  }

  if (stream._closeRequested === true) {
    return false;
  }

  if (stream._started === false) {
    return false;
  }

  if (IsReadableStreamLocked(stream) === true && stream._reader._readRequests.length > 0) {
    return true;
  }

  var desiredSize = GetReadableStreamDesiredSize(stream);
  if (desiredSize > 0) {
    return true;
  }

  return false;
}

function TeeReadableStream(stream, shouldClone) {
  (0, _assert.assert)(IsReadableStream(stream) === true);
  (0, _assert.assert)(typeof shouldClone === 'boolean');

  var reader = AcquireReadableStreamReader(stream);

  var teeState = {
    closedOrErrored: false,
    canceled1: false,
    canceled2: false,
    reason1: undefined,
    reason2: undefined
  };
  teeState.promise = new Promise(function (resolve) {
    return teeState._resolve = resolve;
  });

  var pull = create_TeeReadableStreamPullFunction();
  pull._reader = reader;
  pull._teeState = teeState;
  pull._shouldClone = shouldClone;

  var cancel1 = create_TeeReadableStreamBranch1CancelFunction();
  cancel1._stream = stream;
  cancel1._teeState = teeState;

  var cancel2 = create_TeeReadableStreamBranch2CancelFunction();
  cancel2._stream = stream;
  cancel2._teeState = teeState;

  var underlyingSource1 = Object.create(Object.prototype);
  (0, _helpers.createDataProperty)(underlyingSource1, 'pull', pull);
  (0, _helpers.createDataProperty)(underlyingSource1, 'cancel', cancel1);
  var branch1 = new ReadableStream(underlyingSource1);

  var underlyingSource2 = Object.create(Object.prototype);
  (0, _helpers.createDataProperty)(underlyingSource2, 'pull', pull);
  (0, _helpers.createDataProperty)(underlyingSource2, 'cancel', cancel2);
  var branch2 = new ReadableStream(underlyingSource2);

  pull._branch1 = branch1;
  pull._branch2 = branch2;

  reader._closedPromise['catch'](function (r) {
    if (teeState.closedOrErrored === true) {
      return undefined;
    }

    ErrorReadableStream(branch1, r);
    ErrorReadableStream(branch2, r);
    teeState.closedOrErrored = true;
  });

  return [branch1, branch2];
}

function create_TeeReadableStreamPullFunction() {
  var f = function f() {
    var reader = f._reader;
    var branch1 = f._branch1;
    var branch2 = f._branch2;
    var teeState = f._teeState;
    var shouldClone = f._shouldClone;

    return ReadFromReadableStreamReader(reader).then(function (result) {
      (0, _assert.assert)((0, _helpers.typeIsObject)(result));
      var value = result.value;
      var done = result.done;
      (0, _assert.assert)(typeof done === 'boolean');

      if (done === true && teeState.closedOrErrored === false) {
        CloseReadableStream(branch1);
        CloseReadableStream(branch2);
        teeState.closedOrErrored = true;
      }

      if (teeState.closedOrErrored === true) {
        return undefined;
      }

      // There is no way to access the cloning code right now in the reference implementation.
      // If we add one then we'll need an implementation for StructuredClone.

      if (teeState.canceled1 === false) {
        var value1 = value;
        //        if (shouldClone === true) {
        //          value1 = StructuredClone(value);
        //        }
        EnqueueInReadableStream(branch1, value1);
      }

      if (teeState.canceled2 === false) {
        var value2 = value;
        //        if (shouldClone === true) {
        //          value2 = StructuredClone(value);
        //        }
        EnqueueInReadableStream(branch2, value2);
      }
    });
  };
  return f;
}

function create_TeeReadableStreamBranch1CancelFunction() {
  var f = function f(reason) {
    var stream = f._stream;
    var teeState = f._teeState;

    teeState.canceled1 = true;
    teeState.reason1 = reason;
    if (teeState.canceled2 === true) {
      var compositeReason = (0, _helpers.createArrayFromList)([teeState.reason1, teeState.reason2]);
      var cancelResult = CancelReadableStream(stream, compositeReason);
      teeState._resolve(cancelResult);
    }
    return teeState.promise;
  };
  return f;
}

function create_TeeReadableStreamBranch2CancelFunction() {
  var f = function f(reason) {
    var stream = f._stream;
    var teeState = f._teeState;

    teeState.canceled2 = true;
    teeState.reason2 = reason;
    if (teeState.canceled1 === true) {
      var compositeReason = (0, _helpers.createArrayFromList)([teeState.reason1, teeState.reason2]);
      var cancelResult = CancelReadableStream(stream, compositeReason);
      teeState._resolve(cancelResult);
    }
    return teeState.promise;
  };
  return f;
}
module.exports = exports['default'];

},{"./assert":1,"./helpers":4,"./queue-with-sizes":6,"./utils":9}],8:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

var _readableStream = require('./readable-stream');

var _readableStream2 = _interopRequireDefault(_readableStream);

var _writableStream = require('./writable-stream');

var _writableStream2 = _interopRequireDefault(_writableStream);

var TransformStream = function TransformStream(transformer) {
  _classCallCheck(this, TransformStream);

  if (transformer.flush === undefined) {
    transformer.flush = function (enqueue, close) {
      return close();
    };
  }

  if (typeof transformer.transform !== 'function') {
    throw new TypeError('transform must be a function');
  }

  var writeChunk = undefined,
      writeDone = undefined,
      errorWritable = undefined;
  var transforming = false;
  var chunkWrittenButNotYetTransformed = false;
  this.writable = new _writableStream2['default']({
    start: function start(error) {
      errorWritable = error;
    },
    write: function write(chunk) {
      writeChunk = chunk;
      chunkWrittenButNotYetTransformed = true;

      var p = new Promise(function (resolve) {
        return writeDone = resolve;
      });
      maybeDoTransform();
      return p;
    },
    abort(e) {
      errorReadable(e);
    },
    close: function close() {
      try {
        transformer.flush(enqueueInReadable, closeReadable);
      } catch (e) {
        errorWritable(e);
        errorReadable(e);
      }
    }
  }, transformer.writableStrategy);

  var enqueueInReadable = undefined,
      closeReadable = undefined,
      errorReadable = undefined;
  this.readable = new _readableStream2['default']({
    start: function start(c) {
      enqueueInReadable = c.enqueue.bind(c);
      closeReadable = c.close.bind(c);
      errorReadable = c.error.bind(c);
    },
    pull: function pull() {
      if (chunkWrittenButNotYetTransformed === true) {
        maybeDoTransform();
      }
    }
  }, transformer.readableStrategy);

  function maybeDoTransform() {
    if (transforming === false) {
      transforming = true;
      try {
        transformer.transform(writeChunk, enqueueInReadable, transformDone);
        writeChunk = undefined;
        chunkWrittenButNotYetTransformed = false;
      } catch (e) {
        transforming = false;
        errorWritable(e);
        errorReadable(e);
      }
    }
  }

  function transformDone() {
    transforming = false;
    writeDone();
  }
};

exports['default'] = TransformStream;
module.exports = exports['default'];

},{"./readable-stream":7,"./writable-stream":10}],9:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});
exports.rethrowAssertionErrorRejection = rethrowAssertionErrorRejection;

var _assert = require('./assert');

function rethrowAssertionErrorRejection(e) {
  // Used throughout the reference implementation, as `.catch(rethrowAssertionErrorRejection)`, to ensure any errors
  // get shown. There are places in the spec where we do promise transformations and purposefully ignore or don't
  // expect any errors, but assertion errors are always problematic.
  if (e && e.constructor === _assert.assert.AssertionError) {
    setTimeout(function () {
      throw e;
    }, 0);
  }
}

},{"./assert":1}],10:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

var _createClass = (function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ('value' in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

exports.IsWritableStream = IsWritableStream;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

var _assert = require('./assert');

var _helpers = require('./helpers');

var _utils = require('./utils');

var _queueWithSizes = require('./queue-with-sizes');

var _countQueuingStrategy = require('./count-queuing-strategy');

var _countQueuingStrategy2 = _interopRequireDefault(_countQueuingStrategy);

var WritableStream = (function () {
  function WritableStream() {
    var _this = this;

    var underlyingSink = arguments[0] === undefined ? {} : arguments[0];

    var _ref = arguments[1] === undefined ? {} : arguments[1];

    var size = _ref.size;
    var _ref$highWaterMark = _ref.highWaterMark;
    var highWaterMark = _ref$highWaterMark === undefined ? 0 : _ref$highWaterMark;

    _classCallCheck(this, WritableStream);

    this._underlyingSink = underlyingSink;

    this._closedPromise = new Promise(function (resolve, reject) {
      _this._closedPromise_resolve = resolve;
      _this._closedPromise_reject = reject;
    });

    this._readyPromise = Promise.resolve(undefined);
    this._readyPromise_resolve = null;

    this._queue = [];
    this._state = 'writable';
    this._started = false;
    this._writing = false;

    var normalizedStrategy = (0, _helpers.ValidateAndNormalizeQueuingStrategy)(size, highWaterMark);
    this._strategySize = normalizedStrategy.size;
    this._strategyHWM = normalizedStrategy.highWaterMark;

    SyncWritableStreamStateWithQueue(this);

    var error = closure_WritableStreamErrorFunction();
    error._stream = this;

    var startResult = (0, _helpers.InvokeOrNoop)(underlyingSink, 'start', [error]);
    this._startedPromise = Promise.resolve(startResult);
    this._startedPromise.then(function () {
      _this._started = true;
      _this._startedPromise = undefined;
    });
    this._startedPromise['catch'](function (r) {
      return ErrorWritableStream(_this, r);
    })['catch'](_utils.rethrowAssertionErrorRejection);
  }

  _createClass(WritableStream, [{
    key: 'closed',
    get: function () {
      if (!IsWritableStream(this)) {
        return Promise.reject(new TypeError('WritableStream.prototype.closed can only be used on a WritableStream'));
      }

      return this._closedPromise;
    }
  }, {
    key: 'state',
    get: function () {
      if (!IsWritableStream(this)) {
        throw new TypeError('WritableStream.prototype.state can only be used on a WritableStream');
      }

      return this._state;
    }
  }, {
    key: 'abort',
    value: function abort(reason) {
      if (!IsWritableStream(this)) {
        return Promise.reject(new TypeError('WritableStream.prototype.abort can only be used on a WritableStream'));
      }

      if (this._state === 'closed') {
        return Promise.resolve(undefined);
      }
      if (this._state === 'errored') {
        return Promise.reject(this._storedError);
      }

      ErrorWritableStream(this, reason);
      var sinkAbortPromise = (0, _helpers.PromiseInvokeOrFallbackOrNoop)(this._underlyingSink, 'abort', [reason], 'close', []);
      return sinkAbortPromise.then(function () {
        return undefined;
      });
    }
  }, {
    key: 'close',
    value: function close() {
      if (!IsWritableStream(this)) {
        return Promise.reject(new TypeError('WritableStream.prototype.close can only be used on a WritableStream'));
      }

      if (this._state === 'closing') {
        return Promise.reject(new TypeError('cannot close an already-closing stream'));
      }
      if (this._state === 'closed') {
        return Promise.reject(new TypeError('cannot close an already-closed stream'));
      }
      if (this._state === 'errored') {
        return Promise.reject(this._storedError);
      }
      if (this._state === 'waiting') {
        this._readyPromise_resolve(undefined);
      }

      this._state = 'closing';
      (0, _queueWithSizes.EnqueueValueWithSize)(this._queue, 'close', 0);
      CallOrScheduleWritableStreamAdvanceQueue(this);

      return this._closedPromise;
    }
  }, {
    key: 'ready',
    get: function () {
      if (!IsWritableStream(this)) {
        return Promise.reject(new TypeError('WritableStream.prototype.ready can only be used on a WritableStream'));
      }

      return this._readyPromise;
    }
  }, {
    key: 'write',
    value: function write(chunk) {
      if (!IsWritableStream(this)) {
        return Promise.reject(new TypeError('WritableStream.prototype.write can only be used on a WritableStream'));
      }

      if (this._state === 'closing') {
        return Promise.reject(new TypeError('cannot write while stream is closing'));
      }
      if (this._state === 'closed') {
        return Promise.reject(new TypeError('cannot write after stream is closed' + new Error().stack));
      }
      if (this._state === 'errored') {
        return Promise.reject(this._storedError);
      }

      (0, _assert.assert)(this._state === 'waiting' || this._state === 'writable');

      var chunkSize = 1;

      if (this._strategySize !== undefined) {
        try {
          chunkSize = this._strategySize(chunk);
        } catch (chunkSizeE) {
          ErrorWritableStream(this, chunkSizeE);
          return Promise.reject(chunkSizeE);
        }
      }

      var resolver = undefined,
          rejecter = undefined;
      var promise = new Promise(function (resolve, reject) {
        resolver = resolve;
        rejecter = reject;
      });

      var writeRecord = { promise: promise, chunk: chunk, _resolve: resolver, _reject: rejecter };
      try {
        (0, _queueWithSizes.EnqueueValueWithSize)(this._queue, writeRecord, chunkSize);
      } catch (enqueueResultE) {
        ErrorWritableStream(this, enqueueResultE);
        return Promise.reject(enqueueResultE);
      }

      try {
        SyncWritableStreamStateWithQueue(this);
      } catch (syncResultE) {
        ErrorWritableStream(this, syncResultE);
        return promise;
      }

      CallOrScheduleWritableStreamAdvanceQueue(this);
      return promise;
    }
  }]);

  return WritableStream;
})();

exports['default'] = WritableStream;

function closure_WritableStreamErrorFunction() {
  var f = function f(e) {
    return ErrorWritableStream(f._stream, e);
  };
  return f;
}

function CallOrScheduleWritableStreamAdvanceQueue(stream) {
  if (stream._started === false) {
    stream._startedPromise.then(function () {
      WritableStreamAdvanceQueue(stream);
    })['catch'](_utils.rethrowAssertionErrorRejection);
    return undefined;
  }

  if (stream._started === true) {
    return WritableStreamAdvanceQueue(stream);
  }
}

function CloseWritableStream(stream) {
  (0, _assert.assert)(stream._state === 'closing', 'stream must be in closing state while calling CloseWritableStream');

  var sinkClosePromise = (0, _helpers.PromiseInvokeOrNoop)(stream._underlyingSink, 'close');
  sinkClosePromise.then(function () {
    if (stream._state === 'errored') {
      return;
    }

    (0, _assert.assert)(stream._state === 'closing');

    stream._closedPromise_resolve(undefined);
    stream._state = 'closed';
  }, function (r) {
    return ErrorWritableStream(stream, r);
  })['catch'](_utils.rethrowAssertionErrorRejection);
}

function ErrorWritableStream(stream, e) {
  if (stream._state === 'closed' || stream._state === 'errored') {
    return undefined;
  }

  while (stream._queue.length > 0) {
    var writeRecord = (0, _queueWithSizes.DequeueValue)(stream._queue);
    if (writeRecord !== 'close') {
      writeRecord._reject(e);
    }
  }

  stream._storedError = e;

  if (stream._state === 'waiting') {
    stream._readyPromise_resolve(undefined);
  }
  stream._closedPromise_reject(e);
  stream._state = 'errored';
}

function IsWritableStream(x) {
  if (!(0, _helpers.typeIsObject)(x)) {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(x, '_underlyingSink')) {
    return false;
  }

  return true;
}

function SyncWritableStreamStateWithQueue(stream) {
  if (stream._state === 'closing') {
    return undefined;
  }

  (0, _assert.assert)(stream._state === 'writable' || stream._state === 'waiting', 'stream must be in a writable or waiting state while calling SyncWritableStreamStateWithQueue');

  var queueSize = (0, _queueWithSizes.GetTotalQueueSize)(stream._queue);
  var shouldApplyBackpressure = queueSize > stream._strategyHWM;

  if (shouldApplyBackpressure === true && stream._state === 'writable') {
    stream._state = 'waiting';
    stream._readyPromise = new Promise(function (resolve, reject) {
      stream._readyPromise_resolve = resolve;
    });
  }

  if (shouldApplyBackpressure === false && stream._state === 'waiting') {
    stream._state = 'writable';
    stream._readyPromise_resolve(undefined);
  }

  return undefined;
}

function WritableStreamAdvanceQueue(stream) {
  if (stream._queue.length === 0 || stream._writing === true) {
    return undefined;
  }

  var writeRecord = (0, _queueWithSizes.PeekQueueValue)(stream._queue);

  if (writeRecord === 'close') {
    (0, _assert.assert)(stream._state === 'closing', 'can\'t process final write record unless already closing');
    (0, _queueWithSizes.DequeueValue)(stream._queue);
    (0, _assert.assert)(stream._queue.length === 0, 'queue must be empty once the final write record is dequeued');
    return CloseWritableStream(stream);
  } else {
    stream._writing = true;

    (0, _helpers.PromiseInvokeOrNoop)(stream._underlyingSink, 'write', [writeRecord.chunk]).then(function () {
      if (stream._state === 'errored') {
        return;
      }

      stream._writing = false;

      writeRecord._resolve(undefined);

      (0, _queueWithSizes.DequeueValue)(stream._queue);
      try {
        SyncWritableStreamStateWithQueue(stream);
      } catch (syncResultE) {
        return ErrorWritableStream(stream, syncResultE);
      }
      return WritableStreamAdvanceQueue(stream);
    }, function (r) {
      return ErrorWritableStream(stream, r);
    })['catch'](_utils.rethrowAssertionErrorRejection);
  }
}

},{"./assert":1,"./count-queuing-strategy":3,"./helpers":4,"./queue-with-sizes":6,"./utils":9}]},{},[5])(5)
});

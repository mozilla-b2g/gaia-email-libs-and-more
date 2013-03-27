define(
  [
    'exports'
  ],
  function(
   exports
  ) {

function fetchOptions(partInfo, partial) {
  var body;

  if (!partial) {
    body = partInfo.partID;
  } else {
    // for some reason the imap lib uses strings to delimit the starting and
    // ending byte range....
    body = [
      partInfo.partID,
      String(partial[0]) + '-' + String(partial[1])
    ];
  }

  return {
    request: {
      struct: false,
      headers: false,
      body: body
    }
  };
}

/**
 * Convenience class and wrapper around building multiple fetching operations or
 * the aggregation of many fetching operations into a single unit of
 * operation...
 *
 *
 *    var fetcher = new $bodyfetcher.BodyFetcher(
 *      connection,
 *      BodyParser (or any other kind of parser),
 *      [
 *        { uid: X, partInfo: {}, bytes: [A, B] }
 *      ]
 *    );
 *
 *    // in all examples item is a single element in the
 *    // array (third argument).
 *
 *    fetcher.onerror = function(err, item) {};
 *    fetcher.ondata = function(parsed, item) {}
 *    fetcher.onend = function() {}
 *
 */
function BodyFetcher(connection, parserClass, list) {
  this.connection = connection;
  this.parserClass = parserClass;
  this.list = list;

  this.pending = list.length;

  this.onerror = null;
  this.ondata = null;
  this.onend = null;

  list.forEach(this._fetch, this);
}

BodyFetcher.prototype = {
  _fetch: function(request) {
    // build the fetcher based on the request.uid
    var fetch = this.connection.fetch(
      request.uid,
      fetchOptions(request.partInfo, request.bytes)
    );

    var parser = new this.parserClass(request.partInfo);
    var self = this;

    fetch.on('error', function(err) {
      // if fetch provides an error we expect this request to be completed so we
      // resolve here...
      self._resolve(err, request);
    });

    fetch.on('message', function(msg) {
      msg.on('error', function(err) {
        // similar to the fetch error we expect this only to be called once and
        // exclusive of the error event on the fetch itself...
        self._resolve(err, request);
      });

      msg.on('data', function(content) {
        parser.parse(content);
      });

      msg.on('end', function() {
        self._resolve(null, request, parser.complete(msg));
      });
    });
  },

  _resolve: function() {
    var args = Array.slice(arguments);
    var err = args[0];

    if (err) {
      if (this.onerror) {
        this.onerror.apply(this, args);
      }
    } else {
      if (this.onparsed) {
        // get rid of the error object
        args.shift();

        this.onparsed.apply(this, args);
      }
    }

    if (!--this.pending && this.onend) {
      this.onend();
    }
  }
};


exports.BodyFetcher = BodyFetcher;

});

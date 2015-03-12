define(function(require) {

  var logic = require('logic');
  var scope = logic.scope('Contexts');

  var MailUniverse = require('mailuniverse').MailUniverse;
  var MailBridge = require('mailbridge').MailBridge;
  var MailAPI = require('mailapi').MailAPI;
  var $router = require('worker-router');

  var resolveApiPromise;
  var apiPromise = new Promise((resolve) => {
    resolveApiPromise = resolve;
  });

  function initFrontend(opts) {
    return apiPromise.then(function(api) {
      return {
        api: api
      };
    });
  }

  function initBackend(opts) {
    return new Promise((resolve, reject) => {
      var universe = new MailUniverse(
        function onUniverse() {
          console.log('Universe created');
          var bridge = new MailBridge(universe, 'bridge');
          var api = new MailAPI(); // Don't save this here!

          var realSendMessage = $router.registerSimple(
            'bridge', (data) => { bridge.__receiveMessage(data.args); });

          var bouncedSendMessage = $router.registerSimple(
            'bounced-bridge', (data) => { api.__bridgeReceive(data.args); });

          var origProcessMessage = api._processMessage.bind(api);
          api._processMessage = function(msg) {
            origProcessMessage(msg);
          };

          api.__bridgeSend = function(msg) {
            // 'bridge' => main => 'bounced-bridge'
            bouncedSendMessage(null, msg);
          };
          bridge.__sendMessage = function(msg) {
            self._bridgeLog.bridgeSend(msg.type, msg);
            // 'bounced-bridge' => main => 'bridge'
            realSendMessage(null, msg);
          };

          // Pass the MailAPI to the frontend.
          resolveApiPromise(api);

          resolve({
            universe: universe,
            bridge: bridge
          });
        },
        true, // Assume online; MailUniverse assumes 'true' anyway.
        opts);
    });
  }

  function initServer(opts) {
    if ('controlServerBaseUrl' in opts) {
      self.testServer = self.T.actor(
        'TestFake' + TYPE + 'Server', self.__name,
        {
          testAccount: self,
          restored: opts.restored,
          imapExtensions: opts.imapExtensions,
          folderConfig: opts.folderConfig,
          smtpExtensions: opts.smtpExtensions,
          deliveryMode: opts.deliveryMode,
          oauth: opts.oauth,
          useTimezoneMins: opts.useTimezoneMins
        },
        null, self);
    }
    else {
      self.testServer = self.T.actor(
        'TestReal' + TYPE + 'Server', self.__name,
        {
          testAccount: self,
          restored: opts.restored
        },
        null, self);
    }
  }

  /**
   * Isolate a function from its enclosing scope via stringification.
   */
  function isolateFunction(fn) {
    fn = fn.toString().trim();

    var isArrowFunction = (fn.indexOf('function') !== 0);
    var args, body;
    if (isArrowFunction) {
      var arrowIndex = fn.indexOf('=>');
      args = fn.slice(0, arrowIndex);
      body = fn.slice(arrowIndex + 2);
    } else {
      var curlyBraceIndex = fn.indexOf('{');
      args = fn.slice(8 /* "function" */, curlyBraceIndex);
      body = fn.slice(curlyBraceIndex);
    }
    // Get rid of parenthesis and whitespace in `args`.
    args = args.replace(/[\(\)\s]/g, '');

    return new Function(args, body);
  }

  var frontendContext = null;
  var backendContext = null;

  function asyncExecuteInContext(fn, context, extraArgs) {
    return Promise.resolve().then(() => {
      // If `fn` returns a promise, we'll continue waiting until that
      // promise is resolved before returning.
      return isolateFunction(fn).apply(null, [context].concat(extraArgs));
    }).then((rawValue) => {
      // They'd better pass something JSONable!
      return JSON.parse(JSON.stringify(rawValue === undefined ?
                                       null : rawValue));
    });
  }

  return {
    init: function(opts) {
      // Since we're bootstrapping from the old tests, the contexts
      // are already set up.
      return Promise.all([
        initFrontend(opts).then((ctx) => {
          console.log('SET frontend');
          frontendContext = ctx;
        }),
        initBackend(opts).then((ctx) => {
          console.log('SET backend');
          backendContext = ctx;
        })
      ]);
    },

    /**
     * Evaluate `fn` in the frontend context.
     */
    frontend: function(fn /* ... args */) {
      var args = Array.prototype.slice.call(arguments, 1);
      return asyncExecuteInContext(fn, frontendContext, args);
    },

    backend: function(fn) {
      var args = Array.prototype.slice.call(arguments, 1);
      return asyncExecuteInContext(fn, backendContext, args);
    }
  };
});

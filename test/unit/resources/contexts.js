define(function(require) {

  var logic = require('logic');
  var scope = logic.scope('Contexts');

  var MailUniverse = require('mailuniverse').MailUniverse;
  var MailBridge = require('mailbridge').MailBridge;
  var MailAPI = require('mailapi').MailAPI;
  var $router = require('worker-router');
  var servers = require('./servers');
  var msggen = require('./messageGenerator');

  var $sync = require('syncbase');


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
            // 'bounced-bridge' => main => 'bridge'
            realSendMessage(null, msg);
          };

          // Instantiate the fake server.

          var server = servers.bootNamedServer('server', {
            type: (/imap/.test(opts.variant) ? 'imap' :
                   /pop3/.test(opts.variant) ? 'pop3' :
                   /activesync/.test(opts.variant) ? 'activesync' :
                   null),
            account: null, // set up later
            controlServerBaseUrl: opts.controlServerBaseUrl,
            imapExtensions: opts.imapExtensions || opts.imapExtensions,
            smtpExtensions: opts.smtpExtensions,
            deliveryMode: opts.deliveryMode,
            oauth: opts.oauth,
            date: null, // ???
            emailAddress: opts.emailAddress,
            password: opts.password
          });




          $sync.TEST_adjustSyncValues({
            fillSize: 15,
            days: 7,
            growDays: 7,
            scaleFactor: 1.6,

            // arbitrarily large value for tests
            STALE_CONNECTION_TIMEOUT_MS: 60000,

            // Don't kill jobless connections, as most of the tests don't expect
            // the connections to die, and we test this independently within
            // test_imap_kill_unused_connections.js.
            KILL_CONNECTIONS_WHEN_JOBLESS: false,

            // Don't trigger the whole-folder sync logic except when
            // we explicitly want to test it.
            SYNC_WHOLE_FOLDER_AT_N_MESSAGES: 0,

            // We don't want to test this at scale as part of our unit
            // tests, so crank it way up so we don't ever accidentally
            // run into this.
            bisectThresh: 2000,
            tooMany: 2000,

            // For consistency with our original tests where we would
            // always generate network traffic when opening a slice,
            // set the threshold so that it is always exceeded. Tests
            // that care currently explicitly set this. Note that our
            // choice of -1 assumes that Date.now() is strictly
            // increasing; this is usually pretty safe but ntpdate can
            // do angry things, for one.
            openRefreshThresh: -1,
            // Same deal.
            growRefreshThresh: -1,
          });








          resolve({
            __api: api,
            universe: universe,
            server: server,
            bridge: bridge,
            msggen: new msggen.MessageGenerator()
          });
        },
        true, // Assume online; MailUniverse assumes 'true' anyway.
        opts);
    });
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
    args = args.replace(/[\*\(\)\s]/g, '');

    return new Function(args, body);
  }

  var backendContext = null;
  var serverContext = null;

  function asyncExecuteInContext(context, args) {
    var groupName = (typeof args[0] === 'string' || !args[0] ?
                     args.shift() : null);
    var extraArgs = (Array.isArray(args[0]) ? args.shift() : []);

    if (groupName) {
      logic(context, 'group', { msg: groupName }); // XXX
    }

    var fn = args.shift();
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

  var contexts = {
    init: function(opts) {
      return initBackend(opts).then((ctx) => {
        backendContext = ctx;
        logic.defineScope(backendContext, 'Backend');
        return ctx.__api;
      });
    },

    backend: function(fn) {
      var args = Array.prototype.slice.call(arguments);
      return asyncExecuteInContext(backendContext, args);
    },

    chainBackend: function(desc, fn) {
      if (!fn) {
        fn = desc;
        desc = null;
      }
      return function(result) {
        return contexts.backend(desc, [result], fn);
      };
    }
  };

  return contexts;
});

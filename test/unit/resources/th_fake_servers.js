/**
 * Fake IMAP server spin-up and control.  Created on-demand by sending HTTP
 * requests to the control server via HTTP.
 **/

define((require, exports) => {

  var servers = require('./servers');

  function constructFakeServer(type, self, opts) {
    self.T.convenienceSetup(type, 'fake server bootup', function() {
      var TEST_PARAMS = self.RT.envOptions;

      var normName = self.__name.replace(/\d+/g, '');
      var server = servers.bootNamedServer(normName, {
        type: type,
        account: null, // set up later
        controlServerBaseUrl: TEST_PARAMS.controlServerBaseUrl,
        imapExtensions: opts.imapExtensions || TEST_PARAMS.imapExtensions,
        smtpExtensions: opts.smtpExtensions,
        deliveryMode: opts.deliveryMode,
        oauth: opts.oauth,
        date: opts.testAccount.testUniverse._useDate,
        emailAddress: opts.testAccount.emailAddress,
        password: opts.testAccount.initialPassword
      });

      // Mixin a mixin, for the legacy test fixin'
      for (var name in server) {
        if (typeof server[name] === 'function') {
          self[name] = server[name].bind(server);
        } else {
          self[name] = server[name];
        }
      }
    });
  }

  exports.TESTHELPER = {
    actorMixins: {
      TestFakeIMAPServer: {
        __constructor: function(self, opts) {
          constructFakeServer('imap', self, opts);
        }
      },
      TestFakePOP3Server: {
        __constructor: function(self, opts) {
          constructFakeServer('pop3', self, opts);
        }
      },
      TestActiveSyncServer: {
        __constructor: function(self, opts) {
          constructFakeServer('activesync', self, opts);
        }
      }
    }
  };

}); // end define

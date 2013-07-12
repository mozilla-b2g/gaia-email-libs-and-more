/**
 * Fake IMAP server spin-up and control.  Created on-demand by sending HTTP
 * requests to the control server via HTTP.
 **/

define(
  [
    'rdcommon/log',
    './messageGenerator',
    'mailapi/accountcommon',
    'module',
    'exports'
  ],
  function(
    $log,
    $msggen,
    $accountcommon,
    $module,
    exports
  ) {

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
              'Oct', 'Nov', 'Dec'];

// from (node-imap) imap.js
function formatImapDateTime(date) {
  var s;
  s = ((date.getDate() < 10) ? ' ' : '') + date.getDate() + '-' +
       MONTHS[date.getMonth()] + '-' +
       date.getFullYear() + ' ' +
       ('0'+date.getHours()).slice(-2) + ':' +
       ('0'+date.getMinutes()).slice(-2) + ':' +
       ('0'+date.getSeconds()).slice(-2) +
       ((date.getTimezoneOffset() > 0) ? ' -' : ' +' ) +
       ('0'+(Math.abs(date.getTimezoneOffset()) / 60)).slice(-2) +
       ('0'+(Math.abs(date.getTimezoneOffset()) % 60)).slice(-2);
  return s;
}

function extractUsernameFromEmail(str) {
  var idx = str.indexOf('@');
  if (idx === -1)
    return str;
  return str.substring(0, idx);
}

var TestFakeIMAPServerMixins = {
  __constructor: function(self, opts) {
    if (!("fakeIMAPServers" in self.RT.fileBlackboard))
      self.RT.fileBlackboard.fakeIMAPServers = {};

    var normName = self.__name.replace(/\d+/g, '');
    var serverExists = normName in self.RT.fileBlackboard.fakeIMAPServers;
    var setupVerb = serverExists ? 'reusing' : 'creating';
    // Flag the value to true so that static checks of whether it exists return
    // true.  Use of the value for data purposes must only be done at step-time
    // since 'true' is not very useful on its own.
    if (!serverExists)
      self.RT.fileBlackboard.fakeIMAPServers[normName] = true;

    self.T.convenienceSetup(setupVerb, self,
                            function() {
      self.__attachToLogger(LOGFAB.testFakeIMAPServer(self, null, self.__name));

      var TEST_PARAMS = self.RT.envOptions, serverInfo;

      if (!serverExists) {
        // talk to the control server to get it to create our server
        self.backdoorUrl = TEST_PARAMS.controlServerBaseUrl + '/control';
        serverInfo = self._backdoor(
          {
            command: 'make_imap_and_smtp',
            credentials: {
              username: extractUsernameFromEmail(TEST_PARAMS.emailAddress),
              password: TEST_PARAMS.password
            },
          });

        // now we only want to talk to our specific server control endpoint
        self.backdoorUrl = serverInfo.controlUrl;
        self.RT.fileBlackboard.fakeIMAPServers[normName] = serverInfo;
      }
      else {
        serverInfo = self.RT.fileBlackboard.fakeIMAPServers[normName];
        self.backdoorUrl = serverInfo.controlUrl;
      }

      var configEntry = $accountcommon._autoconfigByDomain['fakeimaphost'];
      configEntry.incoming.hostname = serverInfo.imapHost;
      configEntry.incoming.port = serverInfo.imapPort;
      configEntry.outgoing.hostname = serverInfo.smtpHost;
      configEntry.outgoing.port = serverInfo.smtpPort;
    });
  },

  finishSetup: function(testAccount) {
  },

  _backdoor: function(request, explicitPath) {
    var xhr = new XMLHttpRequest({mozSystem: true, mozAnon: true});
    xhr.open('POST', this.backdoorUrl, false);
    xhr.send(JSON.stringify(request));
    var response = xhr.response ? JSON.parse(xhr.response) : null;
    this._logger.backdoor(request, response, this.backdoorUrl);
    return response;
  },

  // => folderPath or falsey
  getFirstFolderWithType: function(folderType) {
    return this._backdoor({
      command: 'getFirstFolderWithType',
      type: folderType
    });
  },

  // => folderPath or falsey
  getFolderByPath: function(folderPath) {
    return this._backdoor({
      command: 'getFolderByPath',
      name: folderPath
    });
  },

  SYNC_FOLDER_LIST_AFTER_ADD: true,
  addFolder: function(folderPath, testFolder) {
    // returns the canonical folder path (probably)
    return this._backdoor({
      command: 'addFolder',
      name: folderPath,
    });
  },

  removeFolder: function(folderPath) {
    return this._backdoor({
      command: 'removeFolder',
      name: folderPath
    });
  },

  addMessagesToFolder: function(folderPath, messages) {
    var transformedMessages = messages.map(function(message) {
      // Generate an rfc822 message, prefixing on a fake 'received' line so that
      // our INTERNALDATE detecting logic can be happy.
      //
      // XXX this currently requires the timezone to be the computer's local tz
      // since we can't force a timezone offset into a Date object; it's locale
      // dependent.
      var msgString =
        'Received: from 127.1.2.3 by 127.1.2.3; ' +
        formatImapDateTime(message.date) + '\r\n' +
        message.toMessageString();

      var rep = {
        flags: [],
        date: message.date.valueOf(),
        msgString: msgString
      };

      if (message.metaState.deleted)
        rep.flags.push('\\Deleted');
      if (message.metaState.read)
        rep.flags.push('\\Seen');

      return rep;
    });

    return this._backdoor({
      command: 'addMessagesToFolder',
      name: folderPath,
      messages: transformedMessages
    });
  },
};



var LOGFAB = exports.LOGFAB = $log.register($module, {
  testFakeIMAPServer: {
    type: $log.SERVER,
    topBilling: true,

    events: {
      started: { port: false },
      stopped: {},

      backdoor: { request: false, response: false, url: false },
    },
    errors: {
    },
    TEST_ONLY_events: {
    },
  },
});

exports.TESTHELPER = {
  LOGFAB_DEPS: [
    LOGFAB,
  ],
  actorMixins: {
    testFakeIMAPServer: TestFakeIMAPServerMixins,
  }
};

}); // end define

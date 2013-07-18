/**
 * Testing support for using a real IMAP server.  We manipulate the server using
 * our built-in infrastructure.
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

var TestRealIMAPServerMixins = {
  NEEDS_REL_TZ_OFFSET_ADJUSTMENT: true,

  __constructor: function(self, opts) {
    self.testAccount = null;
    self.testUniverse = null;
    self.universe = null;
    self.eAccount = null;
    self.account = null;

    self.T.convenienceSetup(self, 'sets up', function() {
      self.__attachToLogger(LOGFAB.testRealIMAPServer(self, null, self.__name));
    });

  },

  /**
   * Grab any variables off of the testAccount we need.
   */
  finishSetup: function(testAccount) {
    this.testAccount = testAccount;
    this.testUniverse = testAccount.testUniverse;
    this.universe = testAccount.universe;
    this.eAccount = testAccount.eImapAccount;
    this.account = testAccount.imapAccount;
  },

  // => FolderMeta
  getFirstFolderWithType: function(folderType) {
    return this.account.getFirstFolderWithType(folderType);
  },

  // => FolderMeta
  getFolderByPath: function(folderPath) {
    return this.account.getFolderByPath(folderPath);
  },

  SYNC_FOLDER_LIST_AFTER_ADD: false,
  addFolder: function(name, testFolder) {
    this.RT.reportActiveActorThisStep(this.testAccount);
    this.RT.reportActiveActorThisStep(testFolder.connActor);
    this.RT.reportActiveActorThisStep(testFolder.storageActor);
    this.eAccount.expect_runOp_begin('local_do', 'createFolder');
    this.eAccount.expect_runOp_end('local_do', 'createFolder');
    this.eAccount.expect_runOp_begin('do', 'createFolder');
    this.testAccount.help_expect_connection();
    this.eAccount.expect_releaseConnection();
    this.eAccount.expect_runOp_end('do', 'createFolder');
    this.expect_creationNotified(1);

    var self = this, allFoldersSlice = this.testUniverse.allFoldersSlice;
    allFoldersSlice.onsplice = function(index, howMany, added,
                                        requested, expected) {
      allFoldersSlice.onsplice = null;
      self._logger.creationNotified(added.length);
      testFolder.mailFolder = added[0];
    };
    this.universe.createFolder(this.testAccount.accountId, null, name, false,
      function createdFolder(err, folderMeta) {
      if (err) {
        self._logger.folderCreationError(err);
        return;
      }
      testFolder.id = folderMeta.id;
    });
  },

  removeFolder: function(folderMeta) {
    this.RT.reportActiveActorThisStep(this.eAccount);
    this.testAccount.help_expect_connection();
    this.eAccount.expect_releaseConnection();
    this.eAccount.expect_deleteFolder();
    this.testAccount.expect_deletionNotified(1);

    var self = this, allFoldersSlice = this.testUniverse.allFoldersSlice;
    allFoldersSlice.onsplice = function(index, howMany, added,
                                        requested, expected) {
      allFoldersSlice.onsplice = null;
      self._logger.deletionNotified(howMany);
    };
    this.testAccount.account.deleteFolder(folderMeta.id);
  },

  addMessagesToFolder: function(testFolder, messages) {
    var folderMeta = testFolder.serverFolder;
    this.RT.reportActiveActorThisStep(this.eImapAccount);
    this.universe._testModeDisablingLocalOps = true;

    // the append will need to check out and check back-in a connection
    this.expect_runOp(
      'append',
      { local: false, server: true, save: false,
        conn: testFolder._liveSliceThings.length === 0 });
    this.expect_appendNotified();

    // turn the messages into something appendable
    var messagesToAppend = messages.map(function(message) {
      var flags = [];
      if (message.metaState.read)
        flags.push('\\Seen');
      if (message.metaState.deleted)
        flags.push('Deleted');
      return {
        date: message.date,
        messageText: message.toMessageString(),
        flags: flags
      };
    });
    self.universe.appendMessages(folderMeta.id, messagesToAppend);
    self.universe.waitForAccountOps(self.compositeAccount, function() {
      self._logger.appendNotified();
      self.universe._testModeDisablingLocalOps = false;
    });
  },
};


var LOGFAB = exports.LOGFAB = $log.register($module, {
  testRealIMAPServer: {
    type: $log.SERVER,
    topBilling: true,

    events: {
      creationNotified: { count: true },
      deletionNotified: { count: true },
      appendNotified: {},
    },
    errors: {
      folderCreationError: { err: false },
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
    testRealIMAPServer: TestRealIMAPServerMixins,
  }
};

}); // end define

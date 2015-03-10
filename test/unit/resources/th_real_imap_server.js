/**
 * Testing support for using a real IMAP server.  We manipulate the server using
 * our built-in infrastructure.
 **/

define(
  [
    'logic',
    './messageGenerator',
    'accountcommon',
    'module',
    'exports'
  ],
  function(
    logic,
    $msggen,
    $accountcommon,
    $module,
    exports
  ) {

var TestRealIMAPServerMixins = {
  __constructor: function(self, opts) {
    self.testAccount = null;
    self.testUniverse = null;
    logic.defineScope(self, 'TestRealIMAPServer');
    self.universe = null;
    self.eAccount = null;
    self.account = null;
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
  getFolderByPath: function(folderPath) {
    return this.account.getFolderByPath(folderPath);
  },

  setDate: function(timestamp) {
    // this is a NOP. We can't affect a real server's perception of time.
  },

  SYNC_FOLDER_LIST_AFTER_ADD: false,
  addFolder: function(name, testFolder) {
    this.RT.reportActiveActorThisStep(this.testAccount);
    this.RT.reportActiveActorThisStep(testFolder.connActor);
    this.RT.reportActiveActorThisStep(testFolder.storageActor);
    this.eAccount.expect('runOp_begin',
                         { mode: 'local_do',
                           type: 'createFolder' });
    this.eAccount.expect('runOp_end',
                         { mode: 'local_do',
                           type: 'createFolder' });
    this.eAccount.expect('runOp_begin',
                         { mode: 'do',
                           type: 'createFolder' });
    this.testAccount.help_expect_connection();
    this.eAccount.expect('releaseConnection');
    this.eAccount.expect('runOp_end',
                         { mode: 'do',
                           type: 'createFolder' });
    this.expect('creationNotified', 1);

    var self = this, allFoldersSlice = this.testUniverse.allFoldersSlice;
    allFoldersSlice.onsplice = function(index, howMany, added,
                                        requested, expected) {
      allFoldersSlice.onsplice = null;
      logic(self, 'creationNotified', { count: added.length });
      testFolder.mailFolder = added[0];
    };
    this.universe.createFolder(this.testAccount.accountId, null, name, false,
      function createdFolder(err, folderMeta) {
      if (err) {
        logic(self, 'folderCreationError', { error: err });
        return;
      }
      testFolder.id = folderMeta.id;
    });
  },

  removeFolder: function(folderMeta) {
    this.RT.reportActiveActorThisStep(this.eAccount);
    this.testAccount.help_expect_connection();
    this.eAccount.expect('releaseConnection');
    this.eAccount.expect('deleteFolder');
    this.testAccount.expect('deletionNotified', 1);

    var self = this, allFoldersSlice = this.testUniverse.allFoldersSlice;
    allFoldersSlice.onsplice = function(index, howMany, added,
                                        requested, expected) {
      allFoldersSlice.onsplice = null;
      logic(self, 'deletionNotified', { count: howMany });
    };
    this.testAccount.account.deleteFolder(folderMeta.id);
  },

  addMessagesToFolder: function(testFolder, messages) {
    var folderMeta = testFolder.serverFolder;
    this.RT.reportActiveActorThisStep(this.eImapAccount);
    this.universe._testModeDisablingLocalOps = true;

    // the append will need to check out and check back-in a connection
    this.testAccount.expect_runOp(
      'append',
      { local: false, server: true, save: false,
        conn: testFolder._liveSliceThings.length === 0 });
    this.expect('appendNotified');

    // turn the messages into something appendable
    var messagesToAppend = messages.map(function(message) {
      var flags = [];
      if (message.metaState.read)
        flags.push('\\Seen');
      if (message.metaState.deleted)
        flags.push('Deleted');
      return {
        date: message.date,
        messageText: new Blob([message.toMessageString()]),
        flags: flags
      };
    });
    self.universe.appendMessages(folderMeta.id, messagesToAppend);
    self.universe.waitForAccountOps(self.compositeAccount, function() {
      logic(self, 'appendNotified');
      self.universe._testModeDisablingLocalOps = false;
    });
  },

  getMessagesInFolder: function() {
    // XXX So, we can't psychically know what's in an IMAP server's real folder.
    // We have to talk to it, which implies running a sync or doing a naive
    // approximation of a sync.  Of course, in general, our tests don't really
    // need to know what's in there... so for now we're just going to stub this
    // out and hope that it's good enough.  It would probably be more
    // appropriate for us to just explode and make sure we simply aren't called
    // in inappropriate cases, possibly through use of an indicator flag to our
    // would-be callers.
    console.warn('getMessagesInFolder does not/cannot work on real IMAP');
    return [];
  },

  /**
   * Modify the flags on one or more messages in a folder.
   */
  modifyMessagesInFolder: function(folderPath, messages, addFlags, delFlags) {
    var self = this;
    this.expect('modifyNotified', { count: messages.length });

    this.testAccount.expect_runOp(
      'modtags', { local: false, server: true, save: false });

    // Don't run this local op against the server!
    this.universe._testModeDisablingLocalOps = true;
    this.testUniverse.MailAPI.modifyMessageTags([messages],
                                                addFlags, delFlags, 'backdoor');

    // XXX The runOp expectation above might actually be sufficient?
    this.testUniverse.MailAPI.ping(function() {
      self.universe.waitForAccountOps(self.account, function() {
        self.universe._testModeDisablingLocalOps = false;
        logic(self, 'modifyNotified', { count: messages.length });
      });
    });
  },

  /**
   * Delete one or more messages from a folder.
   *
   * @args[
   *   @param[messages @listof[MailHeader]]{
   *     MailHeaders from which we can extract the message-id header values.
   *     Although the upstream caller may have a variant where it is not
   *     provided from MailHeaders, it's not allowed to call into IMAP with
   *     that.
   *   }
   * ]
   */
  deleteMessagesFromFolder: function(folderPath, messages) {
    return this.modifyMessagesInFolder(folderPath, messages,
                                       ['\\Deleted'], null);
  }
};

exports.TESTHELPER = {
  actorMixins: {
    TestRealIMAPServer: TestRealIMAPServerMixins,
  }
};

}); // end define

define(function(require) {

var $msggen = require('./messageGenerator');
var { backend, chainBackend } = require('./contexts');
var logic = require('logic');

/**
 * This is where things start to get fuzzy: most tests do require a layer of
 * abstraction beyond what MailAPI provides, even though we found th_main to be
 * a giant burden. There are a couple things at play here:
 *
 * - Each test file kinda-sorta shares MailUniverse/MailAccount instances
 * throughout the whole file, and our per-test teardown isn't great.
 *
 * - We only specify one set of test credentials, meaning we can't just create
 * a new test account for each test unless we do properly clean up ourselves
 * after each test.
 *
 * Ideally, we should interact directly with MailAPI for most tasks, popping
 * into the backend as needed; the more layers of abstraction (such as test
 * objects that wrap real API objects), the more confusing tests become.
 *
 * This AccountHelpers class is the minimum amount of stuff I needed to get
 * test_disaster_recovery working as a proof of concept. In all cases, it
 * expects the user to work with MailAPI accounts/folders directly, rather than
 * wrapping them in their own helper classes. In that sense, this is really just
 * a place for account-related "macros" that chain together common things.
 *
 * It might make sense to split this out more, and/or have other helpers, but
 * without actually going back and rewriting more tests, it's not clear. In
 * other words, this part of the new test design is ripe for better ideas.
 */

function AccountHelpers(MailAPI) {
  this.MailAPI = MailAPI;
  logic.defineScope(this, 'AccountHelpers');
}

// If we already created an account for this test file, just
// reuse the existing account. Most tests expect one account to
// survive the entire lifetime of the file.
AccountHelpers.account = null;

AccountHelpers.prototype = {
  /**
   * Create an account. Accepts the following options:
   *
   * {
   *   displayName: (string, required),
   *   emailAddress: (string, required),
   *   password: (string, required)
   * }
   *
   * @return {Promise<MailAccount>}
   */
  createAccount(opts) {
    return logic.async(this, 'createAccount frontend', (resolve, reject) => {
      this.MailAPI.tryToCreateAccount({
        displayName: opts.displayName,
        emailAddress: opts.emailAddress,
        password: opts.password
      }, /* configInfo: */ null, (error, errorDetails, account) => {
        if (error) {
          reject({ error: error, errorDetails: errorDetails });
          return;
        }

        AccountHelpers.account = account;
        this.folders = this.MailAPI.viewFolders('account', account);
        this.folders.oncomplete = function() {
          resolve(account.id);
        }.bind(this);
      });
    }).then(chainBackend(function($, accountId) {
      // Find the backend Account instance corresponding to the
      // account we just created.
      $.universe.accounts.some((account) => {
        if (account.id === accountId) {
          $.folderAccount = account;
          $.account = account;

          // The backend fakeserver requires access to the account.
          $.server.setAccount($.account);
          return true; // break out
        }
      });
    })).then(() => {
      return AccountHelpers.account;
    });
  },

  /**
   * Create a test folder, deleting the existing folder if necessary.
   * Optionally, add messages to the folder as well. Return a MailFolder
   * instance.
   *
   * @param {string} folderName
   * @param {object} optionalDefinitionOpts
   * @return {Promise<MailFolder>}
   */
  createFolder(folderName, optionalDefinitionOpts) {
    return backend('createFolder', [folderName], function($, folderName) {
      var existingFolder = $.server.getFolderByPath(folderName);
      if (existingFolder) {
        $.server.removeFolder(existingFolder);
      }
      var canonicalPath = $.server.addFolder(folderName);
      return new Promise((resolve) => {
        $.universe.syncFolderList($.account, () => {
          resolve(canonicalPath);
        });
      });
    }).then((canonicalPath) => {
      return new Promise((resolve) => {
        this.MailAPI.ping(() => {
          resolve(this.folders.getFirstFolderWithPath(canonicalPath));
        });
      });
    }).then((folder) => {
      // If desired, add messages to the folder, but still return
      // the folder instance to the caller.
      if (optionalDefinitionOpts) {
        return this.addMessagesToFolder(folder, optionalDefinitionOpts)
          .then(() => {
            return folder;
          });
      } else {
        return folder;
      }
    });
  },

  /**
   * Add messages to the given MailFolder (or folder path).
   *
   * @param {MailFolder|string} folder
   *   The MailFolder instance, or path string, of the folder.
   * @param {object} definitionOpts
   *   See th_main.js for the specs on this.
   */
  addMessagesToFolder(folder, definitionOpts) {
    return backend(
      'addMessagesToFolder',
      [folder.path || folder, definitionOpts],
      ($, folderPath, definitionOpts) => {
      var messageBodies;
      if (definitionOpts instanceof Function) {
        messageBodies = definitionOpts();
      } else {
        if ($.server.date) {
          $.msggen._clock = $.server.date;
        }
        messageBodies = $.msggen.makeMessages(definitionOpts);
      }

      return $.server.addMessagesToFolder(folderPath, messageBodies)
        .then(() => {
          return messageBodies;
        });
    });
  },

  /**
   * View the messages of a MailFolder as a MailSlice.
   *
   * @param {MailFolder} folder
   * @return {Promise<FolderSlice>}
   */
  viewFolder(folder) {
    return new Promise((resolve, reject) => {
      var slice = this.MailAPI.viewFolderMessages(folder);
      slice.oncomplete = function(newEmailCount) {
        resolve(slice);
      };
    });
  },

  /**
   * Create a nondeterministic subject (in contrast to what TB's messageGenerator
   * does because unit tests usually like determinism.)  This is required because
   * we potentially use a real Inbox which may have test detritus from previous
   * runs.  In that case, we don't want to be tricked by a previous test run's
   * values.
   */
  makeRandomSubject() {
    return 'Composition: ' + Date.now() + ' ' +
      Math.floor(Math.random() * 100000);
  },

  /**
   * Wait for a message with the given subject to show up in the folder.  This
   * clobbers the onadd/oncomplete listeners as part of its operation.
   */
  waitForMessage(slice, expectSubject) {
    var activeTimeout;
    return new Promise((resolve, reject) => {
      var checkHeader = function(header) {
        if (header.subject !== expectSubject) {
          return false;
        }
        satisfied = true;
        resolve(header);
        return true;
      }

      // Check if the message is already in the slice:
      if (!slice.items.some(checkHeader)) {
        slice.onadd = checkHeader;

        // Nope, we have to listen for changes and continually trigger
        // refreshes until we achieve happiness.
        var completeFunc = () => {
          // trigger a refresh after giving the fake-servers a chance to catch up
          activeTimeout = window.setTimeout(
            () => {
              // the slice clears oncomplete each time it fires, so we need to
              // re-bind ourselves
              slice.oncomplete = completeFunc;
              slice.refresh();
            },
            20);
        };
        slice.oncomplete = completeFunc;
        // Trigger a refresh if something isn't still ongoing.  (When the ongoing
        // thing completes, it will trigger our completeFunc.)
        if (slice.status !== 'new' && slice.status !== 'synchronizing') {
          slice.refresh();
        }
      }
    }).then((header) => {
      window.clearTimeout(activeTimeout);
      slice.onadd = null;
      slice.oncomplete = null;
      return header;
    });
  },

  /**
   * Transition helper, this just wraps MailHeader.getBody in a Promise.  (I'm
   * creating this to minimize uplift contamination right now and since the
   * Promises refactoring stuff is largely in the conversations branch.)
   */
  getBody(header, opts) {
    return new Promise((resolve) => {
      header.getBody(opts, resolve);
    });
  },

  /**
   * S.A.F.E.T.Y. Ping.  Safety Ping.
   *
   * This is a hack to ensure that the frontend/test context has received
   * everything that the backend wanted to send us.  This matters for batching
   * and things stuck in the double-bounced postmessage bridge.
   *
   * This is a reasonable thing to use for v2 stuff, but should be removed from
   * v3.  Its very existence is a code smell.  Its use?  Code sulfur.
   */
  safetyPing() {
    return new Promise((resolve) => {
      this.MailAPI.ping(() => {
        resolve();
      });
    });
  }
};


return AccountHelpers;

});

import logic from 'logic';
// XXX proper logging configuration for the front-end too once things start
// working happily.
logic.realtimeLogEverything = true;
logic.bc = new BroadcastChannel('logic');
logic.bc.postMessage({ mode: 'clear' });

// Use a relative link so that consumers do not need to create
// special config to use main-frame-setup.
import addressparser from 'vendored/addressparser';
import evt from 'evt';

import MailFolder from './mail_folder';

import MailConversation from './mail_conversation';
import MailMessage from './mail_message';

import ContactCache from './contact_cache';
import UndoableOperation from './undoable_operation';

import AccountsViewSlice from './accounts_view_slice';
import FoldersListView from './folders_list_view';
import ConversationsListView from './conversations_list_view';
import MessagesListView from './messages_list_view';
import RawListView from './raw_list_view';

import MessageComposition from './message_composition';

import { accountIdFromFolderId, accountIdFromConvId, accountIdFromMessageId,
        convIdFromMessageId } from 'shared/id_conversions';

import * as Linkify from './bodies/linkify';

/**
 * Given a list of MailFolders (that may just be null and not a list), map those
 * to the folder id's.
 */
let normalizeFoldersToIds = (folders) => {
  if (!folders) {
    return folders;
  }
  return folders.map(folder => folder.id);
};

// For testing
export { MailFolder as _MailFolder };

const LEGAL_CONFIG_KEYS = ['debugLogging'];

/**
 * The public API exposed to the client via the MailAPI global.
 *
 * TODO: Implement a failsafe timeout mechanism for returning Promises for
 * requests that will timeout and reject or something.  The idea is to allow
 * code that
 *
 * @constructor
 * @memberof module:mailapi
 */
export function MailAPI() {
  evt.Emitter.call(this);
  logic.defineScope(this, 'MailAPI', {});
  this._nextHandle = 1;

  /**
   * @type {Map<BridgeHandle, Object>}
   *
   * Holds live list views (what were formerly called slices) and live tracked
   * one-off items (ex: viewConversation/friends that call
   * _getItemAndTrackUpdates).
   *
   * In many ways this is nearly identically to _pendingRequests, but this was
   * split off because different semantics were originally intended.  Probably
   * it makes sense to keep this for "persistent subscriptions" and eventually
   * replace things using _pendingRequests with an explicitly supported
   * co.wrap() idiom.
   */
  this._trackedItemHandles = new Map();
  this._pendingRequests = {};
  this._liveBodies = {};

  // Store bridgeSend messages received before back end spawns.
  this._storedSends = [];

  this._processingMessage = null;
  /**
   * List of received messages whose processing is being deferred because we
   * still have a message that is actively being processed, as stored in
   * `_processingMessage`.
   */
  this._deferredMessages = [];

  /**
   * @dict[
   *   @key[debugLogging]
   *   @key[checkInterval]
   * ]{
   *   Configuration data.  This is currently populated by data from
   *   `MailUniverse.exposeConfigForClient` by the code that constructs us.  In
   *   the future, we will probably want to ask for this from the `MailUniverse`
   *   directly over the wire.
   *
   *   This should be treated as read-only.
   * }
   */
  this.config = {};

  /**
   * Has the MailUniverse come up and reported in to us and provided us with the
   * initial config?  You can use latestOnce('configLoaded') for this purpose.
   * Note that you don't need to wait for this if you have other API calls to
   * make since all messages are buffered and released once the universe is
   * available.
   */
  this.configLoaded = false;
  /**
   * Has the MailUniverse finished loading its list of accounts and their
   * folders and told us about them and our `accounts` view and each of their
   * `folders` views has completed populating?  You can use
   * latestOnce('accountsLoaded') in order to be notified once it has occurred
   * (or immediately if it has already occurred).
   */
  this.accountsLoaded = false;

  /* PROPERLY DOCUMENT EVENT 'badlogin'
   * @func[
   *   @args[
   *     @param[account MailAccount]
   *   ]
   * ]{
   *   A callback invoked when we fail to login to an account and the server
   *   explicitly told us the login failed and we have no reason to suspect
   *   the login was temporarily disabled.
   *
   *   The account is put in a disabled/offline state until such time as the
   *
   * }
   */

  ContactCache.init();

  // Default slices:
  this.accounts = this.viewAccounts({ autoViewFolders: true });
}
MailAPI.prototype = evt.mix(/** @lends module:mailapi.MailAPI.prototype */ {
  toString() {
    return '[MailAPI]';
  },
  toJSON() {
    return { type: 'MailAPI' };
  },

  /**
   * Invoked by main-frame-setup when it's done poking things into us so that
   * we can set flags and emit events and such.  We can probably also move more
   * of its logic into this file if it makes sense.
   */
  __universeAvailable() {
    this.configLoaded = true;
    this.emit('configLoaded');
    logic(this, 'configLoaded');

    // wait for the account view to be fully populated
    this.accounts.latestOnce('complete', () => {
      // wait for all of the accounts to have their folder views fully populated
      Promise.all(this.accounts.items.map((account) => {
        return new Promise((resolve) => {
          account.folders.latestOnce('complete', resolve);
        });
      })).then(() => {
        this.accountsLoaded = true;
        logic(this, 'accountsLoaded');
        this.emit('accountsLoaded');
      });
    });
  },

  // This exposure as "utils" exists for legacy reasons right now, we should
  // probably just move consumers to directly require the module.
  utils: Linkify,

  /**
   * Return a Promise that will be resolved with a guaranteed-alive MailAccount
   * instance from our `accounts` view.  You would use this if you can't
   * guarantee that `accountsLoaded` is already true or if the account is
   * potentially in the process of being created.
   */
  eventuallyGetAccountById(accountId) {
    return this.accounts.eventuallyGetAccountById(accountId);
  },

  /**
   * Return a Promise that will be resolved with a guaranteed-alive MailFolder
   * instance from one the corresponding `folders` view on the `MailAccount`
   * from our `accounts` view that owns the folder.  You would use this if you
   * can't guarantee that `accountsLoaded` is already true.  Some implementation
   * changes are required if you want this to also cover folders that are not
   * yet synchronized.
   */
  eventuallyGetFolderById(folderId) {
    var accountId = accountIdFromFolderId(folderId);
    return this.accounts.eventuallyGetAccountById(accountId).then(
      function gotAccount(account) {
        return account.folders.eventuallyGetFolderById(folderId);
      }
    );
  },

  /**
   * Synchronous version of eventuallyGetFolderById that will return null if
   * either the account or folder don't currently exist.  If your logic is gated
   * by latestOnce('accountsLoaded') and this isn't a newly created account,
   * then you should be safe in using this.  Otherwise wait for `accountsLoaded`
   * or use `eventuallyGetFolderById`.
   */
  getFolderById(folderId) {
    const accountId = accountIdFromFolderId(folderId);
    const account = this.accounts.getAccountById(accountId);
    return account && account.folders.getFolderById(folderId);
  },

  /**
   * Convert the folder id's for a message into MailFolder instances by looking
   * them up from the account's folders list view.
   *
   * XXX deal with the potential asynchrony of this method being called before
   * the account is known to us.  We should generally be fine, but we don't have
   * the guards in place to actually protect us.
   */
  _mapLabels(messageId, folderIds) {
    let accountId = accountIdFromMessageId(messageId);
    let account = this.accounts.getAccountById(accountId);
    if (!account) {
      console.warn('the possible has happened; unable to find account with id',
                   accountId);
    }
    let folders = account.folders;
    return Array.from(folderIds).map((folderId) => {
      return folders.getFolderById(folderId);
    });
  },

  /**
   * Send a message over/to the bridge.  The idea is that we (can) communicate
   * with the backend using only a postMessage-style JSON channel.
   */
  __bridgeSend(msg) {
    // This method gets clobbered eventually once back end worker is ready.
    // Until then, it will store calls to send to the back end.

    this._storedSends.push(msg);
  },

  /**
   * Process a message received from the bridge.
   */
  __bridgeReceive(msg) {
    // Pong messages are used for tests
    if (this._processingMessage && msg.type !== 'pong') {
      logic(this, 'deferMessage', { type: msg.type });
      this._deferredMessages.push(msg);
    }
    else {
      logic(this, 'immediateProcess', { type: msg.type });
      this._processMessage(msg);
    }
  },

  _processMessage(msg) {
    var methodName = '_recv_' + msg.type;
    if (!(methodName in this)) {
      logic.fail(new Error('Unsupported message type:', msg.type));
      return;
    }
    try {
      logic(this, 'processMessage', { type: msg.type });
      var promise = this[methodName](msg);
      if (promise && promise.then) {
        this._processingMessage = promise;
        promise.then(this._doneProcessingMessage.bind(this, msg));
      }
    }
    catch (ex) {
      logic(
        this, 'processMessageError',
        {
          type: msg.type,
          ex,
          stack: ex.stack
        });
      return;
    }
  },

  _doneProcessingMessage(msg) {
    if (this._processingMessage && this._processingMessage !== msg) {
      throw new Error('Mismatched message completion!');
    }

    this._processingMessage = null;
    while (this._processingMessage === null && this._deferredMessages.length) {
      this._processMessage(this._deferredMessages.shift());
    }
  },

  /** @see ContactCache.shoddyAutocomplete */
  shoddyAutocomplete(phrase) {
    return ContactCache.shoddyAutocomplete(phrase);
  },

  /**
   * Return a promise that's resolved with a MailConversation instance that is
   * live-updating with events until `release` is called on it.
   */
  getConversation(conversationId, priorityTags) {
    // We need the account for the conversation in question to be loaded for
    // safety, dependency reasons.
    return this.eventuallyGetAccountById(accountIdFromConvId(conversationId))
      .then(() => {
        // account is ignored, we just needed to ensure it existed for
        // _mapLabels to be a friendly, happy, synchronous API.
        return this._getItemAndTrackUpdates(
          'conv', conversationId, MailConversation, priorityTags);
      });
  },

  /**
   * Return a promise that's resolved with a MailMessage instance that is
   * live-updating with events until `release` is called on it.
   *
   * @param {[MessageId, DateMS]} messageNamer
   */
  getMessage(messageNamer, priorityTags) {
    let messageId = messageNamer[0];
    // We need the account for the conversation in question to be loaded for
    // safety, dependency reasons.
    return this.eventuallyGetAccountById(accountIdFromMessageId(messageId))
      .then(() => {
        // account is ignored, we just needed to ensure it existed for
        // _mapLabels to be a friendly, happy, synchronous API.
        return this._getItemAndTrackUpdates(
          'msg', messageNamer, MailMessage, priorityTags);
      });
  },

  /**
   * Sends a message with a freshly allocated single-use handle, returning a
   * Promise that will be resolved when the MailBridge responds to the message.
   * (Someday it may also be rejected if we lose the back-end.)
   */
  _sendPromisedRequest(sendMsg) {
    return new Promise((resolve) => {
      let handle = sendMsg.handle = this._nextHandle++;
      this._pendingRequests[handle] = {
        type: sendMsg.type,
        resolve
      };
      this.__bridgeSend(sendMsg);
    });
  },

  _recv_promisedResult(msg) {
    let handle = msg.handle;
    let pending = this._pendingRequests[handle];
    delete this._pendingRequests[handle];
    pending.resolve(msg.data);
  },

  /**
   * Create an UndoableOperation for synchronous return to the caller that will
   * have its actual tasks to undo filled in asynchronously.  Idiom glue logic.
   */
  _sendUndoableRequest(undoableInfo, requestPayload) {
    let id = this._nextHandle;
    let undoableTasksPromise = this._sendPromisedRequest(requestPayload);
    let undoableOp = new UndoableOperation({
      api: this,
      id,
      operation: undoableInfo.operation,
      affectedType: undoableInfo.affectedType,
      affectedCount: undoableInfo.affectedCount,
      undoableTasksPromise
    });
    this.emit('undoableOp', undoableOp);
    return undoableOp;
  },

  __scheduleUndoTasks(undoableOp, undoTasks) {
    this.emit('undoing', undoableOp);
    this.__bridgeSend({
      type: 'undo',
      undoTasks
    });
  },

  /**
   * Normalize conversation/message references to our list of
   * conversation-with-selector objects of the form/type { id, messageIds,
   * messageSelector }.
   */
  _normalizeConversationSelectorArgs(arrayOfStuff, args) {
    let { detectType: argDetect, conversations: argConversations,
          messages: argMessages, messageSelector } = args;
    let convSelectors;
    if (arrayOfStuff) {
      argDetect = arrayOfStuff;
    }

    if (argDetect) {
      if (argDetect[0] instanceof MailMessage) {
        argMessages = argDetect;
      } else if (argDetect[0] instanceof MailConversation) {
        argConversations = argDetect;
      }
    }
    let affectedType;
    let affectedCount = 0;
    if (argConversations) {
      affectedType = 'conversation';
      affectedCount = argConversations.length;
      convSelectors = argConversations.map((x) => {
        return {
          id: x.id,
          messageSelector
        };
      });
    } else if (argMessages) {
      affectedType = 'message';
      affectedCount = argMessages.length;
      convSelectors = [];
      let selectorByConvId = new Map();
      for (let message of argMessages) {
        let convId = convIdFromMessageId(message.id);
        let selector = selectorByConvId.get(convId);
        if (!selector) {
          selector = {
            id: convId,
            messageIds: [message.id]
          };
          selectorByConvId.set(convId, selector);
          convSelectors.push(selector);
        } else {
          selector.messageIds.push(message.id);
        }
      }
    } else {
      throw new Error('Weird conversation/message selector.');
    }

    return { convSelectors, affectedType, affectedCount };
  },

  _recv_broadcast(msg) {
    let { name, data } = msg.payload;
    this.emit(name, data);
  },

  /**
   * Ask the back-end for an item by its id.  The current state will be loaded
   * from the db and then logically consistent updates provided until release
   * is called on the object.
   *
   * In the future we may support also taking an existing wireRep so that the
   * object can be provided synchronously.  I want to try to avoid that at first
   * because it's the type of thing that really wants to be implemented when
   * we've got our unit tests stood up again.
   *
   * `_cleanupContext` should be invoked by the release method of whatever
   * object we create when all done.
   *
   * XXX there's a serious potential for resource-leak/clobbering races where by
   * the time we resolve our promise the caller will not correctly call release
   * on our value or we'll end up clobbering the value from a chronologically
   * later call to our method.
   */
  _getItemAndTrackUpdates(itemType, itemId, itemConstructor, priorityTags) {
    return new Promise((resolve, reject) => {
      let handle = this._nextHandle++;
      this._trackedItemHandles.set(handle, {
        type: itemType,
        id: itemId,
        callback: (msg) => {
          if (msg.error || !msg.data) {
            reject(
              new Error('track problem, error: ' + msg.error + ' has data?: ' +
                        !!msg.data));
            return;
          }

          let obj = new itemConstructor(
            this, msg.data.state, msg.data.overlays, null, handle);
          resolve(obj);
          this._trackedItemHandles.set(handle, {
            type: itemType,
            id: itemId,
            obj: obj
          });
        }
      });
      this.__bridgeSend({
        type: 'getItemAndTrackUpdates',
        handle: handle,
        itemType: itemType,
        itemId: itemId,
        priorityTags
      });
      return handle;
    });
  },

  _recv_gotItemNowTrackingUpdates(msg) {
    let details = this._trackedItemHandles.get(msg.handle);
    details.callback(msg);
  },

  /**
   * Internal-only API to update the priority associated with an instantiated
   * object.
   */
  _updateTrackedItemPriorityTags(handle, priorityTags) {
    this.__bridgeSend({
      type: 'updateTrackedItemPriorityTags',
      handle: handle,
      priorityTags: priorityTags
    });
  },

  // update event for list views.  This used to be shared logic with updateItem
  // but when overlays came into the picture the divergence got too crazy.
  _recv_update(msg) {
    let details = this._trackedItemHandles.get(msg.handle);
    if (details && details.obj) {
      let obj = details.obj;

      let data = msg.data;
      obj.__update(data);
    }
  },

  // update event for tracked items (rather than list views)
  _recv_updateItem(msg) {
    let details = this._trackedItemHandles.get(msg.handle);
    if (details && details.obj) {
      let obj = details.obj;

      let data = msg.data;
      if (data === null) {
        // - null means removal
        // TODO: consider whether our semantics should be self-releasing in this
        // case.  For now we will leave it up to the caller.
        obj.emit('remove', obj);
      } else {
        // - non-null means it's an update!
        if (data.state) {
          obj.__update(data.state);
        }
        if (data.overlays) {
          obj.__updateOverlays(data.overlays);
        }
        obj.serial++;
        obj.emit('change', obj);
      }
    }
  },

  _cleanupContext(handle) {
    this.__bridgeSend({
      type: 'cleanupContext',
      handle: handle
    });
  },

  /**
   * The mailbridge response to a "cleanupContext" command, triggered by a call
   * to our sibling `_cleanupContext` function which should be invoked by public
   * `release` calls.
   *
   * TODO: Conclusively decide whether it could make sense for this, or a
   * variant of this for cases where the mailbridge/backend can send effectively
   * unsolicited notifications of this.
   */
  _recv_contextCleanedUp(msg) {
    this._trackedItemHandles.delete(msg.handle);
  },

  _downloadBodyReps(messageId, messageDate) {
    this.__bridgeSend({
      type: 'downloadBodyReps',
      id: messageId,
      date: messageDate
    });
  },

  _downloadAttachments(downloadReq) {
    return this._sendPromisedRequest({
      type: 'downloadAttachments',
      downloadReq
    });
  },

  /**
   * Given a user's email address, try and see if we can autoconfigure the
   * account and what information we'll need to configure it, specifically
   * a password or if XOAuth2 credentials will be needed.
   *
   * @param {Object} details
   * @param {String} details.emailAddress
   *   The user's email address.
   * @return {Promise<Object>}
   *   A promise that will be resolved with an object like so:
   *
   *   No autoconfig information is available and the user has to do manual
   *   setup:
   *
   *     {
   *       result: 'no-config-info',
   *       configInfo: null
   *     }
   *
   *   Autoconfig information is available and to complete the autoconfig
   *   we need the user's password.  For IMAP and POP3 this means we know
   *   everything we need and can actually create the account.  For ActiveSync
   *   we actually need the password to try and perform autodiscovery.
   *
   *     {
   *       result: 'need-password',
   *       configInfo: { incoming, outgoing }
   *     }
   *
   *   Autoconfig information is available and XOAuth2 authentication should
   *   be attempted and those credentials then provided to us.
   *
   *     {
   *       result: 'need-oauth2',
   *       configInfo: {
   *         incoming,
   *         outgoing,
   *         oauth2Settings: {
   *           secretGroup: 'google' or 'microsoft' or other arbitrary string,
   *           authEndpoint: 'url to the auth endpoint',
   *           tokenEndpoint: 'url to where you ask for tokens',
   *           scope: 'space delimited list of scopes to request'
   *         }
   *       }
   *     }
   *
   *   A `source` property will also be present in the result object.  Its
   *   value will be one of: 'hardcoded', 'local', 'ispdb',
   *   'autoconfig-subdomain', 'autoconfig-wellknown', 'mx local', 'mx ispdb',
   *   'autodiscover'.
   */
  learnAboutAccount(details) {
    return this._sendPromisedRequest({
      type: 'learnAboutAccount',
      details
    });
  },

  /**
   * Try to create an account.  There is currently no way to abort the process
   * of creating an account.  You really want to use learnAboutAccount before
   * you call this unless you are an automated test.
   *
   * @typedef[AccountCreationError @oneof[
   *   @case['offline']{
   *     We are offline and have no network access to try and create the
   *     account.
   *   }
   *   @case['no-dns-entry']{
   *     We couldn't find the domain name in question, full stop.
   *
   *     Not currently generated; eventually desired because it suggests a typo
   *     and so a specialized error message is useful.
   *   }
   *   @case['no-config-info']{
   *     We were unable to locate configuration information for the domain.
   *   }
   *   @case['unresponsive-server']{
   *     Requests to the server timed out.  AKA we sent packets into a black
   *     hole.
   *   }
   *   @case['port-not-listening']{
   *     Attempts to connect to the given port on the server failed.  We got
   *     packets back rejecting our connection.
   *
   *     Not currently generated; primarily desired because it is very useful if
   *     we are domain guessing.  Also desirable for error messages because it
   *     suggests a user typo or the less likely server outage.
   *   }
   *   @case['bad-security']{
   *     We were able to connect to the port and initiate TLS, but we didn't
   *     like what we found.  This could be a mismatch on the server domain,
   *     a self-signed or otherwise invalid certificate, insufficient crypto,
   *     or a vulnerable server implementation.
   *   }
   *   @case['bad-user-or-pass']{
   *     The username and password didn't check out.  We don't know which one
   *     is wrong, just that one of them is wrong.
   *   }
   *   @case['bad-address']{
   *     The e-mail address provided was rejected by the SMTP probe.
   *   }
   *   @case['pop-server-not-great']{
   *     The POP3 server doesn't support IDLE and TOP, so we can't use it.
   *   }
   *   @case['imap-disabled']{
   *     IMAP support is not enabled for the Gmail account in use.
   *   }
   *   @case['pop3-disabled']{
   *     POP3 support is not enabled for the Gmail account in use.
   *   }
   *   @case['needs-oauth-reauth']{
   *     The OAUTH refresh token was invalid, or there was some problem with
   *     the OAUTH credentials provided. The user needs to go through the
   *     OAUTH flow again.
   *   }
   *   @case['not-authorized']{
   *     The username and password are correct, but the user isn't allowed to
   *     access the mail server.
   *   }
   *   @case['server-problem']{
   *     We were able to talk to the "server" named in the details object, but
   *     we encountered some type of problem.  The details object will also
   *     include a "status" value.
   *   }
   *   @case['server-maintenance']{
   *     The server appears to be undergoing maintenance, at least for this
   *     account.  We infer this if the server is telling us that login is
   *     disabled in general or when we try and login the message provides
   *     positive indications of some type of maintenance rather than a
   *     generic error string.
   *   }
   *   @case['user-account-exists']{
   *     If the user tries to create an account which is already configured.
   *     Should not be created. We will show that account is already configured
   *   }
   *   @case['unknown']{
   *     We don't know what happened; count this as our bug for not knowing.
   *   }
   *   @case[null]{
   *     No error, the account was created and everything is terrific.
   *   }
   * ]]
   *
   * @param {Object} details
   * @param {String} details.emailAddress
   * @param {String} [details.password]
   *   The user's password
   * @param {Object} [configInfo]
   *   If continuing an autoconfig initiated by learnAboutAccount, the
   *   configInfo it returned as part of its results, although you will need
   *   to poke the following structured properties in if you're doing the oauth2
   *   thing:
   *
   *     {
   *       oauth2Secrets: { clientId, clientSecret }
   *       oauth2Tokens: { accessToken, refreshToken, expireTimeMS }
   *     }
   *
   *   If performing a manual config, a manually created configInfo object of
   *   the following form:
   *
   *     {
   *       incoming: { hostname, port, socketType, username, password }
   *       outgoing: { hostname, port, socketType, username, password }
   *     }
   *
   *
   *
   * @param {Function} callback
   *   The callback to invoke upon success or failure.  The callback will be
   *   called with 2 arguments in the case of failure: the error string code,
   *   and the error details object.
   *
   *
   * @args[
   *   @param[details @dict[
   *     @key[displayName String]{
   *       The name the (human, per EULA) user wants to be known to the world
   *       as.
   *     }
   *     @key[emailAddress String]
   *     @key[password String]
   *   ]]
   *   @param[callback @func[
   *     @args[
   *       @param[error AccountCreationError]
   *       @param[errorDetails @dict[
   *         @key[server #:optional String]{
   *           The server we had trouble talking to.
   *         }
   *         @key[status #:optional @oneof[Number String]]{
   *           The HTTP status code number, or "timeout", or something otherwise
   *           providing detailed additional information about the error.  This
   *           is usually too technical to be presented to the user, but is
   *           worth encoding with the error name proper if possible.
   *         }
   *       ]]
   *     ]
   *   ]
   * ]
   */
  tryToCreateAccount(userDetails, domainInfo) {
    return this._sendPromisedRequest({
      type: 'tryToCreateAccount',
      userDetails,
      domainInfo
    }).then((result) => {
      if (result.accountId) {
        return this.accounts.eventuallyGetAccountById(result.accountId).then(
          (account) => {
            return {
              error: null,
              errorDetails: null,
              account
            };
          }
        );
      } else {
        return {
          error: result.error,
          errorDetails: result.errorDetails
        };
      }
    });
  },

  _clearAccountProblems(account, callback) {
    var handle = this._nextHandle++;
    this._pendingRequests[handle] = {
      type: 'clearAccountProblems',
      callback: callback,
    };
    this.__bridgeSend({
      type: 'clearAccountProblems',
      accountId: account.id,
      handle: handle,
    });
  },

  _recv_clearAccountProblems(msg) {
    var req = this._pendingRequests[msg.handle];
    delete this._pendingRequests[msg.handle];
    req.callback && req.callback();
  },

  _modifyAccount(account, mods) {
    return this._sendPromisedRequest({
      type: 'modifyAccount',
      accountId: account.id,
      mods
    }).then(() => null);
  },


  _recreateAccount(account) {
    this.__bridgeSend({
      type: 'recreateAccount',
      accountId: account.id,
    });
  },

  _deleteAccount(account) {
    this.__bridgeSend({
      type: 'deleteAccount',
      accountId: account.id,
    });
  },

  _modifyIdentity(identity, mods) {
    return this._sendPromisedRequest({
      type: 'modifyIdentity',
      identityId: identity.id,
      mods
    }).then(() => null);
  },

  /**
   * Get the list of accounts.  This can be used for the list of accounts in
   * setttings or for a folder tree where only one account's folders are visible
   * at a time.
   *
   * @param {Object} [opts]
   * @param {Boolean} [opts.autoViewFolders=false]
   *   Should the `MailAccount` instances automatically issue viewFolders
   *   requests and assign them to a "folders" property?
   */
  viewAccounts(opts) {
    var handle = this._nextHandle++,
        view = new AccountsViewSlice(this, handle, opts);
    this._trackedItemHandles.set(handle, { obj: view });

    this.__bridgeSend({
      type: 'viewAccounts',
      handle
    });
    return view;
  },

  /**
   * Retrieve the entire folder hierarchy for either 'navigation' (pick what
   * folder to show the contents of, including unified folders), 'movetarget'
   * (pick target folder for moves, does not include unified folders), or
   * 'account' (only show the folders belonging to a given account, implies
   * selection).  In all cases, there may exist non-selectable folders such as
   * the account roots or IMAP folders that cannot contain messages.
   *
   * When accounts are presented as folders via this UI, they do not expose any
   * of their `MailAccount` semantics.
   *
   * @args[
   *   @param[mode @oneof['navigation' 'movetarget' 'account']
   *   @param[argument #:optional]{
   *     Arguent appropriate to the mode; currently will only be a `MailAccount`
   *     instance.
   *   }
   * ]
   */
  viewFolders(mode, accountId) {
    var handle = this._nextHandle++,
        view = new FoldersListView(this, handle);

    this._trackedItemHandles.set(handle, { obj: view });

    this.__bridgeSend({
      type: 'viewFolders',
      mode,
      handle,
      accountId
    });

    return view;
  },

  /**
   * View some list provided by an extension or a hack in the backend, returning
   * a RawListView that holds RawItem instances.  If things get fancy and you
   * aren't dealing in "raw" things, then we might want to create Additional
   * explicit API calls for typing reasons.
   *
   * @param {String} namespace
   *   Effectively identifies the extension/provider that will be providing the
   *   data.  We call it a namespace because maybe multiple extensions will
   *   service the same namespace or something.
   * @param {String} name
   *   Some string that describes to the extension(s)/provider(s) what you want
   *   from inside their namespace.  We require it to be a String so that we
   *   can use it as a key in a Map
   */
  viewRawList(namespace, name) {
    var handle = this._nextHandle++,
        view = new RawListView(this, handle);
    view.source = { namespace, name };
    this._trackedItemHandles.set(handle, { obj: view });

    this.__bridgeSend({
      type: 'viewRawList',
      handle,
      namespace,
      name
    });
    return view;
  },

  /**
   * View the conversations in a folder.
   */
  viewFolderConversations(folder) {
    var handle = this._nextHandle++,
        view = new ConversationsListView(this, handle);
    view.folderId = folder.id;
    // Hackily save off the folder as a stop-gap measure to make it easier to
    // describe the contents of the view until we enhance the tocMeta to
    // better convey this.
    view.folder = this.getFolderById(view.folderId);
    this._trackedItemHandles.set(handle, { obj: view });

    this.__bridgeSend({
      type: 'viewFolderConversations',
      folderId: folder.id,
      handle
    });

    return view;
  },

  _makeDerivedViews(rootView, viewSpecs) {
    const viewDefsWithHandles = [];
    const createView = (viewDef) => {
      const handle = this._nextHandle++;
      const view = new RawListView(this, handle);
      view.viewDef = viewDef;
      this._trackedItemHandles.set(handle, { obj: view });
      viewDefsWithHandles.push({
        handle,
        viewDef
      });
      return view;
    };

    let apiResult = {
      root: rootView
    };
    for (let key of Object.keys(viewSpecs)) {
      let viewDefs = viewSpecs[key];
      apiResult[key] = viewDefs.map(createView);
    }
    return { apiResult, viewDefsWithHandles };
  },

  /**
  * Search a folder's conversations for conversations matching the provided
  * filter constraints, returning a ConversationsListView.
  *
  * @param {Object} spec
  * @param {MailFolder} spec.folder
  *   The folder whose messages we should search.
  * @param {Object} spec.filter
  * @param {String} [spec.filter.author]
  *   Match against author display name or email address.
  * @param {String} [spec.filter.recipients]
  *   Match against recipient display name or email addresses.
  * @param {String} [spec.filter.subject]
  *   Match against the message subject.
  * @param {String} [spec.filter.body]
  *   Match against the authored message body.  Quoted blocks will be ignored.
  * @param {String} [spec.filter.bodyAndQuotes]
  *   Match against the authored message body and any included quoted blocks.
  * @param {Object} spec.derivedViews
  *   Derived view definitions.  The input should look like { foo: [viewDef1,
  *   viewDef2], bar: [viewDef3] }.  When used, this will then alter the
  *   return value of this method to be  { root: theNormalView, foo:
  *   [derivedView1, derivedView2], bar: [derivedView3] }.
  */
  searchFolderConversations(spec) {
    var handle = this._nextHandle++,
        view = new ConversationsListView(this, handle);
    view.folderId = spec.folder.id;
    // Hackily save off the folder as a stop-gap measure to make it easier to
    // describe the contents of the view until we enhance the tocMeta to
    // better convey this.
    view.folder = this.getFolderById(view.folderId);
    this._trackedItemHandles.set(handle, { obj: view });

    let result = view;
    let viewDefsWithHandles = null;
    if (spec.derivedViews) {
      ({ apiResult: result, viewDefsWithHandles } =
        this._makeDerivedViews(view, spec.derivedViews));
    }

    this.__bridgeSend({
      type: 'searchFolderConversations',
      handle,
      spec: {
        folderId: view.folderId,
        filter: spec.filter,
      },
      viewDefsWithHandles
    });
    return result;
  },

  /**
   * View the conversations in a folder.
   */
   viewFolderMessages(folder) {
    var handle = this._nextHandle++,
        view = new MessagesListView(this, handle);
    view.folderId = folder.id;
    // Hackily save off the folder as a stop-gap measure to make it easier to
    // describe the contents of the view until we enhance the tocMeta to
    // better convey this.
    view.folder = this.getFolderById(view.folderId);
    this._trackedItemHandles.set(handle, { obj: view });

    this.__bridgeSend({
      type: 'viewFolderMessages',
      folderId: folder.id,
      handle
    });

    return view;
  },

  viewConversationMessages(convOrId) {
    var handle = this._nextHandle++,
        view = new MessagesListView(this, handle);
    view.conversationId = (typeof(convOrId) === 'string' ? convOrId :
                              convOrId.id);
    this._trackedItemHandles.set(handle, { obj: view });

    this.__bridgeSend({
      type: 'viewConversationMessages',
      conversationId: view.conversationId,
      handle
    });

    return view;
  },

  /**
   * Search a conversations messages for messages matching the provided
   * filter constraints, returning a MessagesListView.
   *
   * @param {Object} spec
   * @param {MailFolder} spec.conversation
   *   The conversation whose messages we should search.
   * @param {Object) spec.filter
   * @param {String} [spec.filter.author]
   *   Match against author display name or email address.
   * @param {String} [spec.filter.recipients]
   *   Match against recipient display name or email addresses.
   * @param {String} [spec.filter.subject]
   *   Match against the message subject.
   * @param {String} [spec.filter.body]
   *   Match against the authored message body.  Quoted blocks will be ignored.
   * @param {String} [spec.filter.bodyAndQuotes]
   *   Match against the authored message body and any included quoted blocks.
   */
  searchConversationMessages(spec) {
    var handle = this._nextHandle++,
        view = new MessagesListView(this, handle);
    view.conversationId = spec.conversation.id;
    this._trackedItemHandles.set(handle, { obj: view });

    this.__bridgeSend({
      type: 'searchConversationMessages',
      handle,
      spec: {
        conversationId: view.conversationId,
        filter: spec.filter
      }
    });

    return view;
  },

  //////////////////////////////////////////////////////////////////////////////
  // Batch Message Mutation
  //
  // If you want to modify a single message, you can use the methods on it
  // directly.
  //
  // All actions are undoable and return an `UndoableOperation`.

  /**
   * Trash the given messages/conversations by moving them to the trash folder.
   * A trash folder will be created if one does not already exist.  If the
   * message is already in the trash folder it will instead be immediately
   * removed.
   *
   * @param {MailMessage[]|MailConversation[]} arrayOfStuff
   *   The messages or conversations to delete.  This should be a homogenous
   *   list, although in the future we could enhance things to support a
   *   mixture.
   * @param {"last"|null} [opts.messageSelector]
   *   Allows filtering the set of affected messages in a conversation when
   *   conversations are provided.  This would be crazy to use for `trash`, but
   *   is mentioned here because if you provide it, we will use it.
   * @return {UndoableOperation}
   *   An undoable operation that roughly describes what was done (to
   *   facilitate describing the thing that can be undone) and a means of
   *   triggering the undo.  Note that while the actual undo() behavior will
   *   attempt to leave things in their original state (rather than inverting
   *   the original request), the characterization of how many
   *   messages/conversations were impacted will not reflect these smarts.
   *
   *   An `undoableOp` event will also be emitted on the base MailAPI instance
   *   if that simplifies your life.
   */
  trash(arrayOfStuff, opts) {
    let { convSelectors, affectedType, affectedCount } =
      this._normalizeConversationSelectorArgs(arrayOfStuff, opts);
    return this._sendUndoableRequest(
      {
        operation: 'trash',
        affectedType,
        affectedCount,
      },
      {
        type: 'trash',
        conversations: convSelectors
      });
  },

  /**
   * Move the given messages/conversations to the desired target folder.  Note
   * that there may be more appropriate semantic options you can take than a
   * direct move.  For example:
   * - use: `trash()` to delete stuff.
   * - future: `archive()` to archive stuff.
   *
   * @param {MailMessage[]|MailConversation[]} arrayOfStuff
   *   The messages or conversations to modify.  This should be a homogenous
   *   list, although in the future we could enhance things to support a
   *   mixture.
   * @param {MailFolder} targetFolder
   *   The folder to move the stuff to.  The folder must belong to the same
   *   account as the stuff.  In the future we may also support an alternate
   *   mechanism where a folder type rather than a specific folder can be
   *   specified, in which case this would work across accounts.  Please feel
   *   free to raise an issue to discuss while also considering whether the
   *   need actually merits a higher level operation.  (Like 'trash' really
   *   does want to be its own high-level thing and not just a re-branded
   *   move operation.)
   * @param {"last"|null} [opts.messageSelector]
   *   Allows filtering the set of affected messages in a conversation when
   *   conversations are provided.
   * @return {UndoableOperation}
   *   An undoable operation that roughly describes what was done (to
   *   facilitate describing the thing that can be undone) and a means of
   *   triggering the undo.  Note that while the actual undo() behavior will
   *   attempt to leave things in their original state (rather than inverting
   *   the original request), the characterization of how many
   *   messages/conversations were impacted will not reflect these smarts.
   *
   *   An `undoableOp` event will also be emitted on the base MailAPI instance
   *   if that simplifies your life.
   */
  move(arrayOfStuff, targetFolder, opts) {
    let { convSelectors, affectedType, affectedCount } =
      this._normalizeConversationSelectorArgs(arrayOfStuff, opts);
    return this._sendUndoableRequest(
      {
        operation: 'move',
        affectedType,
        affectedCount,
      },
      {
        type: 'move',
        conversations: convSelectors,
        targetFolderId: targetFolder.id
      });
  },

  /**
   * Mark the given conversations/messages as read/unread.
   *
   * @param {MailMessage[]|MailConversation[]} arrayOfStuff
   *   The messages or conversations to modify.  This should be a homogenous
   *   list, although in the future we could enhance things to support a
   *   mixture.
   * @param {Boolean} beRead
   *   true to mark stuff read, false to mark stuff unread
   * @param {"last"|null} [opts.messageSelector]
   *   Allows filtering the set of affected messages in a conversation when
   *   conversations are provided.
   * @return {UndoableOperation}
   *   An undoable operation that roughly describes what was done (to
   *   facilitate describing the thing that can be undone) and a means of
   *   triggering the undo.  Note that while the actual undo() behavior will
   *   attempt to leave things in their original state (rather than inverting
   *   the original request), the characterization of how many
   *   messages/conversations were impacted will not reflect these smarts.
   *
   *   An `undoableOp` event will also be emitted on the base MailAPI instance
   *   if that simplifies your life.
   */
  markRead(arrayOfStuff, beRead) {
    return this.modifyTags(
      arrayOfStuff,
      {
        operation: beRead ? 'read' : 'unread',
        addTags: beRead ? ['\\Seen'] : null,
        removeTags: beRead ? null : ['\\Seen']
      }
    );
  },

  /**
   * Star/un-star the given conversations/messages.
   *
   * @param {MailMessage[]|MailConversation[]} arrayOfStuff
   *   The messages or conversations to modify.  This should be a homogenous
   *   list, although in the future we could enhance things to support a
   *   mixture.
   * @param {Boolean} beStarred
   *   true to star the stuff, false to un-star them.
   * @return {UndoableOperation}
   *   An undoable operation that roughly describes what was done (to
   *   facilitate describing the thing that can be undone) and a means of
   *   triggering the undo.  Note that while the actual undo() behavior will
   *   attempt to leave things in their original state (rather than inverting
   *   the original request), the characterization of how many
   *   messages/conversations were impacted will not reflect these smarts.
   *
   *   An `undoableOp` event will also be emitted on the base MailAPI instance
   *   if that simplifies your life.
   */
  markStarred(arrayOfStuff, beStarred) {
    return this.modifyTags(
      arrayOfStuff,
      {
        operation: beStarred ? 'star' : 'unstar',
        addTags: beStarred ? ['\\Flagged'] : null,
        removeTags: beStarred ? null : ['\\Flagged'],
        // If we're starring, we use the same heuristics setStarred used on
        // MailConversation, which is to only star the last one.  This is
        // consistent with what gmail and friends do.  Note that it is our
        // intent that this only applies to the conversation case, and at least
        // for the current implementation (as of writing this), this will not
        // be propagated in the messages case.
        messageSelector: beStarred ? 'last' : null
      }
    );
  },

  /**
   * Add/remove labels on the given conversations/messages.
   *
   * @param {MailMessage[]|MailConversation[]} arrayOfStuff
   *   The messages or conversations to modify.  This should be a homogenous
   *   list, although in the future we could enhance things to support a
   *   mixture.
   * @param {MailFolder[]} [opts.addLabels]
   * @param {MailFolder[]} [opts.removeLabels]
   * @param {"last"|null} [opts.messageSelector]
   *   Allows filtering the set of affected messages in a conversation when
   *   conversations are provided.
   * @return {UndoableOperation}
   *   An undoable operation that roughly describes what was done (to
   *   facilitate describing the thing that can be undone) and a means of
   *   triggering the undo.  Note that while the actual undo() behavior will
   *   attempt to leave things in their original state (rather than inverting
   *   the original request), the characterization of how many
   *   messages/conversations were impacted will not reflect these smarts.
   *
   *   An `undoableOp` event will also be emitted on the base MailAPI instance
   *   if that simplifies your life.
   */
  modifyLabels(arrayOfStuff, opts) {
    let { convSelectors, affectedType, affectedCount } =
      this._normalizeConversationSelectorArgs(arrayOfStuff, opts);
    return this._sendUndoableRequest(
      {
        operation: opts.operation || 'modifylabels',
        affectedType,
        affectedCount,
      },
      {
        type: 'store_labels',
        conversations: convSelectors,
        add: normalizeFoldersToIds(opts.addLabels),
        remove: normalizeFoldersToIds(opts.removeLabels)
      });
  },

  /**
   * Add/remove labels on the given conversations/messages.
   *
   * @param {MailMessage[]|MailConversation[]} arrayOfStuff
   *   The messages or conversations to modify.  This should be a homogenous
   *   list, although in the future we could enhance things to support a
   *   mixture.
   * @param {String[]]} [opts.addTags]
   * @param {String[]} [opts.removeTags]
   * @param {"last"|null} [opts.messageSelector]
   *   Allows filtering the set of affected messages in a conversation when
   *   conversations are provided.
   * @return {UndoableOperation}
   *   An undoable operation that roughly describes what was done (to
   *   facilitate describing the thing that can be undone) and a means of
   *   triggering the undo.  Note that while the actual undo() behavior will
   *   attempt to leave things in their original state (rather than inverting
   *   the original request), the characterization of how many
   *   messages/conversations were impacted will not reflect these smarts.
   *
   *   An `undoableOp` event will also be emitted on the base MailAPI instance
   *   if that simplifies your life.
   */
  modifyTags(arrayOfStuff, opts) {
    let { convSelectors, affectedType, affectedCount } =
      this._normalizeConversationSelectorArgs(arrayOfStuff, opts);
    return this._sendUndoableRequest(
      {
        operation: opts.operation || 'modifytags',
        affectedType,
        affectedCount,
      },
      {
        type: 'store_flags',
        conversations: convSelectors,
        add: opts.addTags,
        remove: opts.removeTags
      });
  },

  /**
   * Enable or disable outbox syncing for this account. This is
   * generally a temporary measure, used when the user is actively
   * editing the list of outbox messages and we don't want to
   * inadvertently move something out from under them. This change
   * does _not_ persist; it's meant to be used only for brief periods
   * of time, not as a "sync schedule" coordinator.
   */
  setOutboxSyncEnabled(account, enabled) {
    return this._sendPromisedRequest({
      type: 'outboxSetPaused',
      accountId: account.id,
      bePaused: !enabled
    }); // (the bridge sends null for the data, which is what gets resolved)
  },

  /**
   * Parse a structured email address
   * into a display name and email address parts.
   * It will return null on a parse failure.
   *
   * @param {String} email A email address.
   * @return {Object} An object of the form { name, address }.
   */
  parseMailbox(email) {
    try {
      var mailbox = addressparser.parse(email);
      return (mailbox.length >= 1) ? mailbox[0] : null;
    }
    catch (ex) {
      return null;
    }
  },

  //////////////////////////////////////////////////////////////////////////////
  // Contact Support

  resolveEmailAddressToPeep(emailAddress, callback) {
    var peep = ContactCache.resolvePeep({ name: null, address: emailAddress });
    if (ContactCache.pendingLookupCount) {
      ContactCache.callbacks.push(callback.bind(null, peep));
    } else {
      callback(peep);
    }
  },

  //////////////////////////////////////////////////////////////////////////////
  // Message Composition

  /**
   * Begin the message composition process, creating a MessageComposition that
   * stores the current message state and periodically persists its state to the
   * backend so that the message is potentially available to other clients and
   * recoverable in the event of a local crash.
   *
   * Composition is triggered in the context of a given message and folder so
   * that the correct account and sender identity for composition can be
   * inferred.  Message may be null if there are no messages in the folder.
   * Folder is not required if a message is provided.
   *
   * @param {MailMessage} message
   * @param {MailFolder} folder
   * @param {Object} options
   * @param {'blank'|'reply'|'forward'} options.command
   * @param {'sender'|'all'} options.mode
   *   The reply mode.  This will eventually indicate the forwarding mode too.
   * @param {Boolean} [options.noComposer=false]
   *   Don't actually want the MessageComposition instance created for you?
   *   Pass true for this.  You can always call resumeMessageComposition
   *   yourself; that's all we do anyways.
   * @return {Promise<MessageComposition>}
   *   A MessageComposition instance populated for use.  You need to call
   *   release on it when you are done.
   */
  beginMessageComposition(message, folder, options) {
    if (!options) {
      options = {};
    }
    return this._sendPromisedRequest({
      type: 'createDraft',
      draftType: options.command,
      mode: options.mode,
      refMessageId: message ? message.id : null,
      refMessageDate: message ? message.date.valueOf() : null,
      folderId: folder ? folder.id : null
    }).then((data) => {
      let namer = { id: data.messageId, date: data.messageDate };
      if (options.noComposer) {
        return namer;
      } else {
        return this.resumeMessageComposition(namer);
      }
    });
  },

  /**
   * Open a message as if it were a draft message (hopefully it is), returning
   * a Promise that will be resolved with a fully valid MessageComposition
   * object.  You will need to call release
   *
   * @param {MailMessage|MessageObjNamer} namer
   */
  resumeMessageComposition(namer) {
    return this.getMessage([namer.id, namer.date.valueOf()]).then((msg) => {
      let composer = new MessageComposition(this);
      return composer.__asyncInitFromMessage(msg);
    });
  },

  _composeAttach(messageId, attachmentDef) {
    this.__bridgeSend({
      type: 'attachBlobToDraft',
      messageId,
      attachmentDef
    });
  },

  _composeDetach(messageId, attachmentRelId) {
    this.__bridgeSend({
      type: 'detachAttachmentFromDraft',
      messageId,
      attachmentRelId
    });
  },

  _composeDone(messageId, command, draftFields) {
    return this._sendPromisedRequest({
      type: 'doneCompose',
      messageId, command, draftFields
    });
  },

  //////////////////////////////////////////////////////////////////////////////
  // mode setting for back end universe. Set interactive
  // if the user has been exposed to the UI and it is a
  // longer lived application, not just a cron sync.
  setInteractive() {
    this.__bridgeSend({
      type: 'setInteractive'
    });
  },

  //////////////////////////////////////////////////////////////////////////////
  // Localization

  /**
   * Provide a list of localized strings for use in message composition.  This
   * should be a dictionary with the following values, with their expected
   * default values for English provided.  Try to avoid being clever and instead
   * just pick the same strings Thunderbird uses for these for the given locale.
   *
   * - wrote: "{{name}} wrote".  Used for the lead-in to the quoted message.
   * - originalMessage: "Original Message".  Gets put between a bunch of dashes
   *    when forwarding a message inline.
   * - forwardHeaderLabels:
   *   - subject
   *   - date
   *   - from
   *   - replyTo (for the "reply-to" header)
   *   - to
   *   - cc
   */
  useLocalizedStrings(strings) {
    this.__bridgeSend({
      type: 'localizedStrings',
      strings: strings
    });
    if (strings.folderNames) {
      this.l10n_folder_names = strings.folderNames;
    }
  },

  /**
   * L10n strings for folder names.  These map folder types to appropriate
   * localized strings.
   *
   * We don't remap unknown types, so this doesn't need defaults.
   */
  l10n_folder_names: {},

  l10n_folder_name(name, type) {
    // eslint-disable-next-line no-prototype-builtins
    if (this.l10n_folder_names.hasOwnProperty(type)) {
      var lowerName = name.toLowerCase();
      // Many of the names are the same as the type, but not all.
      if ((type === lowerName) ||
          (type === 'drafts') ||
          (type === 'junk') ||
          (type === 'queue')) {
        return this.l10n_folder_names[type];
      }
    }
    return name;
  },


  //////////////////////////////////////////////////////////////////////////////
  // Configuration

  /**
   * Change one-or-more backend-wide settings; use `MailAccount.modifyAccount`
   * to chang per-account settings.
   */
  modifyConfig(mods) {
    for (var key in mods) {
      if (LEGAL_CONFIG_KEYS.indexOf(key) === -1) {
        throw new Error(key + ' is not a legal config key!');
      }
    }
    return this._sendPromisedRequest({
      type: 'modifyConfig',
      mods
    }).then(() => null);
  },

  _recv_config(msg) {
    this.config = msg.config;
  },

  //////////////////////////////////////////////////////////////////////////////
  // Diagnostics / Test Hacks

  /**
   * After a zero timeout, send a 'ping' to the bridge which will send a
   * 'pong' back, notifying the provided callback.  This is intended to be hack
   * to provide a way to ensure that some function only runs after all of the
   * notifications have been received and processed by the back-end.
   *
   * Note that ping messages are always processed as they are received; they do
   * not get deferred like other messages.
   */
  ping(callback) {
    var handle = this._nextHandle++;
    this._pendingRequests[handle] = {
      type: 'ping',
      callback: callback,
    };

    // With the introduction of slice batching, we now wait to send the ping.
    // This is reasonable because there are conceivable situations where the
    // caller really wants to wait until all related callbacks fire before
    // dispatching.  And the ping method is already a hack to ensure correctness
    // ordering that should be done using better/more specific methods, so this
    // change is not any less of a hack/evil, although it does cause misuse to
    // potentially be more capable of causing intermittent failures.
    globalThis.setTimeout(() => {
      this.__bridgeSend({
        type: 'ping',
        handle: handle,
      });
    }, 0);
  },

  _recv_pong(msg) {
    var req = this._pendingRequests[msg.handle];
    delete this._pendingRequests[msg.handle];
    req.callback();
  },

  /**
   * Legacy means of setting the debug logging level.  Probably wants to go away
   * in favor of just using modifyConfig directly.  Other debugging-y stuff
   * probably will operate similarly or get its own explicit API calls.
   */
  debugSupport(command, argument) {
    if (command === 'setLogging') {
      this.config.debugLogging = argument;
      return this.modifyConfig({
        debugLogging: argument
      });
    } else if (command === 'dumpLog') {
      throw new Error('XXX circular logging currently not implemented');
    }
    throw new Error(`unsupported debug command: ${command}`);
  },

  /**
   * Clear the set of new messages associated with the given account.  Also
   * exposed on MailAccount as clearNewTracking.
   */
  clearNewTrackingForAccount({ account, accountId, silent }) {
    if (account && !accountId) {
      accountId = account.id;
    }
    this.__bridgeSend({
      type: 'clearNewTrackingForAccount',
      accountId,
      silent
    });
  },

  /**
   * Cause the 'newMessagesUpdate' message to be re-derived and re-broadcast.
   * This should only be used in exceptional circumstances because the whole
   * implementation of this assumes that persistent notifications are generated
   * by the broadcast.  Since the message will also automatically be sent when
   * the set of new messages changes, if you are calling this, you are by
   * definition asking for redundant data you should already have heard about.
   * I would prefix this with `debug` but it's possible there's a reason to
   * expose this that's not horrible.
   */
  flushNewAggregates() {
    this.__bridgeSend({
      type: 'flushNewAggregates'
    });
  },

  /**
   * Compel the backend to act like it received a cronsync.
   *
   * @param {AccountId[]} [arg.accountIds]
   *   The list of account ids to act like we are being told to sync.  If
   *   omitted, the list of all accounts is used.
   * @param {AccountId[]} [arg.notificationAccountIds]
   *   The list of account ids to act like we have outstanding notifications for
   *   (so as to not trigger a new_tracking status clearing).  If omitted, the
   *   list of all accounts is used.
   */
  debugForceCronSync({ accountIds, notificationAccountIds }) {
    let allAccountIds = this.accounts.items.map(account => account.id);

    if (!accountIds) {
      accountIds = allAccountIds;
    }
    if (!notificationAccountIds) {
      notificationAccountIds = allAccountIds;
    }
    this.__bridgeSend({
      type: 'debugForceCronSync',
      accountIds,
      notificationAccountIds
    });
  },

  /**
   * Retrieve the persisted-to-disk log entries we create for things like
   * cronsync.
   *
   * @return {Promise<Object[]>}
   */
  getPersistedLogs() {
    return this._sendPromisedRequest({
      type: 'getPersistedLogs'
    });
  }

  //////////////////////////////////////////////////////////////////////////////
});

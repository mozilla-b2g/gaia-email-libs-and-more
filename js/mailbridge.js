define(function(require) {
'use strict';

let co = require('co');

let logic = require('logic');
let $mailchewStrings = require('./bodies/mailchew_strings');

let BridgeContext = require('./bridge/bridge_context');
let BatchManager = require('./bridge/batch_manager');

let EntireListProxy = require('./bridge/entire_list_proxy');
let WindowedListProxy = require('./bridge/windowed_list_proxy');

/**
 * There is exactly one `MailBridge` instance for each `MailAPI` instance.
 * `same-frame-setup.js` is the only place that hooks them up together right
 * now.
 */
function MailBridge(universe, db, name) {
  logic.defineScope(this, 'MailBridge', { name: name });
  this.name = name;
  this.universe = universe;
  this.universe.registerBridge(this);
  this.db = db;

  this.batchManager = new BatchManager(db);
  this.bridgeContext = new BridgeContext(this, this.batchManager);
  this._pendingMessagesByHandle;

  // outstanding persistent objects that aren't slices. covers: composition
  this._pendingRequests = {};
  //
  this._lastUndoableOpPair = null;
}
MailBridge.prototype = {
  __sendMessage: function(msg) {
    throw new Error('This is supposed to get hidden by an instance var.');
  },

  /**
   * Synchronously process incoming messages; the processing may be async.
   *
   * TODO: be clever about serializing commands on a per-handle basis so that
   * we can maintain a logical ordering of data-dependent commands but not have
   * long-running commands interfering with orthogonal things.  For instance,
   * we should not process seek() commands for a list view until the command
   * creating the list view has been fully processed.
   */
  __receiveMessage: function mb___receiveMessage(msg) {
    var implCmdName = '_cmd_' + msg.type;
    if (!(implCmdName in this)) {
      logic(this, 'badMessageType', { type: msg.type });
      return;
    }
    let namedContext = msg.handle &&
                       this.bridgeContext.maybeGetNamedContext(msg.handle);
    if (namedContext) {
      if (namedContext.pendingCommand) {
        console.warn('deferring', msg);
        namedContext.commandQueue.push(msg);
      } else {
        let promise = namedContext.pendingCommand =
          this._processCommand(msg, implCmdName);
        if (promise) {
          this._trackCommandForNamedContext(namedContext, promise);
        }
      }
    } else {
      let promise = this._processCommand(msg, implCmdName);
      // If the command went async, then it's also possible that the command
      // grew a namedContext and that we therefore need to get it and set up the
      // bookkeeping so that if any other commands come in on this handle before
      // the promise is resolved that we can properly queue them.
      if (promise && msg.handle) {
        namedContext = this.bridgeContext.maybeGetNamedContext(msg.handle);
        if (namedContext) {
          namedContext.pendingCommand = promise;
          this._trackCommandForNamedContext(namedContext, promise);
        }
      }
    }
  },

  _trackCommandForNamedContext: function(namedContext, promise) {
    let runNext = () => {
      this._commandCompletedProcessNextCommandInQueue(namedContext);
    };
    promise.then(runNext, runNext);
  },

  /**
   * Whenever
   */
  _commandCompletedProcessNextCommandInQueue: function(namedContext) {
    if (namedContext.commandQueue.length) {
      console.warn('processing deferred command');
      let promise = namedContext.pendingCommand =
        this._processCommand(namedContext.commandQueue.shift());
      if (promise) {
        let runNext = () => {
          this._commandCompletedProcessNextCommandInQueue(namedContext);
        };
        promise.then(runNext, runNext);
      }
    } else {
      namedContext.pendingCommand = null;
    }
  },

  /**
   *
   * @param {Object} msg
   * @param {String} [implCmdName]
   *   The command name optionally already derived from the message.  Optional
   *   because in some cases the string may already have been created for
   *   fast-fail purposes and still available.  In async cases we may not have
   *   it anymore because it's not worth the hassle to cart it around.
   */
  _processCommand: function(msg, implCmdName) {
    if (!implCmdName) {
      implCmdName = '_cmd_' + msg.type;
    }
    logic(this, 'cmd', {
      type: msg.type,
      msg: msg
    });
    try {
      let result = this[implCmdName](msg);
      if (result && result.then) {
        logic.await(this, 'asyncCommand', { type: msg.type }, result);
        return result;
      }
    } catch(ex) {
      console.error('problem processing', implCmdName, ex, ex.stack);
      logic.fail(ex);
      return null; // note that we did not throw
    }
    return null;
  },

  _cmd_ping: function mb__cmd_ping(msg) {
    this.__sendMessage({
      type: 'pong',
      handle: msg.handle,
    });
  },

  _cmd_modifyConfig: function mb__cmd_modifyConfig(msg) {
    this.universe.modifyConfig(msg.mods);
  },

  notifyConfig: function(config) {
    this.__sendMessage({
      type: 'config',
      config: config,
    });
  },

  _cmd_debugSupport: function mb__cmd_debugSupport(msg) {
    switch (msg.cmd) {
      case 'setLogging':
        this.universe.modifyConfig({ debugLogging: msg.arg });
        break;

      case 'dumpLog':
        switch (msg.arg) {
          case 'storage':
            this.universe.dumpLogToDeviceStorage();
            break;
        }
        break;
    }
  },

  _cmd_setInteractive: function mb__cmd_setInteractive(msg) {
    this.universe.setInteractive();
  },

  _cmd_localizedStrings: function mb__cmd_localizedStrings(msg) {
    $mailchewStrings.set(msg.strings);
  },

  _cmd_learnAboutAccount: function(msg) {
    this.universe.learnAboutAccount(msg.details).then(
      function success(info) {
        this.__sendMessage({
            type: 'learnAboutAccountResults',
            handle: msg.handle,
            data: info
          });
      }.bind(this),
      function errback(/*err*/) {
        this.__sendMessage({
            type: 'learnAboutAccountResults',
            handle: msg.handle,
            data: { result: 'no-config-info', configInfo: null }
          });
      }.bind(this));
  },

  _cmd_tryToCreateAccount: function mb__cmd_tryToCreateAccount(msg) {
    this.universe.tryToCreateAccount(msg.details, msg.domainInfo)
      .then((result) => {
        this.__sendMessage({
          type: 'tryToCreateAccountResults',
          handle: msg.handle,
          account: result.accountWireRep || null,
          error: result.error,
          errorDetails: result.errorDetails,
        });
      });
  },

  _cmd_syncFolderList: function(msg) {
    this.universe.syncFolderList(msg.accountId, 'bridge');
  },

  _cmd_clearAccountProblems: function mb__cmd_clearAccountProblems(msg) {
    var account = this.universe.getAccountForAccountId(msg.accountId),
        self = this;
    account.checkAccount(function(incomingErr, outgoingErr) {
      // Note that ActiveSync accounts won't have an outgoingError,
      // but that's fine. It just means that outgoing never errors!
      let canIgnoreError = function(err) {
        // If we succeeded or the problem was not an authentication,
        // assume everything went fine. This includes the case we're
        // offline.
        return (!err || (
          err !== 'bad-user-or-pass' &&
          err !== 'bad-address' &&
          err !== 'needs-oauth-reauth' &&
          err !== 'imap-disabled'
        ));
      };
      if (canIgnoreError(incomingErr) && canIgnoreError(outgoingErr)) {
        self.universe.clearAccountProblems(account);
      }
      self.__sendMessage({
        type: 'clearAccountProblems',
        handle: msg.handle,
      });
    });
  },

  _cmd_modifyAccount: function mb__cmd_modifyAccount(msg) {
    // TODO: implement; existing logic has been moved to tasks/modify_account.js
  },

  _cmd_deleteAccount: function mb__cmd_deleteAccount(msg) {
    this.universe.deleteAccount(msg.accountId, 'bridge');
  },

  _cmd_modifyIdentity: function mb__cmd_modifyIdentity(msg) {
    // TODO: implement; existing logic moved to tasks/modify_identity.js
  },

  /**
   * Notify the frontend that login failed.
   *
   * @param account
   * @param {string} problem
   * @param {'incoming'|'outgoing'} whichSide
   */
  notifyBadLogin: function mb_notifyBadLogin(account, problem, whichSide) {
    this.__sendMessage({
      type: 'badLogin',
      account: account.toBridgeWire(),
      problem: problem,
      whichSide: whichSide,
    });
  },

  _cmd_requestBodies: function(msg) {
    var self = this;
    this.universe.downloadBodies(msg.messages, msg.options, function() {
      self.__sendMessage({
        type: 'requestBodiesComplete',
        handle: msg.handle,
        requestId: msg.requestId
      });
    });
  },

  _cmd_viewAccounts: co.wrap(function*(msg) {
    let ctx = this.bridgeContext.createNamedContext(msg.handle, 'AccountsView');

    ctx.proxy = new EntireListProxy(this.universe.accountsTOC, ctx);
    yield ctx.acquire(ctx.proxy);
    ctx.proxy.populateFromList();
  }),

  _cmd_viewFolders: co.wrap(function*(msg) {
    let ctx = this.bridgeContext.createNamedContext(msg.handle, 'FoldersView');

    let toc = yield this.universe.acquireAccountFoldersTOC(ctx, msg.accountId);

    ctx.proxy = new EntireListProxy(toc, ctx);
    yield ctx.acquire(ctx.proxy);
    ctx.proxy.populateFromList();
  }),

  _cmd_viewFolderConversations: co.wrap(function*(msg) {
    let ctx = this.bridgeContext.createNamedContext(msg.handle,
                                                    'FolderConversationsView');
    ctx.viewing = {
      type: 'folder',
      folderId: msg.folderId
    };
    let toc = yield this.universe.acquireFolderConversationsTOC(ctx,
                                                                msg.folderId);
    ctx.proxy = new WindowedListProxy(toc, ctx);
    yield ctx.acquire(ctx.proxy);
    this.universe.syncRefreshFolder(msg.folderId, 'viewFolderConversations');
  }),

  _cmd_viewConversationMessages: co.wrap(function*(msg) {
    let ctx = this.bridgeContext.createNamedContext(msg.handle,
                                                    'ConversationMessagesView');
    ctx.viewing = {
      type: 'conversation',
      conversationId: msg.conversationId
    };
    let toc = yield this.universe.acquireConversationTOC(ctx,
                                                         msg.conversationId);
    ctx.proxy = new WindowedListProxy(toc, ctx);
    yield ctx.acquire(ctx.proxy);
  }),

  _cmd_refreshView: function(msg) {
    let ctx = this.bridgeContext.getNamedContextOrThrow(msg.handle);
    if (ctx.viewing.type === 'folder') {
      this.universe.syncRefreshFolder(ctx.viewing.folderId, 'refreshView');
    } else {
      // TODO: only for gmail is generic refreshing sufficient to refresh a
      // conversation in its entirety.  (Noting that this is tricky conceptually
      // anyways; probably what the user wants is to find some other message in
      // the conversation, which means trawling for new messages and triggering
      // backfilling, which is also trawling for new messages if we managed
      // to comprehensively backfill.)
      this.universe.syncRefreshFolder(null, 'refreshView');
    }
  },

  _cmd_growView: function(msg) {
    let ctx = this.bridgeContext.getNamedContextOrThrow(msg.handle);
    if (ctx.viewing.type === 'folder') {
      this.universe.syncGrowFolder(ctx.viewing.folderId, 'growView');
    } else {
      // TODO: growing for conversations is nonsensical under gmail, but has
      // clear backfilling ramifications for other account types
    }
  },

  _cmd_seekProxy: function(msg) {
    let ctx = this.bridgeContext.getNamedContextOrThrow(msg.handle);
    ctx.proxy.seek(msg);
  },

  _cmd_getItemAndTrackUpdates: co.wrap(function*(msg) {
    // XXX implement priority tags support

    // - Fetch the raw data from disk
    let requests = {};
    let idRequestMap = new Map();
    idRequestMap.set(msg.itemId, null);
    // Helper to normalize raw database reps to wire reps.  This matters for
    // things like account info structures.
    let rawToWireRep, eventArgsToRaw;
    // the normalized id of what we're tracking.  (exists because we pass
    // the [messageId, date] tuple for 'msg', which maybe we should pass as a
    // separate arg instead...
    let normId;
    // readKey is the key in the results of the read where our result map is.
    // messages is again special, since the results are keyed by id despite the
    // requests being keyed by the tuple.  (Otherwise reads all reuse their
    // request map anyways.)
    let readKey;
    switch (msg.itemType) {
      case 'conv':
        normId = msg.itemId;
        requests.conversations = idRequestMap;
        readKey = 'conversations';
        // no transformation is performed on conversation reps
        rawToWireRep = (x => x);
        // The change idiom is currently somewhat one-off; we may be able to
        // just fold this into the eventHandler once things stabilize.
        eventArgsToRaw = ((id, convInfo) => { return convInfo; });
        break;
      case 'msg':
        normId = msg.itemId[0];
        requests.messages = idRequestMap;
        readKey = 'messages';
        rawToWireRep = (x => x);
        eventArgsToRaw = ((id, messageInfo) => { return messageInfo; });
        break;
      default:
        throw new Error('unsupported item type: ' + msg.itemType);
    }
    let eventId = msg.itemType + '!' + normId + '!change';
    let ctx = this.bridgeContext.createNamedContext(msg.handle, eventId);

    let fromDb = yield this.db.read(ctx, requests);

    // Normalize to wire rep form
    let dbWireRep = rawToWireRep(fromDb[readKey].get(normId));

    // - Register an event listener that will be removed at context cleanup
    // (We only do this after we have loaded the up-to-date rep.  Note that
    // under the current DB implementation there is a potential short-lived
    // race here that will be addressed to support this idiom correctly.)
    let eventHandler = (arg1, arg2) => {
      let rep = eventArgsToRaw(arg1, arg2);
      if (rep) {
        rep = rawToWireRep(rep);
      }
      ctx.sendMessage('update', rep);
    };
    this.db.on(eventId, eventHandler);
    ctx.runAtCleanup(() => {
      this.db.removeListener(eventId, eventHandler);
    });

    // - Send the wire rep
    ctx.sendMessage('gotItemNowTrackingUpdates', dbWireRep);
  }),

  _cmd_updateTrackedItemPriorityTags: function(msg) {
    // XXX implement priority tags support
  },

  _cmd_cleanupContext: function(msg) {
    this.bridgeContext.cleanupNamedContext(msg.handle);

    this.__sendMessage({
      type: 'contextCleanedUp',
      handle: msg.handle,
    });
  },

  _cmd_fetchSnippets: function(msg) {
    if (msg.convIds) {
      this.universe.fetchConversationSnippets(msg.convIds, 'bridge');
    }
  },

  _cmd_downloadBodyReps: function(msg) {
    this.universe.fetchMessageBody(msg.id, msg.date, 'bridge');
  },

  _cmd_downloadAttachments: function mb__cmd__downloadAttachments(msg) {
    // XXX OLD
    var self = this;
    this.universe.downloadMessageAttachments(
      msg.suid, msg.date, msg.relPartIndices, msg.attachmentIndices,
      msg.registerAttachments,
      function(err) {
        self.__sendMessage({
          type: 'downloadedAttachments',
          handle: msg.handle
        });
      });
  },

  //////////////////////////////////////////////////////////////////////////////
  // Message Mutation
  //
  // All mutations are told to the universe which breaks the modifications up on
  // a per-account basis.

  _cmd_store_labels: function(msg) {
    for (let convInfo of msg.conversations) {
      this.universe.storeLabels(
        convInfo.id,
        convInfo.messageIds,
        convInfo.messageSelector,
        msg.add,
        msg.remove
      );
    }
  },

  _cmd_store_flags: function(msg) {
    for (let convInfo of msg.conversations) {
      this.universe.storeFlags(
        convInfo.id,
        convInfo.messageIds,
        convInfo.messageSelector,
        msg.add,
        msg.remove
      );
    }
  },

  _cmd_outboxSetPaused: function(msg) {
    this.universe.outboxSetPaused(
      accountId,
      msg.bePaused
    ).then(() => {
      this.__sendMessage({
        type: 'promisedResult',
        handle: msg.handle
      });
    });
  },

  _cmd_undo: function mb__cmd_undo(msg) {
    // XXX OLD
    this.universe.undoMutation(msg.longtermIds);
  },

  //////////////////////////////////////////////////////////////////////////////
  // Composition

  _cmd_createDraft: function(msg) {
    this.universe.createDraft({
      draftType: msg.draftType,
      mode: msg.mode,
      refMessageId: msg.refMessageId,
      refMessageDate: msg.refMessageDate,
      folderId: msg.folderId
    }).then(({ messageId, messageDate }) => {
      this.__sendMessage({
        type: 'promisedResult',
        handle: msg.handle,
        messageId,
        messageDate
      });
    });
  },

  _cmd_attachBlobToDraft: function(msg) {
    this.universe.attachBlobToDraft(
      msg.messageId,
      msg.attachmentDef
    );
  },

  _cmd_detachAttachmentFromDraft: function(msg) {
    this.universe.detachAttachmentFromDraft(
      msg.messageId,
      msg.attachmentRelId
    );
  },

  /**
   * Save a draft, delete a draft, or try and send a message.
   *
   * Drafts are saved in our IndexedDB storage. This is notable because we are
   * told about attachments via their Blobs.
   */
  _cmd_doneCompose: function(msg) {
    // Delete and be done if delete.
    if (msg.command === 'delete') {
      this.universe.deleteDraft(msg.messageId);
      return;
    }

    // We must be 'save' or 'send', so we want to save.
    this.universe.saveDraft(msg.messageId, msg.draftFields);
    // Actually send if send.
    if (msg.command === 'send') {
      this.universe.outboxSendDraft(msg.messageId);
    }
  },

  notifyCronSyncStart: function mb_notifyCronSyncStart(accountIds) {
    this.__sendMessage({
      type: 'cronSyncStart',
      accountIds: accountIds
    });
  },

  notifyCronSyncStop: function mb_notifyCronSyncStop(accountsResults) {
    this.__sendMessage({
      type: 'cronSyncStop',
      accountsResults: accountsResults
    });
  },

  /**
   * Notify the frontend about the status of message sends. Data has
   * keys like 'state', 'error', etc, per the sendOutboxMessages job.
   */
  notifyBackgroundSendStatus: function(data) {
    this.__sendMessage({
      type: 'backgroundSendStatus',
      data: data
    });
  }

};

return MailBridge;
}); // end define

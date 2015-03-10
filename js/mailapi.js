define(function(require, exports, module) {
'use strict';

// Use a relative link so that consumers do not need to create
// special config to use main-frame-setup.
var addressparser = require('./ext/addressparser');
var evt = require('evt');

var MailAccount = require('./clientapi/mail_account');
var MailSenderIdentity = require('./clientapi/mail_sender_identity');
var MailFolder = require('./clientapi/mail_folder');
var ContactCache = require('./clientapi/contact_cache');
var UndoableOperation = require('./clientapi/undoable_operation');
var MailHeader = require('./clientapi/mail_header');
var MailMatchedHeader = require('./clientapi/mail_matched_header');

var BridgedViewSlice = require('./clientapi/bridged_view_slice');
var AccountsViewSlice = require('./clientapi/accounts_view_slice');
var FoldersViewSlice = require('./clientapi/folders_view_slice');
var HeadersViewSlice = require('./clientapi/headers_view_slice');

var MessageComposition = require('./clientapi/message_composition');

var Linkify = require('./linkify');

function objCopy(obj) {
  var copy = {};
  Object.keys(obj).forEach(function (key) {
    copy[key] = obj[key];
  });
  return copy;
}

/**
 * The number of header wire messages to cache in the recvCache
 */
var HEADER_CACHE_LIMIT = 8;

// For testing
exports._MailFolder = MailFolder;



var LEGAL_CONFIG_KEYS = [];

/**
 * Error reporting helper; we will probably eventually want different behaviours
 * under development, under unit test, when in use by QA, advanced users, and
 * normal users, respectively.  By funneling all errors through one spot, we
 * help reduce inadvertent breakage later on.
 */
function reportError() {
  console.error.apply(console, arguments);
  var msg = null;
  for (var i = 0; i < arguments.length; i++) {
    if (msg)
      msg += " " + arguments[i];
    else
      msg = "" + arguments[i];
  }
  throw new Error(msg);
}
var unexpectedBridgeDataError = reportError,
    internalError = reportError,
    reportClientCodeError = reportError;


/**
 * The public API exposed to the client via the MailAPI global.
 */
function MailAPI() {
  evt.Emitter.call(this);
  this._nextHandle = 1;

  this._slices = {};
  this._pendingRequests = {};
  this._liveBodies = {};
  /**
   * Functions to invoke to actually process/fire splices.  Exists to support
   * the fallout of waiting for contact resolution now that slice changes are
   * batched.
   */
  this._spliceFireFuncs = [];

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
exports.MailAPI = MailAPI;
MailAPI.prototype = evt.mix({
  toString: function() {
    return '[MailAPI]';
  },
  toJSON: function() {
    return { type: 'MailAPI' };
  },

  // This exposure as "utils" exists for legacy reasons right now, we should
  // probably just move consumers to directly require the module.
  utils: Linkify,

  /**
   * Send a message over/to the bridge.  The idea is that we (can) communicate
   * with the backend using only a postMessage-style JSON channel.
   */
  __bridgeSend: function(msg) {
    // This method gets clobbered eventually once back end worker is ready.
    // Until then, it will store calls to send to the back end.

    this._storedSends.push(msg);
  },

  /**
   * Process a message received from the bridge.
   */
  __bridgeReceive: function ma___bridgeReceive(msg) {
    // Pong messages are used for tests
    if (this._processingMessage && msg.type !== 'pong') {
      this._deferredMessages.push(msg);
    }
    else {
      this._processMessage(msg);
    }
  },

  _processMessage: function ma__processMessage(msg) {
    var methodName = '_recv_' + msg.type;
    if (!(methodName in this)) {
      unexpectedBridgeDataError('Unsupported message type:', msg.type);
      return;
    }
    try {
      var done = this[methodName](msg);
      if (!done) {
        this._processingMessage = msg;
      }
    }
    catch (ex) {
      internalError('Problem handling message type:', msg.type, ex,
                    '\n', ex.stack);
      return;
    }
  },

  _doneProcessingMessage: function(msg) {
    if (this._processingMessage && this._processingMessage !== msg)
      throw new Error('Mismatched message completion!');

    this._processingMessage = null;
    while (this._processingMessage === null && this._deferredMessages.length) {
      this._processMessage(this._deferredMessages.shift());
    }
  },

  _recv_badLogin: function ma__recv_badLogin(msg) {
    this.emit('badlogin',
              new MailAccount(this, msg.account, null),
              msg.problem,
              msg.whichSide);
    return true;
  },

  _fireAllSplices: function() {
    for (var i = 0; i < this._spliceFireFuncs.length; i++) {
      var fireSpliceData = this._spliceFireFuncs[i];
      fireSpliceData();
    }

    this._spliceFireFuncs.length = 0;
  },

  _recv_batchSlice: function receiveBatchSlice(msg) {
    var slice = this._slices[msg.handle];
    if (!slice) {
      unexpectedBridgeDataError("Received message about nonexistent slice:", msg.handle);
      return true;
    }

    var updateStatus = this._updateSliceStatus(msg, slice);
    for (var i = 0; i < msg.sliceUpdates.length; i++) {
      var update = msg.sliceUpdates[i];
      if (update.type === 'update') {
        // Updates are identified by their index position, so they need to be
        // processed in the same order we're hearing about them.
        this._spliceFireFuncs.push(
          this._processSliceUpdate.bind(this, msg, update.updates, slice));
      } else {
        // Added items are transformed immediately, but the actual mutation of
        // the slice and notifications do not fire until _fireAllSplices().
        this._transformAndEnqueueSingleSplice(msg, update, slice);
      }
    }

    // If there are pending contact resolutions, we need to wait them to
    // complete before processing and firing the splices.
    if (ContactCache.pendingLookupCount) {
      ContactCache.callbacks.push(function contactsResolved() {
        this._fireAllSplices();
        this._fireStatusNotifications(updateStatus, slice);
        this._doneProcessingMessage(msg);
      }.bind(this));
      // (Wait for us to call _doneProcessingMessage before processing the next
      // message.  This also means this method will only push one callback.)
      return false;
    }

    this._fireAllSplices();
    this._fireStatusNotifications(updateStatus, slice);
    return true; // All done processing; feel free to process the next msg.
  },

  _fireStatusNotifications: function (updateStatus, slice) {
    if (updateStatus) {
      slice.emit('status', slice.status);
    }
  },

  _updateSliceStatus: function(msg, slice) {
    // - generate namespace-specific notifications
    slice.atTop = msg.atTop;
    slice.atBottom = msg.atBottom;
    slice.userCanGrowUpwards = msg.userCanGrowUpwards;
    slice.userCanGrowDownwards = msg.userCanGrowDownwards;

    // Have to update slice status before we actually do the work
    var generatedStatusChange = (msg.status &&
      (slice.status !== msg.status ||
      slice.syncProgress !== msg.progress));

    if (msg.status) {
      slice.status = msg.status;
      slice.syncProgress = msg.syncProgress;
    }

    return generatedStatusChange;
  },

  _processSliceUpdate: function (msg, splice, slice) {
    try {
      for (var i = 0; i < splice.length; i += 2) {
        var idx = splice[i], wireRep = splice[i + 1],
            itemObj = slice.items[idx];
        itemObj.__update(wireRep);
        slice.emit('change', itemObj, idx);
        itemObj.emit('change', itemObj, idx);
      }
    }
    catch (ex) {
      reportClientCodeError('onchange notification error', ex,
                            '\n', ex.stack);
    }
  },

  /**
   * Transform the slice splice (for contact-resolution side-effects) and
   * enqueue the eventual processing and firing of the splice once all contacts
   * have been resolved.
   */
  _transformAndEnqueueSingleSplice: function(msg, splice, slice) {
   var transformedItems = this._transform_sliceSplice(splice, slice);
   var fake = false;
    // It's possible that a transformed representation is depending on an async
    // call to mozContacts.  In this case, we don't want to surface the data to
    // the UI until the contacts are fully resolved in order to avoid the UI
    // flickering or just triggering reflows that could otherwise be avoided.
    // Since we could be processing multiple updates, just batch everything here
    // and we'll check later to see if any of our splices requires a contact
    // lookup
    this._spliceFireFuncs.push(function singleSpliceUpdate() {
      this._fireSplice(splice, slice, transformedItems, fake);
    }.bind(this));
  },

  /**
   * Perform the actual splice, generating notifications.
   */
  _fireSplice: function(splice, slice, transformedItems, fake) {
    var i, stopIndex, items, tempMsg;

    // - update header count, but only if the splice tracks a
    // headerCount.
    if (splice.headerCount !== undefined) {
      slice.headerCount = splice.headerCount;
    }

    // - generate slice 'onsplice' notification
    slice.emit('splice', splice.index, splice.howMany, transformedItems,
               splice.requested, splice.moreExpected, fake);

    // - generate item 'onremove' notifications
    if (splice.howMany) {
      stopIndex = splice.index + splice.howMany;
      for (i = splice.index; i < stopIndex; i++) {
        var item = slice.items[i];
        slice.emit('remove', item, i);
        item.emit('remove', item, i);
        // the item needs a chance to clean up after itself.
        item.__die();
      }
    }
    // - perform actual splice
    slice.items.splice.apply(
      slice.items,
      [splice.index, splice.howMany].concat(transformedItems));

    // - generate item 'onadd' notifications
    stopIndex = splice.index + transformedItems.length;
    for (i = splice.index; i < stopIndex; i++) {
      slice.emit('add', slice.items[i], i);
    }

    // - generate 'oncomplete' notification
    if (splice.requested && !splice.moreExpected) {
      slice._growing = 0;
      if (slice.pendingRequestCount)
        slice.pendingRequestCount--;

      slice.emit('complete', splice.newEmailCount);
    }
  },

  _transform_sliceSplice: function ma__transform_sliceSplice(splice, slice) {
    var addItems = splice.addItems, transformedItems = [], i;
    switch (slice._ns) {
      case 'accounts':
        for (i = 0; i < addItems.length; i++) {
          transformedItems.push(new MailAccount(this, addItems[i], slice));
        }
        break;

      case 'identities':
        for (i = 0; i < addItems.length; i++) {
          transformedItems.push(new MailSenderIdentity(this, addItems[i]));
        }
        break;

      case 'folders':
        for (i = 0; i < addItems.length; i++) {
          transformedItems.push(new MailFolder(this, addItems[i]));
        }
        break;

      case 'headers':
        for (i = 0; i < addItems.length; i++) {
          transformedItems.push(new MailHeader(slice, addItems[i]));
        }
        break;

      case 'matchedHeaders':
        for (i = 0; i < addItems.length; i++) {
          transformedItems.push(new MailMatchedHeader(slice, addItems[i]));
        }
        break;


      default:
        console.error('Slice notification for unknown type:', slice._ns);
        break;
    }

    return transformedItems;
  },

  _recv_sliceDead: function(msg) {
    var slice = this._slices[msg.handle];
    delete this._slices[msg.handle];
    slice.emit('dead', slice);

    return true;
  },

  _getBodyForMessage: function(header, options, callback) {
    var downloadBodyReps = false, withBodyReps = false;

    if (options && options.downloadBodyReps) {
      downloadBodyReps = options.downloadBodyReps;
    }
    if (options && options.withBodyReps) {
      withBodyReps = options.withBodyReps;
    }

    var handle = this._nextHandle++;
    this._pendingRequests[handle] = {
      type: 'getBody',
      suid: header.id,
      callback: callback
    };
    this.__bridgeSend({
      type: 'getBody',
      handle: handle,
      suid: header.id,
      date: header.date.valueOf(),
      downloadBodyReps: downloadBodyReps,
      withBodyReps: withBodyReps
    });
  },

  _recv_gotBody: function(msg) {
    var req = this._pendingRequests[msg.handle];
    if (!req) {
      unexpectedBridgeDataError('Bad handle for got body:', msg.handle);
      return true;
    }
    delete this._pendingRequests[msg.handle];

    var body = msg.bodyInfo ?
      new MailBody(this, req.suid, msg.bodyInfo, msg.handle) :
      null;

    if (body) {
      this._liveBodies[msg.handle] = body;
    }

    req.callback.call(null, body, req.suid);

    return true;
  },

  _recv_requestBodiesComplete: function(msg) {
    var slice = this._slices[msg.handle];
    // The slice may be dead now!
    if (slice)
      slice._notifyRequestBodiesComplete(msg.requestId);

    return true;
  },

  _recv_bodyModified: function(msg) {
    var body = this._liveBodies[msg.handle];

    if (!body) {
      unexpectedBridgeDataError('body modified for dead handle', msg.handle);
      // possible but very unlikely race condition where body is modified while
      // we are removing the reference to the observer...
      return true;
    }

    var wireRep = msg.bodyInfo;
    // We update the body representation regardless of whether there is an
    // onchange listener because the body may contain Blob handles that need to
    // be updated so that in-memory blobs that have been superseded by on-disk
    // Blobs can be garbage collected.
    body.__update(wireRep, msg.detail);

    body.emit('change', msg.detail, body);

    return true;
  },

  _recv_bodyDead: function(msg) {
    var body = this._liveBodies[msg.handle];

    if (body) {
      body.emit('dead');
    }

    delete this._liveBodies[msg.handle];
    return true;
  },

  _downloadAttachments: function(body, relPartIndices, attachmentIndices,
                                 callWhenDone, callOnProgress) {
    var handle = this._nextHandle++;
    this._pendingRequests[handle] = {
      type: 'downloadAttachments',
      body: body,
      relParts: relPartIndices.length > 0,
      attachments: attachmentIndices.length > 0,
      callback: callWhenDone,
      progress: callOnProgress
    };
    this.__bridgeSend({
      type: 'downloadAttachments',
      handle: handle,
      suid: body.id,
      date: body._date,
      relPartIndices: relPartIndices,
      attachmentIndices: attachmentIndices
    });
  },

  _recv_downloadedAttachments: function(msg) {
    var req = this._pendingRequests[msg.handle];
    if (!req) {
      unexpectedBridgeDataError('Bad handle for got body:', msg.handle);
      return true;
    }
    delete this._pendingRequests[msg.handle];

    // We used to update the attachment representations here.  This is now
    // handled by `bodyModified` notifications which are guaranteed to occur
    // prior to this callback being invoked.

    if (req.callback)
      req.callback.call(null, req.body);
    return true;
  },

  /**
   * Given a user's email address, try and see if we can autoconfigure the
   * account and what information we'll need to configure it, specifically
   * a password or if XOAuth2 credentials will be needed.
   *
   * @param {Object} details
   * @param {String} details.emailAddress
   *   The user's email address.
   * @param {Function} callback
   *   Invoked once we have an answer.  The object will look something like
   *   one of the following results:
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
  learnAboutAccount: function(details, callback) {
    var handle = this._nextHandle++;
    this._pendingRequests[handle] = {
      type: 'learnAboutAccount',
      details: details,
      callback: callback
    };
    this.__bridgeSend({
      type: 'learnAboutAccount',
      handle: handle,
      details: details
    });
  },

  _recv_learnAboutAccountResults: function(msg) {
    var req = this._pendingRequests[msg.handle];
    if (!req) {
      unexpectedBridgeDataError('Bad handle:', msg.handle);
      return true;
    }
    delete this._pendingRequests[msg.handle];

    req.callback.call(null, msg.data);
    return true;
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
   *       @param[err AccountCreationError]
   *       @param[errDetails @dict[
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
  tryToCreateAccount: function ma_tryToCreateAccount(details, domainInfo,
                                                     callback) {
    var handle = this._nextHandle++;
    this._pendingRequests[handle] = {
      type: 'tryToCreateAccount',
      details: details,
      domainInfo: domainInfo,
      callback: callback
    };
    this.__bridgeSend({
      type: 'tryToCreateAccount',
      handle: handle,
      details: details,
      domainInfo: domainInfo
    });
  },

  _recv_tryToCreateAccountResults:
      function ma__recv_tryToCreateAccountResults(msg) {
    var req = this._pendingRequests[msg.handle];
    if (!req) {
      unexpectedBridgeDataError('Bad handle for create account:', msg.handle);
      return true;
    }
    delete this._pendingRequests[msg.handle];

    // We create this account to expose modifications functions to the
    // frontend before we have access to the full accounts slice.  Note that
    // we may not have an account if we failed to create the account!
    var account;
    if (msg.account) {
      account = new MailAccount(this, msg.account, null);
    }

    req.callback.call(null, msg.error, msg.errorDetails, account);
    return true;
  },

  _clearAccountProblems: function ma__clearAccountProblems(account, callback) {
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

  _recv_clearAccountProblems: function ma__recv_clearAccountProblems(msg) {
    var req = this._pendingRequests[msg.handle];
    delete this._pendingRequests[msg.handle];
    req.callback && req.callback();
    return true;
  },

  _modifyAccount: function ma__modifyAccount(account, mods, callback) {
    var handle = this._nextHandle++;
    this._pendingRequests[handle] = {
      type: 'modifyAccount',
      callback: callback,
    };
    this.__bridgeSend({
      type: 'modifyAccount',
      accountId: account.id,
      mods: mods,
      handle: handle
    });
  },

  _recv_modifyAccount: function(msg) {
    var req = this._pendingRequests[msg.handle];
    delete this._pendingRequests[msg.handle];
    req.callback && req.callback();
    return true;
  },

  _deleteAccount: function ma__deleteAccount(account) {
    this.__bridgeSend({
      type: 'deleteAccount',
      accountId: account.id,
    });
  },

  _modifyIdentity: function ma__modifyIdentity(identity, mods, callback) {
    var handle = this._nextHandle++;
    this._pendingRequests[handle] = {
      type: 'modifyIdentity',
      callback: callback,
    };
    this.__bridgeSend({
      type: 'modifyIdentity',
      identityId: identity.id,
      mods: mods,
      handle: handle
    });
  },

  _recv_modifyIdentity: function(msg) {
    var req = this._pendingRequests[msg.handle];
    delete this._pendingRequests[msg.handle];
    req.callback && req.callback();
    return true;
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
  viewAccounts: function ma_viewAccounts(opts) {
    var handle = this._nextHandle++,
        slice = new AccountsViewSlice(this, handle, opts);
    this._slices[handle] = slice;

    this.__bridgeSend({
      type: 'viewAccounts',
      handle: handle,
    });
    return slice;
  },

  /**
   * Get the list of sender identities.  The identities can also be found on
   * their owning accounts via `viewAccounts`.
   */
  viewSenderIdentities: function ma_viewSenderIdentities() {
    var handle = this._nextHandle++,
        slice = new BridgedViewSlice(this, 'identities', handle);
    this._slices[handle] = slice;

    this.__bridgeSend({
      type: 'viewSenderIdentities',
      handle: handle,
    });
    return slice;
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
  viewFolders: function ma_viewFolders(mode, argument) {
    var handle = this._nextHandle++,
        slice = new FoldersViewSlice(this, handle);

    this._slices[handle] = slice;

    this.__bridgeSend({
      type: 'viewFolders',
      mode: mode,
      handle: handle,
      argument: argument ? argument.id : null,
    });

    return slice;
  },

  /**
   * Retrieve a slice of the contents of a folder, starting from the most recent
   * messages.
   */
  viewFolderMessages: function ma_viewFolderMessages(folder) {
    var handle = this._nextHandle++,
        slice = new HeadersViewSlice(this, handle);
    slice.folderId = folder.id;
    // the initial population counts as a request.
    slice.pendingRequestCount++;
    this._slices[handle] = slice;

    this.__bridgeSend({
      type: 'viewFolderMessages',
      folderId: folder.id,
      handle: handle,
    });

    return slice;
  },

  /**
   * Search a folder for messages containing the given text in the sender,
   * recipients, or subject fields, as well as (optionally), the body with a
   * default time constraint so we don't entirely kill the server or us.
   *
   * @args[
   *   @param[folder]{
   *     The folder whose messages we should search.
   *   }
   *   @param[text]{
   *     The phrase to search for.  We don't split this up into words or
   *     anything like that.  We just do straight-up indexOf on the whole thing.
   *   }
   *   @param[whatToSearch @dict[
   *     @key[author #:optional Boolean]
   *     @key[recipients #:optional Boolean]
   *     @key[subject #:optional Boolean]
   *     @key[body #:optional @oneof[false 'no-quotes' 'yes-quotes']]
   *   ]]
   * ]
   */
  searchFolderMessages:
      function ma_searchFolderMessages(folder, text, whatToSearch) {
    var handle = this._nextHandle++,
        slice = new HeadersViewSlice(this, handle, 'matchedHeaders');
    // the initial population counts as a request.
    slice.pendingRequestCount++;
    this._slices[handle] = slice;

    this.__bridgeSend({
      type: 'searchFolderMessages',
      folderId: folder.id,
      handle: handle,
      phrase: text,
      whatToSearch: whatToSearch,
    });

    return slice;
  },

  //////////////////////////////////////////////////////////////////////////////
  // Batch Message Mutation
  //
  // If you want to modify a single message, you can use the methods on it
  // directly.
  //
  // All actions are undoable and return an `UndoableOperation`.

  deleteMessages: function ma_deleteMessages(messages) {
    // We allocate a handle that provides a temporary name for our undoable
    // operation until we hear back from the other side about it.
    var handle = this._nextHandle++;

    var undoableOp = new UndoableOperation(this, 'delete', messages.length,
                                           handle),
        msgSuids = messages.map(serializeMessageName);

    this._pendingRequests[handle] = {
      type: 'mutation',
      handle: handle,
      undoableOp: undoableOp
    };
    this.__bridgeSend({
      type: 'deleteMessages',
      handle: handle,
      messages: msgSuids,
    });

    return undoableOp;
  },

  // Copying messages is not required yet.
  /*
  copyMessages: function ma_copyMessages(messages, targetFolder) {
  },
  */

  moveMessages: function ma_moveMessages(messages, targetFolder, callback) {
    // We allocate a handle that provides a temporary name for our undoable
    // operation until we hear back from the other side about it.
    var handle = this._nextHandle++;

    var undoableOp = new UndoableOperation(this, 'move', messages.length,
                                           handle),
        msgSuids = messages.map(serializeMessageName);

    this._pendingRequests[handle] = {
      type: 'mutation',
      handle: handle,
      undoableOp: undoableOp,
      callback: callback
    };
    this.__bridgeSend({
      type: 'moveMessages',
      handle: handle,
      messages: msgSuids,
      targetFolder: targetFolder.id
    });

    return undoableOp;
  },

  markMessagesRead: function ma_markMessagesRead(messages, beRead) {
    return this.modifyMessageTags(messages,
                                  beRead ? ['\\Seen'] : null,
                                  beRead ? null : ['\\Seen'],
                                  beRead ? 'read' : 'unread');
  },

  markMessagesStarred: function ma_markMessagesStarred(messages, beStarred) {
    return this.modifyMessageTags(messages,
                                  beStarred ? ['\\Flagged'] : null,
                                  beStarred ? null : ['\\Flagged'],
                                  beStarred ? 'star' : 'unstar');
  },

  modifyMessageTags: function ma_modifyMessageTags(messages, addTags,
                                                   removeTags, _opcode) {
    // We allocate a handle that provides a temporary name for our undoable
    // operation until we hear back from the other side about it.
    var handle = this._nextHandle++;

    if (!_opcode) {
      if (addTags && addTags.length)
        _opcode = 'addtag';
      else if (removeTags && removeTags.length)
        _opcode = 'removetag';
    }
    var undoableOp = new UndoableOperation(this, _opcode, messages.length,
                                           handle),
        msgSuids = messages.map(serializeMessageName);

    this._pendingRequests[handle] = {
      type: 'mutation',
      handle: handle,
      undoableOp: undoableOp
    };
    this.__bridgeSend({
      type: 'modifyMessageTags',
      handle: handle,
      opcode: _opcode,
      addTags: addTags,
      removeTags: removeTags,
      messages: msgSuids,
    });

    return undoableOp;
  },

  /**
   * Check the outbox for pending messages, and initiate a series of
   * jobs to attempt to send them. The callback fires after the first
   * message's send attempt completes; this job will then
   * self-schedule further jobs to attempt to send the rest of the
   * outbox.
   *
   * @param {MailAccount} account
   * @param {function} callback
   *   Called after the first message's send attempt finishes.
   */
  sendOutboxMessages: function (account, callback) {
    var handle = this._nextHandle++;
    this._pendingRequests[handle] = {
      type: 'sendOutboxMessages',
      callback: callback
    };
    this.__bridgeSend({
      type: 'sendOutboxMessages',
      accountId: account.id,
      handle: handle
    });
  },

  _recv_sendOutboxMessages: function(msg) {
    var req = this._pendingRequests[msg.handle];
    delete this._pendingRequests[msg.handle];
    req.callback && req.callback();
    return true;
  },

  /**
   * Enable or disable outbox syncing for this account. This is
   * generally a temporary measure, used when the user is actively
   * editing the list of outbox messages and we don't want to
   * inadvertently move something out from under them. This change
   * does _not_ persist; it's meant to be used only for brief periods
   * of time, not as a "sync schedule" coordinator.
   */
  setOutboxSyncEnabled: function (account, enabled, callback) {
    var handle = this._nextHandle++;
    this._pendingRequests[handle] = {
      type: 'setOutboxSyncEnabled',
      callback: callback
    };
    this.__bridgeSend({
      type: 'setOutboxSyncEnabled',
      accountId: account.id,
      outboxSyncEnabled: enabled,
      handle: handle
    });
  },

  _recv_setOutboxSyncEnabled: function(msg) {
    var req = this._pendingRequests[msg.handle];
    delete this._pendingRequests[msg.handle];
    req.callback && req.callback();
    return true;
  },

  /**
   * Parse a structured email address
   * into a display name and email address parts.
   * It will return null on a parse failure.
   *
   * @param {String} email A email address.
   * @return {Object} An object of the form { name, address }.
   */
  parseMailbox: function(email) {
    try {
      var mailbox = addressparser.parse(email);
      return (mailbox.length >= 1) ? mailbox[0] : null;
    }
    catch (ex) {
      reportClientCodeError('parse mailbox error', ex,
                            '\n', ex.stack);
      return null;
    }
  },

  _recv_mutationConfirmed: function(msg) {
    var req = this._pendingRequests[msg.handle];
    if (!req) {
      unexpectedBridgeDataError('Bad handle for mutation:', msg.handle);
      return true;
    }

    req.undoableOp._tempHandle = null;
    req.undoableOp._longtermIds = msg.longtermIds;
    if (req.undoableOp._undoRequested)
      req.undoableOp.undo();

    if (req.callback) {
      req.callback(msg.result);
    }

    return true;
  },

  __undo: function undo(undoableOp) {
    this.__bridgeSend({
      type: 'undo',
      longtermIds: undoableOp._longtermIds,
    });
  },

  //////////////////////////////////////////////////////////////////////////////
  // Contact Support

  resolveEmailAddressToPeep: function(emailAddress, callback) {
    var peep = ContactCache.resolvePeep({ name: null, address: emailAddress });
    if (ContactCache.pendingLookupCount)
      ContactCache.callbacks.push(callback.bind(null, peep));
    else
      callback(peep);
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
   * @args[
   *   @param[message #:optional MailHeader]{
   *     Some message to use as context when not issuing a reply/forward.
   *   }
   *   @param[folder #:optional MailFolder]{
   *     The folder to use as context if no `message` is provided and not
   *     issuing a reply/forward.
   *   }
   *   @param[options #:optional @dict[
   *     @key[replyTo #:optional MailHeader]
   *     @key[replyMode #:optional @oneof[null 'list' 'all']]
   *     @key[forwardOf #:optional MailHeader]
   *     @key[forwardMode #:optional @oneof['inline']]
   *   ]]
   *   @param[callback #:optional Function]{
   *     The callback to invoke once the composition handle is fully populated.
   *     This is necessary because the back-end decides what identity is
   *     appropriate, handles "re:" prefixing, quoting messages, etc.
   *   }
   * ]
   */
  beginMessageComposition: function(message, folder, options, callback) {
    if (!callback)
      throw new Error('A callback must be provided; you are using the API ' +
                      'wrong if you do not.');
    if (!options)
      options = {};

    var handle = this._nextHandle++,
        composer = new MessageComposition(this, handle);

    this._pendingRequests[handle] = {
      type: 'compose',
      composer: composer,
      callback: callback,
    };
    var msg = {
      type: 'beginCompose',
      handle: handle,
      mode: null,
      submode: null,
      refSuid: null,
      refDate: null,
      refGuid: null,
      refAuthor: null,
      refSubject: null,
    };
    if (options.hasOwnProperty('replyTo') && options.replyTo) {
      msg.mode = 'reply';
      msg.submode = options.replyMode;
      msg.refSuid = options.replyTo.id;
      msg.refDate = options.replyTo.date.valueOf();
      msg.refGuid = options.replyTo.guid;
      msg.refAuthor = options.replyTo.author.toWireRep();
      msg.refSubject = options.replyTo.subject;
    }
    else if (options.hasOwnProperty('forwardOf') && options.forwardOf) {
      msg.mode = 'forward';
      msg.submode = options.forwardMode;
      msg.refSuid = options.forwardOf.id;
      msg.refDate = options.forwardOf.date.valueOf();
      msg.refGuid = options.forwardOf.guid;
      msg.refAuthor = options.forwardOf.author.toWireRep();
      msg.refSubject = options.forwardOf.subject;
    }
    else {
      msg.mode = 'new';
      if (message) {
        msg.submode = 'message';
        msg.refSuid = message.id;
      }
      else if (folder) {
        msg.submode = 'folder';
        msg.refSuid = folder.id;
      }
    }
    this.__bridgeSend(msg);
    return composer;
  },

  /**
   * Open a message as if it were a draft message (hopefully it is), returning
   * a MessageComposition object that will be asynchronously populated.  The
   * provided callback will be notified once all composition state has been
   * loaded.
   *
   * The underlying message will be replaced by other messages as the draft
   * is updated and effectively deleted once the draft is completed.  (A
   * move may be performed instead.)
   */
  resumeMessageComposition: function(message, callback) {
    if (!callback)
      throw new Error('A callback must be provided; you are using the API ' +
                      'wrong if you do not.');

    var handle = this._nextHandle++,
        composer = new MessageComposition(this, handle);

    this._pendingRequests[handle] = {
      type: 'compose',
      composer: composer,
      callback: callback,
    };

    this.__bridgeSend({
      type: 'resumeCompose',
      handle: handle,
      messageNamer: serializeMessageName(message)
    });

    return composer;
  },

  _recv_composeBegun: function(msg) {
    var req = this._pendingRequests[msg.handle];
    if (!req) {
      unexpectedBridgeDataError('Bad handle for compose begun:', msg.handle);
      return true;
    }

    req.composer.senderIdentity = new MailSenderIdentity(this, msg.identity);
    req.composer.subject = msg.subject;
    req.composer.body = msg.body; // rich obj of {text, html}
    req.composer.to = msg.to;
    req.composer.cc = msg.cc;
    req.composer.bcc = msg.bcc;
    req.composer._references = msg.referencesStr;
    req.composer.attachments = msg.attachments;
    req.composer.sendStatus = msg.sendStatus; // For displaying "Send failed".

    if (req.callback) {
      var callback = req.callback;
      req.callback = null;
      callback.call(null, req.composer);
    }
    return true;
  },

  _composeAttach: function(draftHandle, attachmentDef, callback) {
    if (!draftHandle) {
      return;
    }
    var draftReq = this._pendingRequests[draftHandle];
    if (!draftReq) {
      return;
    }
    var callbackHandle = this._nextHandle++;
    this._pendingRequests[callbackHandle] = {
      type: 'attachBlobToDraft',
      callback: callback
    };
    this.__bridgeSend({
      type: 'attachBlobToDraft',
      handle: callbackHandle,
      draftHandle: draftHandle,
      attachmentDef: attachmentDef
    });
  },

  _recv_attachedBlobToDraft: function(msg) {
    var callbackReq = this._pendingRequests[msg.handle];
    var draftReq = this._pendingRequests[msg.draftHandle];
    if (!callbackReq) {
      return true;
    }
    delete this._pendingRequests[msg.handle];

    if (callbackReq.callback && draftReq && draftReq.composer) {
      callbackReq.callback(msg.err, draftReq.composer);
    }
    return true;
  },

  _composeDetach: function(draftHandle, attachmentIndex, callback) {
    if (!draftHandle) {
      return;
    }
    var draftReq = this._pendingRequests[draftHandle];
    if (!draftReq) {
      return;
    }
    var callbackHandle = this._nextHandle++;
    this._pendingRequests[callbackHandle] = {
      type: 'detachAttachmentFromDraft',
      callback: callback
    };
    this.__bridgeSend({
      type: 'detachAttachmentFromDraft',
      handle: callbackHandle,
      draftHandle: draftHandle,
      attachmentIndex: attachmentIndex
    });
  },

  _recv_detachedAttachmentFromDraft: function(msg) {
    var callbackReq = this._pendingRequests[msg.handle];
    var draftReq = this._pendingRequests[msg.draftHandle];
    if (!callbackReq) {
      return true;
    }
    delete this._pendingRequests[msg.handle];

    if (callbackReq.callback && draftReq && draftReq.composer) {
      callbackReq.callback(msg.err, draftReq.composer);
    }
    return true;
  },

  _composeDone: function(handle, command, state, callback) {
    if (!handle)
      return;
    var req = this._pendingRequests[handle];
    if (!req) {
      return;
    }
    req.type = command;
    if (callback)
      req.callback = callback;
    this.__bridgeSend({
      type: 'doneCompose',
      handle: handle,
      command: command,
      state: state,
    });
  },

  _recv_doneCompose: function(msg) {
    var req = this._pendingRequests[msg.handle];
    if (!req) {
      unexpectedBridgeDataError('Bad handle for doneCompose:', msg.handle);
      return true;
    }
    req.active = null;
    // Do not cleanup on saves. Do cleanup on successful send, delete, die.
    if (req.type === 'die' || (!msg.err && (req.type !== 'save')))
      delete this._pendingRequests[msg.handle];
    if (req.callback) {
      req.callback.call(null, {
        sentDate: msg.sentDate,
        messageId: msg.messageId,
        sendStatus: msg.sendStatus
      });
      req.callback = null;
    }
    return true;
  },

  //////////////////////////////////////////////////////////////////////////////
  // mode setting for back end universe. Set interactive
  // if the user has been exposed to the UI and it is a
  // longer lived application, not just a cron sync.
  setInteractive: function() {
    this.__bridgeSend({
      type: 'setInteractive'
    });
  },

  //////////////////////////////////////////////////////////////////////////////
  // cron syncing

  /**
   * Receive events about the start and stop of periodic syncing
   */
  _recv_cronSyncStart: function ma__recv_cronSyncStart(msg) {
    this.emit('cronsyncstart', msg.accountIds)
    return true;
  },

  _recv_cronSyncStop: function ma__recv_cronSyncStop(msg) {
    this.emit('cronsyncstop', msg.accountsResults);
    return true;
  },

  _recv_backgroundSendStatus: function(msg) {
    this.emit('backgroundsendstatus', msg.data);
    return true;
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
  useLocalizedStrings: function(strings) {
    this.__bridgeSend({
      type: 'localizedStrings',
      strings: strings
    });
    if (strings.folderNames)
      this.l10n_folder_names = strings.folderNames;
  },

  /**
   * L10n strings for folder names.  These map folder types to appropriate
   * localized strings.
   *
   * We don't remap unknown types, so this doesn't need defaults.
   */
  l10n_folder_names: {},

  l10n_folder_name: function(name, type) {
    if (this.l10n_folder_names.hasOwnProperty(type)) {
      var lowerName = name.toLowerCase();
      // Many of the names are the same as the type, but not all.
      if ((type === lowerName) ||
          (type === 'drafts') ||
          (type === 'junk') ||
          (type === 'queue'))
        return this.l10n_folder_names[type];
    }
    return name;
  },


  //////////////////////////////////////////////////////////////////////////////
  // Configuration

  /**
   * Change one-or-more backend-wide settings; use `MailAccount.modifyAccount`
   * to chang per-account settings.
   */
  modifyConfig: function(mods) {
    for (var key in mods) {
      if (LEGAL_CONFIG_KEYS.indexOf(key) === -1)
        throw new Error(key + ' is not a legal config key!');
    }
    this.__bridgeSend({
      type: 'modifyConfig',
      mods: mods
    });
  },

  _recv_config: function(msg) {
    this.config = msg.config;
    return true;
  },

  //////////////////////////////////////////////////////////////////////////////
  // Diagnostics / Test Hacks

  /**
   * After a setZeroTimeout, send a 'ping' to the bridge which will send a
   * 'pong' back, notifying the provided callback.  This is intended to be hack
   * to provide a way to ensure that some function only runs after all of the
   * notifications have been received and processed by the back-end.
   *
   * Note that ping messages are always processed as they are received; they do
   * not get deferred like other messages.
   */
  ping: function(callback) {
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
    window.setZeroTimeout(function() {
      this.__bridgeSend({
        type: 'ping',
        handle: handle,
      });
    }.bind(this));
  },

  _recv_pong: function(msg) {
    var req = this._pendingRequests[msg.handle];
    delete this._pendingRequests[msg.handle];
    req.callback();
    return true;
  },

  debugSupport: function(command, argument) {
    if (command === 'setLogging')
      this.config.debugLogging = argument;
    this.__bridgeSend({
      type: 'debugSupport',
      cmd: command,
      arg: argument
    });
  }

  //////////////////////////////////////////////////////////////////////////////
});

}); // end define

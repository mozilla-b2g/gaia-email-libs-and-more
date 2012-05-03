/**
 *
 **/

define(
  [
    'exports'
  ],
  function(

    exports
  ) {

function MailAccount(api, wireRep) {
  this._api = api;
  this.id = wireRep.id;
  this.type = wireRep.type;
  this.name = wireRep.name;

  this.host = wireRep.host;
  this.port = wireRep.port;
  this.username = wireRep.username;
  this.crypto = wireRep.crypto;

  // build a place for the DOM element and arbitrary data into our shape
  this.element = null;
  this.data = null;
}
MailAccount.prototype = {
  toString: function() {
    return '[MailAccount: ' + this.type + ' ' + this.id + ']';
  },

  modifyAccount: function() {
    throw new Error("NOT YET IMPLEMENTED");
  },
};

function MailFolder(api, wireRep) {
  // Accounts have a somewhat different wireRep serialization, but we can best
  // tell by the id's; a folder's id is derived from the account with a dash
  // separating.
  var isAccount = wireRep.id.indexOf('-') === -1;

  this._api = api;
  this.id = wireRep.id;

  /**
   * The human-readable name of the folder.  (As opposed to its path or the
   * modified utf-7 encoded folder names.)
   */
  this.name = wireRep.name;
  /**
   * @listof[String]{
   *   The hierarchical path of the folder, with each path component as a
   *   separate string.  All path values are human-readable (as opposed to
   *   modified modified utf-7 encoded folder names.)
   * }
   */
  this.path = wireRep.path;
  /**
   * @oneof[
   *   @case['account']{
   *     It's not really a folder at all, just an account serving as hierarchy.
   *   }
   *   @case['nomail']{
   *     A folder that exists only to provide hierarchy but which can't
   *     contain messages.  An artifact of various mail backends that are
   *     reflected in IMAP as NOSELECT.
   *   }
   *   @case['inbox']
   *   @case['drafts']
   *   @case['sent']
   *   @case['trash']
   *   @case['archive']
   *   @case['junk']
   *   @case['normal']{
   *     A traditional mail folder with nothing special about it.
   *   }
   * ]{
   *   Non-localized string indicating the type of folder this is, primarily
   *   for styling purposes.
   * }
   */
  this.type = isAccount ? 'account' : wireRep.type;

  this.selectable = !isAccount && wireRep.type !== 'nomail';

  this.onchange = null;
  this.onremove = null;

  // build a place for the DOM element and arbitrary data into our shape
  this.element = null;
  this.data = null;
}
MailFolder.prototype = {
  toString: function() {
    return '[MailFolder: ' + this.path + ']';
  },
};

function filterOutBuiltinFlags(flags) {
  // so, we could mutate in-place if we were sure the wire rep actually came
  // over the wire.  Right now there is de facto rep sharing, so let's not
  // mutate and screw ourselves over.
  var outFlags = [];
  for (var i = flags.length - 1; i >= 0; i--) {
    if (flags[i][0] !== '\\')
      outFlags.push(flags[i]);
  }
  return outFlags;
}

/**
 * Email overview information for displaying the message in the list as planned
 * for the current UI.  Things that we don't need (ex: to/cc/bcc) for the list
 * end up on the body, currently.  They will probably migrate to the header in
 * the future.
 *
 * Events are generated if the metadata of the message changes or if the message
 * is removed.  The `BridgedViewSlice` instance is how the system keeps track
 * of what messages are being displayed/still alive to need updates.
 */
function MailHeader(slice, wireRep) {
  this._slice = slice;
  this.id = wireRep.suid;

  this.author = wireRep.author;

  this.date = new Date(wireRep.date);
  this.isRead = wireRep.flags.indexOf('\\Seen') !== -1;
  this.isStarred = wireRep.flags.indexOf('\\Flagged') !== -1;
  this.isRepliedTo = wireRep.flags.indexOf('\\Answered') !== -1;
  this.tags = filterOutBuiltinFlags(wireRep.flags);
  this.hasAttachments = wireRep.hasAttachments;

  this.subject = wireRep.subject;
  this.snippet = wireRep.snippet;

  this.onchange = null;
  this.onremove = null;

  // build a place for the DOM element and arbitrary data into our shape
  this.element = null;
  this.data = null;
}
MailHeader.prototype = {
  toString: function() {
    return '[MailHeader: ' + this.id + ']';
  },

  /**
   * Delete this message
   */
  deleteMessage: function() {
  },

  /**
   * Move this message to another folder.
   */
  moveMessage: function(targetFolder) {
  },

  /**
   * Copy this message to another folder.
   */
  copyMessage: function(targetFolder) {
  },

  setRead: function(beRead) {
  },

  setStarred: function(beStarred) {
  },

  setRepliedTo: function(beRepliedTo) {
  },

  modifyTags: function(addTags, removeTags) {
  },

  /**
   * Request the `MailBody` instance for this message, passing it to the
   * provided callback function once retrieved.
   */
  getBody: function(callback) {
  },
};

/**
 * Lists the attachments in a message as well as providing a way to display the
 * body while (eventually) also accounting for message quoting.
 *
 * Mail bodies are immutable and so there are no events on them or lifetime
 * management to worry about.  However, you should keep the `MailHeader` alive
 * and worry about its lifetime since the message can get deleted, etc.
 */
function MailBody(api, id) {
  this._api = api;
  this.id = id;

  this.to = null;
  this.cc = null;
  this.bcc = null;
  this.attachments = null;
  // for the time being, we only provide text/plain contents, and we provide
  // those flattened.
  this.bodyText = null;
}
MailBody.prototype = {
  toString: function() {
    return '[MailBody: ' + id + ']';
  },
};

/**
 * Provides the file name, mime-type, and estimated file size of an attachment.
 * In the future this will also be the means for requesting the download of
 * an attachment or for attachment-forwarding semantics.
 */
function MailAttachment() {
  this.filename = null;
  this.mimetype = null;

  // build a place for the DOM element and arbitrary data into our shape
  this.element = null;
  this.data = null;
}
MailAttachment.prototype = {
  toString: function() {
    return '[MailAttachment: "' + this.filename + '"]';
  },
};

/**
 * Undoable operations describe the operation that was performed for
 * presentation to the user and hold onto a handle that can be used to undo
 * whatever it was.  While the current UI plan does not call for the ability to
 * get a list of recently performed actions, the goal is to make it feasible
 * in the future.
 */
function UndoableOperation() {
}
UndoableOperation.prototype = {
  toString: function() {
    return '[UndoableOperation]';
  },
};

/**
 *
 */
function BridgedViewSlice(api, ns, handle) {
  this._api = api;
  this._ns = ns;
  this._handle = handle;

  this.items = [];

  this.atTop = null;
  this.atBottom = false;

  this.onadd = null;
  this.onsplice = null;
  this.onremove = null;
}
BridgedViewSlice.prototype = {
  toString: function() {
    return '[BridgedViewSlice: ' + handle + ']';
  },

  requestGrowth: function() {
  },

  die: function() {
    this._api.__bridgeSend({
        type: 'killSlice',
        handle: this._handle
      });
  },
};

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
 *
 */
function MailAPI() {
  this._nextHandle = 1;
  this.onstatuschange = null;

  this._slices = {};
  this._pendingRequests = {};
}
exports.MailAPI = MailAPI;
MailAPI.prototype = {
  /**
   * Send a message over/to the bridge.  The idea is that we (can) communicate
   * with the backend using only a postMessage-style JSON channel.
   */
  __bridgeSend: function(msg) {
    // actually, this method gets clobbered.
  },

  /**
   * Process a message received from the bridge.
   */
  __bridgeReceive: function ma___bridgeReceive(msg) {
    var methodName = '_recv_' + msg.type;
    if (!(methodName in this)) {
      unexpectedBridgeDataError('Unsupported message type:', msg.type);
      return;
    }
    try {
      this[methodName](msg);
    }
    catch (ex) {
      internalError('Problem handling message type:', msg.type, ex,
                    '\n', ex.stack);
      return;
    }
  },

  _recv_sliceSplice: function ma__recv_sliceSplice(msg) {
    var slice = this._slices[msg.handle];
    console.log('slice splice for handle', msg.handle, 'w/ns:', slice._ns,
                'deleted', msg.howMany, 'added', msg.addItems.length);
    if (!slice) {
      unexpectedBridgeDataError('Received message about a nonexistent slice:',
                                msg.handle);
      return;
    }

    var addItems = msg.addItems, transformedItems = [], i;
    switch (slice._ns) {
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
    }

    if (slice.onsplice) {
      console.log('  onsplice exists!');
      try {
        slice.onsplice(msg.index, msg.howMany, transformedItems,
                       msg.requested, msg.moreExpected);
      }
      catch (ex) {
        reportClientCodeError('onsplice notification error', ex,
                              '\n', ex.stack);
      }
      console.log('  onsplice call completed!');
    }
    slice.items.splice.apply(slice.items,
                             [msg.index, msg.howMany].concat(transformedItems));
  },

  /**
   * Try to create an account.  There is currently no way to abort the process
   * of creating an account.
   *
   * @typedef[AccountCreationError @oneof[
   *   @case['offline']{
   *     We are offline and have no network access to try and create the
   *     account.
   *   }
   *   @case['no-dns-entry']{
   *     We couldn't find the domain name in question, full stop.
   *   }
   *   @case['unresponsive-server']{
   *     Requests to the server timed out.  AKA we sent packets into a black
   *     hole.
   *   }
   *   @case['port-not-listening']{
   *     Attempts to connect to the given port on the server failed.  We got
   *     packets back rejecting our connection.
   *   }
   *   @case['bad-security']{
   *     We were able to connect to the port and initiate TLS, but we didn't
   *     like what we found.  This could be a mismatch on the server domain,
   *     a self-signed or otherwise invalid certificate, insufficient crypto,
   *     or a vulnerable server implementation.
   *   }
   *   @case['not-an-imap-server']{
   *     Whatever is there isn't actually an IMAP server.
   *   }
   *   @case['sucky-imap-server']{
   *     The IMAP server is too bad for us to use.
   *   }
   *   @case['bad-user-or-pass']{
   *     The username and password didn't check out.  We don't know which one
   *     is wrong, just that one of them is wrong.
   *   }
   *   @case[null]{
   *     No error, the account was created and everything is terrific.
   *   }
   * ]]
   *
   * @args[
   *   @param[details]
   *   @param[callback @func[
   *     @args[
   *       @param[err AccountCreationError]
   *     ]
   *   ]
   * ]
   */
  tryToCreateAccount: function ma_tryToCreateAccount(details, callback) {
    var handle = this._nextHandle++;
    this._pendingRequests[handle] = {
      type: 'tryToCreateAccount',
      details: details,
      callback: callback
    };
    this.__bridgeSend({
      type: 'tryToCreateAccount',
      handle: handle,
      details: details
    });
  },

  _recv_tryToCreateAccountResults:
      function ma__recv_tryToCreateAccountResults(msg) {
    var req = this._pendingRequests[msg.handle];
    if (!req) {
      unexpectedBridgeDataError('Bad handle for create account:', msg.handle);
      return;
    }
    delete this._pendingRequests[msg.handle];

    req.callback(msg.error);
  },

  /**
   * Get the list of accounts.  This is intended to be used only for the list
   * of accounts in a settings UI.
   */
  viewAccounts: function ma_viewAccounts() {
    var handle = this._nextHandle++,
        slice = new BridgedViewSlice(this, 'folders', handle);
    this._slices[handle] = slice;

    this.__bridgeSend({
      type: 'viewAccounts',
      handle: handle,
    });
  },

  /**
   * Retrieve the entire folder hierarchy for either 'navigation' (pick what
   * folder to show the contents of, including unified folders) or 'selection'
   * (pick target folder for moves, does not include unified folders.)  In both
   * cases, there will exist non-selectable folders such as the account roots or
   * IMAP folders that cannot contain messages.
   */
  viewFolders: function ma_viewFolders(mode) {
    var handle = this._nextHandle++,
        slice = new BridgedViewSlice(this, 'folders', handle);
    this._slices[handle] = slice;

    this.__bridgeSend({
      type: 'viewFolders',
      handle: handle,
    });

    return slice;
  },

  /**
   * Retrieve a slice of the contents of a folder, starting from the most recent
   * messages.
   */
  viewFolderMessages: function ma_viewFolderMessages(folder) {
    var handle = this._nextHandle++,
        slice = new BridgedViewSlice(this, 'headers', handle);
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
   * Expected UX: run the search once without body, then the user can ask for
   * the body search too if the first match doesn't meet their expectations.
   */
  quicksearchFolderMessages:
      function ma_quicksearchFolderMessages(folder, text, searchBodyToo) {
    throw new Error("NOT YET IMPLEMENTED");
  },

  //////////////////////////////////////////////////////////////////////////////
  // Batch Message Mutation
  //
  // If you want to modify a single message, you can use the methods on it
  // directly.
  //
  // All actions are undoable and return an `UndoableOperation`.

  deleteMessages: function ma_deleteMessages(messages) {
  },

  copyMessages: function ma_copyMessages(messages, targetFolder) {
  },

  moveMessages: function ma_moveMessages(messages, targetFolder) {
  },

  markMessagesRead: function ma_markMessagesRead(messages, beRead) {
  },

  markMessagesStarred: function ma_markMessagesStarred(messages, beStarred) {
  },

  modifyMessagesTags: function ma_modifyMessageTags(messages, addTags,
                                                    removeTags) {
  },


  //////////////////////////////////////////////////////////////////////////////
};


}); // end define

define(function(require) {
'use strict';

var evt = require('evt');
var ContactCache = require('./contact_cache');

// so, we could mutate in-place if we were sure the wire rep actually came
function filterOutBuiltinFlags(flags) {
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
* Extract the canonical naming attributes out of the MailHeader instance.
*/
function serializeMessageName(x) {
  return {
    date: x.date.valueOf(),
    suid: x.id,
    // NB: strictly speaking, this is redundant information.  However, it is
    // also fairly handy to pass around for IMAP since otherwise we might need
    // to perform header lookups later on.  It will likely also be useful for
    // debugging.  But ideally we would not include this.
    guid: x.guid
  };
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
function MailHeader(api, wireRep, slice) {
  evt.Emitter.call(this);
  this._api = api;
  this._slice = slice;

  // Store the wireRep so it can be used for caching.
  this._wireRep = wireRep;

  this.id = wireRep.suid;
  this.guid = wireRep.guid;

  this.author = ContactCache.resolvePeep(wireRep.author);
  this.to = ContactCache.resolvePeeps(wireRep.to);
  this.cc = ContactCache.resolvePeeps(wireRep.cc);
  this.bcc = ContactCache.resolvePeeps(wireRep.bcc);
  this.replyTo = wireRep.replyTo;

  this.date = new Date(wireRep.date);

  this.__update(wireRep);
  this.hasAttachments = wireRep.hasAttachments;

  this.subject = wireRep.subject;
  this.snippet = wireRep.snippet;
}
MailHeader.prototype = evt.mix({
  toString: function() {
    return '[MailHeader: ' + this.id + ']';
  },
  toJSON: function() {
    return {
      type: 'MailHeader',
      id: this.id
    };
  },

  /**
   * The use-case is the message list providing the message reader with a
   * header.  The header really wants to get update notifications from the
   * backend and therefore not be inert, but that's a little complicated and out
   * of scope for the current bug.
   *
   * We clone at all because our MailPeep.onchange and MailPeep.element values
   * were getting clobbered.  All the instances are currently intended to map
   * 1:1 to a single UI widget, so cloning seems like the right thing to do.
   *
   * A deeper issue is whether the message reader will want to have its own
   * slice since the reader will soon allow forward/backward navigation.  I
   * assume we'll want the message list to track that movement, which suggests
   * that it really doesn't want to do that.  This suggests we'll either want
   * non-inert clones or to just use a list-of-handlers model with us using
   * closures and being careful about removing event handlers.
   */
  makeCopy: function() {
    return new MailHeader(this._api, this._wireRep, this._slice);
  },

  __update: function(wireRep) {
    this._wireRep = wireRep;
    if (wireRep.snippet !== null) {
      this.snippet = wireRep.snippet;
    }

    this.isRead = wireRep.flags.indexOf('\\Seen') !== -1;
    this.isStarred = wireRep.flags.indexOf('\\Flagged') !== -1;
    this.isRepliedTo = wireRep.flags.indexOf('\\Answered') !== -1;
    this.isForwarded = wireRep.flags.indexOf('$Forwarded') !== -1;
    this.isJunk = wireRep.flags.indexOf('$Junk') !== -1;
    this.tags = filterOutBuiltinFlags(wireRep.flags);

    // Messages in the outbox will have `sendStatus` populated like so:
    // {
    //   state: 'pending', 'error', 'success', 'sending', or 'syncDone'
    //   err: null,
    //   badAddresses: null,
    //   sendFailures: 2
    // }
    this.sendStatus = wireRep.sendStatus || {};
  },

  /**
   * Release subscriptions associated with the header; currently this just means
   * tell the ContactCache we no longer care about the `MailPeep` instances.
   */
  __die: function() {
    ContactCache.forgetPeepInstances([this.author], this.to, this.cc, this.bcc);
  },

  /**
   * Delete this message
   */
  deleteMessage: function() {
    return this._slice._api.deleteMessages([this]);
  },

  /*
   * Copy this message to another folder.
   */
  /*
  copyMessage: function(targetFolder) {
    return this._slice._api.copyMessages([this], targetFolder);
  },
  */

  /**
   * Move this message to another folder.
   */
  moveMessage: function(targetFolder) {
    return this._slice._api.moveMessages([this], targetFolder);
  },

  /**
   * Set or clear the read status of this message.
   */
  setRead: function(beRead) {
    return this._slice._api.markMessagesRead([this], beRead);
  },

  /**
   * Set or clear the starred/flagged status of this message.
   */
  setStarred: function(beStarred) {
    return this._slice._api.markMessagesStarred([this], beStarred);
  },

  /**
   * Add and/or remove tags/flags from this messages.
   */
  modifyTags: function(addTags, removeTags) {
    return this._slice._api.modifyMessageTags([this], addTags, removeTags);
  },

  /**
   * Request the `MailBody` instance for this message, passing it to
   * the provided callback function once retrieved. If you request the
   * bodyReps as part of this call, the backend guarantees that it
   * will only call the "onchange" notification when the body has
   * actually changed. In other words, if you end up calling getBody()
   * multiple times for some reason, the backend will be smart about
   * only fetching the bodyReps the first time and generating change
   * notifications as one would expect.
   *
   * @args[
   *   @param[options @dict[
   *     @key[downloadBodyReps #:default false]{
   *       Asynchronously initiate download of the body reps.  The body may
   *       be returned before the body parts are downloaded, but they will
   *       eventually show up.  Use the 'onchange' event to hear as the body
   *       parts get added.
   *     }
   *     @key[withBodyReps #:default false]{
   *       Don't return until the body parts are fully downloaded.
   *     }
   *   ]]
   * ]
   */
  getBody: function(options, callback) {
    if (typeof(options) === 'function') {
      callback = options;
      options = null;
    }
    this._slice._api._getBodyForMessage(this, options, callback);
  },

  /**
   * Returns the number of bytes needed before we can display the full
   * body. If this value is large, we should warn the user that they
   * may be downloading a large amount of data. For IMAP, this value
   * is the amount of data we need to render bodyReps and
   * relatedParts; for POP3, we need the whole message.
   */
  get bytesToDownloadForBodyDisplay() {
    // If this is unset (old message), default to zero so that we just
    // won't show any warnings (rather than prompting incorrectly).
    return this._wireRep.bytesToDownloadForBodyDisplay || 0;
  },

  /**
   * Assume this is a draft message and return a MessageComposition object
   * that will be asynchronously populated.  The provided callback will be
   * notified once all composition state has been loaded.
   *
   * The underlying message will be replaced by other messages as the draft
   * is updated and effectively deleted once the draft is completed.  (A
   * move may be performed instead.)
   */
  editAsDraft: function(callback) {
    var composer = this._slice._api.resumeMessageComposition(this, callback);
    composer.hasDraft = true;
    return composer;
  },

  /**
   * Start composing a reply to this message.
   *
   * @args[
   *   @param[replyMode @oneof[
   *     @default[null]{
   *       To be specified...
   *     }
   *     @case['sender']{
   *       Reply to the author of the message.
   *     }
   *     @case['list']{
   *       Reply to the mailing list the message was received from.  If there
   *       were other mailing lists copied on the message, they will not
   *       be included.
   *     }
   *     @case['all']{
   *       Reply to the sender and all listed recipients of the message.
   *     }
   *   ]]{
   *     The not currently used reply-mode.
   *   }
   * ]
   * @return[MessageComposition]
   */
  replyToMessage: function(replyMode, callback) {
    return this._slice._api.beginMessageComposition(
      this, null, { replyTo: this, replyMode: replyMode }, callback);
  },

  /**
   * Start composing a forward of this message.
   *
   * @args[
   *   @param[forwardMode @oneof[
   *     @case['inline']{
   *       Forward the message inline.
   *     }
   *   ]]
   * ]
   * @return[MessageComposition]
   */
  forwardMessage: function(forwardMode, callback) {
    return this._slice._api.beginMessageComposition(
      this, null, { forwardOf: this, forwardMode: forwardMode }, callback);
  },
});

return MailHeader;
});

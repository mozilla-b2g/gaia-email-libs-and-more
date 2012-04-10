/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * @typedef[AccountId String]{
 *   Arbitrary/unique identifier for an account.
 * }
 * @typedef[FolderId String]{
 *   Arbitrary/unique identifier for a folder.
 * }
 * @typedef[UID Number]{
 *   The IMAP server's (numeric) UID for a message; always associated with the
 *   FolderId for a server.
 * }
 * @typedef[MutationId String]{
 *   Arbitrary, lexicographically-increasing identifier (on a per-folder)
 *   basis to name mutations that need to be sent to the IMAP server.  Exists to
 *   provide a sequential ordering and without overloading UID namespace (which
 *   has been a source of bugs in Thunderbird.)
 * }
 * @typedef[Minpoch String]{
 *   Math.floor(dateInMS / 131072) (aka 2^17) encoded ordered-base64-style for
 *   24-bits.  That takes us up to the year 2039.  Each minpoch has a
 *   granularity of ~2.18 minutes.  This is intended as a compromise for
 *   time-bucketing so that we don't store a lot of useless entropy but also
 *   that we don't end up with a ton of messages in each bucket under flame-war
 *   conditions.
 * }
 * @typedef[MsgId String]{
 *   Arbitrary/unique identitifer for a message that we create using our
 *   ordered-base64 encoding.  This exists because: 1) rfc822 message-id header
 *   values can be very long and unwiedly, 2) in olden times, some clients (ex:
 *   Exchange gateways) would do insane things like use the same message-id for
 *   every message, 3) there may be cases where a message gets retransmitted
 *   with multiple message-id's (ex: stupid mailman newsgroup gateways that
 *   create a new message-id for each newsgroup they repost to)
 * }
 * @typedef[PeepId String]{
 *   Unique identifier for a person.  For now, for contacts this is just the
 *   lower-cased first e-mail address for a contact to simplify debugging.  But
 *   this should probably end-up being the "id" UUID field for the WebContacts
 *   API contact representation.  For non-contacts, this is just the e-mail
 *   address we have observed.
 * }
 * @typedef[Rfc822MessageId String]{
 *   The RFC(2)822 Message-Id header's value for a message.  These are supposed
 *   to be unique, but there's a whole tale of woe with older clients/gateways
 *   that would reuse them, mailman newsgroup gateways clobbering them, etc.
 * }
 **/

define(
  [
    'exports'
  ],
  function(
    exports
  ) {

/**
 * Configuration, account configuration, and IMAP folder state data.
 */
exports.TBL_CONFIG = 'config';
/**
 * The root configuration object.
 */
exports.ROW_CONFIG_ROOT = 'config';
/**
 * The account definition which contains host/user information and (currently)
 * passwords.  Lives outside 'config' because it is sensitive.
 */
exports.ROWPREFIX_CONFIG_ACCOUNT_DEF = 'accountDef';
/**
 * Maps folder id's (which are unique across accounts) to the state data we
 * have on the folder.  Lives outside 'config' because it has high turnover
 * and is fairly dry reading.
 *
 * row id: accountFolders:`AccountId`
 * value type: @dictof[@key[FolderId] @value[IMAPFolderState]]
 */
exports.ROWPREFIX_CONFIG_ACCOUNT_FOLDERS = 'accountFolders';

/**
 * row id: `FolderId`:`UID`
 * @list[
 *   @param[ConvId]
 *   @param[Minpoch]
 *   @param[MsgId]
 *   @param[ModSeq]
 * ]
 */
exports.TBL_FOLDER_MESSAGES = 'folderMessages';

/**
 * row id: `FolderId`:`MutationId`
 * value: @dict[
 *   @key[uid UID]
 *   @key[add @listof["keyword" String]]
 *   @key[remove @listof["keyword" String]]
 * ]
 */
exports.TBL_FOLDER_MUTATIONS = 'folderMutations';

/**
 * Maps message-id header values to the conversation the message is or should
 * be stored in.
 *
 * row id: `Rfc822MessageId`
 * value: @list[
 *   @param[ConvId]
 *   @param[MsgId]
 * ]
 */
exports.TBL_MESSAGE_IDS = 'msgids';

/**
 * - `ConvId`:b`Rfc822MessageId` => @oneof[Minpoch null]
 *     Tracks all the "msgid:" rows associated with this conversation for
 *     cleanup purposes as well as providing a way to find the exact row names
 *     for the metadata by learning the associated minpoch.
 *
 * - `ConvId`:n => Number
 *     Number of messages stored in this conversation.  For consolidated
 *     messages (messages with the same `Rfc822MessageId`), each IMAP source
 *     message gets counted, so this may be greater than the number of
 *     `MsgId`s associated with the conversation.
 *
 * - `ConvId`:ourmeta
 *     Metadata status for the conversation.
 *
 * - `ConvId`:u`ContactId`
 *     User write involvement summary for the message.  Contains a list of
 *     [`Minpoch`, `MsgId`] tuples indicating the messages the user has written
 *     in the conversation.  This is primarily to simplify index maintenance,
 *     but also may be provide an efficient way to jump to the specific messages
 *     a user has written in a long thread.
 *
 * - `ConvId`:x`Minpoch`:d`MsgId` metadata on the message:
 *   - starred, repliedTo, forwarded: Boolean
 *   - tags: [String+]
 *   - source: either `FolderId`:`UID` or a recursive form of this structure
 *     that includes all the source meta-data.  This lets us perform unions when
 *     deltas occur for one of the contents.
 *
 * - `ConvId`:x`Minpoch`:m`MsgId` Full information on the message / its
 *     contents.
 */
exports.TBL_CONVERSATIONS = 'conversations';


/**
 * The master conversation ordered view; all converations our user is in on.
 */
exports.IDX_ALL_CONVS = "idxConv";

/**
 * The per-peep conversation involvement view (for both contact and non-contact
 *  peeps right now.)
 */
exports.IDX_CONV_PEEP_WRITE_INVOLVEMENT = "idxPeepConvWrite";


/**
 * Data on people with e-mail addresses who may or may not be contacts in the
 * WebContacts API address book.  CURRENTLY SPECULATIVE.
 *
 * This will probably include something like the following (a la deuxdrop):
 * - nunread - The number of unread messages from this user.
 * - nconvs - The number of conversations involving the user.
 * And new:
 * - minpoch write timestamp management.
 */
exports.TBL_PEEPS = "";

/**
 * Contacts by their display name (as we so named them).
 *
 * Peeps are inserted into this view index when we discover that they are B2G
 * contacts.
 */
exports.IDX_PEEP_CONTACT_NAME = 'idxPeepName';

/**
 * Peeps by recency of messages they have written to conversations (the user is
 *  involved in).
 *
 * Peeps are inserted into this view index when we detect them as a contact or
 *  when they write a message to a conversation (even if not added as a
 *  contact).  The correctness of the latter is up for debate; the thing we are
 *  trying to avoid is having to do a sweep to figure out the right values if
 *  we haven't been keeping this up-to-date.  (nb: it wouldn't be hard to do
 *  that since the peep per-conv index is and should be always maintained, we
 *  just have to query it.)
 */
exports.IDX_PEEP_WRITE_INVOLVEMENT = "idxPeepWrite";


/**
 * Table for tracking
 */
exports.TBL_NEW_TRACKING = "newness";
exports.ROW_NEW_CONVERSATIONS = "convs";


exports.dbSchemaDef = {
  tables: [
    {
      name: exports.TBL_CONFIG,
      indices: [],
    },
    {
      name: exports.TBL_FOLDER_MESSAGES,
      indices: [],
    },
    {
      name: exports.TBL_FOLDER_MUTATIONS,
      indices: [],
    },
    {
      name: exports.TBL_MESSAGE_IDS,
      indices: [],
    },
    {
      name: exports.TBL_CONVERSATIONS,
      indices: [
        exports.IDX_ALL_CONVS,
        exports.IDX_CONV_PEEP_WRITE_INVOLVEMENT,
      ],
    },
    {
      name: exports.TBL_PEEPS,
      indices: [
        exports.IDX_PEEP_CONTACT_NAME,
        exports.IDX_PEEP_WRITE_INVOLVEMENT,
      ],
    },
    {
      name: exports.TBL_NEW_TRACKING,
      indices: [],
    },
  ],

  queues: [
  ],
};

}); // end define

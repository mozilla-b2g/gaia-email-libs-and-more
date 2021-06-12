import evt from 'evt';
import logic from 'logic';

import { engineFrontEndAccountMeta } from '../engine_glue';

import { bsearchForInsert } from 'shared/util';

/**
 * Ordering accounts by their name, why not.  (It used to just be creation / id
 * order.)
 */
function accountDefComparator(a, b) {
  if (!a.name) {
    return -1;
  } else if (!b.name) {
    return 1;
  }
  return a.name.localeCompare(b.name);
}

/**
 * Provides a list of all accountDefs known to the system.  These accounts need
 * not be loaded/active in memory.  (This differs from v1 where an account had
 * to be loaded to be reported, limiting our capability to lazy-load.)
 *
 * The data-representation provided to the front-end is a specialized wire-rep
 * that censors some data (passwords!), and XXX in the future will include some
 * overlay gunk.
 *
 * The `AccountManager` creates us and is responsible for telling us about
 * accounts being added and removed.  It is the one who listens to MailDB
 * events, not us!  This sets us apart from other TOC's that do their own
 * listening.  We do this because there is lazy-loading involved and it's
 * simpler to reason about if we don't announce the account until everything is
 * good to go.  (This also allows us to potentially introduce some additional
 * pre-reqs in the future.)
 */
export default function AccountsTOC() {
  evt.Emitter.call(this);
  logic.defineScope(this, 'AccountsTOC');

  this.accountDefs = this.items = [];
  this.accountDefsById = this.itemsById = new Map();
}
AccountsTOC.prototype = evt.mix({
  type: 'AccountsTOC',
  overlayNamespace: 'accounts',

  // We don't care about who references us because we have the lifetime of the
  // universe.
  __acquire() {
    return Promise.resolve(this);
  },

  __release() {
    // nothing to do
  },

  isKnownAccount(accountId) {
    return this.accountDefsById.has(accountId);
  },

  getAllItems() {
    return this.accountDefs.map(this.accountDefToWireRep);
  },

  getItemIndexById(id) {
    const item = this.itemsById.get(id);
    return this.items.indexOf(item);
  },

  /**
   * Add the account with the given accountDef to be tracked by the TOC,
   * returning the wireRep for the account for any legacy needs.  (We otherwise
   * have no useful return value, so why not do something ugly?)
   */
  __addAccount(accountDef) {
    let idx = bsearchForInsert(this.accountDefs, accountDef,
                               accountDefComparator);
    this.accountDefs.splice(idx, 0, accountDef);
    this.accountDefsById.set(accountDef.id, accountDef);
    logic(this, 'addAccount', { accountId: accountDef.id, index: idx });

    let wireRep = this.accountDefToWireRep(accountDef);
    this.emit('add', wireRep, idx);
  },

  __accountModified(accountDef) {
    // (Object identity holds here, and the number of accounts will always be
    // smallish, so just use indexOf.)
    let idx = this.accountDefs.indexOf(accountDef);
    if (idx === -1) {
      throw new Error('how do you have a different object?');
    }
    this.emit('change', this.accountDefToWireRep(accountDef), idx);
  },

  __removeAccountById(accountId) {
    let accountDef = this.accountDefsById.get(accountId);
    let idx = this.accountDefs.indexOf(accountDef);
    logic(this, 'removeAccountById', { accountId: accountId, index: idx });

    this.accountDefsById.delete(accountId);
    this.accountDefs.splice(idx, 1);

    this.emit('remove', accountId, idx);
  },

  accountDefToWireRep(accountDef) {
    return Object.assign(
      // NB: This structure is basically verbatim from v1.x to avoid
      // gratuitous change, but it could make sense to make varying changes.
      {
        id: accountDef.id,
        name: accountDef.name,
        type: accountDef.type,
        engine: accountDef.engine,

        defaultPriority: accountDef.defaultPriority,

        enabled: true, // XXX overlay mechanism or universe consultation?
        problems: [], // XXX ditto

        syncRange: accountDef.syncRange,
        syncInterval: accountDef.syncInterval,
        notifyOnNew: accountDef.notifyOnNew,
        playSoundOnSend: accountDef.playSoundOnSend,

        identities: accountDef.identities,

        credentials: {
          username: accountDef.credentials.username,
          outgoingUsername: accountDef.credentials.outgoingUsername,
          // no need to send the password to the UI.
          // send all the oauth2 stuff we've got, though.
          oauth2: accountDef.credentials.oauth2
        },

        servers: [
          {
            type: accountDef.receiveType,
            connInfo: accountDef.receiveConnInfo,
            activeConns: 0, // XXX overlay info but we have never used this
          },
          {
            type: accountDef.sendType,
            connInfo: accountDef.sendConnInfo,
            activeConns: 0, // XXX overlay info but we have never used this
          }
        ],
      },
      // Information about the engine is exposed from here.  This is what gives
      // us: engineFacts
      engineFrontEndAccountMeta.get(accountDef.engine)
    );
  },

});

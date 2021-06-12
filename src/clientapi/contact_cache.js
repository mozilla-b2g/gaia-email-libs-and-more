import MailPeep from './mail_peep';

/**
 * Caches contact lookups, both hits and misses, as well as updating the
 * MailPeep instances returned by resolve calls.
 *
 * We maintain strong maps from both contact id and e-mail address to MailPeep
 * instances.  We hold a strong reference because BridgedViewSlices already
 * require explicit lifecycle maintenance (aka call die() when done with them).
 * We need the contact id and e-mail address because when a contact is changed,
 * an e-mail address may be changed, and we don't get to see the old
 * representation.  So if the e-mail address was deleted, we need the contact id
 * mapping.  And if the e-mail address was added, we need the e-mail address
 * mapping.
 *
 * If the mozContacts API is not available, we just create inert MailPeep
 * instances that do not get tracked or updated.
 *
 * Domain notes:
 *
 * The contacts API does not enforce any constraints on the number of contacts
 * who can use an e-mail address, but the e-mail app only allows one contact
 * to correspond to an e-mail address at a time.
 */
var ContactCache = {
  /**
   * Maps e-mail addresses to the mozContact rep for the object, or null if
   * there was a miss.
   *
   * We explicitly do not want to choose an arbitrary MailPeep instance to
   * (re)use because it could lead to GC memory leaks if data/element/an expando
   * were set on the MailPeep and we did not zero it out when the owning slice
   * was destroyed.  We could, however, use the live set of peeps as a fallback
   * if we don't have a contact cached.
   */
  _contactCache: new Map(),
  /** The number of entries in the cache. */
  _cacheHitEntries: 0,
  /** The number of stored misses in the cache. */
  _cacheEmptyEntries: 0,

  /**
   * Maximum number of hit entries in the cache before we should clear the
   * cache.
   */
  MAX_CACHE_HITS: 256,
  /** Maximum number of empty entries to store in the cache before clearing. */
  MAX_CACHE_EMPTY: 1024,

  /** Maps contact id to lists of MailPeep instances. */
  _livePeepsById: new Map(),
  /** Maps e-mail addresses to lists of MailPeep instances */
  _livePeepsByEmail: new Map(),

  pendingLookupCount: 0,

  callbacks: [],

  init: function() {
    var contactsAPI = navigator.mozContacts;
    if (!contactsAPI) {
      return;
    }

    contactsAPI.oncontactchange = this._onContactChange.bind(this);
  },

  _resetCache: function() {
    this._contactCache.clear();
    this._cacheHitEntries = 0;
    this._cacheEmptyEntries = 0;
  },

  shutdown: function() {
    var contactsAPI = navigator.mozContacts;
    if (!contactsAPI) {
      return;
    }
    contactsAPI.oncontactchange = null;
  },

  /**
   * Perform an autocomplete lookup over the currently live MailPeep instances.
   * This is shoddy because we actually have two sources of email/human data
   * available to us: the mozContacts database and the corpus of mail addresses
   * in synchronized mail.  Doing the right thing is non-trivial.
   *
   * So we do the simplest, most pragmatic thing we can do, which is just walk
   * this cache.  It potentially has enough data to make it seem smart or at
   * least something smart that's broken/buggy.
   *
   * @return {Promise<MailPeep[]>}
   *   A Promise is resolved with a list of non-live matching MailPeep
   *   instances.  In the future they may be live and there may be some
   *   life-cycle management burden associated with this.  Or maybe we will
   *   return an `EntireListView` instance.
   */
  shoddyAutocomplete: function(phrase) {
    // string-for-regexp escaping logic from searchfilter.js that I worry about
    // a little:
    // TODO: use a proper factored-out/supported regexp-from-string module
    if (!(phrase instanceof RegExp)) {
      phrase = new RegExp(phrase.replace(/[-[\]/{}()*+?.\\^$|]/g,
                                         '\\$&'),
                          'i');
    }

    let matches = [];
    const MAX_MATCHES = 8;

    // The email map includes MailPeeps that are not backed by mozContacts as
    // well as ones that are, so that's the one to use.
    for (let peeps of this._livePeepsByEmail.values()) {
      // It's a list of practically identical instances, we only want one.
      let peep = peeps[0];
      if (peep.name) {
        if (phrase.exec(peep.name)) {
          matches.push(peep);
          if (matches.length >= MAX_MATCHES) {
            break;
          }
          continue;
        }
      }
      if (phrase.exec(peep.address)) {
        matches.push(peep);
        if (matches.length >= MAX_MATCHES) {
          break;
        }
        continue;
      }
      // NB: We could also look at fields on the actual mozContacts instance
      // if we had the instance.  (We don't.  Also this is a lazy hackjob
      // remember.)
    }

    return Promise.resolve(matches);
  },

  /**
   * Currently we process the updates in real-time as we get them.  There's an
   * inherent trade-off between chewing CPU when we're in the background and
   * minimizing latency when we are displayed.  We're biased towards minimizing
   * latency right now.
   *
   * All contact changes flush our contact cache rather than try and be fancy.
   * We are already fancy with the set of live peeps and our lookups could just
   * leverage that.  (The contact cache is just intended as a steady-state
   * high-throughput thing like when displaying messages in the UI.  We don't
   * expect a lot of contact changes to happen during that time.)
   *
   * For info on the events/triggers, see:
   * https://developer.mozilla.org/en-US/docs/DOM/ContactManager.oncontactchange
   */
  _onContactChange: function(event) {
    function cleanOutPeeps(livePeeps) {
      for (var iPeep = 0; iPeep < livePeeps.length; iPeep++) {
        var peep = livePeeps[iPeep];
        peep.contactId = null;
        peep.emit('change', peep);
      }
    }

    var contactsAPI = navigator.mozContacts;
    var livePeepsById = this._livePeepsById,
        livePeepsByEmail = this._livePeepsByEmail;

    // clear the cache if it has anything in it (per the above doc block)
    if (this._cacheHitEntries || this._cacheEmptyEntries) {
      this._resetCache();
    }

    // -- Contact removed OR all contacts removed!
    if (event.reason === 'remove') {
      // - all contacts removed! (clear() called)
      if (!event.contactID) {
        for (let livePeeps of livePeepsById.values()) {
          cleanOutPeeps(livePeeps);
        }
        livePeepsById.clear();
      }
      // - just one contact removed
      else {
        let livePeeps = livePeepsById.get(event.contactID);
        if (livePeeps) {
          cleanOutPeeps(livePeeps);
          livePeepsById.delete(event.contactID);
        }
      }
    }
    // -- Created or updated; we need to fetch the contact to investigate
    else {
      var req = contactsAPI.find({
        filterBy: ['id'],
        filterOp: 'equals',
        filterValue: event.contactID
      });
      req.onsuccess = function() {
        // If the contact disappeared we will hear a 'remove' event and so don't
        // need to process this.
        if (!req.result.length) {
          return;
        }
        var contact = req.result[0], iPeep, peep;

        // - process update with apparent e-mail address removal
        if (event.reason === 'update') {
          let livePeeps = livePeepsById.get(contact.id);
          if (livePeeps) {
            var contactEmails = contact.email ?
                  contact.email.map(function(e) { return e.value; }) :
                [];
            for (iPeep = 0; iPeep < livePeeps.length; iPeep++) {
              peep = livePeeps[iPeep];
              if (contactEmails.indexOf(peep.address) === -1) {
                // Need to fix-up iPeep because of the splice; reverse iteration
                // reorders our notifications and we don't want that, hence
                // this.
                livePeeps.splice(iPeep--, 1);
                peep.contactId = null;
                peep.emit('change', peep);
              }
            }
            if (livePeeps.length === 0) {
              livePeepsById.delete(contact.id);
            }
          }
        }
        // - process create/update causing new coverage
        if (!contact.email) {
          return;
        }
        for (var iEmail = 0; iEmail < contact.email.length; iEmail++) {
          var email = contact.email[iEmail].value;
          let livePeeps = livePeepsByEmail.get(email);
          // nothing to do if there are no peeps that use that email address
          if (!livePeeps) {
            continue;
          }

          for (iPeep = 0; iPeep < livePeeps.length; iPeep++) {
            peep = livePeeps[iPeep];
            // If the peep is not yet associated with this contact or any other
            // contact, then associate it.
            if (!peep.contactId) {
              peep.contactId = contact.id;
              var idLivePeeps = livePeepsById.get(peep.contactId);
              if (idLivePeeps === undefined) {
                idLivePeeps = [];
                livePeepsById.set(peep.contactId, idLivePeeps);
              }
              idLivePeeps.push(peep);
            }
            // However, if it's associated with a different contact, then just
            // skip the peep.
            else if (peep.contactId !== contact.id) {
              continue;
            }
            // (The peep must be associated with this contact, so update and
            // fire)

            if (contact.name && contact.name.length) {
              peep.name = contact.name[0];
            }
            peep.emit('change', peep);
          }
        }
      };
      // We don't need to do anything about onerror; the 'remove' event will
      // probably have fired in this case, making us correct.
    }
  },

  resolvePeeps: function(addressPairs) {
    if (addressPairs == null) {
      return null;
    }
    var resolved = [];
    for (var i = 0; i < addressPairs.length; i++) {
      resolved.push(this.resolvePeep(addressPairs[i]));
    }
    return resolved;
  },
  /**
   * Create a MailPeep instance with the best information available and return
   * it.  Information from the (moz)Contacts API always trumps the passed-in
   * information.  If we have a cache hit (which covers both positive and
   * negative evidence), we are done/all resolved immediately.  Otherwise, we
   * need to issue an async request.  In that case, you want to check
   * ContactCache.pendingLookupCount and push yourself onto
   * ContactCache.callbacks if you want to be notified when the current set of
   * lookups gets resolved.
   *
   * This is a slightly odd API, but it's based on the knowledge that for a
   * single e-mail we will potentially need to perform multiple lookups and that
   * e-mail addresses are also likely to come in batches so there's no need to
   * generate N callbacks when 1 will do.
   */
  resolvePeep: function(addressPair) {
    var emailAddress = addressPair.address;
    var entry = this._contactCache.get(emailAddress);
    var peep;
    var contactsAPI = navigator.mozContacts;
    // known miss; create miss peep
    // no contacts API, always a miss, skip out before extra logic happens
    if (entry === null || !contactsAPI) {
      peep = new MailPeep(addressPair.name || '', emailAddress, null, null);
      if (!contactsAPI) {
        return peep;
      }
    }
    // known contact; unpack contact info
    else if (entry !== undefined) {
      var name = addressPair.name || '';
      if (entry.name && entry.name.length) {
        name = entry.name[0];
      }
      peep = new MailPeep(
        name,
        emailAddress,
        entry.id,
        (entry.photo && entry.photo.length) ? entry.photo[0] : null);
    }
    // not yet looked-up; assume it's a miss and we'll fix-up if it's a hit
    else {
      peep = new MailPeep(addressPair.name || '',
                          emailAddress, null, null);

      // Place a speculative miss in the contact cache so that additional
      // requests take that path.  They will get fixed up when our lookup
      // returns (or if a change event happens to come in before our lookup
      // returns.)  Note that we do not do any hit/miss counting right now; we
      // wait for the result to come back.
      this._contactCache.set(emailAddress, null);

      this.pendingLookupCount++;

      // Search contacts, but use an all lower-case name, since the contacts
      // API's search plumbing uses a lowercase version of the email address
      // for these search comparisons. However, the actual display of the
      // contact in the contact app has casing preserved. emailAddress could
      // be undefined though if a group/undisclosed-recipients case, so guard
      // against that (deeper normalization fix tracked in bug 1097820). Using
      // empty string in the undefined emailAddress case because passing the
      // value of undefined directly in the filterValue results in some contacts
      // being returned. Potentially all contacts. However passing empty string
      // gives back no results, even if there is a contact with no email address
      // assigned to it.
      var filterValue = emailAddress ? emailAddress.toLowerCase() : '';
      var req = contactsAPI.find({
                  filterBy: ['email'],
                  filterOp: 'equals',
                  filterValue: filterValue
                });
      var self = this, handleResult = function() {
        if (req.result && req.result.length) {
          // CONSIDER TODO SOMEDAY: since the search is done witha a
          // toLowerCase() call, it is conceivable that we could get multiple
          // results with slightly different casing. It might be nice to try
          // to find the best casing match, but the payoff for that is likely
          // small, and the common case will be that the first one is good to
          // use.
          var contact = req.result[0];

          ContactCache._contactCache.set(emailAddress, contact);
          if (++ContactCache._cacheHitEntries > ContactCache.MAX_CACHE_HITS) {
            self._resetCache();
          }

          var peepsToFixup = self._livePeepsByEmail.get(emailAddress);
          // there might no longer be any MailPeeps alive to care; leave
          if (!peepsToFixup) {
            return;
          }
          for (let i = 0; i < peepsToFixup.length; i++) {
            let fixupPeep = peepsToFixup[i];
            if (!fixupPeep.contactId) {
              fixupPeep.contactId = contact.id;
              let livePeeps = self._livePeepsById.get(fixupPeep.contactId);
              if (livePeeps === undefined) {
                livePeeps = [];
                self._livePeepsById.set(fixupPeep.contactId, livePeeps);
              }
              livePeeps.push(fixupPeep);
            }

            if (contact.name && contact.name.length) {
              fixupPeep.name = contact.name[0];
            }
            if (contact.photo && contact.photo.length) {
              fixupPeep._thumbnailBlob = contact.photo[0];
            }

            // If no one is waiting for our/any request to complete, generate a
            // change notification.
            if (!self.callbacks.length) {
              fixupPeep.emit('change', fixupPeep);
            }
          }
        }
        else {
          ContactCache._contactCache.set(emailAddress, null);
          if (++ContactCache._cacheEmptyEntries > ContactCache.MAX_CACHE_EMPTY){
            self._resetCache();
          }
        }
        // Only notify callbacks if all outstanding lookups have completed
        if (--self.pendingLookupCount === 0) {
          for (let i = 0; i < ContactCache.callbacks.length; i++) {
            ContactCache.callbacks[i]();
          }
          ContactCache.callbacks.splice(0, ContactCache.callbacks.length);
        }
      };
      req.onsuccess = handleResult;
      req.onerror = handleResult;
    }

    // - track the peep in our lists of live peeps
    var livePeeps;
    livePeeps = this._livePeepsByEmail.get(emailAddress);
    if (livePeeps === undefined) {
      livePeeps = [];
      this._livePeepsByEmail.set(emailAddress, livePeeps);
    }
    livePeeps.push(peep);

    if (peep.contactId) {
      livePeeps = this._livePeepsById.get(peep.contactId);
      if (livePeeps === undefined) {
        livePeeps = [];
        this._livePeepsById.set(peep.contactId, livePeeps);
      }
      livePeeps.push(peep);
    }

    return peep;
  },

  forgetPeepInstances: function() {
    var livePeepsById = this._livePeepsById,
        livePeepsByEmail = this._livePeepsByEmail;
    for (var iArg = 0; iArg < arguments.length; iArg++) {
      var peeps = arguments[iArg];
      if (!peeps) {
        continue;
      }
      for (var iPeep = 0; iPeep < peeps.length; iPeep++) {
        var peep = peeps[iPeep], livePeeps, idx;
        if (peep.contactId) {
          livePeeps = livePeepsById.get(peep.contactId);
          if (livePeeps) {
            idx = livePeeps.indexOf(peep);
            if (idx !== -1) {
              livePeeps.splice(idx, 1);
              if (livePeeps.length === 0) {
                livePeepsById.delete(peep.contactId);
              }
            }
          }
        }
        livePeeps = livePeepsByEmail.get(peep.address);
        if (livePeeps) {
          idx = livePeeps.indexOf(peep);
          if (idx !== -1) {
            livePeeps.splice(idx, 1);
            if (livePeeps.length === 0) {
              livePeepsByEmail.delete(peep.address);
            }
          }
        }
      }
    }
  },
};

export default ContactCache;

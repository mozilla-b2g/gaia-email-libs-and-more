/**
 * Testhelper for faking mozContacts stuff.  We can change this to use the real
 * thing in the future, especially once we get bitten by this not being the
 * actual implementation.
 *
 * We are currently stubbing because we are running MailAPI on the worker in
 * our tests anyways, so mozContacts would need to be artificially remoted
 * anyways.  There may be some test runtime advantages to this too, but it's
 * not a primary concern.
 **/

define(
  [
    'rdcommon/log',
    'mailapi',
    'module',
    'exports'
  ],
  function(
    $log,
    $mailapi,
    $module,
    exports
  ) {

// avoid rep exposure breaking things
function clone(obj) {
  if (obj == null)
    return obj;
  var s = JSON.stringify(obj);
  try {
    return JSON.parse(s);
  }
  catch (ex) {
    console.error('Bad JSON somehow?', s);
    throw ex;
  }
}

/**
 *
 */
var TestContactsMixins = {
  __constructor: function(self, opts) {

    // -- clobber the mozContacts shim at static time
    // (if we do it dynamically, ordering will matter relative to when the
    // MailUnivers gets created.)
    self._savedFakeContactsImpl = window.navigator.mozContacts;

    self._nextContactID = 1;
    self._dbByEmail = {};
    self._dbByContactId = {};

    self._trappedFindCalls = null;

    /**
     * The fake mozContacts API.
     *
     * We support trapping by partially running the func and returning early.
     * When the traps complete, the method gets called again with the request
     * object originally returned.  This structuring is arbitrary.
     */
    self.contactsAPI = window.navigator.mozContacts = {

      find: function(options, _hackReq) {
        if (!options ||
            options.filterBy.length !== 1 ||
            (options.filterBy[0] !== 'email' &&
             options.filterBy[0] !== 'id') ||
            options.filterOp !== 'equals') {
          self._logger.unsupportedFindCall(options);
          throw new Error("Unsupported find call!");
        }
        var req;
        if (_hackReq) {
          req = _hackReq;
        }
        else {
          req = { onsuccess: null, onerror: null };
          self._logger.apiFind_begin(options.filterBy[0], options.filterOp,
                                     options.filterValue, null);
        }

        if (self._trappedFindCalls) {
          self._trappedFindCalls.push(
            { options: options, req: req });
          return req;
        }

        window.setZeroTimeout(function() {
          if (!req.onsuccess)
            return;
          var result;
          if (options.filterBy[0] === 'email') {
            var emailAddr = options.filterValue.toLowerCase();
            if (!self._dbByEmail.hasOwnProperty(emailAddr))
              result = [];
            else // this is already a list! no wrapping required!
              result = clone(self._dbByEmail[emailAddr]);
          }
          else if (options.filterBy[0] === 'id') {
            var id = options.filterValue;
            if (!self._dbByContactId.hasOwnProperty(id))
              result = [];
            else
              result = [clone(self._dbByContactId[id])];
          }
          self._logger.apiFind_end(options.filterBy[0], options.filterOp,
                                   options.filterValue, result);
          req.result = result;
          req.onsuccess({ target: req });
        });
        return req;
      },

      getAll: function(options) {
        self._logger.getAllCalled();
        throw new Error("getAll() is unsupported!");
      },

      _clear: function() {
        self._dbByEmail = {};
        self._dbByContactId = {};
        this._fireContactChange('remove', undefined);
      },

      clear: function() {
        this._clear();
      },

      _store: function(contact) {
        self._dbByContactId[contact.id] = contact;
        for (var i = 0; i < contact.email.length; i++) {
          var contactInfo = contact.email[i],
              emailAddr = contactInfo.value.toLowerCase();
          if (!self._dbByEmail.hasOwnProperty(emailAddr))
            self._dbByEmail[emailAddr] = [];
          self._dbByEmail[emailAddr].push(contact);
        }
      },

      _kill: function(contact) {
        if (!self._dbByContactId.hasOwnProperty(contact.id))
          return;
        // normalize instance
        contact = self._dbByContactId[contact.id];
        // remove from id map
        delete self._dbByContactId[contact.id];
        // remove e-mail entry mappings
        for (var i = 0; i < contact.email.length; i++) {
          var contactInfo = contact.email[i],
              emailAddr = contactInfo.value.toLowerCase();
          if (!self._dbByContactId.hasOwnProperty(emailAddr))
            continue;
          var list = self._dbByEmail[emailAddr],
              idx = list.indexOf(contact);
          if (idx !== -1)
            list.splice(idx, 1);
          if (list.length === 0)
          delete self._dbByEmail[emailAddr];
        }
      },

      _save: function(newContact, quiet) {
        newContact = clone(newContact); // avoid rep exposure
        var exists = newContact.id &&
                     self._dbByContactId.hasOwnProperty(newContact.id);
        var reason;
        if (exists) {
          reason = 'update';
          var oldContact = self._dbByContactId[newContact.id];
          this._kill(oldContact);
        }
        else {
          reason = 'create';
        }
        this._store(newContact);
        if (!quiet)
          this._fireContactChange(reason, newContact.id);
      },

      save: function(contact) {
        // we could log that the code-under-test called us
        this._save(contact);
      },

      _remove: function(contact) {
        this._kill(contact);
        this._fireContactChange('remove', contact.id);
      },

      remove: function(contact) {
        // we could log that the code-under-test called us
        if (!self._dbByContactId.hasOwnProperty(contact.id))
          return;
        this._remove(contact);
      },

      getSimContacts: function(type) {
        throw new Error('Not faked!');
      },

      oncontactchange: null,

      _fireContactChange: function(reason, contactID) {
        if (!self.contactsAPI.oncontactchange) {
          self._logger.unhandledContactchange(reason, contactID);
          return;
        }
        self._logger.oncontactchange(reason, contactID, null,
                                     self.contactsAPI.oncontactchange,
                                     { reason: reason, contactID: contactID });
      },
    };

    self.T.convenienceSetup(self, 'initializes', function() {
      self.__attachToLogger(LOGFAB.testContacts(self, null, self.__name));
      // force the ContactCache to reset its state entirely
      var ContactCache = $mailapi.ContactCache;
      ContactCache._resetCache();
      ContactCache._livePeepsById = Object.create(null);
      ContactCache._livePeepsByEmail = Object.create(null);
      ContactCache.pendingLookupCount = 0;
      ContactCache.callbacks = [];
    });
    self.T.convenienceDeferredCleanup(self, 'cleans up', function() {
      window.navigator.mozContacts = self._savedFakeContactsImpl;
    });
  },


  //////////////////////////////////////////////////////////////////////////////
  // Friendly APIs
  //
  // Simplify mucking with the contacts API for testing purposes and distinguish
  // calls made to the API by the unit tests from those made by the tested code.

  _mapEmails: function(emails) {
    if (!Array.isArray(emails))
      // always require a list to make it obvious more can be added
      throw('We take a list of emails!');
    return emails.map(function(email) {
      return { type: 'PREF', value: email };
    });
  },

  createContact: function(name, emails, quiet) {
    var contact = {
      id: this._nextContactID++,
      email: this._mapEmails(emails),
      photo: [],
    };
    if (name)
      contact.name = [name];

    this._logger.createContact(contact.id, contact);
    this.contactsAPI._save(contact, quiet);

    return contact;
  },

  updateContact: function(contact, name, emails) {
    contact = clone(contact);
    if (name)
      contact.name = [name];
    if (emails)
      contact.email = this._mapEmails(emails);
    this._logger.updateContact(contact.id, contact);
    this.contactsAPI._save(contact);
  },

  removeContact: function(contact) {
    this._logger.removeContact(contact.id, contact);
    this.contactsAPI._remove(contact);
  },

  clearContacts: function(contact) {
    this._logger.clearContacts();
    this.contactsAPI._clear();
  },

  /**
   * Cause calls to mozContacts.find() to get stored but not processed.
   */
  trapFindCalls: function() {
    this._trappedFindCalls = [];
  },

  /**
   * Cause all the calls to mozContacts.find() that `trapFindCalls` stuck in
   * limbo to actually run now.
   */
  releaseFindCalls: function() {
    var trapped = this._trappedFindCalls;
    this._trappedFindCalls = null;

    for (var i = 0; i < trapped.length; i++) {
      var trap = trapped[i];
      this.contactsAPI.find(trap.options, trap.req);
    }
  },
};

var LOGFAB = exports.LOGFAB = $log.register($module, {
  testContacts: {
    asyncJobs: {
      apiFind: { by: false, op: false, value: false, result: false },
    },
    calls: {
      oncontactchange: { reason: false, contactID: false },
    },
    events: {
      createContact: { id: false, contact: false },
      updateContact: { id: false, contact: false },
      removeContact: { id: false, contact: false },
      clearContacts: {},

      unhandledContactchange: { reason: false, contactID: false },
    },
    errors: {
      getAllCalled: {},
      unsupportedFindCall: { options: false },
    },
  },
});

exports.TESTHELPER = {
  LOGFAB_DEPS: [
    LOGFAB
  ],
  actorMixins: {
    testContacts: TestContactsMixins
  }
};


}); // end define

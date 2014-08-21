/**
 * Test ContactsCache logic.
 **/

define(['rdcommon/testcontext', './resources/th_main',
        './resources/th_contacts',
        'activesync/codepages/AirSync',
        'mailapi', 'exports'],
       function($tc, $th_main, $th_contacts, $airsync, $mailapi, exports) {
const FilterType = $airsync.Enums.FilterType;

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_mailapi_contacts' }, null,
  [$th_main.TESTHELPER, $th_contacts.TESTHELPER], ['app']);

function countKeysInObj(obj) {
  var count = 0;
  for (var key in obj) {
    count++;
  }
  return count;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * The data-model for mozContacts returns lists in places where you might not
 * really expect a list; check that all code paths subscript properly.  (We
 * had bugs before where we would return the DOMStringList; this would
 * stringify okay when there was only one entry, but structured cloning hates
 * DOMStringList and breaks, so it was bad.)
 *
 * There are 3 code paths we need to check:
 * 1) Cache miss where we have to perform the lookup then pull the data out
 *    when that call completes.
 * 2) Cache hit where we pull the data out synchronously.
 * 3) Cache miss that fails the lookup but then a create or update event
 *    causes the peep to be covered by a contact.  Both create and update
 *    use the same code as far as subscripting goes.
 */
TD.commonCase('get DOMStrings not DOMStringLists', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U'),
      testContacts = T.actor('testContacts', 'contacts'),
      eCheck = T.lazyLogger('check');
  var ContactCache = $mailapi.ContactCache;

  // Add our contact.
  var bobsName = 'Bob Bobbington',
      bobsEmail = 'bob@bob.nul';
  T.setup('create bob', function() {
    testContacts.createContact(bobsName, [bobsEmail], 'quiet');
  });

  T.group('cache miss, lookup hit');
  T.action(eCheck, 'bob asynchronously hits', function() {
    eCheck.expect_namedValue('isContact', true);
    eCheck.expect_namedValue('name', bobsName);
    testUniverse.MailAPI.resolveEmailAddressToPeep(bobsEmail, function(peep) {
      eCheck.namedValue('isContact', peep.isContact);
      eCheck.namedValue('name', peep.name);
    });
  });

  T.group('cache hit');
  T.action(eCheck, 'bob synchronously hits', function() {
    eCheck.expect_namedValue('isContact', true);
    eCheck.expect_namedValue('name', bobsName);
    testUniverse.MailAPI.resolveEmailAddressToPeep(bobsEmail, function(peep) {
      eCheck.namedValue('isContact', peep.isContact);
      eCheck.namedValue('name', peep.name);
    });
  });

  T.group('cache miss, lookup miss, event-driven hit');
  var samsName = 'Sam Sammington',
      samsEmail = 'sam@sam.nul';
  T.action(eCheck, 'sam and fail to resolve', function() {
    eCheck.expect_namedValue('isContact', false);
    // The name gets coerced to '' so it remains falsey but string coercion
    // rules avoid us ever having someone named "null"
    eCheck.expect_namedValue('name', '');
    testUniverse.MailAPI.resolveEmailAddressToPeep(samsEmail, function(peep) {
      eCheck.namedValue('isContact', peep.isContact);
      eCheck.namedValue('name', peep.name);

      // Set this up for the next step.
      peep.onchange = function() {
        eCheck.event('onchange');
        eCheck.namedValue('isContact', peep.isContact);
        eCheck.namedValue('name', peep.name);
      };
    });
  });
  T.action('create contact,', eCheck, 'sam', function() {
    eCheck.expect_event('onchange');
    eCheck.expect_namedValue('isContact', true);
    eCheck.expect_namedValue('name', samsName);
    // this will fire the onchange event we set up in the previous step
    testContacts.createContact(samsName, [samsEmail]);
  });

  T.group('cleanup');
});

/**
 * Make sure empty names don't cause us to freak out.  (Although freaking out
 * is a legitimate choice; who doesn't have a name?  Ghosts, that's who.)
 *
 * This test is a modified version of the DOMString/DOMStringList one.
 */
TD.commonCase('do not die on empty names', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U', { restored: true }),
      testContacts = T.actor('testContacts', 'contacts'),
      eCheck = T.lazyLogger('check');
  var ContactCache = $mailapi.ContactCache;

  // Add our contact.
  var bobsEmail = 'bob@bob.nul';
  T.setup('create bob', function() {
    testContacts.createContact(null, [bobsEmail], 'quiet');
  });

  T.group('cache miss, lookup hit');
  T.action(eCheck, 'bob asynchronously hits', function() {
    eCheck.expect_namedValue('isContact', true);
    // ContactCache coerces to '' for type reasons
    eCheck.expect_namedValue('name', '');
    testUniverse.MailAPI.resolveEmailAddressToPeep(bobsEmail, function(peep) {
      eCheck.namedValue('isContact', peep.isContact);
      eCheck.namedValue('name', peep.name);
    });
  });

  T.group('cache hit');
  T.action(eCheck, 'bob synchronously hits', function() {
    eCheck.expect_namedValue('isContact', true);
    // (null coerced to '')
    eCheck.expect_namedValue('name', '');
    testUniverse.MailAPI.resolveEmailAddressToPeep(bobsEmail, function(peep) {
      eCheck.namedValue('isContact', peep.isContact);
      eCheck.namedValue('name', peep.name);
    });
  });

  T.group('cache miss, lookup miss, event-driven hit');
  var samsEmail = 'sam@sam.nul';
  T.action(eCheck, 'sam and fail to resolve', function() {
    eCheck.expect_namedValue('isContact', false);
    // The name gets coerced to '' so it remains falsey but string coercion
    // rules avoid us ever having someone named "null"
    eCheck.expect_namedValue('name', '');
    testUniverse.MailAPI.resolveEmailAddressToPeep(samsEmail, function(peep) {
      eCheck.namedValue('isContact', peep.isContact);
      eCheck.namedValue('name', peep.name);

      // Set this up for the next step.
      peep.onchange = function() {
        eCheck.event('onchange');
        eCheck.namedValue('isContact', peep.isContact);
        eCheck.namedValue('name', peep.name);
      };
    });
  });
  T.action('create contact,', eCheck, 'sam', function() {
    eCheck.expect_event('onchange');
    eCheck.expect_namedValue('isContact', true);
    eCheck.expect_namedValue('name', '');
    // this will fire the onchange event we set up in the previous step
    testContacts.createContact(null, [samsEmail]);
  });

  T.group('cleanup');
});



/**
 * Make sure we clear the cache when we hit the appropriate number of hits
 * and empties.  We directly muck with the cache counters rather than mess
 * with the constants or actually generating all those hits/empties.
 *
 * We do test the operation of the cache as a byproduct of these checks.
 */
TD.commonCase('bounded cache size', function(T, RT) {
  T.group('setup');
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('testUniverse', 'U', { restored: true }),
      testContacts = T.actor('testContacts', 'contacts'),
      eCheck = T.lazyLogger('check');
  var ContactCache = $mailapi.ContactCache;

  // -- max out empties
  T.group('max out empties');
  T.action('add real hit, real empty', eCheck, function() {
    eCheck.expect_namedValue('pending lookups', 2);
    eCheck.expect_namedValue('pre-lookup hit name', 'Foo');
    eCheck.expect_namedValueD('expected hit isContact', true);
    eCheck.expect_namedValue('expected hit name', 'Mr. Foo');
    eCheck.expect_namedValueD('expected empty isContact', false);

    eCheck.expect_namedValue('post-lookup hit count', 1);
    eCheck.expect_namedValue('post-lookup empty count', 1);
    eCheck.expect_namedValue('post-lookup cache entry count', 2);

    testContacts.createContact('Mr. Foo', ['foo@bar']);

    var shouldHit = ContactCache.resolvePeep(
                      { name: 'Foo', address: 'foo@bar' });
    var shouldEmpty = ContactCache.resolvePeep(
                        { name: 'Baz', address: 'baz@bar' });

    eCheck.namedValue('pending lookups',
                      ContactCache.pendingLookupCount);
    eCheck.namedValue('pre-lookup hit name', shouldHit.name);
    ContactCache.callbacks.push(function() {
      eCheck.namedValueD('expected hit isContact', shouldHit.isContact,
                         shouldHit);
      eCheck.namedValue('expected hit name', shouldHit.name);
      eCheck.namedValueD('expected empty isContact', shouldEmpty.isContact,
                         shouldEmpty);

      eCheck.namedValue('post-lookup hit count',
                        ContactCache._cacheHitEntries);
      eCheck.namedValue('post-lookup empty count',
                        ContactCache._cacheEmptyEntries);
      eCheck.namedValue('post-lookup cache entry count',
                        countKeysInObj(ContactCache._contactCache));
    });
  });
  T.action('max empties, trigger additional empty, observe clear', eCheck,
           function() {
    eCheck.expect_namedValue('pending lookups', 1);
    eCheck.expect_namedValue('expected empty isContact', false);
    eCheck.expect_namedValue('post-lookup hit count', 0);
    eCheck.expect_namedValue('post-lookup empty count', 0);
    eCheck.expect_namedValue('post-lookup cache entry count', 0);

    // the comparison for reset is '>' which matches with our name here.
    ContactCache._cacheEmptyEntries = ContactCache.MAX_CACHE_EMPTY;

    var shouldEmpty = ContactCache.resolvePeep(
                        { name: 'Zorro', address: 'zor@o' });
    eCheck.namedValue('pending lookups',
                      ContactCache.pendingLookupCount);
    ContactCache.callbacks.push(function() {
      eCheck.namedValue('expected empty isContact', shouldEmpty.isContact);

      eCheck.namedValue('post-lookup hit count',
                        ContactCache._cacheHitEntries);
      eCheck.namedValue('post-lookup empty count',
                        ContactCache._cacheEmptyEntries);
      eCheck.namedValue('post-lookup cache entry count',
                        countKeysInObj(ContactCache._contactCache));
    });
  });
  // So, it's not like this our dream behaviour, but let's test what we're
  // trying to do.
  T.action('looking up our clearing empty is a miss the next time', eCheck,
           function() {
    eCheck.expect_namedValue('pending lookups', 1);
    eCheck.expect_namedValue('expected empty isContact', false);

    eCheck.expect_namedValue('post-lookup hit count', 0);
    eCheck.expect_namedValue('post-lookup empty count', 1);
    eCheck.expect_namedValue('post-lookup cache entry count', 1);

    var shouldEmpty = ContactCache.resolvePeep(
                        { name: 'Zorro', address: 'zor@o' });
    eCheck.namedValue('pending lookups',
                      ContactCache.pendingLookupCount);
    ContactCache.callbacks.push(function() {
      eCheck.namedValue('expected empty isContact', shouldEmpty.isContact);

      eCheck.namedValue('post-lookup hit count',
                        ContactCache._cacheHitEntries);
      eCheck.namedValue('post-lookup empty count',
                        ContactCache._cacheEmptyEntries);
      eCheck.namedValue('post-lookup cache entry count',
                        countKeysInObj(ContactCache._contactCache));
    });
  });


  // -- max out hits
  T.group('max out hits');
  T.action('add real hit, still have real empty', eCheck, function() {
    eCheck.expect_namedValue('pending lookups', 1);
    eCheck.expect_namedValue('expected hit isContact', true);

    eCheck.expect_namedValue('post-lookup hit count', 1);
    eCheck.expect_namedValue('post-lookup empty count', 1);
    eCheck.expect_namedValue('post-lookup cache entry count', 2);

    var shouldHit = ContactCache.resolvePeep(
                      { name: 'Foo', address: 'foo@bar' });

    eCheck.namedValue('pending lookups',
                      ContactCache.pendingLookupCount);
    ContactCache.callbacks.push(function() {
      eCheck.namedValue('expected hit isContact', shouldHit.isContact);

      eCheck.namedValue('post-lookup hit count',
                        ContactCache._cacheHitEntries);
      eCheck.namedValue('post-lookup empty count',
                        ContactCache._cacheEmptyEntries);
      eCheck.namedValue('post-lookup cache entry count',
                        countKeysInObj(ContactCache._contactCache));
    });
  });
  T.action('max hits, trigger additional hit, observe clear', eCheck,
           function() {
    eCheck.expect_namedValue('pending lookups', 1);
    eCheck.expect_namedValueD('expected hit isContact', true);
    eCheck.expect_namedValue('post-lookup hit count', 0);
    eCheck.expect_namedValue('post-lookup empty count', 0);
    eCheck.expect_namedValue('post-lookup cache entry count', 0);

    testContacts.createContact('El Kabong', ['ka@bong']);

    // the comparison for reset is '>' which matches with our name here.
    ContactCache._cacheHitEntries = ContactCache.MAX_CACHE_HITS;

    var shouldHit = ContactCache.resolvePeep(
                        { name: 'Kabong', address: 'ka@bong' });
    eCheck.namedValue('pending lookups',
                      ContactCache.pendingLookupCount);
    ContactCache.callbacks.push(function() {
      eCheck.namedValueD('expected hit isContact', shouldHit.isContact,
                         shouldHit);

      eCheck.namedValue('post-lookup hit count',
                        ContactCache._cacheHitEntries);
      eCheck.namedValue('post-lookup empty count',
                        ContactCache._cacheEmptyEntries);
      eCheck.namedValue('post-lookup cache entry count',
                        countKeysInObj(ContactCache._contactCache));
    });
  });
  // So, it's not like this our dream behaviour, but let's test what we're
  // trying to do.
  T.action('looking up our clearing hit is a miss the next time', eCheck,
           function() {
    eCheck.expect_namedValue('pending lookups', 1);
    eCheck.expect_namedValueD('expected hit isContact', true);

    eCheck.expect_namedValue('post-lookup hit count', 1);
    eCheck.expect_namedValue('post-lookup empty count', 0);
    eCheck.expect_namedValue('post-lookup cache entry count', 1);

    var shouldHit = ContactCache.resolvePeep(
                        { name: 'Kabong', address: 'ka@bong' });
    eCheck.namedValue('pending lookups',
                      ContactCache.pendingLookupCount);
    ContactCache.callbacks.push(function() {
      eCheck.namedValueD('expected hit isContact', shouldHit.isContact,
                         shouldHit);

      eCheck.namedValue('post-lookup hit count',
                        ContactCache._cacheHitEntries);
      eCheck.namedValue('post-lookup empty count',
                        ContactCache._cacheEmptyEntries);
      eCheck.namedValue('post-lookup cache entry count',
                        countKeysInObj(ContactCache._contactCache));
    });
  });

  T.group('cleanup');
});

/**
 * Test we do the right thing in response to updates
 * - Contact hit, nothing we care about changed.
 * - Contact hit, name change.
 * - Contact hit, unrelated extra e-mail added.
 * - Contact hit, e-mail changed, no longer a hit.
 * - Contact miss, new contact created with e-mail, now a hit.
 * - Contact miss, existing contact changed to include e-mail, now a hit.
 * - Two contact hits, clear contacts DB, both become misses, cache cleared
 *   out.
 */
TD.commonCase('oncontactchange processing', function(T, RT) {
  T.group('setup');
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('testUniverse', 'U', { restored: true }),
      testContacts = T.actor('testContacts', 'contacts'),
      eCheck = T.lazyLogger('check');
  var ContactCache = $mailapi.ContactCache;

  /**
   * Helper to create and resolve contacts.
   *
   * We duplicate the contents of our resolve/preChange/postChange argument lists
   * in order to make sure that our event notifications fire for all of their
   * live peeps, not just the first one/last one/etc.
   *
   * @typedef[ContactSetArgs @dict[
   *   @key[name #:optional String]
   *   @key[emails #:optional @listof[String]]
   * ]]
   * @typedef[ContactCheckArgs @dict[
   *   @key[isContact Boolean]
   *   @key[name String]
   * ]]
   *
   * @args[
   *   @param[args @dict[
   *     @key[create @listof[ContactSetArgs]]
   *     @key[resolve @listof[AddressPair]]
   *     @key[preChange @listof[ContactCheckArgs]]
   *     @key[change @listof[ContactSetArgs]]
   *     @key[postChange @listof[ContactCheckArgs]]
   *   ]]
   * ]
   */
  function checkMutation(args) {
    function dupeList(list) {
      var duped = [];
      for (var i = 0; i < list.length; i++) {
        duped.push(list[i]);
      }
      return duped;
    }
    args = {
      create: args.create,
      resolve: dupeList(args.resolve),
      preChange: dupeList(args.preChange),
      change: args.change,
      postChange: dupeList(args.postChange),
    };
    var mailPeeps;
    T.action(eCheck, 'it', function() {
      // - create the contacts, trigger resolution
      var contacts = args.create.map(function(def) {
        // Do not generate notifications for our initial creation; we are trying
        // to just act like the contact has already existed.
        return testContacts.createContact(def.name, def.emails, 'quiet');
      });
      mailPeeps = args.resolve.map(function(addresspair, idx) {
        var mailPeep = ContactCache.resolvePeep(addresspair);
        mailPeep.onchange = function() {
          eCheck.event('MailPeep ' + idx + ' onchange');
          eCheck.namedValue('MailPeep ' + idx + ' isContact',
                            mailPeep.isContact);
          eCheck.namedValue('MailPeep ' + idx + ' name',
                            mailPeep.name);
          // the e-mail address is what we are keying off of, so it can't change
          // in this test.
        };
        return mailPeep;
      });

      function expectLookups() {
        eCheck.expect_eventD('resolved');
        args.preChange.forEach(function(def, idx) {
          eCheck.expect_namedValue('MailPeep ' + idx + ' isContact', def.isContact);
          eCheck.expect_namedValue('MailPeep ' + idx + ' name', def.name);
        });
      }
      function lookupsCompleted() {
        eCheck.eventD('resolved',
                      { liveById: clone(ContactCache._livePeepsById),
                        liveByEmail: clone(ContactCache._livePeepsByEmail) });
        mailPeeps.forEach(function(peep, idx) {
          eCheck.namedValue('MailPeep ' + idx + ' isContact', peep.isContact);
          eCheck.namedValue('MailPeep ' + idx + ' name', peep.name);
        });

        // - generate changes only after lookups are complete!
        if (args.change === 'clear') {
          testContacts.clearContacts();
        }
        else {
          args.change.forEach(function(changeDef, idx) {
            if (idx >= contacts.length) {
              contacts.push(testContacts.createContact(changeDef.name,
                                                       changeDef.emails));
            }
            else {
              testContacts.updateContact(contacts[idx], changeDef.name,
                                         changeDef.emails);
            }
          });
        }
      };

      // We want to expect that we get the event in the first place (per the
      // boolean, then check that the values are consistent with our mutations.)
      if (ContactCache.pendingLookupCount) {
        expectLookups();
        ContactCache.callbacks.push(function() {
          lookupsCompleted();
        });
      }
      else {
        expectLookups();
        lookupsCompleted();
      }

      args.postChange.forEach(function(expChange, idx) {
        eCheck.expect_event('MailPeep ' + idx + ' onchange');
        eCheck.expect_namedValue('MailPeep ' + idx + ' isContact',
                                 expChange.isContact);
        eCheck.expect_namedValue('MailPeep ' + idx + ' name',
                                 expChange.name);
      });
    });
    T.cleanup(eCheck, 'kill MailPeeps', function() {
      eCheck.expect_namedValue('live peeps by id', Object.create(null));
      eCheck.expect_namedValue('live peeps by email', Object.create(null));
      ContactCache.forgetPeepInstances(mailPeeps);
      eCheck.namedValue('live peeps by id', ContactCache._livePeepsById);
      eCheck.namedValue('live peeps by email', ContactCache._livePeepsByEmail);
    });
  }

  T.group('Contact hit, nothing we care about changed');
  checkMutation({
    create: [{ name: 'A', emails: ['a@example.nul'] }],
    resolve: [{ name: 'blah', address: 'a@example.nul' }],
    preChange: [{ isContact: true, name: 'A' }],
    change: [{}],
    postChange: [{ isContact: true, name: 'A' }]
  });


  T.group('Contact hit, name change');
  checkMutation({
    create: [{ name: 'B', emails: ['b@example.nul'] }],
    resolve: [{ name: 'blah', address: 'b@example.nul'}],
    preChange: [{ isContact: true, name: 'B' }],
    change: [{ name: 'Bob' }],
    postChange: [{ isContact: true, name: 'Bob' }]
  });

  T.group('Contact hit, unrelated extra e-mail added');
  checkMutation({
    create: [{ name: 'C', emails: ['c@example.nul'] }],
    resolve: [{ name: 'blah', address: 'c@example.nul' }],
    preChange: [{ isContact: true, name: 'C' }],
    change: [{ emails: ['c@example.nul', 'c2@example.nul'] }],
    postChange: [{ isContact: true, name: 'C' }]
  });

  T.group('Contact hit, e-mail changed, no longer a hit');
  checkMutation({
    create: [{ name: 'D', emails: ['d@example.nul'] }],
    resolve: [{ name: 'blah', address: 'd@example.nul' }],
    preChange: [{ isContact: true, name: 'D' }],
    change: [{ name: 'Doug', emails: ['d-alt@example.nul'] }],
    // the name change does not get applied because the e-mail no longer applies
    postChange: [{ isContact: false, name: 'D' }]
  });

  T.group('Contact hit on 2nd email, 2nd email removed, no longer a hit');
  checkMutation({
    create: [{ name: 'Dalt', emails: ['d1@example.nul', 'd2@example.nul'] }],
    resolve: [{ name: 'blah', address: 'd2@example.nul' }],
    preChange: [{ isContact: true, name: 'Dalt' }],
    change: [{ name: 'Dalt2', emails: ['d1@example.nul'] }],
    // the name change does not get applied because the e-mail no longer applies
    postChange: [{ isContact: false, name: 'Dalt' }]
  });

  T.group('Contact miss, new contact created with e-mail, now a hit');
  checkMutation({
    create: [],
    resolve: [{ name: 'blah', address: 'e@example.nul' }],
    preChange: [{ isContact: false, name: 'blah' }],
    change: [{ name: 'E', emails: ['e@example.nul'] }],
    postChange: [{ isContact: true, name: 'E' }]
  });

  T.group('Contact miss, existing contact changed to include e-mail, now a hit');
  checkMutation({
    create: [{ name: 'F', emails: ['f-wrong@example.nul'] }],
    resolve: [{ name: 'blah', address: 'f@example.nul' }],
    preChange: [{ isContact: false, name: 'blah' }],
    change: [{ emails: ['f@example.nul'] }],
    postChange: [{ isContact: true, name: 'F' }]
  });

  T.group('Two contact hits, clear contacts DB, both become misses');
  checkMutation({
    create: [{ name: 'Y', emails: ['y@example.nul'] },
             { name: 'Z', emails: ['z@example.nul'] }],
    resolve: [{ name: 'y', address: 'y@example.nul' },
              { name: 'z', address: 'z@example.nul' }],
    preChange: [{ isContact: true, name: 'Y' },
                { isContact: true, name: 'Z' }],
    change: 'clear',
    postChange: [{ isContact: false, name: 'Y' },
                 { isContact: false, name: 'Z' }]
  });

  T.group('cleanup');
});

/**
 * It's vitally important that we do not leak references to our MailPeep
 * instances.  So we check that:
 * - If a message is added, the count of live MailPeeps is appropriately increased.
 * - If a message is removed, the count of live MailPeeps is appropriately
 *   reduced.
 * - If a slice is killed, the count of live MailPeeps is appropriately
 *   reduced (to zero, in this case.)
 */
TD.commonCase('live peep tracking', function(T, RT) {
  T.group('setup');
  var TEST_PARAMS = RT.envOptions;
  var testUniverse = T.actor('testUniverse', 'U', { restored: true }),
      testAccount = T.actor('testAccount', 'A',
                            { universe: testUniverse }),
      testContacts = T.actor('testContacts', 'contacts'),
      eCheck = T.lazyLogger('check');
  var ContactCache = $mailapi.ContactCache;

  function countLiveThings() {
    var byIdCount = 0, byEmailCount = 0;
    for (var contactId in ContactCache._livePeepsById) {
      byIdCount += ContactCache._livePeepsById[contactId].length;
    }
    for (var email in ContactCache._livePeepsByEmail) {
      byEmailCount += ContactCache._livePeepsByEmail[email].length;
    }
    return byIdCount + byEmailCount;
  }

  function expectAndCheckLiveCounts(expected) {
    T.check(eCheck, 'live counts', function() {
      eCheck.expect_namedValueD('live', expected);
      eCheck.namedValueD('live', countLiveThings(),
                         { liveById: clone(ContactCache._livePeepsById),
                           liveByEmail: clone(ContactCache._livePeepsByEmail) });
    });
  }

  var testFolder = testAccount.do_createTestFolder(
    'test_contacts',
    { count: 2, age: { days: 2 }, age_incr: { days: 1 } });

  T.group('2 messages = 4 alive');

  var folderView = testAccount.do_openFolderView(
    'sync', testFolder,
    [{ count: 2, full: 2, flags: 0, deleted: 0,
       filterType: FilterType.NoFilter }],
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  // 2 messages with 1 author and 1 recipient, none of which are contacts =>
  // 2 * (1 + 1) = 4
  expectAndCheckLiveCounts(4);

  T.group('1 deleted => 1 message = 2 alive');
  testAccount.do_deleteMessagesOnServerThenRefresh(folderView, [0]);
  expectAndCheckLiveCounts(2);

  T.group('2 added => 3 messages = 6 alive');
  var addedMessages = [];
  testAccount.do_addMessagesToFolder(
    testFolder,
    { count: 2, age: { days: 0 }, age_incr: { days: 1 } },
    { pushMessagesTo: addedMessages });
  testAccount.do_refreshFolderView(
    folderView,
    { count: 3, full: 2, flags: 1, deleted: 0 },
    { additions: addedMessages, changes: [], deletions: [] },
    { top: true, bottom: true, grow: false },
    { syncedToDawnOfTime: true });

  expectAndCheckLiveCounts(6);

  T.group('slice killed = 0 alive');
  testAccount.do_closeFolderView(folderView);
  expectAndCheckLiveCounts(0);

  T.group('cleanup');
});

}); // end define

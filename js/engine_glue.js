define(function() {
'use strict';

/**
 * The home for all engine abstractions; if you add a new account type or engine
 * then this is ideally the only place it gets added.  Some changes may happen
 * in the future to define these all as optional extensions that the app_logic
 * gets to decide on.  This module provides a means of requiring/loading the
 * givenengine modules on demand, as well as providing metadata about engines.
 *
 * Currently we use two type of identifiers:
 * - Account Type Strings (old, but not going away):
 *   - imap+smtp
 *   - pop3+smtp
 *   - activesync
 * - Engine Id Strings (new):
 *   - gmailImap
 *   - vanillaImap
 *   - activesync
 *   - pop3
 */
return {
  /**
   * Maps account types to their configurator module id.  It's assumed that the
   * module requiring them is under ./tasks.
   */
  configuratorModules: new Map([
    [
      'activesync',
      function() {
        return new Promise(function(resolve) {
          require(['gelam/activesync/configurator'], function(mod) {
            resolve(mod);
          });
        });
      }
    ],
    [
      'imap+smtp',
      function() {
        return new Promise(function(resolve) {
          require(['gelam/composite/configurator'], function(mod) {
            resolve(mod);
          });
        });
      }
    ],
    [
      'pop3+smtp',
      function() {
        return new Promise(function(resolve) {
          require(['gelam/composite/configurator'], function(mod) {
            resolve(mod);
          });
        });
      }
    ]
  ]),

  /**
   * Maps account types to their validator module id.  It's assumed that the
   * module requiring them is under ./tasks.
   */
  validatorModules: new Map([
    [
      'activesync',
      function() {
        return new Promise(function(resolve) {
          require(['gelam/activesync/validator'], function(mod) {
            resolve(mod);
          });
        });
      }
    ],
    [
      'imap+smtp',
      function() {
        return new Promise(function(resolve) {
          require(['gelam/composite/validator'], function(mod) {
            resolve(mod);
          });
        });
      }
    ],
    [
      'pop3+smtp',
      function() {
        return new Promise(function(resolve) {
          require(['gelam/composite/validator'], function(mod) {
            resolve(mod);
          });
        });
      }
    ]
  ]),

  /**
   * Maps account types to their account module id.  It's assumed that the
   * module requiring them is ./universe/account_manager.
   */
  accountModules: new Map([
    [
      'activesync',
      function() {
        return new Promise(function(resolve) {
          require(['gelam/activesync/account'], function(mod) {
            resolve(mod);
          });
        });
      }
    ],
    [
      'imap+smtp',
      function() {
        return new Promise(function(resolve) {
          require(['gelam/composite/account'], function(mod) {
            resolve(mod);
          });
        });
      }
    ],
    [
      'pop3+smtp',
      function() {
        return new Promise(function(resolve) {
          require(['gelam/composite/account'], function(mod) {
            resolve(mod);
          });
        });
      }
    ]
  ]),

  /**
   * Maps engine id's to their task module id.  It's assumed that the module
   * requiring them is ./universe/account_manager, or something equally nested.
   */
  engineTaskMappings: new Map([
    [
      'gmailImap',
      function() {
        return new Promise(function(resolve) {
          require(['gelam/imap/gmail_tasks'], function(mod) {
            resolve(mod);
          });
        });
      }
    ],
    [
      'vanillaImap',
      function() {
        return new Promise(function(resolve) {
          require(['gelam/imap/vanilla_tasks'], function(mod) {
            resolve(mod);
          });
        });
      }
    ],
    [
      'activesync',
      function() {
        return new Promise(function(resolve) {
          require(['gelam/activesync/activesync_tasks'], function(mod) {
            resolve(mod);
          });
        });
      }
    ],
    [
      'pop3',
      function() {
        return new Promise(function(resolve) {
          require(['gelam/pop3/pop3_tasks'], function(mod) {
            resolve(mod);
          });
        });
      }
    ]
  ]),

  /**
   * In those cases where there's something that we need to hack because of
   * current engine limitations, put it here.  All the guilt in one place.
   */
  engineHacks: new Map([
    [
      'gmailImap',
      {
        // For various reasons of things not exploding, we are disabling
        // certain folder types.  See below for details.
        unselectableFolderTypes: new Set([
          // Currently if the user ever enters the "all mail" folder, we will
          // end up synchronizing every new message the user ever receives after
          // this point.  This will turn out badly.
          'all',
          // The sync engine doesn't know how to deal with folders that aren't
          // covered by all mail.
          'junk', 'trash'
        ])
      }
    ],
    [
      'vanillaImap',
      {
        unselectableFolderTypes: new Set()
      }
    ],
    [
      'activesync',
      {
        unselectableFolderTypes: new Set()
      }
    ],
    [
      'pop3',
      {
        unselectableFolderTypes: new Set()
      }
    ]
  ]),

  /**
   * Maps engine id's to metadata about engines for use by the back-end.
   * Exposed by AccountManager.getAccountEngineFacts(accountId), but you could
   * also access it directly yourself.
   *
   * While it looks like there's a lot of overlap/duplication with
   * engineFrontEndAccountMeta and engineFrontEndFolderMeta, and there is, it's
   * desirable to avoid overloading any of these.  Also, we can safely be more
   * cavalier in our naming for the back-end since it's all internal API.
   */
  engineBackEndFacts: new Map([
    [
      'gmailImap',
      {
        syncGranularity: 'account'
      }
    ],
    [
      'vanillaImap',
      {
        syncGranularity: 'folder'
      }
    ],
    [
      'activesync',
      {
        syncGranularity: 'folder'
      }
    ],
    [
      'pop3',
      {
        syncGranularity: 'folder'
      }
    ]
  ]),

  /**
   * Maps engine id's to metadata about engines to tell the front-end by
   * annotating stuff onto the account wire rep.  This was brought into
   * existence for syncGranularity purposes, but the idea is that anything that
   * varies on an account/engine basis should go in here.  This allows new
   * useful info to be added without requiring the front-end to have its own
   * hardcoded assumptions or us to stick it in the account defs and migrate the
   * accounts, etc.
   *
   * The keys are engine id's, the values are Objects that are mixed into the
   * returned account info sent via the AccountsTOC.  In general I suggest we
   * try and cluster things into things like `engineFacts`.
   */
  engineFrontEndAccountMeta: new Map([
    [
      'gmailImap',
      {
        engineFacts: {
          syncGranularity: 'account'
        },
        usesArchiveMetaphor: true
      }
    ],
    [
      'vanillaImap',
      {
        engineFacts: {
          syncGranularity: 'folder'
        },
        usesArchiveMetaphor: false
      }
    ],
    [
      'activesync',
      {
        engineFacts: {
          syncGranularity: 'folder'
        },
        usesArchiveMetaphor: false
      }
    ],
    [
      'pop3',
      {
        engineFacts: {
          // This could arguably be 'account' too, but that would hinge on us
          // having some type of local folder stuff going on.  We can of course
          // revisit this as needed.
          syncGranularity: 'folder'
        },
        usesArchiveMetaphor: false
      }
    ]
  ]),

  /**
   * Maps engine id's to metadata about engines to tell the front-end by
   * annotating stuff onto account-owned folder reps.  Same deal as
   * `engineFrontEndAccountMeta` but for folders, basically.
   *
   * Note that we currently do not wrap things under anything like `engineFacts`
   * because we want to let folders generally be engine-agnostic.  (While
   * the engine is a huge aspect of what an account is, and the account wire
   * rep is already a big soupy mess of stuff.)
   */
  engineFrontEndFolderMeta: new Map([
    [
      'gmailImap',
      {
        syncGranularity: 'account'
      }
    ],
    [
      'vanillaImap',
      {
        syncGranularity: 'folder'
      }
    ],
    [
      'activesync',
      {
        syncGranularity: 'folder'
      }
    ],
    [
      'pop3',
      {
        syncGranularity: 'folder'
      }
    ]
  ]),
};
});

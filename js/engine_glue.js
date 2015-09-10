define(function() {
'use strict';

/**
 * We map arbitrary engine-related identifiers to the module identifiers of the
 * modules that provide them.  It's on you to do the require() call yourself.
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
      '../activesync/configurator'
    ],
    [
      'imap+smtp',
      '../composite/configurator'
    ],
    [
      'pop3+smtp',
      '../composite/configurator'
    ]
  ]),

  /**
   * Maps account types to their validator module id.  It's assumed that the
   * module requiring them is under ./tasks.
   */
  validatorModules: new Map([
    [
      'activesync',
      '../activesync/validator'
    ],
    [
      'imap+smtp',
      '../composite/validator'
    ],
    [
      'pop3+smtp',
      '../composite/validator'
    ]
  ]),

  /**
   * Maps account types to their account module id.  It's assumed that the
   * module requiring them is ./universe/account_manager.
   */
  accountModules: new Map([
    [
      'activesync',
      '../activesync/account'
    ],
    [
      'imap+smtp',
      '../composite/account'
    ],
    [
      'pop3+smtp',
      '../composite/account'
    ]
  ]),

  /**
   * Maps engine id's to their task module id.  It's assumed that the module
   * requiring them is ./universe/account_manager, or something equally nested.
   */
  engineTaskMappings: new Map([
    [
      'gmailImap',
      '../imap/gmail_tasks'
    ],
    [
      'vanillaImap',
      '../imap/vanilla_tasks'
    ],
    [
      'activesync',
      '../activesync/activesync_tasks'
    ],
    [
      'pop3',
      '../pop3/pop3_tasks'
    ]
  ])
};
});

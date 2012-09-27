/**
 * Drives periodic synchronization, covering the scheduling, deciding what
 * folders to sync, and generating notifications to relay to the UI.
 * mozAlarm to schedule ourselves to wake up when our next synchronization
 * should occur.
 *
 * All synchronization occurs in parallel because we want the interval that we
 * force the device's radio into higher power modes to be as short as possible.
 **/

define(
  [
    'exports'
  ],
  function(
    exports
  ) {


/**
 *
 * @args[
 *   @param[accountHolder]{
 *     Anything with an attribute 'accounts' that lists the accounts, but
 *     pretty much just the `MailUniverse`.  The goal is to avoid needing to be
 *     explicitly notified when the list of accounts changes (and not break if
 *     an entirely new list is assigned).
 *   }
 * ]
 */
function CronSyncer(accountHolder) {
  this._accountHolder = accountHolder;


}
CronSyncer.prototype = {
  /**
   * Synchronize the given account.  Right now this is just the Inbox for the
   * account.
   */
  syncAccount: function(account) {
  },

  shutdown: function() {
  }
};

}); // end define

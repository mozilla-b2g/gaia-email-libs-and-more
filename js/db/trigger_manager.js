define(function() {
'use strict';

/**
 * Helps the trigger implementations be clean and have a chance of being
 * understood and debugged.  Specifically, it:
 * - Registers the declarative triggers with the MailDB using on.  (The trigger
 *   implementation just describes what it wants to listen on.)
 * - Does bind magic so that the first argument to each trigger is an automagic
 *   helper that is the means of the trigger having a side-effect.  This allows
 *   us to optionally crank up the debug if we want, or just be lazy and
 *   simple.  We have the trigger call a method rather than just returning a
 *   value because triggers will usually not have to do anything, etc.
 */
function TriggerManager() {

}
TriggerManager.prototype = {

};
});

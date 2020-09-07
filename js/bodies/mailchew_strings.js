/* Holds localized strings fo mailchew. mailbridge will set the values.
 * This is broken out as a separate module so that mailchew can be loaded
 * async as needed.
 **/

import evt from 'evt';

export const events = new evt.Emitter();

// This will get mutated below.  ES Module bindings are live, so this should
// technically work, but maybe our consumer just listens for the event and its
// payload anyways?
export let strings = null;

export function set(_strings) {
  strings = _strings;
  events.emit('strings', strings);
}


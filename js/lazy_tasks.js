define(function(require) {
'use strict';

/**
 * At some point we want to lazy-load the various tasks, which implies a mapping
 * from names to things to require.  (Possibly via naming convention, possibly
 * via build-registry or other hacks.)  For now, this just manually requires all
 * of the tasks that currently work.
 **/

require('./tasks/delete_account');

require('./imap/tasks/sync_folder_list');

require('./imap/tasks/sync_grow');
require('./imap/tasks/sync_refresh');
require('./imap/tasks/sync_conv');
require('./imap/tasks/sync_body');

//require('./imap/tasks/store_flags');
//require('./imap/tasks/store_labels');

});

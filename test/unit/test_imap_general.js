/**
 * Test our IMAP sync logic under non-pathological conditions.  We exercise
 * logic with a reasonable number of messages.  Test cases that involve folders
 * with ridiculous numbers of messages and/or huge gaps in time which will take
 * a while to run and/or might upset the IMAP servers are handled in
 * `test_imap_excessive.js`.
 **/


/**
 * Connect to the server, create a folder that doesn't exist, cram it with the
 * expected messages corpus.  Invokes the callback with the name of the folder
 * once it has been populated.
 */
function setup_test_folder(corpus, callback) {
}

/**
 * Try and synchronize an empty folder.  Verify that our slice completes with
 * minimal legwork.
 */
add_test(function test_empty_folder_sync() {

});

/**
 * Perform a folder sync where our initial time fetch window contains all of the
 * messages in the folder.
 */
add_test(function test_initial_interval_is_full_sync() {
});


/**
 * Perform a folder sync where we need to search multiple time ranges in order
 * to gain a sufficient number of messages.
 */
add_test(function test_initial_fetch_spans_multiple_time_ranges() {
});

/**
 * Perform a folder sync
 */

function run_test() {


  run_next_test();
}

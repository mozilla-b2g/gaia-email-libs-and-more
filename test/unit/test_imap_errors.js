/**
 * Test IMAP common/high-level error-handling logic and error cases that aren't
 * tested by more specific tests.
 *
 * There are two broad classes of errors we test:
 * 1) Connection losses due to network glitches, etc.
 * 2) Logic errors on our part, be they our code doing something that throws an
 *    exception, or our code triggering a server error that we don't know how to
 *    handle.
 *
 * We test the following here:
 * -
 *
 * We test these things elsewhere:
 * -
 *
 * We want tests for the following (somewhere):
 * - Sync connect failure: Can't talk to the server at all.
 * - Sync login failure: The server does not like our credentials.
 * - Sync connection loss on SELECT. (This is during the opening of the folder
 *    connection and therefore strictly before actual synchronization logic is
 *    under way.)
 * - Sync connection loss on UID SEARCH. (This is during the _reliaSearch call,
 *    which theoretically is restartable without any loss of sync logic state.)
 * - Sync connection loss on UID FETCH. (This is within the sync process itself,
 *    which theoretically is restartable if the IMAP connection maintains its
 *    state and re-establishes.)
 *
 * - Failures in the (auto)configuration process (covering all the enumerated
 *   failure values we define.)
 **/

load('resources/fault_injecting_socket.js');

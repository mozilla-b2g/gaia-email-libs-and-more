/**
 * Test IMAP common/high-level error-handling logic and error cases that aren't
 * tested by more specific tests.  We
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
 * - Sync connection losses:
 *
 * - Failures in the (auto)configuration process (covering all the enumerated
 *   failure values we define.)
 **/

load('resources/fault_injecting_socket.js');

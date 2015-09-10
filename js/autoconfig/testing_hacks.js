define(function() {
'use strict';

/**
 * This map exists exclusively for the benefit of our automated testing.  It
 * is the only mechanism allowing autoconfig to use insecure connections.  It
 * used to have stuff in it, but automated tests know to mutate this table, so
 * we don't actually need anything in here.
 */
return new Map();
});

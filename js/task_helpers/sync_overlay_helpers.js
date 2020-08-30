/**
 * Common logic used by all sync_refresh/sync_grow overlays.  This has been
 * factored out because it's gotten sufficiently verbose and complex and likely
 * to change that the copy-and-paste no longer provides clarity but instead
 * would be a nighmare.
 */
export function syncNormalOverlay(id, marker, inProgress, blockedBy) {
  let status;
  if (inProgress) {
    status = 'active';
  } else if (marker) {
    status = 'pending';
  } else {
    return null;
  }

  let blocked = null;
  if (blockedBy) {
    // yuck
    switch (blockedBy[blockedBy.length - 1][0]) {
      case 'o': // online
        blocked = 'offline';
        break;
      case 'c': // credentials!*
        blocked = 'bad-auth';
        break;
      case 'h': // happy!*
        blocked = 'unknown';
        break;
      default:
        break;
    }
  }

  return { status, blocked };
}

/**
 * Like syncNormalOverlay but for prefix overlays.
 */
export function syncPrefixOverlay(fullId, binId, marker, inProgress, blockedBy) {
  return syncNormalOverlay(binId, marker, inProgress, blockedBy);
}

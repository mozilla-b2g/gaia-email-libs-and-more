import BugzillaClient from './bugzilla_client';

/**
 * The Bugzilla validator validates the server/API key information while
 * also determining who the current user is and the groups (projects) they
 * belong to.
 *
 */
export default async function validateBugzilla({ userDetails, credentials, connInfoFields }) {
  const client = new BugzillaClient({
    serverUrl: connInfoFields.serverUrl,
    apiToken: credentials.apiKey,
  });

  try {
    const whoami = await client.restCall(
      'whoami',
      null
    );

    // Note that only displayName and emailAddress will actually end up getting
    // propagated by the `account_create` task.  We're just propagating the
    // other info here out of the try block to be placed into the engineData.
    //
    // TODO: The identity representation should likely be rethought to be more
    // encompassing and consistent with the changes to the MailPeep rep we're
    // using post-phabricator.
    userDetails.bugzillaId = whoami.id;
    userDetails.displayName = whoami.real_name;
    userDetails.emailAddress = whoami.name;
    userDetails.nick = whoami.nick;
  } catch(ex) {
    // XXX this should be a `logic` error
    console.error('Problem running whoami', ex);
    return {
      error: 'unknown',
      errorDetails: {
        server: connInfoFields.serverUrl,
      },
    };
  }

  // TODO: We could do a "user" lookup here to get the groups the user is a
  // member of, but I don't know that we'd actually use that info.

  return {
    engineFields: {
      engine: 'bugzilla',
      engineData: {
        // The userEmail ends up as part of the identity, but the others don't
        // get propagated through and these are interesting at the very least.
        bugzillaId: userDetails.bugzillaId,
        userEmail: userDetails.emailAddress,
        userNick: userDetails.nick,
      },
      receiveProtoConn: null,
    },
  };
}

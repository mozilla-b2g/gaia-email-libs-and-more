import PhabricatorClient from './phabricator_client';

/**
 * The Phabricator validator validates the server/API key information while
 * also determining who the current user is and the groups (projects) they
 * belong to.
 *
 */
export default async function validatePhabricator({ userDetails, credentials, connInfoFields }) {
  const client = new PhabricatorClient({
    serverUrl: connInfoFields.serverUrl,
    apiToken: credentials.apiKey,
  });

  let userPhid;
  let groups;

  try {
    const whoami = await client.apiCall(
      'user.whoami',
      {}
    );

    userDetails.displayName = whoami.realName;
    // This isn't actually an email address.  We do have one available as
    // `primaryEmail` but that's not currently something we care about.
    userDetails.emailAddress = whoami.userName;

    userPhid = whoami.phid;
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

  try {
    const projects = await client.apiCall(
      'project.search',
      {
        constraints: {
          members: [userPhid]
        }
      }
    );

    groups = [];
    for (const info of projects.data) {
      // Bugzilla security groups are boring, so we want to ignore them.
      if (!info.fields.name.startsWith('bmo-')) {
        groups.push({
          id: info.id,
          phid: info.phid,
          name: info.fields.name,
          description: info.fields.description,
        });
      }
    }
  } catch(ex) {
    // XXX this should be a `logic` error
    console.error('Problem running projects search', ex);
    return {
      error: 'unknown',
      errorDetails: {
        server: connInfoFields.serverUrl,
      },
    };
  }


  return {
    engineFields: {
      engine: 'phabricator',
      engineData: {
        userPhid,
        groups,
      },
      receiveProtoConn: null,
    },
  };
}

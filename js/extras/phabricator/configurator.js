export default function configuratePhabricator(userDetails/*, domainInfo*/) {
  return {
    credentials: {
      apiKey: userDetails.phabApiKey,
    },
    typeFields: {
    },
    connInfoFields: {
      serverUrl: userDetails.phabServerUrl,
    },
  };
}

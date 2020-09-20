export default function configurateBugzilla(userDetails/*, domainInfo*/) {
  return {
    // Pass the user details through because the validator will want to mutate
    // `displayName` and `address` into place (for now, until things get
    // further generalized, this was an email client after all).
    userDetails,
    credentials: {
      apiKey: userDetails.bugzillaApiKey,
    },
    typeFields: {
    },
    connInfoFields: {
      serverUrl: userDetails.bugzillaServerUrl,
    },
  };
}

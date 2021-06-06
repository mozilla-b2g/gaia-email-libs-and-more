export default function configurateICal(userDetails/*, domainInfo*/) {
  return {
    // Pass the user details through because the validator will want to mutate
    // `displayName` and `address` into place (for now, until things get
    // further generalized, this was an email client after all).
    userDetails,
    credentials: {
    },
    typeFields: {
    },
    connInfoFields: {
      calendarUrl: userDetails.calendarUrl,
    },
  };
}

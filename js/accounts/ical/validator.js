import ICAL from 'ical.js';

/**
 * Validate a bearer calendar URL by verifying it parses fine and then
 * extracting metadata to help name the calendar.
 */
export default async function validateICal({ userDetails, credentials, connInfoFields }) {
  const calendarUrl = connInfoFields.calendarUrl;

  try {
    const icalReq = new Request(
      calendarUrl,
      {
      });
    const icalResp = await fetch(icalReq);
    if (icalResp.status >= 400) {
      return {
        error: 'unknown',
        errorDetails: {
          status: icalResp.status,
          calendarUrl,
        },
      };
    }

    const icalText = await icalResp.text();
    const parsed = ICAL.parse(icalText);
    const root = new ICAL.Component(parsed);

    const calName = root.getFirstPropertyValue('x-wr-calname') || 'Unnamed Calendar';

    userDetails.displayName = calName;
    // XXX This is not strictly correct but also doesn't matter.  We should
    // normalize how the `account_create` task chooses the account name to not
    // draw directly from this.
    userDetails.emailAddress = calName;
  } catch(ex) {
    return {
      error: 'unknown',
      errorDetails: {
        message: ex.toString(),
      },
    };
  }

  return {
    engineFields: {
      engine: 'ical',
      engineData: {
      },
      receiveProtoConn: null,
    },
  };
}

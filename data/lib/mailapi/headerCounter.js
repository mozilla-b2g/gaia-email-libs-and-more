/**
 * This file implements a function which performs a
 * a streaming search of a folder to determine the count of
 * headers which match a particular filter.
 */


define(
  [
    'module',
    'exports'
  ],
  function(
    $module,
    exports) {


exports.countHeaders = function(storage, filter, callback) {

  var matched = 0;

  // Relatively arbitrary value, but makes sure we don't use too much
  // memory while streaming
  var fetchSize = 30;

  var loading = false;

  // These correspond to the range of headers that we have searched to generate
  // the current set of matched headers.  Our matches will always be fully
  // contained by this range.
  //
  // This range can and will shrink.  Currently we shrink to the first/last
  // remaining matches.  Strictly speaking, this is too aggressive.  The
  // optimal shrink constraint would be to pick the message adjacent to the
  // first matches we are discarding so that growing by one message would
  // immediately re-find the message.  However it would be even
  // MORE efficient to just maintain a compact list of messages that have
  // matched that we never forget, so we'll just do that when we're feeling all
  // fancy in the future.
  var startTS = null;
  var startUID = null;
  var endTS = null;
  var endUID = null;


  function gotMessages(dir, callback, headers, moreMessagesComing) {
    // conditionally indent messages that are non-notable callbacks since we
    // have more messages coming.  sanity measure for asuth for now.
    var logPrefix = moreMessagesComing ? 'sf: ' : 'sf:';
    console.log(logPrefix, 'gotMessages', headers.length, 'more coming?',
                moreMessagesComing);
    // update the range of what we have seen and searched
    if (headers.length) {
      if (dir === -1) { // (more recent)
        endTS = headers[0].date;
        endUID = headers[0].id;
      }
      else { // (older)
        var lastHeader = headers[headers.length - 1];
        startTS = lastHeader.date;
        startUID = lastHeader.id;
        if (endTS === null) {
          endTS = headers[0].date;
          endUID = headers[0].id;
        }
      }
    }

    var checkHandle = function checkHandle(headers) {


      // Update the matched count
      for (i = 0; i < headers.length; i++) {
        var header = headers[i];
        var isMatch = filter(header);
        if (isMatch) {
          matched++;
        }
      }


      var atTop = storage.headerIsYoungestKnown(
                    endTS, endUID);
      var atBottom = storage.headerIsOldestKnown(
                        startTS, startUID);
      console.log(atBottom);
      var canGetMore = (dir === -1) ? !atTop : !atBottom,
          wantMore = !moreMessagesComing && canGetMore;



      if (wantMore) {
        console.log(logPrefix, 'requesting more because want more');
        loading = false;
        reqGrow(dir, false, true, callback);
      } else if (!moreMessagesComing) {
        callback(matched);
      }

      // (otherwise we need to wait for the additional messages to show before
      //  doing anything conclusive)
    }

    checkHandle(headers);

  }

  function reqGrow(dirMagnitude, userRequestsGrowth, autoDoNotDesireMore,
    callback) {
    // If the caller is impatient and calling reqGrow on us before we are done,
    // ignore them.  (Otherwise invariants will be violated, etc. etc.)  This
    // is okay from an event perspective since we will definitely generate a
    // completion notification, so the only way this could break the caller is
    // if they maintained a counter of complete notifications to wait for.  But
    // they cannot/must not do that since you can only ever get one of these!
    // (And the race/confusion is inherently self-solving for naive code.)
    if (!autoDoNotDesireMore && loading) {
      return;
    }

    // Stop processing dynamic additions/modifications while this is happening.
    loading = true;
    var count;
    if (dirMagnitude < 0) {
      storage.getMessagesAfterMessage(endTS, endUID,
        fetchSize,
        gotMessages.bind(null, -1, callback));
    }
    else {
      storage.getMessagesBeforeMessage(startTS, startUID,
        fetchSize,
        gotMessages.bind(null, 1, callback));
    }
  }

  // Fetch as many headers as we want in our results; we probably will have
  // less than a 100% hit-rate, but there isn't much savings from getting the
  // extra headers now, so punt on those.
  storage.getMessagesInImapDateRange(
    0, null, fetchSize, fetchSize,
    gotMessages.bind(null, 1, callback));

};

}); // end define

const DEFAULT_POLL_INTERVAL = 1000;

export class JsonIndexPoller {
  constructor({ url, onNewData, pollInterval, active }) {
    this._url = url;
    this._onNewData = onNewData;
    this._pollInterval = pollInterval || DEFAULT_POLL_INTERVAL;

    // Track whether we've ever received to data to know whether we want to read
    // cached results or not.  (If we already have data, if the data is coming
    // from the cache, we don't need to consume the body.)
    this._everGotData = false;

    this._active = active || false;
    this._timeoutHandle = null;
    this._pending = null;

    this._fire = this._fire.bind(this);
  }

  start() {
    if (this._active) {
      return;
    }
    this._active = true;
    if (this._pending) {
      return;
    }
    this._fire();
  }

  stop() {
    this._active = false;
    clearTimeout(this._timeoutHandle);
    this._intervalHandle = null;
  }

  /**
   * Mark that _fire completed, possibly rescheduling _fire using a timer.
   */
  _maybeReschedule() {
    this._pending = false;
    if (this._active) {
      this._timeoutHandle = setTimeout(this._fire, this._pollInterval);
    }
  }

  _fire() {
    this._timeoutHandle = null;

    // Issue the fetch with default settings.  The browser will be smart about
    // caching and use if-modified-since internally.  We can detect if the data
    // has changed by checking Last-Modified ourselves and then fast-path by
    // not firing not asking for
    // the contents of the
    this._pending = true;
    fetch(this._url).then(
      (response) => {
        // If we got data, process.
        if (response.status === 200 ||
            response.status === 0 || // (cover gecko non-http mechanisms)
            // consume a cache hit if we haven't read the data yet
            (!this._everGotData && response.status === 304)) {
          response.json().then(
            (obj) => {
              this._everGotData = true;
              this._maybeReschedule();
              this._onNewData(obj);
            },
            () => {
              this._maybeReschedule();
            });
        } else {
          this._maybeReschedule();
        }
      },
      () => {
        this._maybeReschedule();
      });
  }
}

## GELAM: Gaia Email Libraries (and more!)

This repository (gaia-email-libs-and-more, better known as GELAM), contains the backend code for the [Gaia Email](http://github.com/mozilla-b2g/gaia/tree/master/apps/email) app. This library can also potentially be used for other clients too, as long as you are cool with our design decisions.

The files you see in Gaia at `gaia/apps/email/js/ext` are built from GELAM and should not be modified directly; instead, develop the gaia backend here, and run `make install-into-gaia` to build GELAM into your Gaia tree.

## Getting Started

1. Clone this repository *recursively*:

        git clone --recursive https://github.com/mozilla-b2g/gaia-email-libs-and-more.git

  If you forgot to use `--recursive`, just run `git submodule update --init --recursive` instead.

2. Build [B2G Desktop](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox_OS/Using_the_B2G_desktop_client), or alternatively, try running `make b2g` to download a prebuilt copy. The unit tests run in B2G desktop

3. Install [node.js](http://nodejs.org) and [NPM](http://npmjs.org).

4. Make the following symlinks, replacing the paths as appropriate:

        cd gaia-email-libs-and-more
        ln -s YOUR_GAIA_REPO_PATH gaia-symlink
        ln -s YOUR_B2G_DESKTOP_PATH b2g-bindir-symlink

5. Run `npm install` in GELAM.

### Running Unit Tests

To run tests, use the following commands:

**To run all tests:** `make tests`

**To run just one test:** `make one-test SOLO_FILE=$filename`

**To run just one protocol variant**: `make tests TEST_VARIANT=imap:fake`

For instance, to run the `test/unit/test_compose.js` test, you would run `make one-test SOLO_FILE=test_compose`.

GELAM is a complex piece of software; to make it easier to debug tests, GELAM includes a browser-based test viewer. When you run the unit tests, you'll see a reminder to run `make results` to open the detailed logs in your browser. You don't need to run a web server.

### Installing your changes into Gaia

    cd $GELAM
    make install-into-gaia
    cd $GAIA

Then, check to make sure that the files in `$GAIA/apps/email/js/ext` include solely your changes, and commit the entire `js/ext` folder with your Gaia pull request.

## What's In This Repository? What does GELAM do?

This repository includes all of the code that talks the IMAP, POP3, and ActiveSync email protocols, as well as storage and mail composition. It exposes an interface called `MailAPI`, which provides a high-level interface for all of the above.

To avoid bogging down the main thread with potentially-expensive resources, most of the action happens in a Web Worker; `MailAPI` passes commands from the main thread to the worker via a JSON bridge.

## Third-Party Dependencies

We reuse existing third-party libraries whenever possible. Most of these libraries come from the [whiteout-io email.js](http://emailjs.org) group, including IMAP, SMTP, and MIME utilities.

These dependencies live in the `js/ext` directory in GELAM, and our RequireJS configuration is set to allow you to refer to modules within that directory with an absolute path. (When you install GELAM into Gaia, you'll see `$GAIA/apps/email/js/ext/ext` -- don't be alarmed, you're just dealing with two layers of dependencies.)

## More about unit tests

The unit tests can run against real mail servers or fake ones (originally from Thunderbird). By default, we use fake servers, so no extra setup should be needed. As mentioned in the guide above, the tests run in a b2g-desktop instance, and you must point GELAM at your b2g directory first.

On OS X, your b2g-desktop symlink will be something like `/Applications/B2G.app/Contents/MacOS/`.

`make help` provides details about all supported commands.

### Nitty-Gritty Details about Fake Servers

Don't read this section unless you have to; this section is for advanced understanding only.

The tests use the fakeserver code from Thunderbird. A vendor-branch is used to
track upstream:

https://github.com/asutherland/gaia-email-libs-and-more/tree/thunderbird-fakeserver-vendor

Everything under `test-runner/chrome/fakeserver` is pretty much just existing comm-central or mozilla-central (httpd.js) code, with some outstanding patches that have been reviewed but not yet landed, and a couple of small things that will hopefully be upstreamed at some point.

## Communication

- Mailing List: **[dev-gaia](https://lists.mozilla.org/listinfo/dev-gaia)**
- IRC: `irc.mozilla.org`, in the `#gelam` channel

## Legal Notes and Disclaimers

We include ActiveSync support because it's the only sane option for Hotmail.

Microsoft asserts that they have some patents on the ActiveSync protocol.  If you want to use/ship/distribute this library, you are either going to want to strip out ActiveSync-touching logic or make sure that you are okay with whatever those patents are.  Microsoft has some Open Source friendly words relating to some protocols, including their e-mail protocols, which may make things fine for
you if you are not distributing things commercially.

Specifically, the "Interoperability Principles" program has a patent pledge: http://www.microsoft.com/openspecifications/en/us/programs/other/interoperability-principles-patent-pledges/default.aspx

The pledge defines that it relates to the protocols listed at: http://msdn.microsoft.com/en-us/library/dd208104%28v=PROT.10%29.aspx

From the "Open Protocols" page, if you click on the following links in succession, you will reach the ActiveSync documentation:

- ["Protocols"](http://msdn.microsoft.com/en-us/library/gg685446.aspx)

- ["Exchange Server Protocols"](http://msdn.microsoft.com/en-us/library/cc307725%28v=EXCHG.80%29.aspx)
- ["Exchange Server Protocol Documents"](http://msdn.microsoft.com/en-us/library/cc425499%28v=exchg.80%29.aspx)

There is also a [commercial licensing program](http://www.microsoft.com/about/legal/en/us/intellectualproperty/iplicensing/programs/exchangeactivesyncprotocol.aspx) known to exist.

We are not lawyers and this is not legal advice. The above links will hopefully save you time when you or your lawyer do your research.

# CI

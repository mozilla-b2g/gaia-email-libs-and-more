E-mail libraries for the gaia e-mail client.  A bunch of node and AMD modules
get r.js optimized into a single JS file that gets loaded into the Gaia email
client.  The library can also potentially be used for other clients too, as
long as you are cool with our design decisions.

## Submodules ##

To make sure the submodules are initialized properly, please make sure to
check out the repository recursively:

```
git clone --recursive https://github.com/mozilla-b2g/gaia-email-libs-and-more.git
```

If you already checked out without the --recursive flag, you can try the
following command inside the repository directory:

```
git submodule update --init --recursive
```

## New Code ##

This repo provides:

- "Client daemon" logic that is the backend.  It does the IMAP protocol talking,
  storage maintenance, etc.  It communicates over a JSON bridge with the
  front-end which provides the:
- MailAPI, for use by the UI/front-end.  It communicates asynchronously with
  the back-end over the JSON bridge.


## Code Reuse ##

We are aggressively attempting to use existing JS libraries.  Currently, these
are mainly node libraries.  We use a combination of slightly-forked versions,
shims, and AMD-wrappings (using volo) to get this to work.  We use MIT-licensed
code from the following projects or converted projects:

- util, Stream shims from https://github.com/substack/node-browserify
   which is frequently modified node.js source code.
- MIME parsing/rfc822 logic from: https://github.com/andris9/mailparser
- MIME composition from: https://github.com/andris9/mailcomposer
- SMTP library from: https://github.com/andris9/simplesmtp
- MIME helper functions from: https://github.com/andris9/mimelib
- address parser library from: https://github.com/andris9/addressparser
- String encoding/character set conversion from
  http://code.google.com/p/stringencoding/.  This will removed once the
  TextEncoder/TextDecoder enhancement bug for Gecko lands:
  https://bugzilla.mozilla.org/show_bug.cgi?id=764234
- HTML sanitization from: https://github.com/asutherland/bleach.js

We shim the following ourselves to the minimum required:
- node's Buffer implementation
- node's crypto module, for crypto.createHash("md5") to support hash.update and
   hash.digest("hex").

We fork the following:
- node-imap from https://github.com/mscdex/node-imap.  This was done because we
   were trying to avoid shimming the node network API in favor of using our
   TCP WebAPI.  Changes were also required because of the differences between
   node's Buffers and our Buffer-shim based on typed arrays.  Our fork is
   currently intended to be a bit of a dead-end.  Since node is abandoning
   Buffers in favor of typed arrays/data-views, we will likely migrate to a
   new upstream revision of this library or an entirely different library in the
   future.  (Our current major concern for IMAP is on pipelining requests, so
   whatever library best offers that is likely what we will end up using.  If
   no other library offers it and node-imap is willing to accept patches for
   doing so, we will likely stick with node-imap.)


## The "And More" bit ##

This repo started out life as a restartless Jetpack extension for Firefox to
provide a restartless version of the TCP WebAPI with permissions.  There was
also an intent to provide a more desktop friendly development UI.  Code for
this stuff is still in here in various states of workingness, but is not a
priority or goal and a lot of it has now been removed.  That which remains
is planned to be deleted or moved to a separate repository.


## Installing Into Gaia ##

Make sure you have a symlink, `gaia-symlink`, that points at the root directory
of your gaia checkout.

For example, to create it:
```
ln -s ~/git/gaia gaia-symlink
```

Then, to run all the build steps and to copy our used files across into gaia,
run:
```
make install-into-gaia
```

## Unit Tests ##

Unit tests are intended to be run against b2g-desktop in xulrunner mode, but
Firefox or Thunderbird should work equally well.  The Makefile has targets for
`imap-tests` and for `one-imap-test` (likewise for `activesync` and `torture`).
To run all tests for all account types, use the target `all-tests`.  You can
also prefix these target with `post-` to post the results to an ArbPL instance.
For more details on this, see "Viewing the Test Results" below.

Running these tests depends on your having `b2g-bindir-symlink` files in the
root of your gaia-email-libs-and-more checkout so it can build the path
properly.

### IMAP ###

The IMAP tests like to run against real servers.  We use dovecot installed
on Ubuntu hooked up to postfix on localhost, but the unit tests can run against
any server anywhere.  For example, a somewhat recent dovecot on a remote server
works just as well as localhost, it's just harder to use on a airplane.  Some
servers, such as Yahoo's IMAP at the current time, are too broken to use the
unit tests.  For example, Yahoo's APPEND command ignores the specified
INTERNALDATE value, which makes it useless for many synchronization unit tests.

For more details on setting up a Dovecot server, see
[test/dovecot.md](test/dovecot.md).

### Setup ###

Create the symlink described above for xulrunner:
```
ln -s /path/to/b2g-desktop b2g-bindir-symlink
```

On OSX: `/path/to/b2g-desktop` will be something like:

```
/Applications/B2G.app/Contents/MacOS/
```

### Running the Tests ###

To run a single test, in this case, test_imap_general.js which is located at
test/unit/test_imap_general.js in the repo:
```
make one-imap-test SOLO_FILE=test_imap_general.js
```
This will produce a log file of the run at
test/unit/test_imap_general.js.log

To run all of the unit tests:
```
make all-tests
```
This will remove all existing log files prior to the run.  Afterwards, all log
files should be updated/exist, and a log that is the concatenation of all of
the test logs should exist at test/unit/all.log

### Viewing the Test Results ###

The logs generated by the unit tests are in JSON, but that doesn't help you much
on its own.  Happily, there is an HTML UI for viewing the logs, that can be
found here and dubbed ArbPL which was born as a hybrid of a log viewing UI and a
competitor to tinderbox pushlog that involved a server component for speed:

https://github.com/asutherland/arbitrarypushlog

The easiest and most fun way to use ArbPL is to run the server.  This is because
the UI is able to use Socket.IO to update as new test runs come in.  To be
able to do this, the setup process looks generally like this:

```
sudo apt-get install graphviz
git clone --recursive git://github.com/asutherland/arbitrarypushlog.git
cd arbitrarypushlog/server
npm install
```

Things are now installed.

You can run the server by typing the following in the root of arbitrarypushlog.
```
./webserve
```

The server is now running on port 8008.  You can browse to
http://localhost:8008/?tree=Logal and you will see the list of results.  At
the start of time, the database is empty, and the UI doesn't really like that,
so you will need to hit refresh after you get some data in there.

To get data in, the command is:
```
./logalchew /path/to/test_blah_blah.js.log
```

Alternatively, you can create a symlink "arbpl-dir-symlink", and then use a
Makefile target such as `post-one-imap-test` to automatically run ./logalchew
on the result.

To make this more obvious that this is an option for those skimming the page,
this means:
```
make post-one-imap-test SOLO_FILE=test_imap_general.js
```

or

```
make post-all-tests
```


## Legal Disclaimers, Notes, Etc. ##

We are including ActiveSync support because it's the only sane option for
Hotmail.

Microsoft asserts that they have some patents on the ActiveSync protocol.  If
you want to use/ship/distribute this library, you are either going to want to
strip out ActiveSync-touching logic or make sure that you are okay with whatever
those patents are.  Microsoft has some Open Source friendly words relating to
some protocols, including their e-mail protocols, which may make things fine for
you if you are not distributing things commercially.

Specifically, the "Interoperability Principles" program has a patent pledge:
http://www.microsoft.com/openspecifications/en/us/programs/other/interoperability-principles-patent-pledges/default.aspx

The pledge defines that it relates to the protocols listed at:
http://msdn.microsoft.com/en-us/library/dd208104%28v=PROT.10%29.aspx

From the "Open Protocols" page, if you click on the following links in
succession, you will reach the ActiveSync documentation:

- "Protocols" http://msdn.microsoft.com/en-us/library/gg685446.aspx
- "Exchange Server Protocols" http://msdn.microsoft.com/en-us/library/cc307725%28v=EXCHG.80%29.aspx
- "Exchange Server Protocol Documents" http://msdn.microsoft.com/en-us/library/cc425499%28v=exchg.80%29.aspx

There is also a commercial licensing program known to exist:
http://www.microsoft.com/about/legal/en/us/intellectualproperty/iplicensing/programs/exchangeactivesyncprotocol.aspx

I am not a lawyer, I am not qualified to tell you what any of the above actually
mean.  The above links will hopefully save you time when you or your lawyer
do your research.  None of this is legal advice.

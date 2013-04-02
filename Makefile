# full rsync
RSYNC=rsync -avL
# rsync JS files only, ignore jsdoc subdir.
RSYNC_JS=rsync -r -f "- jsdoc/" -f "+ */" -f "+ *.js" -f "- *" --prune-empty-dirs

VOLO=./scripts/volo

# Volo does its transformations in-place, so we need to copy junk across,
#  transform it, then copy it to the destination dir.
NODE_PKGS := addressparser mailparser mailcomposer mimelib simplesmtp browserify-builtins

TRANS_NODE_PKGS := $(addprefix node-transformed-deps/,$(NODE_PKGS))
DEP_NODE_PKGS := $(addprefix data/deps/,$(NODE_PKGS))

node-transformed-deps:
	mkdir -p node-transformed-deps

$(TRANS_NODE_PKGS): node-transformed-deps
	$(RSYNC) node-deps/$(notdir $@) node-transformed-deps
	$(VOLO) npmrel $@
	touch $@

# the cp is for main shims created by volo
$(DEP_NODE_PKGS): $(TRANS_NODE_PKGS)
	mkdir -p $@
	-cp node-transformed-deps/$(notdir $@).js data/deps/
	$(RSYNC_JS) node-transformed-deps/$(notdir $@)/ $@/
	touch $@

OUR_JS_DEPS := $(wildcard data/lib/mailapi/*.js) $(wildcard data/lib/mailapi/imap/*.js) $(wildcard data/lib/mailapi/smtp*.js) $(wildcard data/lib/mailapi/activesync/*.js) $(wildcard data/lib/mailapi/fake/*.js) $(wildcard data/deps/rdcommon/*.js)

install-into-gaia: gaia-symlink $(DEP_NODE_PKGS) $(OUR_JS_DEPS)
	node scripts/copy-to-gaia.js gaia-symlink/apps/email

build: $(DEP_NODE_PKGS) $(OUR_JS_DEPS)


gaia-symlink:
	echo "You need to create a symlink 'gaia-symlink' pointing at the gaia dir"

PYTHON=python
B2GSD=b2g-srcdir-symlink
B2GBD=b2g-builddir-symlink
ARBPLD=arbpl-dir-symlink
PYTHONINCDIRS=-I$(B2GSD)/build -I$(B2GBD)/_tests/mozbase/mozinfo
# common xpcshell args
RUNXPCARGS=--symbols-path=$(B2GBD)/dist/crashreporter-symbols \
           --build-info-json=$(B2GBD)/mozinfo.json \
           --testing-modules-dir=$(B2GBD)/_tests/modules

# Common test running logic.  Some test files are for both IMAP and ActiveSync.
# Some test files are just for one or the other.  xpcshell has a mechanism for
# specifying constraings on test files in xpcshell.ini, and we are using that.

define run-xpc-tests # $(call run-xpc-tests,type)
	-rm test/unit/all-$(1).log test/unit/*.js.log
	-GELAM_TEST_ACCOUNT_TYPE=$(2) $(PYTHON) $(B2GSD)/config/pythonpath.py $(PYTHONINCDIRS) $(B2GSD)/testing/xpcshell/runxpcshelltests.py $(RUNXPCARGS) --build-info-json=test/config-$(1).json $(B2GBD)/dist/bin/xpcshell test/unit
	cat test/unit/*.js.log > test/unit/all-$(1).log
endef

SOLO_FILE ?= $(error Specify a test filename in SOLO_FILE when using check-interactive or check-one)

define run-one-test
	GELAM_TEST_ACCOUNT_TYPE=$(2) $(PYTHON) $(B2GSD)/config/pythonpath.py $(PYTHONINCDIRS) $(B2GSD)/testing/xpcshell/runxpcshelltests.py $(RUNXPCARGS) --build-info-json=test/config-$(1).json --test-path=$(SOLO_FILE) $(B2GBD)/dist/bin/xpcshell test/unit
endef

XPCWIN=node_modules/xpcwindow/bin/xpcwindow
TESTRUNNER=$(CURDIR)/test/loggest-runner.js

ifeq ($(wildcard b2g-bindir-symlink),)
  B2GBIND=$(B2GBD)/dist/bin
  RUNMOZ=$(B2GBIND)/run-mozilla.sh
  RUNB2G=$(B2GBIND)/b2g
else
  B2GBIND=b2g-bindir-symlink
  RUNMOZ=$(B2GBIND)/run-mozilla.sh
  RUNB2G=$(B2GBIND)/b2g-bin
endif

# run all the tests listed in a test config file
define run-tests  # $(call run-tests,configName,accountType)
	-rm -f test-logs/all-$(1).log
	-rm -f test-logs/$(1)/*.log
	-rm -rf test-profile
	-mkdir -p test-profile/device-storage test-profile/fake-sdcard
	-mkdir -p test-logs/$(1)
	-GELAM_TEST_ACCOUNT_TYPE=$(2) $(RUNMOZ) $(RUNMOZFLAGS) $(RUNB2G) -app $(CURDIR)/test-runner/application.ini -no-remote -profile $(CURDIR)/test-profile --test-config $(CURDIR)/test/config-$(1).json
	cat test-logs/$(1)/*.log > test-logs/all-$(1).log
endef

# run one test
define run-one-test
	-rm -rf test-profile
	-mkdir -p test-profile/device-storage test-profile/fake-sdcard
	-mkdir -p test-logs/$(1)
	-rm -f test-logs/$(1)/$(basename $(SOLO_FILE)).log
	-GELAM_TEST_ACCOUNT_TYPE=$(2) $(RUNMOZ) $(RUNMOZFLAGS) $(RUNB2G) -app $(CURDIR)/test-runner/application.ini -no-remote -profile $(CURDIR)/test-profile --test-config $(CURDIR)/test/config-$(1).json --test-name $(basename $(SOLO_FILE))
endef

######################
# IMAP test variations
imap-tests: build
	$(call run-tests,imap,imap)

one-imap-test: build
	$(call run-one-test,imap,imap)

post-one-imap-test: one-imap-test
	cd $(ARBPLD); ./logalchew $(CURDIR)/test-logs/imap/$(basename $(SOLO_FILE)).log

post-imap-tests: imap-tests
	cd $(ARBPLD); ./logalchew $(CURDIR)/test-logs/all-imap.log


######################
# ActiveSync test variations
activesync-tests: build
	$(call run-xpc-tests,activesync,activesync)

one-activesync-test: build
	$(call run-one-test,activesync,activesync)

post-one-activesync-test: one-activesync-test
	cd $(ARBPLD); ./logalchew $(CURDIR)/test/unit/$(SOLO_FILE).log

post-activesync-tests: activesync-tests
	cd $(ARBPLD); ./logalchew $(CURDIR)/test/unit/all-activesync.log


######################
# Torture test variations (currently IMAP only)
torture-tests: build
	$(call run-xpc-tests,torture,imap)

one-torture-test: build
	$(call run-one-test,torture,imap)

interactive-torture-test: build
	$(call run-interactive-test,torture,imap)

post-one-torture-test: one-torture-test
	cd $(ARBPLD); ./logalchew $(CURDIR)/test/unit/$(SOLO_FILE).log

post-torture-tests: torture-tests
	cd $(ARBPLD); ./logalchew $(CURDIR)/test/unit/all-torture.log


######################
# Bundle up all the tests!
all-tests: imap-tests activesync-tests

post-all-tests: post-imap-tests post-activesync-tests post-torture-tests


ACTIVESYNC_SERVER_PORT ?= 8880

activesync-server:
	$(PYTHON) $(CURDIR)/test/run_server.py $(B2GSD) $(B2GBD) $(CURDIR) \
	  run_activesync_server.js --port $(ACTIVESYNC_SERVER_PORT)

clean:
	rm -rf data/deps
	rm -rf node-transformed-deps

.DEFAULT_GOAL=install-into-gaia
.PHONY: build install-into-gaia

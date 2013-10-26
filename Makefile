.PHONY: help
help:
	@echo "(this is 'make help')"
	@echo "## BUILDING ##"
	@echo ""
	@echo "make build"
	@echo "  Just build."
	@echo "make clean"
	@echo "  Nuke all build byproducts."
	@echo "make install-into-gaia"
	@echo "  Clean, build and copy tests into gaia"
	@echo ""
	@echo "## FAKE SERVERS (for use by you, not for testing) ##"
	@echo ""
	@echo "make imap-server"
	@echo "  Run the IMAP fake-server"
	@echo "make activesync-server"
	@echo "  Run the ActiveSync fake-server"
	@echo ""
	@echo "## TESTING ##"
	@echo ""
	@echo "make tests"
	@echo "  Run all tests, do not post results to ArbPL"
	@echo "make post-tests"
	@echo "  Run all tests, post results to ArbPL"
	@echo ""
	@echo "make one-test SOLO_FILE=test_name.js"
	@echo "  Run one test file (all variants), do not post results to ArbPL"
	@echo "make post-one-test SOLO_FILE=test_name.js"
	@echo "  Run one test file (all variants), post results to ArbPL"
	@echo ""
	@echo "To enable verbose log output to the console: TEST_LOG_ENABLE=true"

# full rsync
RSYNC=rsync -avL
# rsync JS files only, ignore jsdoc subdir.
RSYNC_JS=rsync -r -f "- jsdoc/" -f "+ */" -f "+ *.js" -f "- *" --prune-empty-dirs

VOLO=./scripts/volo

TEST_VARIANT ?= all

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

OUR_JS_DEPS := $(wildcard data/lib/mailapi/*.js) $(wildcard data/lib/mailapi/imap/*.js) $(wildcard data/lib/mailapi/smtp*.js) $(wildcard data/lib/mailapi/activesync/*.js) $(wildcard data/deps/rdcommon/*.js)

install-into-gaia: clean gaia-symlink $(DEP_NODE_PKGS) $(OUR_JS_DEPS)
	node scripts/copy-to-gaia.js gaia-symlink/apps/email

build: $(DEP_NODE_PKGS) $(OUR_JS_DEPS)


gaia-symlink:
	echo "You need to create a symlink 'gaia-symlink' pointing at the gaia dir"

B2GBD := b2g-builddir-symlink
ifeq ($(wildcard b2g-bindir-symlink),)
  B2GBIND := $(B2GBD)/dist/bin
  RUNB2G := $(B2GBIND)/b2g
else
  B2GBIND := b2g-bindir-symlink
  RUNB2G := $(B2GBIND)/b2g-bin
endif

ARBPLD=arbpl-dir-symlink

# Best effort use RUNMOZ if its available otherwise ignore it.
RUNMOZ := $(wildcard $(B2GBIND)/run-mozilla.sh)

# Common test running logic.  Some test files are for both IMAP and ActiveSync.
# Some test files are just for one or the other.  xpcshell has a mechanism for
# specifying constraings on test files in xpcshell.ini, and we are using that.

SOLO_FILE ?= $(error Specify a test filename in SOLO_FILE when using check-interactive or check-one)

TESTRUNNER=$(CURDIR)/test/loggest-runner.js


# run all the tests listed in a test config file
define run-tests  # $(call run-tests)
	-rm -f test-logs/*.log test-logs/*.logs
	-rm -rf test-profile
	-mkdir -p test-profile/device-storage test-profile/fake-sdcard
	-mkdir -p test-logs
	$(RUNMOZ) $(RUNMOZFLAGS) $(RUNB2G) -app $(CURDIR)/test-runner/application.ini -no-remote -profile $(CURDIR)/test-profile --test-config $(CURDIR)/test/test-files.json --test-variant $(TEST_VARIANT) --test-log-enable "$(TEST_LOG_ENABLE)"
	cat test-logs/*.log > test-logs/all.logs
endef

# run one test
define run-one-test
	-rm -rf test-profile
	-mkdir -p test-profile/device-storage test-profile/fake-sdcard
	-mkdir -p test-logs
	-rm -f test-logs/$(basename $(SOLO_FILE))-*.log
	$(RUNMOZ) $(RUNMOZFLAGS) $(RUNB2G) -app $(CURDIR)/test-runner/application.ini -no-remote -profile $(CURDIR)/test-profile --test-config $(CURDIR)/test/test-files.json --test-name $(basename $(SOLO_FILE)) --test-variant $(TEST_VARIANT) --test-log-enable "$(TEST_LOG_ENABLE)"
	cat test-logs/$(basename $(SOLO_FILE))-*.log > test-logs/$(basename $(SOLO_FILE)).logs
endef

define run-no-test #(call run-no-test,command,profdir)
	-rm -rf $(2)
	-mkdir -p $(2)
	-$(RUNMOZ) $(RUNMOZFLAGS) $(RUNB2G) -app $(CURDIR)/test-runner/application.ini -no-remote -profile $(CURDIR)/$(2) --test-config $(CURDIR)/test/test-files.json --test-command $(1)
endef

######################
# All tests

tests: build
	$(call run-tests)

one-test: build
	$(call run-one-test)

post-one-test: one-test
	cd $(ARBPLD); ./logalchew $(CURDIR)/test-logs/$(basename $(SOLO_FILE)).logs

post-tests: tests
	cd $(ARBPLD); ./logalchew $(CURDIR)/test-logs/all.logs


######################
# Bundle up all the tests!

all-tests: tests


ACTIVESYNC_SERVER_PORT ?= 8880

FAKE_ACTIVESYNC_PROFILE=fake-activesync-server-profile
activesync-server:
	$(call run-no-test,activesync-fake-server,$(FAKE_ACTIVESYNC_PROFILE))

FAKE_IMAP_PROFILE=fake-imap-server-profile
imap-server:
	$(call run-no-test,imap-fake-server,$(FAKE_IMAP_PROFILE))

clean:
	rm -rf data/deps
	rm -rf node-transformed-deps

.DEFAULT_GOAL=help
.PHONY: build install-into-gaia

node_modules: package.json
	npm install

b2g: node_modules
	./node_modules/.bin/mozilla-download \
		--product b2g \
		--channel prerelease \
		--branch mozilla-central \
		$@

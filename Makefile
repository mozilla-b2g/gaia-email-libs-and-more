# full rsync
RSYNC=rsync -avL
# rsync JS files only, ignore jsdoc subdir.
RSYNC_JS=rsync -r -f "- jsdoc/" -f "+ */" -f "+ *.js" -f "- *" --prune-empty-dirs

VOLO=./scripts/volo

# Volo does its transformations in-place, so we need to copy junk across,
#  transform it, then copy it to the destination dir.
NODE_PKGS := addressparser mailparser mailcomposer mimelib simplesmtp browserify-builtins

SED_TRANSFORMS_mailcomposer = s/mimelib-noiconv/mimelib/g

TRANS_NODE_PKGS := $(addprefix node-transformed-deps/,$(NODE_PKGS))
DEP_NODE_PKGS := $(addprefix data/deps/,$(NODE_PKGS))

node-transformed-deps:
	mkdir -p node-transformed-deps

$(TRANS_NODE_PKGS): node-transformed-deps
	$(RSYNC) node-deps/$(notdir $@) node-transformed-deps
	$(VOLO) npmrel $@
	$(if $(SED_TRANSFORMS_$(notdir $@)),sed -i -e "$(SED_TRANSFORMS_$(notdir $@))" node-transformed-deps/$(notdir $@)/lib/*.js)

# the cp is for main shims created by volo
$(DEP_NODE_PKGS): $(TRANS_NODE_PKGS)
	mkdir -p $@
	-cp node-transformed-deps/$(notdir $@).js data/deps/
	$(RSYNC_JS) node-transformed-deps/$(notdir $@)/ $@/


OUR_JS_DEPS := $(wildcard data/lib/mailapi/*.js) $(wildcard data/lib/mailapi/imap/*.js) $(wildcard data/lib/mailapi/smtp*.js) $(wildcard data/lib/mailapi/activesync/*.js) $(wildcard data/lib/mailapi/fake/*.js) $(wildcard data/deps/rdcommon/*.js)

gaia-email-opt.js: scripts/gaia-email-opt.build.js scripts/optStart.frag scripts/optEnd.frag $(DEP_NODE_PKGS) $(OUR_JS_DEPS) deps/almond.js
	node scripts/r.js -o scripts/gaia-email-opt.build.js

gaia-symlink:
	echo "You need to create a symlink 'gaia-symlink' pointing at the gaia dir"

clean-install-gaia-email-opt:
	rm gaia-email-opt.js
	$(MAKE) install-gaia-email-opt

install-gaia-email-opt: gaia-email-opt.js gaia-symlink
	cp gaia-email-opt.js gaia-symlink/apps/email/js/ext

PYTHON=python
B2GSD=b2g-srcdir-symlink
B2GBD=b2g-builddir-symlink
ARBPLD=arbpl-dir-symlink
PYTHONINCDIRS=-I$(B2GSD)/build -I$(B2GBD)/_tests/mozbase/mozinfo
xpcshell-tests:
	-rm test/unit/all.log test/unit/*.js.log
	-$(PYTHON) $(B2GSD)/config/pythonpath.py $(PYTHONINCDIRS) $(B2GSD)/testing/xpcshell/runxpcshelltests.py --symbols-path=$(B2GBD)/dist/crashreporter-symbols --build-info-json=$(B2GBD)/mozinfo.json $(B2GBD)/dist/bin/xpcshell test/unit
	cat test/unit/*.js.log > test/unit/all.log

SOLO_FILE ?= $(error Specify a test filename in SOLO_FILE when using check-interactive or check-one)

check-one:
	$(PYTHON) $(B2GSD)/config/pythonpath.py $(PYTHONINCDIRS) $(B2GSD)/testing/xpcshell/runxpcshelltests.py --symbols-path=$(B2GBD)/dist/crashreporter-symbols --build-info-json=$(B2GBD)/mozinfo.json --test-path=$(SOLO_FILE) $(B2GBD)/dist/bin/xpcshell test/unit

check-interactive:
	$(PYTHON) $(B2GSD)/config/pythonpath.py $(PYTHONINCDIRS) $(B2GSD)/testing/xpcshell/runxpcshelltests.py --symbols-path=$(B2GBD)/dist/crashreporter-symbols --build-info-json=$(B2GBD)/mozinfo.json --test-path=$(SOLO_FILE) --interactive $(B2GBD)/dist/bin/xpcshell test/unit

post-check-one: check-one
	cd $(ARBPLD); ./logalchew $(CURDIR)/test/unit/$(SOLO_FILE).log

post-xpcshell-tests: xpcshell-tests
	cd $(ARBPLD); ./logalchew $(CURDIR)/test/unit/all.log

storage_server_port = 8080

activesync-server:
	$(PYTHON) $(CURDIR)/test/run_server.py $(B2GSD) $(B2GBD) $(CURDIR) \
	  run_activesync_server.js --port $(storage_server_port)

clean:
	rm -rf data/deps
	rm -rf node-transformed-deps

.DEFAULT_GOAL=gaia-email-opt.js
.PHONY: install-gaia-email-opt

# full rsync
RSYNC=rsync -avL
# rsync JS files only, ignore jsdoc subdir.
RSYNC_JS=rsync -r -f "- jsdoc/" -f "+ */" -f "+ *.js" -f "- *" --prune-empty-dirs

VOLO=./scripts/volo

# Volo does its transformations in-place, so we need to copy junk across,
#  transform it, then copy it to the destination dir.
NODE_PKGS := mailparser mimelib iconv-lite browserify-builtins

TRANS_NODE_PKGS := $(addprefix node-transformed-deps/,$(NODE_PKGS))
DEP_NODE_PKGS := $(addprefix data/deps/,$(NODE_PKGS))

node-transformed-deps:
	mkdir -p node-transformed-deps

$(TRANS_NODE_PKGS): node-transformed-deps
	$(RSYNC) node-deps/$(notdir $@) node-transformed-deps
	$(VOLO) npmrel $@

$(DEP_NODE_PKGS): $(TRANS_NODE_PKGS)
	mkdir -p $@
	$(RSYNC_JS) node-transformed-deps/$(notdir $@)/ $@/



xpi: $(DEP_NODE_PKGS)
	$(RSYNC) deps/wmsy/lib/wmsy data/deps/
	$(RSYNC) deps/stringencoding/encoding.js data/deps
	cfx --templatedir=xpi-template $(JSONARG) xpi

# create the XPI and post it to our web browser, assuming we are running with:
# https://addons.mozilla.org/en-US/firefox/addon/autoinstaller/
run: xpi
	wget --post-file=jetpack-tcp-imap-demo.xpi http://localhost:8222/

# Tell the extension to automatically run our sync test logic so we don't need
# to manually hit a bunch of buttons every time (or have to spawn a new firefox
# instance.)
runtest: JSONARG='--static-args={"synctest": true}'
runtest: run

clean:
	rm -rf data/deps
	rm -rf node-transformed-deps

.DEFAULT_GOAL=xpi

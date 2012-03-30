# full rsync
RSYNC=rsync -avL
# rsync JS files only, ignore jsdoc subdir.
RSYNC_JS=rsync -r -f "- jsdoc/" -f "+ */" -f "+ *.js" -f "- *" --prune-empty-dirs

VOLO=./scripts/volo

# Volo does its transformations in-place, so we need to copy junk across,
#  transform it, then copy it to the destination dir.
NODE_PKGS := mailparser mimelib iconv-lite

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
	echo $(RSYNC) deps/wmsy/lib/wmsy data/deps/
	echo cfx xpi

clean:
	rm -rf data/deps
	rm -rf node-transformed-deps

.DEFAULT_GOAL=xpi

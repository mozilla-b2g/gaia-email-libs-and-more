OUT := logic-inspector.min.js
SRC := $(shell find js/ -type f -name '*.js')

.PHONY: clean

BROWSERIFY_TRANSFORM = [ babelify --presets [ react ] --plugins [ transform-es2015-modules-commonjs ] ]

# Rebuild when JS files change.
$(OUT): node_modules $(SRC)
	node_modules/.bin/browserify -t $(BROWSERIFY_TRANSFORM) js/main.js  --outfile $(OUT)

.PHONY: watchify
watchify:
	node_modules/.bin/watchify -v -t $(BROWSERIFY_TRANSFORM) js/main.js  --outfile $(OUT)

# If our package.json has been updated, run npm install
node_modules: package.json
	npm install
	touch node_modules

clean:
	rm $(OUT)

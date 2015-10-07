OUT := logic-inspector.min.js
SRC := $(shell find js/ -type f -name '*.js')

.PHONY: clean

# Rebuild when JS files change.
$(OUT): node_modules $(SRC)
	node_modules/.bin/browserify js/main.js -t babelify --outfile $(OUT)

# If our package.json has been updated, run npm install
node_modules: package.json
	npm install
	touch node_modules

clean:
	rm $(OUT)

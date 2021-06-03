.PHONY: build clean

# If our package.json has been updated, run npm install
node_modules: package.json
	npm install
	touch node_modules

# XXX there previously was some actual dependency logic in here when browserify
# was used and perhaps it could come back, but the churn here is low.
build: node_modules
	npm run build

clean:
	rm $(OUT)

SRC = $(wildcard src/*.js)
LIB = $(SRC:src/%.js=lib/%.js)
BABEL = node node_modules/babel/bin/babel/index.js

lib: $(LIB)
lib/%.js: src/%.js
	mkdir -p $(@D)
	$(BABEL) $< -o $@

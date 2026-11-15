# SHARED-EXPERIENCE: engineering | standard: PROJECT_STANDARDS.md §Engineering | local implementation; changes must be mirrored in every app listed there
# Flux's standard commands (PLAN.md §4.11). Every heavy step runs under SharedKit's tools/heavy.sh.
SHAREDKIT ?= $(or $(SHAREDKIT_HOME),$(HOME)/dev/SharedKit)
HEAVY := "$(SHAREDKIT)/tools/heavy.sh"
export DEVELOPER_DIR := /Applications/Xcode.app/Contents/Developer
SIMULATOR ?= Shared-iPhone

.PHONY: build test ui-test lint check-fast check testflight feedback sim-cleanup

build:
	$(HEAVY) bash scripts/standard-commands.sh build

test:
	npm test && npm run -s test:mac
	$(HEAVY) bash scripts/standard-commands.sh test

# Builds once, then runs the suite without building (D-083); the app is reused between tests.
ui-test:
	$(HEAVY) bash scripts/standard-commands.sh ui-test $(SIMULATOR)

lint:
	npm run -s format:check && npm run -s lint:standards

check-fast: lint test

check: check-fast ui-test
	npm run -s check:native

testflight:
	@test -n "$(PLATFORM)" -a -n "$(BUILD)" || { echo "make testflight PLATFORM=ios|mac BUILD=YYYYMMDDNN [ARGS=--dry-run]"; exit 2; }
	$(HEAVY) bash scripts/testflight.sh $(PLATFORM) $(BUILD) $(ARGS)

feedback:
	python3 -I scripts/feedback.py pull

sim-cleanup:
	python3 -I "$(SHAREDKIT)/tools/sim_cleanup.py" --device $(SIMULATOR) --shutdown

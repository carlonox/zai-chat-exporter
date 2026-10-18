// Minimal test runner — no external dependencies.
// Uses Node's built-in `assert` module. Each test file exports a function
// that takes the assert object and registers tests.
//
// Run with: `node tests/run.js` (or `npm test`).

var assert = require("assert");
var path = require("path");
var fs = require("fs");

// tests/lib/runner.js → tests/ is the parent directory.
var TESTS_DIR = path.resolve(__dirname, "..");

var PASSED = 0;
var FAILED = 0;
var FAILURES = [];

function registerTest(name, fn) {
  // Each test gets its own timeout — defaults to 5s, override via
  // `this.timeout(ms)` inside the test function (not exposed in this
  // tiny runner; tests that need longer just `await`).
  return new Promise(function(resolve) {
    try {
      var maybe = fn();
      if (maybe && typeof maybe.then === "function") {
        maybe.then(function() {
          PASSED++;
          console.log("  \u2713 " + name);
          resolve();
        }).catch(function(err) {
          FAILED++;
          FAILURES.push({ name: name, err: err });
          console.log("  \u2717 " + name + "  ->  " + (err && err.message ? err.message : err));
          resolve();
        });
      } else {
        PASSED++;
        console.log("  \u2713 " + name);
        resolve();
      }
    } catch (err) {
      FAILED++;
      FAILURES.push({ name: name, err: err });
      console.log("  \u2717 " + name + "  ->  " + (err && err.message ? err.message : err));
      resolve();
    }
  });
}

function describe(groupName, fn) {
  console.log("\n" + groupName);
  var tests = [];
  global.it = function(name, testFn) {
    tests.push({ name: groupName + " :: " + name, fn: testFn });
  };
  fn();
  delete global.it;
  return tests;
}

async function runAll() {
  console.log("Z.ai Chat Exporter — Test Suite");
  console.log("================================");

  var testFiles = [
    "test_extract_body.js",
    "test_exporters.js",
    "test_batched_fetch.js",
    "test_popup_normalization.js",
    "test_select_export.js",
    "test_integration_scenarios.js",
    "test_order.js",
    "test_markdown_order.js",
    "test_viewer_logic.js"
  ];

  for (var i = 0; i < testFiles.length; i++) {
    var file = path.join(TESTS_DIR, testFiles[i]);
    if (!fs.existsSync(file)) {
      console.log("\nSkipping " + testFiles[i] + " (not found)");
      continue;
    }
    var mod = require(file);
    if (typeof mod.run !== "function") {
      console.log("\nSkipping " + testFiles[i] + " (no run() export)");
      continue;
    }
    var tests = mod.run(describe, assert);
    for (var j = 0; j < tests.length; j++) {
      await registerTest(tests[j].name, tests[j].fn);
    }
  }

  console.log("\n----------------------------------------");
  console.log("Passed: " + PASSED + "  Failed: " + FAILED);
  if (FAILURES.length > 0) {
    console.log("\nFailures:");
    for (var k = 0; k < FAILURES.length; k++) {
      console.log("  - " + FAILURES[k].name);
      if (FAILURES[k].err && FAILURES[k].err.stack) {
        console.log("    " + FAILURES[k].err.stack.split("\n").slice(0, 3).join("\n    "));
      }
    }
    process.exit(1);
  } else {
    process.exit(0);
  }
}

module.exports = { runAll: runAll };

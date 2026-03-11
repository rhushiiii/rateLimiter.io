const test = require("node:test");
const assert = require("node:assert/strict");
const { endpointMatches, methodMatches } = require("../src/lib/policyMatcher");

test("endpoint wildcard matching", () => {
  assert.equal(endpointMatches("/api/*", "/api/public"), true);
  assert.equal(endpointMatches("/api/public", "/api/public"), true);
  assert.equal(endpointMatches("/api/public", "/api/strict"), false);
});

test("method matching", () => {
  assert.equal(methodMatches("GET", "get"), true);
  assert.equal(methodMatches("*", "POST"), true);
  assert.equal(methodMatches("POST", "GET"), false);
});

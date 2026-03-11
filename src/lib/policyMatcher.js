function endpointMatches(pattern, endpoint) {
  if (!pattern || pattern === "*") return true;
  if (pattern.endsWith("*")) {
    return endpoint.startsWith(pattern.slice(0, -1));
  }
  return pattern === endpoint;
}

function methodMatches(policyMethod, requestMethod) {
  if (!policyMethod || policyMethod === "*") return true;
  return policyMethod.toUpperCase() === requestMethod.toUpperCase();
}

function getMatchingPolicies(policies, req) {
  return policies.filter(
    (policy) =>
      policy.enabled !== false &&
      endpointMatches(policy.endpointPattern || "*", req.path) &&
      methodMatches(policy.method || "*", req.method)
  );
}

module.exports = {
  endpointMatches,
  methodMatches,
  getMatchingPolicies,
};

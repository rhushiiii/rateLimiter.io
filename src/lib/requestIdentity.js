function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function getApiKey(req) {
  return req.headers["x-api-key"] || req.headers.authorization || "anonymous";
}

function getUserId(req) {
  return req.headers["x-user-id"] || req.user?.id || "anonymous";
}

function getOrganizationId(req) {
  return req.headers["x-org-id"] || "unknown-org";
}

function scopeIdentifier(scope, req) {
  switch (scope) {
    case "ip":
      return getClientIp(req);
    case "user":
      return getUserId(req);
    case "apiKey":
      return getApiKey(req);
    case "organization":
      return getOrganizationId(req);
    case "endpoint":
      return req.path;
    default:
      return getClientIp(req);
  }
}

module.exports = {
  getClientIp,
  getApiKey,
  getUserId,
  getOrganizationId,
  scopeIdentifier,
};

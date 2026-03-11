const { randomUUID } = require("crypto");
const { getRedisClient } = require("../redis/client");
const { defaultPolicies } = require("../config/defaultPolicies");

const POLICIES_KEY = "rl:policies:v1";

class PolicyStore {
  constructor() {
    this.redis = getRedisClient();
    this.cache = [];
    this.isRedisBacked = true;
  }

  async init() {
    try {
      const stored = await this.redis.get(POLICIES_KEY);
      if (!stored) {
        this.cache = [...defaultPolicies];
        await this.redis.set(POLICIES_KEY, JSON.stringify(this.cache));
        this.isRedisBacked = true;
        return this.cache;
      }
      this.cache = JSON.parse(stored);
      this.isRedisBacked = true;
      return this.cache;
    } catch (err) {
      if (this.cache.length === 0) {
        this.cache = [...defaultPolicies];
      }
      this.isRedisBacked = false;
      return this.cache;
    }
  }

  async list() {
    if (this.cache.length === 0) {
      await this.init();
    }
    return this.cache;
  }

  async create(policy) {
    const normalized = normalizePolicy({ ...policy, id: policy.id || randomUUID() });
    this.cache.push(normalized);
    await this._persist();
    return normalized;
  }

  async update(id, partial) {
    const index = this.cache.findIndex((p) => p.id === id);
    if (index < 0) return null;

    const updated = normalizePolicy({ ...this.cache[index], ...partial, id });
    this.cache[index] = updated;
    await this._persist();
    return updated;
  }

  async remove(id) {
    const before = this.cache.length;
    this.cache = this.cache.filter((p) => p.id !== id);
    if (this.cache.length === before) return false;
    await this._persist();
    return true;
  }

  async _persist() {
    try {
      await this.redis.set(POLICIES_KEY, JSON.stringify(this.cache));
      this.isRedisBacked = true;
    } catch (err) {
      this.isRedisBacked = false;
    }
  }
}

function normalizePolicy(input) {
  return {
    id: String(input.id),
    name: input.name || input.id,
    algorithm: input.algorithm || "fixed_window",
    scope: input.scope || "ip",
    method: input.method || "*",
    endpointPattern: input.endpointPattern || "*",
    limit: Number(input.limit || 100),
    windowSec: Number(input.windowSec || input.window || 60),
    capacity: Number(input.capacity || input.limit || 100),
    refillRate: Number(input.refillRate || (input.limit || 100) / (input.windowSec || input.window || 60)),
    cost: Number(input.cost || 1),
    enabled: input.enabled !== false,
  };
}

module.exports = {
  PolicyStore,
  normalizePolicy,
};

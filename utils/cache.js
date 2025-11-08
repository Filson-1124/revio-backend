import NodeCache from "node-cache";

let cacheClient = null;

if (!cacheClient) {
  const mem = new NodeCache({ stdTTL: 60 * 60, checkperiod: 120 });
  cacheClient = {
    async get(key) {
      return mem.get(key);
    },
    async set(key, value, ttl = 3600) {
      mem.set(key, value, ttl);
    },
    async del(key) {
      mem.del(key);
    },
  };
  console.log("[cache] Using in-memory cache (node-cache)");
}

export default cacheClient;
// for repeated/same term and def

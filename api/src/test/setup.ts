// Test env: point Mongo + Redis at test-only namespaces so tests can never
// clobber a running dev database. Set BEFORE any api module imports env.

process.env.NODE_ENV = "test";
process.env.MONGO_URI ??= "mongodb://mongo:27017/flashkart_test";
process.env.REDIS_URL ??= "redis://redis:6379/1"; // Redis logical DB 1 = tests
process.env.JWT_ACCESS_SECRET ??= "test-access-secret-at-least-16-chars-long";
process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret-at-least-16-chars-long";
process.env.JWT_ACCESS_TTL ??= "15m";
process.env.JWT_REFRESH_TTL ??= "7d";
process.env.CORS_ORIGIN ??= "http://localhost:5173";
process.env.RATE_LIMIT_BYPASS_TOKEN ??= "test-bypass";

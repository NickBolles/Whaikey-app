import "@testing-library/jest-dom/vitest";

process.env.BETTER_AUTH_SECRET = "test-secret";
process.env.DATABASE_PATH = ":memory:";

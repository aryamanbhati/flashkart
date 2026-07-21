// Auth end-to-end via supertest against the real Express app. Covers:
//   * register + login happy path
//   * requireAuth rejects missing / bad tokens
//   * refresh rotates AND reuse of an old refresh nukes the family

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { resetState, teardown } from "../test/helpers.js";

const app = createApp();

function register(email: string) {
  return request(app).post("/auth/register").send({
    email,
    name: "Test",
    password: "correct-horse-battery",
  });
}

function login(email: string) {
  return request(app).post("/auth/login").send({
    email,
    password: "correct-horse-battery",
  });
}

// The test client (supertest) doesn't carry cookies between requests
// automatically — we manually extract Set-Cookie and echo it on the next call.
function extractCookie(res: request.Response, name: string): string | null {
  const raw = res.headers["set-cookie"];
  if (!raw) return null;
  const arr = Array.isArray(raw) ? raw : [raw];
  const line = arr.find((c) => c.startsWith(`${name}=`));
  return line ? line.split(";")[0] : null;
}

describe("auth", () => {
  beforeEach(async () => {
    await resetState();
  });

  afterAll(async () => {
    await teardown();
  });

  it("register → login → me", async () => {
    const email = `u${Date.now()}@test.local`;
    await register(email).expect(201);
    const loginRes = await login(email).expect(200);
    expect(loginRes.body.accessToken).toBeTruthy();
    expect(loginRes.body.user.email).toBe(email);

    const me = await request(app)
      .get("/auth/me")
      .set("Authorization", `Bearer ${loginRes.body.accessToken}`)
      .expect(200);
    expect(me.body.user.email).toBe(email);
  });

  it("requireAuth rejects missing / bad tokens", async () => {
    await request(app).get("/auth/me").expect(401);
    await request(app).get("/auth/me").set("Authorization", "Bearer garbage").expect(401);
  });

  it("wrong password → 401 with same message as unknown email (no enumeration)", async () => {
    const email = `u${Date.now()}@test.local`;
    await register(email);
    const wrong = await request(app)
      .post("/auth/login")
      .send({ email, password: "definitely-not-the-password" })
      .expect(401);
    const unknown = await request(app)
      .post("/auth/login")
      .send({ email: "nobody@test.local", password: "whatever12" })
      .expect(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it("refresh rotation + reuse detection", async () => {
    const email = `u${Date.now()}@test.local`;
    await register(email);
    const loginRes = await login(email);
    const rt0 = extractCookie(loginRes, "frt");
    expect(rt0).not.toBeNull();

    // 1st rotate — RT0 -> RT1
    const rot1 = await request(app)
      .post("/auth/refresh")
      .set("Cookie", rt0!)
      .expect(200);
    const rt1 = extractCookie(rot1, "frt");
    expect(rt1).not.toBeNull();
    expect(rt1).not.toBe(rt0);

    // Reuse RT0 → 401 reuse detected + family nuked
    const reuse = await request(app).post("/auth/refresh").set("Cookie", rt0!).expect(401);
    expect(reuse.body.error.message).toMatch(/reuse/);

    // The legit RT1 is now dead too (family revoked)
    await request(app).post("/auth/refresh").set("Cookie", rt1!).expect(401);
  });
});

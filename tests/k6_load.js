// k6 load test: 200 concurrent VUs against the list endpoint.
// Budgets: p95 < 80ms reads, error rate 0. Run: k6 run tests/k6_load.js
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  scenarios: {
    lists: {
      executor: "constant-vus",
      vus: 200,
      duration: "2m",
    },
  },
  thresholds: {
    http_req_duration: ["p(95)\u003c80"],   // reads budget
    http_req_failed: ["rate==0"],
  },
};

const BASE = __ENV.BASE || "https://example.com";
const COOKIE = __ENV.COOKIE || "";  // access_token cookie for an authed user

export default function () {
  const res = http.get(`${BASE}/api/tasks?scope=created&sort=deadline&dir=asc&limit=50`, {
    headers: { Cookie: COOKIE },
  });
  check(res, { "status 200": (r) => r.status === 200 });
  sleep(0.5);
}

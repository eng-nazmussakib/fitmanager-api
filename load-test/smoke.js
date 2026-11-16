// k6 smoke/load test (ACAS 17-load-testing uses k6). Not part of `npm test`: install k6, start the API, then
//   k6 run load-test/smoke.js                                  # 10 users for 30 s
//   k6 run -e BASE=https://dev.example.com -e VUS=50 load-test/smoke.js
// Thresholds fail the run, so it can gate a pipeline. Watch /metrics (or Grafana) while it runs.
import { check, sleep } from 'k6';
import http from 'k6/http';

const BASE = __ENV.BASE || 'http://localhost:3000';
const API = `${BASE}/api/v1`;

export const options = {
    vus: Number(__ENV.VUS || 10),
    duration: __ENV.DURATION || '30s',
    thresholds: {
        http_req_failed: ['rate<0.01'],
        'http_req_duration{name:list}': ['p(95)<300'],
        'http_req_duration{name:me}': ['p(95)<100']
    }
};

/** Signs in once; every virtual user reuses the token (the load is on reads, not on password hashing). */
export function setup() {
    const res = http.post(`${API}/auth/login`, JSON.stringify({ username: 'admin', password: 'Admin@123' }), {
        headers: { 'Content-Type': 'application/json' }
    });
    check(res, { 'signed in': r => r.status === 200 });
    return { token: res.json('data.access_token') };
}

export default function (data) {
    const params = name => ({ headers: { Authorization: `Bearer ${data.token}` }, tags: { name } });
    check(http.get(`${API}/auth/me`, params('me')), { 'me 200': r => r.status === 200 });
    const page = Math.floor(Math.random() * 4);
    check(http.get(`${API}/items?offset=${page * 10}&limit=10&sort_by=amount`, params('list')), { 'list 200': r => r.status === 200 });
    check(http.get(`${API}/ddl?ddl_key=category`, params('ddl')), { 'ddl 200': r => r.status === 200 });
    sleep(1);
}

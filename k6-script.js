import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('error_rate');
const responseTime = new Trend('response_time');
const successCount = new Counter('success_count');
const failCount = new Counter('fail_count');

// Config dari environment variable (di-pass dari GitHub Actions)
const BASE_URL = __ENV.TARGET_URL || 'https://your-dev-api.com';
const BEARER_TOKEN = __ENV.BEARER_TOKEN || '';
const VIRTUAL_USERS = parseInt(__ENV.VIRTUAL_USERS) || 100;
const DURATION = __ENV.DURATION || '1m';
const RAMP_DURATION = __ENV.RAMP_DURATION || '30s';

export const options = {
  stages: [
    { duration: RAMP_DURATION, target: Math.floor(VIRTUAL_USERS * 0.3) },  // ramp up 30%
    { duration: RAMP_DURATION, target: Math.floor(VIRTUAL_USERS * 0.7) },  // ramp up 70%
    { duration: DURATION,      target: VIRTUAL_USERS },                     // full stress
    { duration: RAMP_DURATION, target: 0 },                                 // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000', 'p(99)<5000'], // 95% < 2s, 99% < 5s
    error_rate: ['rate<0.05'],                         // error rate < 5%
    http_req_failed: ['rate<0.05'],
  },
};

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${BEARER_TOKEN}`,
};

// Request body sesuai API inquiry burn
const payload = JSON.stringify({
  loyaltyMemberId: 'KAI00000605',
  productCode: '123PROM',
  storeCode: 'A',
  companyCode: 'KAI',
  productPrice: 20000,
  burnType: 'PAYFULL',
  additionalData: {
    origin: 'BANDUNG',
    destination: 'MANGGARAI',
    trainName: 'ARGO PARAHYANGAN',
    test: 'Test',
  },
});

export default function () {
  // GET dengan JSON body
  const res = http.get(`${BASE_URL}`, { headers, body: payload });

  const success = check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 2s': (r) => r.timings.duration < 2000,
    'no error in body': (r) => !r.body.toLowerCase().includes('error'),
  });

  // Track custom metrics
  responseTime.add(res.timings.duration);
  errorRate.add(!success);

  if (success) {
    successCount.add(1);
  } else {
    failCount.add(1);
  }

  sleep(1); // 1 detik jeda antar request per VU
}

// Summary di akhir test — ini yang akan dikirim ke Google Sheet
export function handleSummary(data) {
  const summary = {
    timestamp: new Date().toISOString(),
    target_url: BASE_URL,
    virtual_users: VIRTUAL_USERS,
    duration: DURATION,
    total_requests: data.metrics.http_reqs?.values?.count || 0,
    req_per_second: (data.metrics.http_reqs?.values?.rate || 0).toFixed(2),
    avg_response_ms: (data.metrics.http_req_duration?.values?.avg || 0).toFixed(2),
    p95_response_ms: (data.metrics.http_req_duration?.values['p(95)'] || 0).toFixed(2),
    p99_response_ms: (data.metrics.http_req_duration?.values['p(99)'] || 0).toFixed(2),
    min_response_ms: (data.metrics.http_req_duration?.values?.min || 0).toFixed(2),
    max_response_ms: (data.metrics.http_req_duration?.values?.max || 0).toFixed(2),
    error_rate_pct: ((data.metrics.http_req_failed?.values?.rate || 0) * 100).toFixed(2),
    success_count: data.metrics.http_reqs?.values?.count - (data.metrics.http_req_failed?.values?.count || 0),
    fail_count: data.metrics.http_req_failed?.values?.count || 0,
    status: data.metrics.http_req_failed?.values?.rate < 0.05 ? 'PASS' : 'FAIL',
  };

  // Output ke stdout (akan di-capture GitHub Actions)
  console.log('K6_SUMMARY_JSON=' + JSON.stringify(summary));

  return {
    'summary.json': JSON.stringify(summary, null, 2),
    stdout: '\n✅ Stress test selesai!\n',
  };
}

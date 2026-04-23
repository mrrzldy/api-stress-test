import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// ============================================================
// CUSTOM METRICS
// ============================================================
const errorRate      = new Rate('error_rate');
const timeoutRate    = new Rate('timeout_rate');
const error4xxRate   = new Rate('error_4xx_rate');
const error5xxRate   = new Rate('error_5xx_rate');
const responseTime   = new Trend('response_time');
const successCount   = new Counter('success_count');
const failCount      = new Counter('fail_count');
const timeoutCount   = new Counter('timeout_count');
const error4xxCount  = new Counter('error_4xx_count');
const error5xxCount  = new Counter('error_5xx_count');

// ============================================================
// CONFIG — dari GitHub Actions
// ============================================================
const BASE_URL      = __ENV.TARGET_URL  || 'https://your-dev-api.com';
const BEARER_TOKEN  = __ENV.BEARER_TOKEN || '';
const VIRTUAL_USERS = parseInt(__ENV.VIRTUAL_USERS) || 100;
const DURATION      = __ENV.DURATION     || '1m';
const RAMP_DURATION = __ENV.RAMP_DURATION || '30s';

// ============================================================
// OPTIONS & THRESHOLDS
// ============================================================
export const options = {
  stages: [
    { duration: RAMP_DURATION, target: Math.floor(VIRTUAL_USERS * 0.3) },
    { duration: RAMP_DURATION, target: Math.floor(VIRTUAL_USERS * 0.7) },
    { duration: DURATION,      target: VIRTUAL_USERS },
    { duration: RAMP_DURATION, target: 0 },
  ],
  thresholds: {
    http_req_duration:  ['p(95)<2000', 'p(99)<5000'],
    error_rate:         ['rate<0.05'],
    timeout_rate:       ['rate<0.02'],   // timeout < 2%
    error_4xx_rate:     ['rate<0.05'],   // 4xx < 5%
    error_5xx_rate:     ['rate<0.02'],   // 5xx < 2%
    http_req_failed:    ['rate<0.05'],
  },
  // Timeout per request 10 detik
  httpDebug: 'full',
};

// ============================================================
// REQUEST
// ============================================================
const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${BEARER_TOKEN}`,
};

const payload = JSON.stringify({
  loyaltyMemberId: 'KAI00000605',
  productCode:     '123PROM',
  storeCode:       'A',
  companyCode:     'KAI',
  productPrice:    20000,
  burnType:        'PAYFULL',
  additionalData: {
    origin:      'BANDUNG',
    destination: 'MANGGARAI',
    trainName:   'ARGO PARAHYANGAN',
    test:        'Test',
  },
});

// ============================================================
// MAIN TEST FUNCTION
// ============================================================
export default function () {
  const res = http.get(`${BASE_URL}`, {
    headers,
    body: payload,
    timeout: '10s', // request timeout 10 detik
  });

  // Deteksi timeout (status 0 = network error / timeout)
  const isTimeout = res.status === 0;
  const is4xx     = res.status >= 400 && res.status < 500;
  const is5xx     = res.status >= 500;
  const isSuccess = res.status === 200;

  // Track per kategori
  timeoutCount.add(isTimeout ? 1 : 0);
  error4xxCount.add(is4xx ? 1 : 0);
  error5xxCount.add(is5xx ? 1 : 0);
  successCount.add(isSuccess ? 1 : 0);
  failCount.add(!isSuccess ? 1 : 0);

  timeoutRate.add(isTimeout);
  error4xxRate.add(is4xx);
  error5xxRate.add(is5xx);
  errorRate.add(!isSuccess);
  responseTime.add(res.timings.duration);

  // Check & validasi
  check(res, {
    'status 200':          (r) => r.status === 200,
    'tidak timeout':       (r) => r.status !== 0,
    'tidak 4xx':           (r) => r.status < 400 || r.status >= 500,
    'tidak 5xx':           (r) => r.status < 500,
    'response time < 2s':  (r) => r.timings.duration < 2000,
  });

  // Log error detail ke console (keliatan di GitHub Actions log)
  if (isTimeout) {
    console.error(`[TIMEOUT] VU=${__VU} ITER=${__ITER} - Request timeout setelah 10s`);
  } else if (is4xx) {
    console.error(`[4xx ERROR] VU=${__VU} status=${res.status} body=${res.body.substring(0, 200)}`);
  } else if (is5xx) {
    console.error(`[5xx ERROR] VU=${__VU} status=${res.status} body=${res.body.substring(0, 200)}`);
  }

  sleep(1);
}

// ============================================================
// SUMMARY REPORT — dikirim ke Google Sheet
// ============================================================
export function handleSummary(data) {
  const totalReqs    = data.metrics.http_reqs?.values?.count || 0;
  const failedReqs   = data.metrics.http_req_failed?.values?.count || 0;
  const timeouts     = data.metrics.timeout_count?.values?.count || 0;
  const err4xx       = data.metrics.error_4xx_count?.values?.count || 0;
  const err5xx       = data.metrics.error_5xx_count?.values?.count || 0;
  const errorRatePct = ((data.metrics.http_req_failed?.values?.rate || 0) * 100).toFixed(2);

  // Tentukan status keseluruhan
  let overallStatus = 'PASS';
  const failReasons = [];

  if (data.metrics.http_req_failed?.values?.rate >= 0.05) {
    overallStatus = 'FAIL';
    failReasons.push(`Error rate ${errorRatePct}% (threshold <5%)`);
  }
  if (data.metrics.http_req_duration?.values['p(95)'] >= 2000) {
    overallStatus = 'FAIL';
    failReasons.push(`P95 response time ${data.metrics.http_req_duration?.values['p(95)'].toFixed(0)}ms (threshold <2000ms)`);
  }
  if (data.metrics.timeout_rate?.values?.rate >= 0.02) {
    overallStatus = 'FAIL';
    failReasons.push(`Timeout rate ${(data.metrics.timeout_rate?.values?.rate * 100).toFixed(2)}% (threshold <2%)`);
  }
  if (data.metrics.error_5xx_rate?.values?.rate >= 0.02) {
    overallStatus = 'FAIL';
    failReasons.push(`5xx error rate ${(data.metrics.error_5xx_rate?.values?.rate * 100).toFixed(2)}% (threshold <2%)`);
  }

  const summary = {
    timestamp:        new Date().toISOString(),
    target_url:       BASE_URL,
    virtual_users:    VIRTUAL_USERS,
    duration:         DURATION,
    status:           overallStatus,
    fail_reasons:     failReasons.join(' | ') || '-',

    // Volume
    total_requests:   totalReqs,
    req_per_second:   (data.metrics.http_reqs?.values?.rate || 0).toFixed(2),
    success_count:    totalReqs - failedReqs,
    fail_count:       failedReqs,

    // Error breakdown
    timeout_count:    timeouts,
    error_4xx_count:  err4xx,
    error_5xx_count:  err5xx,
    error_rate_pct:   errorRatePct,
    timeout_rate_pct: ((data.metrics.timeout_rate?.values?.rate || 0) * 100).toFixed(2),

    // Response time
    avg_response_ms:  (data.metrics.http_req_duration?.values?.avg || 0).toFixed(2),
    p95_response_ms:  (data.metrics.http_req_duration?.values['p(95)'] || 0).toFixed(2),
    p99_response_ms:  (data.metrics.http_req_duration?.values['p(99)'] || 0).toFixed(2),
    min_response_ms:  (data.metrics.http_req_duration?.values?.min || 0).toFixed(2),
    max_response_ms:  (data.metrics.http_req_duration?.values?.max || 0).toFixed(2),
  };

  console.log('K6_SUMMARY_JSON=' + JSON.stringify(summary));

  // Text report untuk GitHub Actions log
  const textReport = `
=====================================
       STRESS TEST REPORT
=====================================
Target URL  : ${BASE_URL}
Virtual Users: ${VIRTUAL_USERS}
Duration    : ${DURATION}
Status      : ${overallStatus}
${failReasons.length > 0 ? 'Fail Reasons: ' + failReasons.join('\n              ') : ''}
-------------------------------------
VOLUME
  Total Requests : ${totalReqs}
  Success        : ${totalReqs - failedReqs}
  Failed         : ${failedReqs}
  Req/s          : ${summary.req_per_second}
-------------------------------------
ERROR BREAKDOWN
  Timeout (0)    : ${timeouts}
  4xx Errors     : ${err4xx}
  5xx Errors     : ${err5xx}
  Error Rate     : ${errorRatePct}%
  Timeout Rate   : ${summary.timeout_rate_pct}%
-------------------------------------
RESPONSE TIME
  Avg            : ${summary.avg_response_ms} ms
  P95            : ${summary.p95_response_ms} ms
  P99            : ${summary.p99_response_ms} ms
  Min            : ${summary.min_response_ms} ms
  Max            : ${summary.max_response_ms} ms
=====================================
`;

  return {
    'summary.json': JSON.stringify(summary, null, 2),
    stdout: textReport,
  };
}

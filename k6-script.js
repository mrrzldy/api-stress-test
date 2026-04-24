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
const responseTime   = new Trend('response_time', true); // true = enable percentiles
const successCount   = new Counter('success_count');
const failCount      = new Counter('fail_count');
const timeoutCount   = new Counter('timeout_count');
const error4xxCount  = new Counter('error_4xx_count');
const error5xxCount  = new Counter('error_5xx_count');

// ============================================================
// CONFIG
// ============================================================
const BASE_URL      = __ENV.TARGET_URL    || 'https://your-dev-api.com';
const BEARER_TOKEN  = __ENV.BEARER_TOKEN  || '';
const VIRTUAL_USERS = parseInt(__ENV.VIRTUAL_USERS) || 100;
const DURATION      = __ENV.DURATION      || '1m';
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
    error_rate:      ['rate<0.05'],
    timeout_rate:    ['rate<0.02'],
    error_4xx_rate:  ['rate<0.05'],
    error_5xx_rate:  ['rate<0.02'],
    http_req_failed: ['rate<0.05'],
  },
};

// ============================================================
// PAYLOAD
// ============================================================
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
// ERROR SAMPLE COLLECTOR
// ============================================================
const errorSamples = [];

// ============================================================
// MAIN TEST FUNCTION
// ============================================================
export default function () {
  const res = http.post(`${BASE_URL}`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${BEARER_TOKEN}`,
    },
    timeout: '10s',
  });

  const isTimeout = res.status === 0;
  const is4xx     = res.status >= 400 && res.status < 500;
  const is5xx     = res.status >= 500;
  const isSuccess = res.status === 200;

  timeoutCount.add(isTimeout ? 1 : 0);
  error4xxCount.add(is4xx ? 1 : 0);
  error5xxCount.add(is5xx ? 1 : 0);
  successCount.add(isSuccess ? 1 : 0);
  failCount.add(!isSuccess ? 1 : 0);

  timeoutRate.add(isTimeout);
  error4xxRate.add(is4xx);
  error5xxRate.add(is5xx);
  errorRate.add(!isSuccess);

  // FIX: only add response time for non-timeout requests
  // Timeout responses have duration = 10000ms (the timeout ceiling),
  // which skews P95/P99 — exclude them for accurate percentiles
  if (!isTimeout) {
    responseTime.add(res.timings.duration);
  }

  // Collect error sample max 5
  if (!isSuccess && errorSamples.length < 5) {
    errorSamples.push({
      status: res.status,
      body:   res.body ? res.body.substring(0, 300) : '(empty)',
    });
  }

  check(res, {
    'status 200':         (r) => r.status === 200,
    'tidak timeout':      (r) => r.status !== 0,
    'tidak 4xx':          (r) => r.status < 400 || r.status >= 500,
    'tidak 5xx':          (r) => r.status < 500,
    'response time < 2s': (r) => r.timings.duration < 2000,
  });

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
// SUMMARY REPORT
// ============================================================
export function handleSummary(data) {
  const totalReqs    = data.metrics.http_reqs?.values?.count || 0;
  const failedReqs   = data.metrics.http_req_failed?.values?.count || 0;
  const timeouts     = data.metrics.timeout_count?.values?.count || 0;
  const err4xx       = data.metrics.error_4xx_count?.values?.count || 0;
  const err5xx       = data.metrics.error_5xx_count?.values?.count || 0;
  const errorRatePct = ((data.metrics.http_req_failed?.values?.rate || 0) * 100).toFixed(2);

  // FIX: use custom response_time metric (excludes timeouts) for accurate P95/P99
  // Falls back to http_req_duration if custom metric is unavailable
  const rtMetric = data.metrics.response_time || data.metrics.http_req_duration;
  const p95      = rtMetric?.values['p(95)'] || 0;
  const p99      = rtMetric?.values['p(99)'] || 0;
  const avgMs    = rtMetric?.values?.avg || 0;
  const minMs    = rtMetric?.values?.min || 0;
  const maxMs    = rtMetric?.values?.max || 0;

  // ── Status logic ──────────────────────────────────────────
  let overallStatus = 'PASS';
  const failReasons = [];

  if (data.metrics.http_req_failed?.values?.rate >= 0.05) {
    overallStatus = 'FAIL';
    failReasons.push(`Error rate ${errorRatePct}% (threshold <5%)`);
  }
  if (data.metrics.timeout_rate?.values?.rate >= 0.02) {
    overallStatus = 'FAIL';
    failReasons.push(`Timeout rate ${(data.metrics.timeout_rate?.values?.rate * 100).toFixed(2)}% (threshold <2%)`);
  }
  if (data.metrics.error_5xx_rate?.values?.rate >= 0.02) {
    overallStatus = 'FAIL';
    failReasons.push(`5xx error rate ${(data.metrics.error_5xx_rate?.values?.rate * 100).toFixed(2)}% (threshold <2%)`);
  }
  if (data.metrics.error_4xx_rate?.values?.rate >= 0.05) {
    overallStatus = 'FAIL';
    failReasons.push(`4xx error rate ${(data.metrics.error_4xx_rate?.values?.rate * 100).toFixed(2)}% (threshold <5%)`);
  }

  if (p95 >= 2000) {
    if (overallStatus === 'PASS') overallStatus = 'SLOW';
    failReasons.push(`P95 response time ${p95.toFixed(0)}ms (threshold <2000ms)`);
  }
  if (p99 >= 5000) {
    if (overallStatus === 'PASS') overallStatus = 'SLOW';
    failReasons.push(`P99 response time ${p99.toFixed(0)}ms (threshold <5000ms)`);
  }

  const httpStatusBreakdown = {};
  if (timeouts > 0) httpStatusBreakdown['timeout(0)'] = timeouts;
  if (err4xx > 0)   httpStatusBreakdown['4xx'] = err4xx;
  if (err5xx > 0)   httpStatusBreakdown['5xx'] = err5xx;

  const summary = {
    timestamp:        new Date().toISOString(),
    target_url:       BASE_URL,
    virtual_users:    VIRTUAL_USERS,
    duration:         DURATION,
    ramp_duration:    RAMP_DURATION,   // FIX: added missing field
    status:           overallStatus,
    fail_reasons:     failReasons.join(' | ') || '-',

    total_requests:   totalReqs,
    req_per_second:   (data.metrics.http_reqs?.values?.rate || 0).toFixed(2),
    success_count:    totalReqs - failedReqs,
    fail_count:       failedReqs,

    timeout_count:    timeouts,
    error_4xx_count:  err4xx,
    error_5xx_count:  err5xx,
    error_rate_pct:   errorRatePct,
    timeout_rate_pct: ((data.metrics.timeout_rate?.values?.rate || 0) * 100).toFixed(2),

    // FIX: use custom response_time metric for accurate values (excludes timeouts)
    avg_response_ms:  avgMs.toFixed(2),
    p95_response_ms:  p95.toFixed(2),
    p99_response_ms:  p99.toFixed(2),
    min_response_ms:  minMs.toFixed(2),
    max_response_ms:  maxMs.toFixed(2),

    http_status:      JSON.stringify(httpStatusBreakdown),
    error_sample:     JSON.stringify(errorSamples),
  };

  console.log('K6_SUMMARY_JSON=' + JSON.stringify(summary));

  const textReport = `
=====================================
       STRESS TEST REPORT
=====================================
Target URL   : ${BASE_URL}
Virtual Users: ${VIRTUAL_USERS}
Duration     : ${DURATION}
Ramp Duration: ${RAMP_DURATION}
Status       : ${overallStatus}
${failReasons.length > 0 ? 'Reasons      : ' + failReasons.join('\n               ') : ''}
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
RESPONSE TIME (excluding timeouts)
  Avg            : ${summary.avg_response_ms} ms
  P95            : ${summary.p95_response_ms} ms
  P99            : ${summary.p99_response_ms} ms
  Min            : ${summary.min_response_ms} ms
  Max            : ${summary.max_response_ms} ms
-------------------------------------
ERROR SAMPLES (max 5)
  ${errorSamples.length === 0
    ? 'Tidak ada error'
    : errorSamples.map((e, i) => `[${i + 1}] status=${e.status} body=${e.body}`).join('\n  ')}
=====================================
`;

  return {
    'summary.json': JSON.stringify(summary, null, 2),
    stdout: textReport,
  };
}

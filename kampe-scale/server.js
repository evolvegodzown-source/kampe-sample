// Kampe Dashboard server: serves the static dashboard + JSON API backed by the Kampe Postgres DB.
const express = require('express');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Load .env when present (local dev). On Netlify the same values come from
// site environment variables, so a missing .env must not crash the module.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2];
  }
} catch (_) { /* no .env — expect process env vars */ }

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 5,
  connectionTimeoutMillis: 15000,
});

const app = express();
// Netlify layout keeps the dashboard in public/; the original layout had
// index.html next to server.js. Serve both so local dev works unchanged.
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname, { index: 'index.html' }));

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  console.error('API error:', err.message);
  res.status(500).json({ error: err.message });
});

// KPIs sourced from "Pharmacies Lolades List.xlsx" (manual list maintained by the team):
//  - ONBOARDING ATTENDEES tab row count -> Onboarded Pharmacies
//  - TRAINED PHARMACIES tab row count   -> Trained Pharmacies
// Update these constants when the Excel file is refreshed.
const EXCEL_KPI = { onboarded: 193, trained: 139 };

// Pharmacies excluded from all DB-fed figures: test accounts, yopmail signups, Glad Pharmacy.
const PHARMACY_EXCLUSIONS = `p.is_test_account = false
  AND p.id IS DISTINCT FROM 1225
  AND (p.email IS NULL OR p.email NOT ILIKE '%yopmail.com%')
  AND LOWER(TRIM(p.name)) <> 'glad pharmacy'`;

app.get('/api/pharmacy-profiles', wrap(async (req, res) => {
  const windowDays = Math.min(Math.max(Number(req.query.window) || 30, 7), 365);
  const R = dateRange('b.created_at', req);
  const [withEnrollees, active, trend, cities, ledger] = await Promise.all([
    pool.query(`
      SELECT COUNT(DISTINCT b.primary_pharmacy_id)::int AS n
      FROM company_beneficiary b
      JOIN pharmacy_pharmacy p ON p.id = b.primary_pharmacy_id
      WHERE b.primary_pharmacy_id IS NOT NULL AND ${PHARMACY_EXCLUSIONS}${R.sql}`, R.vals),
    // Active = at least 1 new enrollee (beneficiary created) in the selected window
    pool.query(`
      SELECT COUNT(DISTINCT b.primary_pharmacy_id)::int AS n
      FROM company_beneficiary b
      JOIN pharmacy_pharmacy p ON p.id = b.primary_pharmacy_id
      WHERE b.primary_pharmacy_id IS NOT NULL AND ${PHARMACY_EXCLUSIONS}${R.sql}
        AND b.created_at >= NOW() - make_interval(days => $${R.vals.length + 1})`, [...R.vals, windowDays]),
    pool.query(`
      SELECT DATE_TRUNC('month', created_at)::date AS month, COUNT(*)::int AS n
      FROM pharmacy_pharmacy p
      WHERE created_at >= NOW() - INTERVAL '12 months' AND ${PHARMACY_EXCLUSIONS}
      GROUP BY 1 ORDER BY 1`),
    pool.query(`
      SELECT COALESCE(NULLIF(city, ''), 'Unspecified') AS city, COUNT(*)::int AS n
      FROM pharmacy_pharmacy p
      WHERE ${PHARMACY_EXCLUSIONS}
      GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
    pool.query(`
      SELECT name, address, city, created_at
      FROM pharmacy_pharmacy p
      WHERE ${PHARMACY_EXCLUSIONS}
      ORDER BY created_at DESC NULLS LAST
      LIMIT 1000`),
  ]);

  const onboarded = EXCEL_KPI.onboarded;
  const trained = EXCEL_KPI.trained;
  const activeN = active.rows[0].n;
  res.json({
    windowDays,
    sources: { onboarded: 'excel', trained: 'excel' },
    kpis: {
      onboarded,
      trained,
      withEnrollees: withEnrollees.rows[0].n,
      active: activeN,
      inactive: Math.max(trained - activeN, 0),
      pctActive: onboarded ? Math.round((activeN / onboarded) * 1000) / 10 : 0,
    },
    trend: trend.rows,
    cities: cities.rows,
    ledger: ledger.rows,
  });
}));

// Enrollment KPIs. Exclusions for ALL figures: policy_status 'inactive',
// enrollee emails containing yopmail.com, Glad Pharmacy, placeholder names
// (first/last name "doe"), the "azzez sanni" plan name (0 matches today,
// kept as a safeguard), and — per business rule — everyone enrolled in 2025.
const ENROLLEE_BASE = `FROM company_beneficiary b
  LEFT JOIN pharmacy_pharmacy p ON p.id = b.primary_pharmacy_id
  WHERE b.policy_status <> 'inactive'
    AND EXTRACT(YEAR FROM b.created_at) <> 2025
    AND (b.primary_pharmacy_id IS NULL OR b.primary_pharmacy_id <> 1225)
    AND (b.email IS NULL OR b.email NOT ILIKE '%yopmail.com%')
    AND (p.id IS NULL OR (p.id <> 1225 AND LOWER(TRIM(p.name)) <> 'glad pharmacy'))
    AND LOWER(TRIM(b.first_name)) <> 'doe'
    AND LOWER(TRIM(b.last_name)) <> 'doe'
    AND (b.plan_name IS NULL OR b.plan_name NOT ILIKE '%azzez sanni%')`;

// Shared calendar-range parsing: ?from=YYYY-MM-DD&to=YYYY-MM-DD on a date col.
function dateRange(col, req, base = 0) {
  const conds = [], vals = [];
  const { from, to } = req.query;
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) { vals.push(from); conds.push(`${col} >= $${base + vals.length}::date`); }
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) { vals.push(to); conds.push(`${col} < $${base + vals.length}::date + INTERVAL '1 day'`); }
  return { sql: conds.length ? ` AND ${conds.join(' AND ')}` : '', vals };
}

app.get('/api/enrollment', wrap(async (req, res) => {
  const trendGroup = ['year', 'month', 'week'].includes(req.query.trend) ? req.query.trend : 'month';
  // Date filters from the dashboard: calendar from/to range plus year/month
  // dropdowns. Combine freely; all enrollee figures honour them.
  const conds = [], vals = [];
  const { from, to, year, month } = req.query;
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) { vals.push(from); conds.push('b.created_at >= $IDX::date'); }
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) { vals.push(to); conds.push(`b.created_at < $IDX::date + INTERVAL '1 day'`); }
  if (year && /^\d{4}$/.test(year)) { vals.push(year); conds.push('EXTRACT(YEAR FROM b.created_at) = $IDX::int'); }
  if (month && /^(0?[1-9]|1[0-2])$/.test(month)) { vals.push(month); conds.push('EXTRACT(MONTH FROM b.created_at) = $IDX::int'); }
  // IDX is replaced with the real placeholder number; base=1 for the trend
  // query whose $1 is already the grouping unit.
  const FILTER = (base = 0) => conds.length
    ? ` AND ${conds.map((c, i) => c.replace('IDX', String(base + i + 1))).join(' AND ')}`
    : '';
  const [totals, newEnrollees, selfEnrolled, gender, planSplit, planNames, ageBrackets, enrollmentTrend] = await Promise.all([
    pool.query(`
      SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE b.policy_status = 'active')::int AS active,
        COUNT(*) FILTER (WHERE b.policy_status = 'expired')::int AS expired,
        ROUND(AVG(EXTRACT(YEAR FROM AGE(b.dob))))::int AS avg_age
      ${ENROLLEE_BASE}${FILTER()}`, vals),
    pool.query(`SELECT COUNT(*)::int AS n ${ENROLLEE_BASE}${FILTER()} AND b.created_at >= NOW() - INTERVAL '48 hours'`, vals),
    pool.query(`SELECT COUNT(*)::int AS n ${ENROLLEE_BASE}${FILTER()} AND b.source = 'online'`, vals),
    pool.query(`
      SELECT COALESCE(NULLIF(LOWER(b.gender), ''), 'unspecified') AS label, COUNT(*)::int AS n
      ${ENROLLEE_BASE}${FILTER()} GROUP BY 1 ORDER BY 2 DESC`, vals),
    pool.query(`
      SELECT b.policy_status AS label, COUNT(*)::int AS n
      ${ENROLLEE_BASE}${FILTER()} GROUP BY 1 ORDER BY 2 DESC`, vals),
    pool.query(`
      SELECT COALESCE(NULLIF(TRIM(b.plan_name), ''), 'Unspecified') AS label, COUNT(*)::int AS n
      ${ENROLLEE_BASE}${FILTER()} GROUP BY 1 ORDER BY 2 DESC LIMIT 6`, vals),
    pool.query(`
      SELECT CASE
          WHEN EXTRACT(YEAR FROM AGE(b.dob)) BETWEEN 1 AND 18 THEN '1-18'
          WHEN EXTRACT(YEAR FROM AGE(b.dob)) BETWEEN 19 AND 35 THEN '19-35'
          WHEN EXTRACT(YEAR FROM AGE(b.dob)) BETWEEN 36 AND 50 THEN '36-50'
          ELSE 'Above 50'
        END AS label, COUNT(*)::int AS n
      ${ENROLLEE_BASE}${FILTER()} AND b.dob IS NOT NULL
      GROUP BY 1`, vals),
    pool.query(`
      SELECT DATE_TRUNC($1, b.created_at)::date AS bucket, COUNT(*)::int AS n
      ${ENROLLEE_BASE}${FILTER(1)} GROUP BY 1 ORDER BY 1`, [trendGroup, ...vals]),
  ]);
  res.json({
    kpis: {
      total: totals.rows[0].total,
      active: totals.rows[0].active,
      expired: totals.rows[0].expired,
      new48h: newEnrollees.rows[0].n,
      selfEnrolled: selfEnrolled.rows[0].n,
      avgAge: totals.rows[0].avg_age,
    },
    gender: gender.rows,
    planSplit: planSplit.rows,
    planNames: planNames.rows,
    ageBrackets: ageBrackets.rows,
    enrollmentTrend: { group: trendGroup, rows: enrollmentTrend.rows },
    filter: { from: from || null, to: to || null, year: year || null, month: month || null },
  });
}));

// Enrollee activity (claims) KPIs and charts, fed live from
// company_beneficiaryactivity. Glad Pharmacy (id 1225) is excluded, as are
// claims belonging to 2025-created enrollees.
const ACTIVITY_BASE = `FROM company_beneficiaryactivity a
  LEFT JOIN pharmacy_pharmacy p ON p.id = a.pharmacy_id
  LEFT JOIN company_beneficiary b ON b.id = a.beneficiary_id
  WHERE a.pharmacy_id IS DISTINCT FROM 1225
    AND (p.id IS NULL OR p.id <> 1225)
    AND (b.id IS NULL OR EXTRACT(YEAR FROM b.created_at) <> 2025)`;

app.get('/api/activities', wrap(async (req, res) => {
  const R = dateRange('a.created_at', req);
  const [totals, titleSplit, monthly, topPharmacies, recent, testsPerformed, pharmacyTests] = await Promise.all([
    pool.query(`
      SELECT COUNT(*)::int AS total,
        COUNT(DISTINCT a.beneficiary_id)::int AS enrollees,
        COUNT(DISTINCT a.pharmacy_id)::int AS pharmacies,
        COUNT(*) FILTER (WHERE a.created_at >= NOW() - INTERVAL '30 days')::int AS last30
      ${ACTIVITY_BASE}${R.sql}`, R.vals),
    pool.query(`
      SELECT a.title AS label, COUNT(*)::int AS n
      ${ACTIVITY_BASE}${R.sql} GROUP BY 1 ORDER BY 2 DESC`, R.vals),
    pool.query(`
      SELECT DATE_TRUNC('month', a.created_at)::date AS bucket, COUNT(*)::int AS n
      ${ACTIVITY_BASE}${R.sql} GROUP BY 1 ORDER BY 1`, R.vals),
    pool.query(`
      SELECT COALESCE(p.name, 'Unspecified') AS label, COUNT(*)::int AS n
      ${ACTIVITY_BASE}${R.sql} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, R.vals),
    pool.query(`
      SELECT a.title, a.summary, a.created_at, COALESCE(p.name, 'Unspecified') AS pharmacy
      ${ACTIVITY_BASE}${R.sql} ORDER BY a.created_at DESC LIMIT 12`, R.vals),
    pool.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(a.details::text, '')) ILIKE '%malaria%'
        )::int AS malaria,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(a.details::text, '')) ILIKE '%fasting blood sugar%'
             OR LOWER(COALESCE(a.details::text, '')) ILIKE '%fbs%'
        )::int AS fbs,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(a.details::text, '')) ILIKE '%lung function%'
        )::int AS lung_function,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(a.details::text, '')) ILIKE '%pregnancy%'
             OR LOWER(COALESCE(a.details::text, '')) ILIKE '%pregnancy test%'
        )::int AS pt,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(a.details::text, '')) ILIKE '%blood pressure%'
             OR LOWER(COALESCE(a.details::text, '')) ILIKE '%bp%'
        )::int AS bp,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(a.details::text, '')) ILIKE '%protein%'
        )::int AS urinalysis,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(a.details::text, '')) ILIKE '%hepatitis%'
        )::int AS hepatitis
      ${ACTIVITY_BASE}${R.sql}`, R.vals),
    // Tests per pharmacy, same keyword logic as testsPerformed — feeds the
    // Pharmacy Activities pivot table
    pool.query(`
      SELECT COALESCE(p.name, 'Unspecified') AS pharmacy,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(a.details::text, '')) ILIKE '%malaria%')::int AS malaria,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(a.details::text, '')) ILIKE '%fasting blood sugar%'
             OR LOWER(COALESCE(a.details::text, '')) ILIKE '%fbs%'
        )::int AS fbs,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(a.details::text, '')) ILIKE '%lung function%')::int AS lung_function,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(a.details::text, '')) ILIKE '%pregnancy%'
             OR LOWER(COALESCE(a.details::text, '')) ILIKE '%pregnancy test%'
        )::int AS pt,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(a.details::text, '')) ILIKE '%blood pressure%'
             OR LOWER(COALESCE(a.details::text, '')) ILIKE '%bp%'
        )::int AS bp,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(a.details::text, '')) ILIKE '%protein%')::int AS urinalysis,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(a.details::text, '')) ILIKE '%hepatitis%')::int AS hepatitis
      ${ACTIVITY_BASE}${R.sql}
      GROUP BY 1 ORDER BY 2 DESC LIMIT 300`, R.vals),
  ]);
  const total = totals.rows[0].total || 1;
  res.json({
    kpis: {
      totalClaims: totals.rows[0].total,
      enrollees: totals.rows[0].enrollees,
      pharmacies: totals.rows[0].pharmacies,
      last30: totals.rows[0].last30,
      medPurchases: titleSplit.rows.find(r => r.label === 'Medication Purchase')?.n || 0,
    },
    testsPerformed: {
      malaria: Number(testsPerformed.rows[0].malaria || 0),
      fbs: Number(testsPerformed.rows[0].fbs || 0),
      lungFunction: Number(testsPerformed.rows[0].lung_function || 0),
      pt: Number(testsPerformed.rows[0].pt || 0),
      bp: Number(testsPerformed.rows[0].bp || 0),
      urinalysis: Number(testsPerformed.rows[0].urinalysis || 0),
      hepatitis: Number(testsPerformed.rows[0].hepatitis || 0),
    },
    titleSplit: titleSplit.rows.map(r => ({ ...r, pct: Math.round(r.n / total * 1000) / 10 })),
    monthly: monthly.rows,
    topPharmacies: topPharmacies.rows,
    recent: recent.rows,
    pharmacyTests: pharmacyTests.rows,
  });
}));

// POCT KPIs and charts, fed live from company_visittest, company_clinicalvisit
// and common_test. Supports the global calendar range on visit date.
app.get('/api/pocts', wrap(async (req, res) => {
  const R = dateRange('cv.created_at', req);
  const W = `cv.pharmacy_id IS DISTINCT FROM 1225${R.sql}`;
  const [kpis, monthly, screening, topTests, vitals, bp] = await Promise.all([
    pool.query(`
      SELECT
        (SELECT COUNT(*) FROM company_visittest v
         JOIN company_clinicalvisit cv ON cv.id = v.visit_id
         WHERE ${W})::int AS total_tests,
        (SELECT COUNT(*) FROM company_clinicalvisit cv WHERE ${W})::int AS visits,
        (SELECT COUNT(DISTINCT pharmacy_id) FROM company_clinicalvisit cv
         WHERE pharmacy_id IS NOT NULL AND ${W})::int AS pharmacies,
        (SELECT COUNT(*) FROM company_visittest v
         JOIN company_clinicalvisit cv ON cv.id = v.visit_id
         WHERE ${W})::numeric
          / NULLIF((SELECT COUNT(*) FROM company_clinicalvisit cv WHERE ${W}), 0) AS tests_per_visit,
        (SELECT COUNT(*) FILTER (WHERE LOWER(v.result) = 'positive')::numeric
           / NULLIF(COUNT(*) FILTER (WHERE LOWER(v.result) IN ('positive', 'negative')), 0)
         FROM company_visittest v
         JOIN company_clinicalvisit cv ON cv.id = v.visit_id
         JOIN common_test t ON t.id = v.test_id
         WHERE t.name = 'Malaria' AND ${W}) AS malaria_positivity
    `, R.vals),
    pool.query(`
      SELECT DATE_TRUNC('month', cv.created_at)::date AS bucket, COUNT(*)::int AS n
      FROM company_visittest v
      JOIN company_clinicalvisit cv ON cv.id = v.visit_id
      WHERE ${W}
      GROUP BY 1 ORDER BY 1`, R.vals),
    pool.query(`
      SELECT t.name AS label,
        COUNT(*)::int AS tested,
        COUNT(*) FILTER (WHERE LOWER(v.result) = 'positive')::int AS positive
      FROM company_visittest v
      JOIN company_clinicalvisit cv ON cv.id = v.visit_id
      JOIN common_test t ON t.id = v.test_id
      WHERE ${W}
        AND t.name IN ('Malaria', 'Hepatitis B', 'Pregnancy Test result')
      GROUP BY 1 ORDER BY 2 DESC`, R.vals),
    pool.query(`
      SELECT CASE
          WHEN t.name = 'Diastolic blood pressure' THEN 'BP'
          WHEN t.name = 'Fasting Blood Sugar' THEN 'FBS'
          ELSE t.name
        END AS label, COUNT(*)::int AS n
      FROM company_visittest v
      JOIN company_clinicalvisit cv ON cv.id = v.visit_id
      JOIN common_test t ON t.id = v.test_id
      WHERE ${W}
        AND t.name <> 'Systolic blood pressure'
      GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, R.vals),
    pool.query(`
      SELECT COUNT(weight)::int AS weight, COUNT(temperature)::int AS temperature, COUNT(bmi)::int AS bmi
      FROM company_clinicalvisit cv
      WHERE ${W}`, R.vals),
    pool.query(`
      WITH bp AS (
        SELECT v.visit_id,
          MAX(CASE WHEN t.name = 'Systolic blood pressure' THEN v.result::numeric END) AS sys,
          MAX(CASE WHEN t.name = 'Diastolic blood pressure' THEN v.result::numeric END) AS dia
        FROM company_visittest v
        JOIN company_clinicalvisit cv ON cv.id = v.visit_id
        JOIN common_test t ON t.id = v.test_id
        WHERE ${W}
          AND t.name IN ('Systolic blood pressure', 'Diastolic blood pressure')
          AND v.result ~ '^\\d+(\\.\\d+)?$'
        GROUP BY v.visit_id)
      SELECT COUNT(*)::int AS bp_visits,
        COUNT(*) FILTER (WHERE sys >= 140 OR dia >= 90)::int AS elevated_visits
      FROM bp`, R.vals),
  ]);
  res.json({
    kpis: {
      totalTests: kpis.rows[0].total_tests,
      visits: kpis.rows[0].visits,
      pharmacies: kpis.rows[0].pharmacies,
      testsPerVisit: Math.round((Number(kpis.rows[0].tests_per_visit) || 0) * 10) / 10,
      malariaPositivity: Math.round((Number(kpis.rows[0].malaria_positivity) || 0) * 1000) / 10,
    },
    monthly: monthly.rows,
    screening: screening.rows,
    topTests: topTests.rows,
    vitals: {
      ...vitals.rows[0],
      bpVisits: bp.rows[0].bp_visits,
      elevatedBpVisits: bp.rows[0].elevated_visits,
    },
  });
}));

// Revenue KPIs:
//  - Pillometer Lite: trained pharmacies (from the ONBOARDING/TRAINED Excel
//    KPIs above) each pay EUR 50; converted to Naira at the rate from
//    "Exchange Rate.xlsx" (Average sheet).
//  - Kampe Meds: Odoo orderlines (invoiced qty > 0) whose product
//    fuzzy-matches (>=85%) the Kampe Drug List, bought by customers that
//    fuzzy-match (>=85%) a TRAINED pharmacy from Pharmacies Lolades List.xlsx.
//    Computed by odoo_meds.py into odoo_meds_cache.json; per-line rows are
//    served for date filtering.
//  - Cards: every eligible enrollee is a sold card; revenue is 20% of the
//    plan cost. Plan prices are stored in kobo, hence / 100.
const meds = require('./odoo-meds');
const EUR_TO_NGN = 1665.421; // Exchange Rate.xlsx, sheet "Average"
const PILLOMETER_LITE_EUR = 50;
const CARD_SHARE = 0.20;

app.get('/api/revenue', wrap(async (req, res) => {
  const [m, cards] = await Promise.all([
    meds.get(),
    pool.query(`
      SELECT COUNT(*)::int AS cards_sold,
        COALESCE(SUM(COALESCE(kp.price, 0)), 0)::numeric AS price_kobo
      FROM company_beneficiary b
      LEFT JOIN pharmacy_pharmacy p ON p.id = b.primary_pharmacy_id
      LEFT JOIN company_kampeplan kp ON kp.id = b.kampe_plan_id
      WHERE b.policy_status <> 'inactive'
        AND EXTRACT(YEAR FROM b.created_at) <> 2025
        AND (b.primary_pharmacy_id IS NULL OR b.primary_pharmacy_id <> 1225)
        AND (b.email IS NULL OR b.email NOT ILIKE '%yopmail.com%')
        AND (p.id IS NULL OR (p.id <> 1225 AND LOWER(TRIM(p.name)) <> 'glad pharmacy'))
        AND LOWER(TRIM(b.first_name)) <> 'doe'
        AND LOWER(TRIM(b.last_name)) <> 'doe'
        AND (b.plan_name IS NULL OR b.plan_name NOT ILIKE '%azzez sanni%')`),
  ]);
  const trained = EXCEL_KPI.trained;
  const eur = trained * PILLOMETER_LITE_EUR;
  res.json({
    eurToNgn: EUR_TO_NGN,
    kpis: {
      trainedPharmacies: trained,
      pillometerLiteEUR: eur,
      pillometerLiteNGN: Math.round(eur * EUR_TO_NGN),
      kampeMedsNGN: Math.round(m.revenue),
      kampeMedsMatchedProducts: m.matchedProducts,
      cardsSold: cards.rows[0].cards_sold,
      cardsRevenueNGN: Math.round(Number(cards.rows[0].price_kobo) / 100 * CARD_SHARE),
    },
    meds: {
      orderlineRows: m.orderlineRows,
      invoicedRows: m.invoicedRows,
      matchedRows: m.matchedRows,
      kampeRows: m.kampeRows ?? null,
      matchThreshold: m.matchThreshold,
      computedAt: m.computedAt,
      stale: m.stale === true,
      audit: m.audit || null,
      lines: m.lines,
    },
  });
}));

const PHARMACY_ENROLLEE_BASE = `${ENROLLEE_BASE}
  AND (p.id IS NULL OR (${PHARMACY_EXCLUSIONS}))`;

// Renewals analytics: a beneficiary paying more than once is a renewal.
// Only paid payments tied to an eligible beneficiary (same exclusions as
// everywhere else, incl. the 2025 rule) are counted.
const PAYMENT_BASE = `FROM payment_payment pay
  JOIN company_beneficiary b ON b.id = pay.beneficiary_id
  LEFT JOIN pharmacy_pharmacy p ON p.id = b.primary_pharmacy_id
  WHERE pay.is_paid = true
    AND pay.status IN ('success', 'paid')
    AND b.policy_status <> 'inactive'
    AND EXTRACT(YEAR FROM b.created_at) <> 2025
    AND (b.primary_pharmacy_id IS NULL OR b.primary_pharmacy_id <> 1225)
    AND (b.email IS NULL OR b.email NOT ILIKE '%yopmail.com%')
    AND (p.id IS NULL OR (p.id <> 1225 AND LOWER(TRIM(p.name)) <> 'glad pharmacy'))
    AND LOWER(TRIM(b.first_name)) <> 'doe'
    AND LOWER(TRIM(b.last_name)) <> 'doe'
    AND (b.plan_name IS NULL OR b.plan_name NOT ILIKE '%azzez sanni%')`;

app.get('/api/renewals', wrap(async (req, res) => {
  const R = dateRange('pay.created_at', req);
  const RANKED = `WITH ranked AS (
    SELECT pay.beneficiary_id, pay.amount, pay.created_at, b.plan_name, b.first_name, b.last_name,
      ROW_NUMBER() OVER (PARTITION BY pay.beneficiary_id ORDER BY pay.created_at, pay.id) AS rn
    ${PAYMENT_BASE}${R.sql})`;
  const [kpis, monthly, plans, topRenewers] = await Promise.all([
    pool.query(`
      ${RANKED}
      SELECT COUNT(*)::int AS payments,
        COUNT(DISTINCT beneficiary_id)::int AS payers,
        COUNT(*) FILTER (WHERE rn = 1)::int AS first_payments,
        COUNT(*) FILTER (WHERE rn > 1)::int AS renewals,
        COUNT(DISTINCT beneficiary_id) FILTER (WHERE rn > 1)::int AS renewers,
        COALESCE(SUM(amount) FILTER (WHERE rn > 1), 0)::numeric AS renewal_amount,
        COALESCE(SUM(amount) FILTER (WHERE rn = 1), 0)::numeric AS first_amount
      FROM ranked`, R.vals),
    pool.query(`
      ${RANKED}
      SELECT DATE_TRUNC('month', created_at)::date AS bucket,
        COUNT(*) FILTER (WHERE rn = 1)::int AS firsts,
        COUNT(*) FILTER (WHERE rn > 1)::int AS renewals
      FROM ranked GROUP BY 1 ORDER BY 1`, R.vals),
    pool.query(`
      ${RANKED}
      SELECT COALESCE(NULLIF(TRIM(plan_name), ''), 'Unspecified') AS plan,
        COUNT(DISTINCT beneficiary_id)::int AS payers,
        COUNT(DISTINCT beneficiary_id) FILTER (WHERE rn > 1)::int AS renewers
      FROM ranked GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, R.vals),
    pool.query(`
      ${RANKED}
      SELECT TRIM(first_name || ' ' || last_name) AS label,
        COUNT(*)::int AS n,
        SUM(amount)::numeric AS total,
        MAX(created_at)::date AS last_pay
      FROM ranked GROUP BY beneficiary_id, first_name, last_name
      HAVING COUNT(*) > 1 ORDER BY 2 DESC LIMIT 15`, R.vals),
  ]);
  const k = kpis.rows[0];
  const payers = k.payers || 1;
  res.json({
    kpis: {
      payments: k.payments,
      payers: k.payers,
      firstPayments: k.first_payments,
      renewals: k.renewals,
      renewers: k.renewers,
      renewalRate: Math.round((k.renewers / payers) * 1000) / 10,
      avgPerPayer: Math.round((k.payments / payers) * 100) / 100,
      renewalAmount: Number(k.renewal_amount),
      firstAmount: Number(k.first_amount),
    },
    monthly: monthly.rows,
    plans: plans.rows.map(r => ({
      ...r,
      rate: r.payers ? Math.round((r.renewers / r.payers) * 1000) / 10 : 0,
    })),
    topRenewers: topRenewers.rows.map(r => ({ ...r, total: Number(r.total) })),
  });
}));

// Individual-location variant: enrollees are counted per pharmacy LOCATION
// (primary_pharmacy_location_id) so same-name branches are never merged.
const LOCATION_ENROLLEE_BASE = `FROM company_beneficiary b
  JOIN pharmacy_pharmacylocation loc ON loc.id = b.primary_pharmacy_location_id
  JOIN pharmacy_pharmacy p ON p.id = loc.pharmacy_id
  WHERE b.policy_status <> 'inactive'
    AND (b.primary_pharmacy_id IS NULL OR b.primary_pharmacy_id <> 1225)
    AND (b.email IS NULL OR b.email NOT ILIKE '%yopmail.com%')
    AND p.id <> 1225
    AND LOWER(TRIM(p.name)) <> 'glad pharmacy'
    AND LOWER(TRIM(b.first_name)) <> 'doe'
    AND LOWER(TRIM(b.last_name)) <> 'doe'
    AND (b.plan_name IS NULL OR b.plan_name NOT ILIKE '%azzez sanni%')
    AND (${PHARMACY_EXCLUSIONS})`;

app.get('/api/pharmacy-enrollments', wrap(async (req, res) => {
  // Date filters (year/month/week of enrollee created_at) applied to the
  // plan breakdown and the pharmacy x plan table only.
  const conds = [], vals = [];
  const { year, month, week } = req.query;
  if (year && /^\d{4}$/.test(year)) { vals.push(year); conds.push('EXTRACT(YEAR FROM b.created_at) = $IDX::int'); }
  if (month && /^(0?[1-9]|1[0-2])$/.test(month)) { vals.push(month); conds.push('EXTRACT(MONTH FROM b.created_at) = $IDX::int'); }
  if (week && /^(0?[1-9]|[1-4][0-9]|5[0-3])$/.test(week)) { vals.push(week); conds.push('EXTRACT(WEEK FROM b.created_at) = $IDX::int'); }
  const FILTER = ` AND ${conds.map((c, i) => c.replace('IDX', String(i + 1))).join(' AND ')}`;
  const R = dateRange('b.created_at', req, conds.length);
  const RANGE = R.sql;
  const ALLVALS = [...vals, ...R.vals];
  const [kpis, topPharmacies, planSummary, tableRows, filterOptions, mostActive, newest, mostLocations] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*)::int AS enrollees,
        COUNT(*) FILTER (WHERE b.primary_pharmacy_id IS NOT NULL)::int AS assigned_enrollees,
        COUNT(*) FILTER (WHERE b.primary_pharmacy_id IS NULL)::int AS self_enrolled,
        COUNT(DISTINCT b.primary_pharmacy_id) FILTER (WHERE b.primary_pharmacy_id IS NOT NULL)::int AS pharmacies_with_enrollees,
        ROUND(100.0 * COUNT(*) FILTER (WHERE b.primary_pharmacy_id IS NOT NULL)
          / NULLIF(COUNT(*), 0), 1)::numeric AS coverage_pct
      ${PHARMACY_ENROLLEE_BASE}`),
    pool.query(`
      SELECT p.name AS label, COALESCE(NULLIF(p.city, ''), 'Unspecified') AS city,
        COUNT(*)::int AS n
      ${PHARMACY_ENROLLEE_BASE}
        AND b.primary_pharmacy_id IS NOT NULL
      GROUP BY p.name, p.city ORDER BY 3 DESC LIMIT 15`),
    pool.query(`
      SELECT COALESCE(NULLIF(TRIM(b.plan_name), ''), 'Unspecified') AS plan,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE b.policy_status = 'active')::int AS active,
        COUNT(*) FILTER (WHERE b.policy_status = 'expired')::int AS expired
      ${PHARMACY_ENROLLEE_BASE}${conds.length ? FILTER : ''}${RANGE}
      GROUP BY 1 ORDER BY 2 DESC`, ALLVALS),
    pool.query(`
      SELECT loc.id AS location_id, p.name AS pharmacy, loc.name AS location_name,
        COALESCE(NULLIF(TRIM(loc.address), ''), COALESCE(NULLIF(TRIM(p.address), ''), 'Unspecified')) AS address,
        COALESCE(NULLIF(loc.city, ''), COALESCE(NULLIF(p.city, ''), 'Unspecified')) AS city,
        COALESCE(NULLIF(TRIM(b.plan_name), ''), 'Unspecified') AS plan,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE b.policy_status = 'active')::int AS active,
        COUNT(*) FILTER (WHERE b.policy_status = 'expired')::int AS expired
      ${LOCATION_ENROLLEE_BASE}${conds.length ? FILTER : ''}${RANGE}
      GROUP BY 1, 2, 3, 4, 5, 6
      ORDER BY 7 DESC
      LIMIT 2000`, ALLVALS),
    pool.query(`
      SELECT DISTINCT EXTRACT(YEAR FROM b.created_at)::int AS year,
        EXTRACT(WEEK FROM b.created_at)::int AS week
      ${PHARMACY_ENROLLEE_BASE}`),
    pool.query(`
      SELECT p.name || ' · ' || COALESCE(NULLIF(loc.name, ''), 'main') AS label,
        COUNT(*)::int AS n
      ${LOCATION_ENROLLEE_BASE}
      GROUP BY loc.id, p.name, loc.name
      ORDER BY 2 DESC LIMIT 1`),
    pool.query(`
      SELECT p.name AS label, MAX(p.created_at)::date AS since
      ${PHARMACY_ENROLLEE_BASE}
        AND b.primary_pharmacy_id IS NOT NULL
      GROUP BY p.name ORDER BY 2 DESC NULLS LAST LIMIT 1`),
    pool.query(`
      SELECT p.name AS label, COUNT(DISTINCT loc.id)::int AS n
      ${LOCATION_ENROLLEE_BASE}
      GROUP BY p.name ORDER BY 2 DESC LIMIT 1`),
  ]);
  res.json({
    kpis: Object.fromEntries(Object.entries(kpis.rows[0]).map(([key, value]) => [key, Number(value || 0)])),
    pharmacyKpis: {
      mostActive: mostActive.rows[0] || null,
      newest: newest.rows[0] || null,
      mostLocations: mostLocations.rows[0] || null,
    },
    topPharmacies: topPharmacies.rows,
    planSummary: planSummary.rows,
    tableRows: tableRows.rows,
    filterYears: [...new Set(filterOptions.rows.map(r => r.year))].sort((a, b) => b - a),
    filterWeeks: [...new Set(filterOptions.rows.map(r => r.week))].sort((a, b) => a - b),
    filter: { year: year || null, month: month || null, week: week || null },
  });
}));

// Quality Score: four per-pharmacy measures on a 5-star scale.
// Bands (per measure, per pharmacy): >=80% -> 5 stars, NGN 30,000;
// 60-79.99% -> 3 stars, NGN 20,000; below 60% -> 0 stars, NGN 0.
// Q1 (BP measurement) is scored per pharmacy LOCATION on adult enrollees:
// distinct adults with >=1 BP-test activity / total adult enrollees, plus
// each location's total clinical visits.
app.get('/api/quality', wrap(async (req, res) => {
  const RA = dateRange('a.created_at', req);
  const RV = dateRange('cv.created_at', req);
  const [activity, htnRx, highBpVisits, positiveMalariaTests, adults, poct, bpLocations, visits] = await Promise.all([
    pool.query(`
      SELECT COALESCE(p.name, 'Unspecified') AS pharmacy,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(a.details::text, '')) ILIKE '%blood pressure%'
             OR LOWER(COALESCE(a.details::text, '')) ILIKE '%bp%'
        )::int AS bp_tests,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(a.details::text, '')) ILIKE '%malaria%'
        )::int AS malaria_tests,
        COUNT(*) FILTER (
          WHERE a.title = 'Medication Purchase'
            AND LOWER(COALESCE(a.details::text, '')) ~
                '(artemether|lumefantrine|amatem|camosunate|p-?alaxin|co-?mal|coartem|artesunate|quinine|swidar|chloroquine|malar)'
        )::int AS malaria_rx
      ${ACTIVITY_BASE}${RA.sql}
      GROUP BY 1 ORDER BY 1`, RA.vals),
    pool.query(`
      SELECT COALESCE(p.name, 'Unspecified') AS pharmacy,
        COUNT(DISTINCT a.id)::int AS htn_rx
      ${ACTIVITY_BASE}${RA.sql}
        AND a.title = 'Medication Purchase'
        AND LOWER(COALESCE(a.details::text, '')) ~
          '(nifedipine|nucard|lisinopril|amlodipine|renix|vasoprin)'
      GROUP BY 1 ORDER BY 1`, RA.vals),
    pool.query(`
      SELECT COALESCE(p.name, 'Unspecified') AS pharmacy,
        COUNT(DISTINCT cv.id)::int AS high_bp_visits
      FROM company_clinicalvisit cv
      JOIN company_visittest v ON v.visit_id = cv.id
      JOIN common_test t ON t.id = v.test_id
      LEFT JOIN pharmacy_pharmacy p ON p.id = cv.pharmacy_id
      WHERE cv.pharmacy_id IS DISTINCT FROM 1225
        AND (p.id IS NULL OR p.id <> 1225)
        AND LOWER(t.name) = 'systolic blood pressure'
        AND v.result ~ '^\\d+(\\.\\d+)?$'
        AND v.result::numeric > 120${RV.sql}
      GROUP BY 1 ORDER BY 1`, RV.vals),
    pool.query(`
      SELECT COALESCE(p.name, 'Unspecified') AS pharmacy,
        COUNT(DISTINCT v.id)::int AS positive_malaria_tests
      FROM company_visittest v
      JOIN company_clinicalvisit cv ON cv.id = v.visit_id
      JOIN common_test t ON t.id = v.test_id
      LEFT JOIN pharmacy_pharmacy p ON p.id = cv.pharmacy_id
      WHERE cv.pharmacy_id IS DISTINCT FROM 1225
        AND (p.id IS NULL OR p.id <> 1225)
        AND LOWER(t.name) = 'malaria'
        AND LOWER(TRIM(v.result)) = 'positive'${RV.sql}
      GROUP BY 1 ORDER BY 1`, RV.vals),
    pool.query(`
      SELECT p.name AS pharmacy, COUNT(*)::int AS n
      ${PHARMACY_ENROLLEE_BASE}
        AND b.primary_pharmacy_id IS NOT NULL
        AND EXTRACT(YEAR FROM AGE(b.dob)) >= 18
      GROUP BY p.name`, []),
    pool.query(`
      WITH bp AS (
        SELECT v.visit_id,
          MAX(CASE WHEN t.name = 'Systolic blood pressure' THEN 1 ELSE 0 END)
            + MAX(CASE WHEN t.name = 'Diastolic blood pressure' THEN 1 ELSE 0 END) AS both_bp
        FROM company_visittest v
        JOIN common_test t ON t.id = v.test_id
        WHERE t.name IN ('Systolic blood pressure', 'Diastolic blood pressure')
        GROUP BY v.visit_id)
      SELECT COALESCE(p.name, 'Unspecified') AS pharmacy,
        COUNT(DISTINCT cv.id)::int AS visits,
        COUNT(DISTINCT cv.id) FILTER (WHERE bp.both_bp = 2)::int AS bp_readings
      FROM company_clinicalvisit cv
      LEFT JOIN bp ON bp.visit_id = cv.id
      LEFT JOIN pharmacy_pharmacy p ON p.id = cv.pharmacy_id
      WHERE cv.pharmacy_id IS DISTINCT FROM 1225
        AND (p.id IS NULL OR p.id <> 1225)${RV.sql}
      GROUP BY 1 ORDER BY 1`, RV.vals),
    pool.query(`
      SELECT loc.id AS location_id, p.name AS pharmacy, loc.name AS location_name,
        COALESCE(NULLIF(TRIM(loc.address), ''), COALESCE(NULLIF(TRIM(p.address), ''), 'Unspecified')) AS address,
        COUNT(DISTINCT b.id)::int AS adult_enrollees,
        COUNT(DISTINCT b.id) FILTER (WHERE a.id IS NOT NULL)::int AS adults_with_bp
      FROM company_beneficiary b
      JOIN pharmacy_pharmacylocation loc ON loc.id = b.primary_pharmacy_location_id
      JOIN pharmacy_pharmacy p ON p.id = loc.pharmacy_id
      LEFT JOIN company_beneficiaryactivity a
        ON a.beneficiary_id = b.id
        AND a.pharmacy_id = loc.pharmacy_id
        AND a.pharmacy_id IS DISTINCT FROM 1225
        AND (LOWER(COALESCE(a.details::text, '')) ILIKE '%blood pressure%'
           OR LOWER(COALESCE(a.details::text, '')) ILIKE '%bp%')${RA.sql}
      WHERE EXTRACT(YEAR FROM AGE(b.dob)) >= 18
        AND b.policy_status <> 'inactive'
        AND EXTRACT(YEAR FROM b.created_at) <> 2025
        AND (b.email IS NULL OR b.email NOT ILIKE '%yopmail.com%')
        AND p.id <> 1225
        AND LOWER(TRIM(p.name)) <> 'glad pharmacy'
        AND LOWER(TRIM(b.first_name)) <> 'doe'
        AND LOWER(TRIM(b.last_name)) <> 'doe'
        AND (b.plan_name IS NULL OR b.plan_name NOT ILIKE '%azzez sanni%')
        AND (${PHARMACY_EXCLUSIONS})
      GROUP BY 1, 2, 3, 4
      ORDER BY 5 DESC`, RA.vals),
    pool.query(`
      SELECT COALESCE(p.name, 'Unspecified') AS pharmacy, COUNT(*)::int AS visits
      FROM company_clinicalvisit cv
      LEFT JOIN pharmacy_pharmacy p ON p.id = cv.pharmacy_id
      WHERE cv.pharmacy_id IS DISTINCT FROM 1225
        AND (p.id IS NULL OR p.id <> 1225)${RV.sql}
      GROUP BY 1`, RV.vals),
  ]);
  const byPharm = new Map();
  const add = (row, fields) => {
    if (!byPharm.has(row.pharmacy)) byPharm.set(row.pharmacy, { pharmacy: row.pharmacy });
    const o = byPharm.get(row.pharmacy);
    for (const f of fields) o[f] = row[f] ?? 0;
  };
  activity.rows.forEach(r => add(r, ['bp_tests', 'malaria_tests', 'malaria_rx']));
  htnRx.rows.forEach(r => add(r, ['htn_rx']));
  highBpVisits.rows.forEach(r => add(r, ['high_bp_visits']));
  positiveMalariaTests.rows.forEach(r => add(r, ['positive_malaria_tests']));
  adults.rows.forEach(r => add(r, ['n']));
  poct.rows.forEach(r => add(r, ['visits', 'bp_readings']));
  const visitsByPharm = Object.fromEntries(visits.rows.map(r => [r.pharmacy, r.visits]));
  const rows = [...byPharm.values()].map(r => ({
    pharmacy: r.pharmacy,
    adultEnrollees: r.n || 0,
    bpTests: r.bp_tests || 0,
    htnRx: r.htn_rx || 0,
    highBpVisits: r.high_bp_visits || 0,
    malariaTests: r.positive_malaria_tests || 0,
    malariaRx: r.malaria_rx || 0,
    visits: r.visits || 0,
    bpReadings: r.bp_readings || 0,
  }));
  res.json({
    rows,
    bpLocations: bpLocations.rows.map(r => ({
      locationId: r.location_id,
      pharmacy: r.pharmacy,
      locationName: r.location_name,
      address: r.address,
      adultEnrollees: r.adult_enrollees,
      adultsWithBp: r.adults_with_bp,
      visits: visitsByPharm[r.pharmacy] || 0,
    })),
  });
}));

// Malaria positive cases line listing: one row per positive malaria test,
// with the antimalarial dispensed (if any) recorded for the same beneficiary
// within 7 days after the test. Pharmacy exclusions match the rest of the
// dashboard (Glad Pharmacy id 1225, test accounts, yopmail signups).
const ANTIMALARIAL_RE = '(artemether|lumefantrine|amatem|camosunate|p-?alaxin|co-?mal|coartem|artesunate|quinine|swidar|chloroquine|malar)';

app.get('/api/malaria-cases', wrap(async (req, res) => {
  const R = dateRange('cv.created_at', req);
  const { rows } = await pool.query(`
    SELECT to_char(cv.created_at::date, 'YYYY-MM-DD') AS date,
      TRIM(COALESCE(b.first_name, '') || ' ' || COALESCE(b.last_name, '')) AS beneficiary,
      COALESCE(p.name, 'Unspecified') AS pharmacy,
      rx.drug_names AS drugs
    FROM company_visittest v
    JOIN company_clinicalvisit cv ON cv.id = v.visit_id
    JOIN common_test t ON t.id = v.test_id
    LEFT JOIN company_beneficiary b ON b.id = cv.beneficiary_id
    LEFT JOIN pharmacy_pharmacy p ON p.id = cv.pharmacy_id
    LEFT JOIN LATERAL (
      SELECT (
        SELECT string_agg(DISTINCT prod->>'product_name', '; ')
        FROM jsonb_array_elements(COALESCE(a.details->'products', '[]'::jsonb)) prod
        WHERE LOWER(COALESCE(prod->>'product_name', '')) ~ '${ANTIMALARIAL_RE}'
      ) AS drug_names
      FROM company_beneficiaryactivity a
      WHERE a.beneficiary_id = cv.beneficiary_id
        AND a.title = 'Medication Purchase'
        AND LOWER(COALESCE(a.details::text, '')) ~ '${ANTIMALARIAL_RE}'
        AND a.created_at BETWEEN cv.created_at - INTERVAL '1 day' AND cv.created_at + INTERVAL '7 days'
      ORDER BY a.created_at
      LIMIT 1
    ) rx ON true
    WHERE LOWER(t.name) = 'malaria'
      AND LOWER(TRIM(v.result)) = 'positive'
      AND cv.pharmacy_id IS DISTINCT FROM 1225
      AND (p.id IS NULL OR (${PHARMACY_EXCLUSIONS}))${R.sql}
    ORDER BY cv.created_at DESC
    LIMIT 5000`, R.vals);
  const cases = rows.map(r => ({ date: r.date, beneficiary: r.beneficiary, pharmacy: r.pharmacy, drugs: r.drugs || null }));
  res.json({
    rows: cases,
    total: cases.length,
    withRx: cases.filter(r => r.drugs).length,
  });
}));

// High BP line listing: one row per clinical visit whose highest systolic
// reading is > 140 mmHg, with the antihypertensive dispensed (if any) for the
// same beneficiary within 7 days after the visit. Pharmacy exclusions match
// the rest of the dashboard (Glad Pharmacy id 1225, test accounts, yopmail).
const HTN_RX_RE = '(nifedipine|nucard|lisinopril|amlodipine|renix|vasoprin)';

app.get('/api/high-bp', wrap(async (req, res) => {
  const R = dateRange('cv.created_at', req);
  const { rows } = await pool.query(`
    SELECT to_char(cv.created_at::date, 'YYYY-MM-DD') AS date,
      TRIM(COALESCE(b.first_name, '') || ' ' || COALESCE(b.last_name, '')) AS beneficiary,
      COALESCE(p.name, 'Unspecified') AS pharmacy,
      MAX(v.result::numeric) FILTER (WHERE LOWER(t.name) = 'systolic blood pressure')::int AS systolic,
      MAX(v.result::numeric) FILTER (WHERE LOWER(t.name) = 'diastolic blood pressure')::int AS diastolic,
      rx.drug_names AS drugs
    FROM company_clinicalvisit cv
    JOIN company_visittest v ON v.visit_id = cv.id
    JOIN common_test t ON t.id = v.test_id
    LEFT JOIN company_beneficiary b ON b.id = cv.beneficiary_id
    LEFT JOIN pharmacy_pharmacy p ON p.id = cv.pharmacy_id
    LEFT JOIN LATERAL (
      SELECT (
        SELECT string_agg(DISTINCT prod->>'product_name', '; ')
        FROM jsonb_array_elements(COALESCE(a.details->'products', '[]'::jsonb)) prod
        WHERE LOWER(COALESCE(prod->>'product_name', '')) ~ '${HTN_RX_RE}'
      ) AS drug_names
      FROM company_beneficiaryactivity a
      WHERE a.beneficiary_id = cv.beneficiary_id
        AND a.title = 'Medication Purchase'
        AND LOWER(COALESCE(a.details::text, '')) ~ '${HTN_RX_RE}'
        AND a.created_at BETWEEN cv.created_at - INTERVAL '1 day' AND cv.created_at + INTERVAL '7 days'
      ORDER BY a.created_at
      LIMIT 1
    ) rx ON true
    WHERE LOWER(t.name) IN ('systolic blood pressure', 'diastolic blood pressure')
      AND v.result ~ '^\\d+(\\.\\d+)?$'
      AND cv.pharmacy_id IS DISTINCT FROM 1225
      AND (p.id IS NULL OR (${PHARMACY_EXCLUSIONS}))${R.sql}
    GROUP BY cv.id, b.first_name, b.last_name, p.name, rx.drug_names
    HAVING MAX(v.result::numeric) FILTER (WHERE LOWER(t.name) = 'systolic blood pressure') > 140
    ORDER BY cv.created_at DESC
    LIMIT 5000`, R.vals);
  const cases = rows.map(r => ({ date: r.date, beneficiary: r.beneficiary, pharmacy: r.pharmacy, systolic: r.systolic, diastolic: r.diastolic ?? null, drugs: r.drugs || null }));
  res.json({
    rows: cases,
    total: cases.length,
    withRx: cases.filter(r => r.drugs).length,
  });
}));

// Start a local server only when run directly (`node server.js`). When the
// app is required by the Netlify function wrapper, exporting is enough.
if (require.main === module) {
  const port = Number(process.env.PORT || 8899);
  meds.warm();
  app.listen(port, () => console.log(`Kampe dashboard running at http://localhost:${port}`));
}

module.exports = app;

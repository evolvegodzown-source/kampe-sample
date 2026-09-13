"""
Kampe Beneficiaries — Live Enrollment Dashboard (Streamlit)

Reads from the Kampe database:
  - company_beneficiary  (enrollees, enrolled at `created_at`)
  - pharmacy_pharmacy    (pharmacy names, joined on primary pharmacy id)

DB credentials: add a [kampe_db] section to .streamlit/secrets.toml with
keys: dbname, user, password, host, port (and sslmode if needed).
On Streamlit Community Cloud, put the same block in the app's Secrets settings.

Run:  streamlit run kampe_live_dashboard.py
"""

from pathlib import Path

import pandas as pd
import psycopg2
import streamlit as st

REFRESH_SECONDS = 60  # auto-refresh cadence for "live" data

# Partner logos shown in the header (drop the files into workspace/logos/)
LOGO_DIR = Path(__file__).parent / "logos"
LOGOS = [
    ("axa", "AXA"),
    ("drugstoc", "DrugStoc"),
    ("kampe", "Kampe Care"),
    ("pharmaccess", "PharmAccess"),
]


def db_config():
    try:
        return {k: v for k, v in st.secrets["kampe_db"].items()}
    except Exception:
        raise RuntimeError(
            "Missing DB credentials. Add a [kampe_db] section to "
            ".streamlit/secrets.toml (locally) or to the app's Secrets "
            "settings on Streamlit Community Cloud."
        )


def get_connection():
    return psycopg2.connect(**db_config())


def run_query(sql, params=None):
    conn = get_connection()
    try:
        return pd.read_sql(sql, conn, params=params)
    finally:
        conn.close()


# ── Schema introspection (column names can vary; resolve once) ───────────────
@st.cache_data(show_spinner=False)
def resolve_columns():
    cols = run_query(
        """
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_name IN ('company_beneficiary', 'pharmacy_pharmacy')
        """
    )
    bcols = set(cols.loc[cols.table_name == "company_beneficiary", "column_name"])
    pcols = set(cols.loc[cols.table_name == "pharmacy_pharmacy", "column_name"])

    def pick(available, candidates):
        for c in candidates:
            if c in available:
                return c
        return None

    if {"first_name", "last_name"} <= bcols:
        name_expr = "TRIM(b.first_name || ' ' || b.last_name)"
    elif "name" in bcols:
        name_expr = "b.name"
    elif "full_name" in bcols:
        name_expr = "b.full_name"
    else:
        name_expr = "b.id::text"

    mapping = {
        "name_expr": name_expr,
        "phone": pick(bcols, ["phone_number", "phone", "phone_no", "mobile"]),
        "email": pick(bcols, ["email", "email_address", "mail"]),
        "last_name": pick(bcols, ["last_name", "surname", "family_name"]),
        "plan": pick(bcols, ["plan_name", "plan", "package_name"]),
        "policy": pick(bcols, ["policy_name", "policy"]),
        "status": pick(bcols, ["policy_status", "status", "enrollment_status", "state"]),
        "pharmacy_fk": pick(bcols, ["primary_pharmacy_id", "primary_pharmacy"]),
        "pharmacy_name": pick(pcols, ["name", "pharmacy_name", "title"]),
    }
    return mapping


def status_clause(status_col, statuses):
    """SQL fragment + params for the policy-status filter (empty selection = all)."""
    if not status_col or not statuses:
        return "", {}
    return " AND COALESCE({col}::text, 'Unknown') = ANY(%(statuses)s)".format(col=status_col), {
        "statuses": list(statuses)
    }


# Test/junk enrollees removed from every count: yopmail emails, pharmacy id 1225,
# last name "doe", policy names containing "azzez sanni", blank policy names
EXCLUDED_EMAIL_PATTERN = "%yopmail%"
EXCLUDED_PHARMACY_ID = "1225"
EXCLUDED_LAST_NAME = "doe"
EXCLUDED_POLICY_PATTERN = "%azeez%sanni%"


def exclusion_clause(cols, alias=""):
    """SQL fragment + params excluding junk enrollees from all queries."""
    parts, params = [], {}
    if cols["email"]:
        parts.append(f"COALESCE({alias}{cols['email']}::text, '') ILIKE %(excl_email)s")
        params["excl_email"] = EXCLUDED_EMAIL_PATTERN
    if cols["pharmacy_fk"]:
        parts.append(f"COALESCE({alias}{cols['pharmacy_fk']}::text, '') = %(excl_pharmacy)s")
        params["excl_pharmacy"] = EXCLUDED_PHARMACY_ID
    if cols["last_name"]:
        parts.append(f"LOWER(TRIM({alias}{cols['last_name']}::text)) = %(excl_last_name)s")
        params["excl_last_name"] = EXCLUDED_LAST_NAME
    policy_col = cols["policy"] or cols["plan"]
    if policy_col:
        parts.append(f"{alias}{policy_col}::text ILIKE %(excl_policy)s")
        params["excl_policy"] = EXCLUDED_POLICY_PATTERN
        parts.append(f"NULLIF(TRIM({alias}{policy_col}::text), '') IS NULL")
    if not parts:
        return "", {}
    return " AND NOT (" + " OR ".join(parts) + ")", params


# ── Data fetchers (short TTL keeps the dashboard "live") ─────────────────────
@st.cache_data(ttl=REFRESH_SECONDS, show_spinner=False)
def fetch_dates(cols):
    excl, excl_params = exclusion_clause(cols)
    df = run_query(
        f"""
        SELECT DISTINCT created_at::date AS d
        FROM company_beneficiary
        WHERE created_at IS NOT NULL{excl}
        ORDER BY d DESC
        """,
        excl_params,
    )
    return [pd.to_datetime(d).date() for d in df["d"]]


@st.cache_data(ttl=REFRESH_SECONDS, show_spinner=False)
def fetch_hourly(day, cols, statuses):
    clause, extra = status_clause(cols["status"], statuses)
    excl, excl_params = exclusion_clause(cols)
    df = run_query(
        f"""
        SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*) AS enrolments
        FROM company_beneficiary
        WHERE created_at::date = %(day)s{clause}{excl}
        GROUP BY hour
        """,
        {"day": day, **extra, **excl_params},
    )
    full = pd.DataFrame({"hour": range(24)})
    full = full.merge(df, on="hour", how="left").fillna({"enrolments": 0})
    full["enrolments"] = full["enrolments"].astype(int)
    full["cumulative"] = full["enrolments"].cumsum()
    full["label"] = full["hour"].map(lambda h: f"{h:02d}:00")
    return full


@st.cache_data(ttl=REFRESH_SECONDS, show_spinner=False)
def fetch_statuses(cols):
    if not cols["status"]:
        return []
    excl, excl_params = exclusion_clause(cols)
    df = run_query(
        f"""
        SELECT COALESCE(NULLIF({cols['status']}::text, ''), 'Unknown') AS status, COUNT(*) AS n
        FROM company_beneficiary
        WHERE TRUE{excl}
        GROUP BY 1
        ORDER BY n DESC
        """,
        excl_params,
    )
    return df["status"].tolist()


@st.cache_data(ttl=REFRESH_SECONDS, show_spinner=False)
def fetch_plan_distribution(day, cols, statuses):
    if not cols["plan"]:
        return pd.DataFrame(columns=["plan_name", "enrolments"])
    clause, extra = status_clause(cols["status"], statuses)
    excl, excl_params = exclusion_clause(cols)
    df = run_query(
        f"""
        SELECT COALESCE(NULLIF({cols['plan']}::text, ''), 'Unknown') AS plan_name,
               COUNT(*) AS enrolments
        FROM company_beneficiary
        WHERE created_at::date = %(day)s{clause}{excl}
        GROUP BY 1
        ORDER BY enrolments DESC
        """,
        {"day": day, **extra, **excl_params},
    )
    return df


@st.cache_data(ttl=REFRESH_SECONDS, show_spinner=False)
def fetch_ledger(day, cols, statuses):
    name_expr = cols["name_expr"]
    phone = f"b.{cols['phone']}" if cols["phone"] else "NULL"
    plan = f"b.{cols['plan']}" if cols["plan"] else "NULL"
    status = f"b.{cols['status']}" if cols["status"] else "NULL"
    clause, extra = status_clause(f"b.{cols['status']}" if cols["status"] else None, statuses)
    excl, excl_params = exclusion_clause(cols, alias="b.")
    ph_fk = cols["pharmacy_fk"]
    if ph_fk and cols["pharmacy_name"]:
        ph_select = f"b.{ph_fk}"
        ph_name = f"p.{cols['pharmacy_name']}"
        join = f"LEFT JOIN pharmacy_pharmacy p ON p.id = b.{ph_fk}"
    else:
        ph_select, ph_name, join = "NULL", "NULL", ""
    return run_query(
        f"""
        SELECT {name_expr}              AS name,
               {phone}                  AS phone,
               {plan}                   AS plan_name,
               {status}                 AS policy_status,
               {ph_select}              AS primary_pharmacy_id,
               {ph_name}                AS pharmacy_name,
               b.created_at             AS enrolled_at
        FROM company_beneficiary b
        {join}
        WHERE b.created_at::date = %(day)s{clause}{excl}
        ORDER BY b.created_at
        """,
        {"day": day, **extra, **excl_params},
    )


@st.cache_data(ttl=REFRESH_SECONDS, show_spinner=False)
def fetch_alltime_total(cols):
    excl, excl_params = exclusion_clause(cols)
    df = run_query(
        f"SELECT COUNT(*) AS n FROM company_beneficiary WHERE TRUE{excl}",
        excl_params,
    )
    return int(df["n"][0])


# ── Page ─────────────────────────────────────────────────────────────────────
st.set_page_config(page_title="Kampe Enrollment Dashboard", page_icon="📋", layout="wide")

st.markdown(
    """
    <style>
      .stApp { background: linear-gradient(180deg, #150811 0%, #1d0a18 100%); }
      [data-testid="stMetric"] {
        background: #241020; border: 1px solid #5a1f42;
        border-radius: 12px; padding: 16px 20px;
      }
      [data-testid="stMetricLabel"] { color: #d18aad; }
      [data-testid="stMetricValue"] { color: #ff5fa8; font-size: 1.5rem; }
      [data-testid="stMetricLabel"] > div,
      [data-testid="stMetricValue"] > div,
      [data-testid="stMetricDelta"] > div {
        white-space: normal !important;
        overflow: visible !important;
        text-overflow: clip !important;
        overflow-wrap: anywhere;
        line-height: 1.25;
      }
      h1, h2, h3 { color: #ff8fc2; }
      hr { border-color: #5a1f42; }
      .logo-strip {
        display: flex; align-items: center; justify-content: center;
        gap: 48px; padding: 12px 0 4px 0; flex-wrap: wrap;
      }
      .logo-strip img {
        max-height: 56px; max-width: 220px; object-fit: contain;
        filter: drop-shadow(0 0 6px rgba(214, 51, 132, 0.35));
      }
    </style>
    """,
    unsafe_allow_html=True,
)


def render_logo_strip():
    import base64

    imgs = []
    for stem, label in LOGOS:
        for ext in (".png", ".jpg", ".jpeg", ".webp", ".svg"):
            path = LOGO_DIR / f"{stem}{ext}"
            if path.exists():
                b64 = base64.b64encode(path.read_bytes()).decode()
                mime = "image/svg+xml" if ext == ".svg" else f"image/{ext.lstrip('.')}"
                imgs.append(f'<img src="data:{mime};base64,{b64}" alt="{label}" title="{label}">')
                break
    if imgs:
        st.markdown(f'<div class="logo-strip">{"".join(imgs)}</div>', unsafe_allow_html=True)


def render():
    render_logo_strip()
    st.title("Kampe Beneficiary Enrollment")
    st.caption(
        "Live view of hourly beneficiary enrollments from the Kampe database · "
        "excludes yopmail test emails, pharmacy 1225, last name “doe”, "
        "“azzez sanni” and blank policy names"
    )

    cols = resolve_columns()
    dates = fetch_dates(cols)
    if not dates:
        st.warning("No enrolments found in `company_beneficiary` yet.")
        return

    selected = st.selectbox(
        "Enrollment date",
        dates,
        format_func=lambda d: pd.Timestamp(d).strftime("%A, %d %B %Y"),
    )

    # Policy-status filter (inactive included; empty selection = all statuses)
    all_statuses = fetch_statuses(cols)
    if all_statuses:
        picked = st.multiselect(
            "Policy status",
            all_statuses,
            default=all_statuses,
            help="Filter the total beneficiary count and every chart by policy status, e.g. inactive.",
        )
        statuses = tuple(picked)  # empty tuple = no filter
    else:
        statuses = ()
        st.caption("No policy-status column found on `company_beneficiary` — showing all beneficiaries.")

    hourly = fetch_hourly(selected, cols, statuses)
    plans = fetch_plan_distribution(selected, cols, statuses)
    ledger = fetch_ledger(selected, cols, statuses)

    total_day = int(hourly["enrolments"].sum())
    peak_row = hourly.loc[hourly["enrolments"].idxmax()]
    active_hours = int((hourly["enrolments"] > 0).sum())
    top_plan = plans.iloc[0] if len(plans) else None
    filter_note = None
    if all_statuses and picked and len(picked) < len(all_statuses):
        filter_note = f"filtered: {', '.join(picked)}"

    k1, k2, k3, k4, k5 = st.columns(5)
    k1.metric("Total Beneficiaries (day)", f"{total_day:,}", filter_note)
    k2.metric(
        "Peak Hour",
        peak_row["label"] if total_day else "—",
        f"{int(peak_row['enrolments']):,} enrolments" if total_day else None,
    )
    k3.metric("Active Hours", f"{active_hours} / 24")
    k4.metric(
        "Top Plan",
        top_plan["plan_name"] if top_plan is not None else "—",
        f"{int(top_plan['enrolments']):,} enrolments" if top_plan is not None else None,
    )
    k5.metric("All-Time Enrollees", f"{fetch_alltime_total(cols):,}")

    st.divider()

    left, right = st.columns([3, 2])
    with left:
        st.subheader("Hourly Enrollment Progression")
        st.line_chart(
            hourly.set_index("label")[["enrolments", "cumulative"]],
            color=["#ff5fa8", "#a61e6d"],
            width="stretch",
        )
    with right:
        st.subheader("Distribution by Plan")
        if len(plans):
            st.bar_chart(
                plans.set_index("plan_name")["enrolments"],
                color="#ff5fa8",
                horizontal=True,
                width="stretch",
            )
        else:
            st.info("No plan data for this date.")

    st.subheader("Enrollment Ledger")
    st.dataframe(
        ledger,
        width="stretch",
        hide_index=True,
        column_config={
            "name": "Name",
            "phone": "Phone No",
            "plan_name": "Plan Name",
            "policy_status": "Policy Status",
            "primary_pharmacy_id": "Primary Pharmacy ID",
            "pharmacy_name": "Pharmacy Name",
            "enrolled_at": st.column_config.DatetimeColumn("Enrolled At", format="hh:mm A"),
        },
    )
    st.caption(f"Last refreshed: {pd.Timestamp.now().strftime('%H:%M:%S')}")


# Auto-refresh loop keeps KPIs/charts/tables live for every viewer of the shared link
st.sidebar.title("Settings")
auto_refresh = st.sidebar.toggle(f"Auto-refresh every {REFRESH_SECONDS}s", value=True)
if st.sidebar.button("🔄 Refresh live data", type="primary", use_container_width=True):
    st.cache_data.clear()
    st.rerun()

try:
    if auto_refresh:
        st.fragment(render, run_every=REFRESH_SECONDS)()
    else:
        render()
except Exception as exc:  # surface DB/config errors cleanly
    st.error(f"Could not load dashboard data: {exc}")
    st.info("Check the [kampe_db] section in .streamlit/secrets.toml or the app's Cloud secrets.")

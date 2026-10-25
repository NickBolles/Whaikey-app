-- Scan funnel and barcode coverage (M0.5). Read-only; run in the Supabase SQL
-- editor or psql against a READ-ONLY role. Same numbers as /admin/scan
-- (src/lib/observability/scan-telemetry.ts). `scan_events` holds no user,
-- session or IP column; rows expire after 90 days (sweepTelemetry).

-- 1. Catalog coverage: how much of the scannable catalog a barcode can land on.
select
  count(*)                                                             as bottles,
  count(*) filter (where exists (select 1 from bottle_upcs u where u.bottle_id = b.id))
                                                                       as with_upc,
  round(100.0 * count(*) filter (where exists (select 1 from bottle_upcs u where u.bottle_id = b.id))
        / nullif(count(*), 0), 1)                                      as pct_with_upc,
  count(*) filter (where exists (select 1 from bottle_upcs u where u.bottle_id = b.id and u.confirmed_count > 0))
                                                                       as with_confirmed_upc,
  count(*) filter (where b.flavor_profile is not null)                 as with_flavor_profile,
  round(100.0 * count(*) filter (where b.flavor_profile is not null) / nullif(count(*), 0), 1)
                                                                       as pct_flavor_profile
from bottles b
where b.status <> 'user_submitted';

-- 1b. Barcode rows by provenance.
select source, count(*) from bottle_upcs group by source order by 2 desc;

-- 2. Scan funnel, last 30 days, per kind.
with w as (
  select * from scan_events where created_at >= now() - interval '30 days'
)
select
  kind,
  count(*) filter (where outcome <> 'confirmed')                         as attempts,
  count(*) filter (where outcome = 'matched')                            as own_hits,
  round(100.0 * count(*) filter (where outcome = 'matched')
        / nullif(count(*) filter (where outcome <> 'confirmed'), 0), 1)   as pct_own_hit,
  round(100.0 * count(*) filter (where outcome in ('matched', 'candidates'))
        / nullif(count(*) filter (where outcome <> 'confirmed'), 0), 1)   as pct_resolved,
  count(*) filter (where outcome = 'miss')                               as misses,
  count(*) filter (where outcome = 'confirmed')                          as confirmed,
  count(*) filter (where outcome = 'confirmed' and confirm_rank = 0)     as confirmed_top_match,
  percentile_cont(0.5)  within group (order by latency_ms) filter (where outcome <> 'confirmed') as p50_ms,
  percentile_cont(0.95) within group (order by latency_ms) filter (where outcome <> 'confirmed') as p95_ms
from w
group by kind
order by kind;

-- 2b. Barcode outcomes by source (own DB vs each external provider).
select source, outcome, count(*)
from scan_events
where kind = 'barcode' and created_at >= now() - interval '30 days'
group by 1, 2
order by 3 desc;

-- 3. Coverage gaps: the most-scanned barcodes we have no mapping for.
select upc, count(*) as scans, count(*) filter (where outcome = 'miss') as no_candidates
from scan_events
where upc is not null and created_at >= now() - interval '30 days'
group by upc
order by scans desc, upc
limit 50;

-- 4. Weekly trend of the own-DB barcode hit rate.
select date_trunc('week', created_at) as week,
       count(*) filter (where outcome <> 'confirmed') as attempts,
       round(100.0 * count(*) filter (where outcome = 'matched')
             / nullif(count(*) filter (where outcome <> 'confirmed'), 0), 1) as pct_own_hit
from scan_events
where kind = 'barcode'
group by 1
order by 1 desc
limit 12;

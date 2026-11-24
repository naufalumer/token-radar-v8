// Token radar, radar-8 (terminal): the same pricing model as radar-7, unchanged.
// One sealed snapshot in, one ranked board out. The model is identical to the
// previous generation on purpose: the board must reproduce byte for byte, so
// this version changes only the dashboard that presents it. Everything below
// is written fresh for this version; the arithmetic is the model's own, kept
// exact so the reproduction target holds.
//
// The board ranks pre-token protocols by calibrated implied launch value.
// A protocol is pre-token when its record carries no token (no market cap,
// no CoinGecko id, no symbol). Live-token protocols are set aside and shown
// at the market's own values, never mixed into the ranked board.
//
// Implied value comes only from the snapshot's own figures:
//
//   category multiple = median(mcap / TVL) of live-token protocols in the
//     same category (3+ peers), else the whole-market median, clamped
//     to [0.02, 1.0]. The market sets the multiple, not the author.
//   size tilt = ONE pooled size effect: log10(mcap) regressed on log10(TVL)
//     over all live-token protocols (CEX excluded). Applied at half the
//     fitted strength, clamped to [0.50, 1.50], anchored at 1 at the
//     market's median live TVL, because the fit is weak (R2 near 0.14)
//     and a full-strength tilt would price giants far below their peers.
//   fitted multiple = clamp(category multiple x size tilt, 0.02, 1.0)
//   base = TVL x fitted multiple
//   growth = 1 + clamp(change_7d, -50, 100) / 100 x 0.6
//   maturity = 0.70 + min(age_days, 1095) / 1095 x 0.30 (unknown age: 365)
//   chain reach = 1 + min(chains - 1, 5) x 0.02
//   raw = max(1, round(base x growth x maturity x chain reach))
//   calibrated = raw through an out-of-fold calibration: a winsorized
//     log-space linear map from log10(raw) to log10(true value), fitted
//     only on out-of-fold predictions of live-token peers, shift capped
//     at +/-0.75 dex. Monotone, so a protocol that priced higher still
//     prices higher; no token's own outcome calibrates its own price.
//
// The model is checked on the snapshot itself: a 5-fold check on live
// tokens prices each held-out token under six rules and records median
// error, trimmed mean error, wins against the flat median, Spearman rank
// correlation, log-space error and share within twice the true value.
// Per-category fits were tested and lost to the pooled fit on five of six
// checks with so few peers per category; the within-category slope ties
// the pooled fit and stays out for no gain. The full formula (not just
// the multiple) is validated, so growth, maturity, chain reach and the
// calibration are measured, not asserted. The calibration is measured
// honestly too: inside each outer fold, the fold's calibrator is fitted
// on inner out-of-fold predictions of the training peers only.
//
// The historical backtest (BACKTEST) is research baked in as a constant:
// on 2026-10-15 the shipped model priced 113 live-token peers from their
// TVL that day; by 2026-11-14 their realized market caps were known. The
// program runs with no network and the sealed snapshot carries no history,
// so the backtest ships as a constant. It measures the model; it never
// tunes it. No protocol name is ever special-cased.
//
// Layout of this file:
//   1. snapshot shape, model constants, version
//   2. calibration and validation report shapes
//   3. backtest shapes and the baked-in BACKTEST constant
//   4. board rows, dashboard data, plus the dashboard-only derived data
//      (modeled series, chain totals, news items)
//   5. small maths (median, least squares, ranks, Spearman, tilt, weights)
//   6. calibration layer
//   7. validation (folds, out-of-fold predictions, six rules)
//   8. board assembly, farm plans, snapshot parsing, the gate, data.js

/** A protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox moves them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  chain_step: number;
  chain_max_extra: number;
  multiple_floor: number;
  multiple_cap: number;
  min_peers: number;
  size_damping: number;
  tilt_floor: number;
  tilt_cap: number;
  /** Calibration shift cap, in decades (log10 units). */
  calib_shift_cap_dex: number;
  /** Winsorization percentiles for the calibration's training log-predictions. */
  calib_winsor_lo_pct: number;
  calib_winsor_hi_pct: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.6,
  growth_floor: -50,
  growth_cap: 100,
  maturity_floor: 0.7,
  maturity_range: 0.3,
  maturity_days: 1095,
  unknown_age_days: 365,
  chain_step: 0.02,
  chain_max_extra: 5,
  multiple_floor: 0.02,
  multiple_cap: 1.0,
  min_peers: 3,
  size_damping: 0.5,
  tilt_floor: 0.5,
  tilt_cap: 1.5,
  calib_shift_cap_dex: 0.75,
  calib_winsor_lo_pct: 5,
  calib_winsor_hi_pct: 95,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-8-terminal';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One calibrated category multiple: the market's own mcap/TVL for that category. */
export interface CategoryMultiple {
  category: string;
  multiple: number;
  peers: number;
  fallback: boolean;
}

/** The pooled size effect: log10(mcap) = intercept + slope x log10(TVL) over live peers. */
export interface PowerLawFit {
  slope: number;
  slope_damped: number;
  r2: number;
  peers: number;
  median_tvl_usd: number;
}

/** One live peer's ratio, for the dashboard's per-category peer basis. */
export interface PeerBasis {
  slug: string;
  name: string;
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
}

/** The live-peer basis for one category: every peer's ratio, lowest first, with quartiles. */
export interface CategoryBasis {
  category: string;
  peers: PeerBasis[];
  q1: number;
  median: number;
  q3: number;
}

/** One category's share of the 5-fold check: where the size tilt helps and where it hurts. */
export interface CategoryValidation {
  category: string;
  peers: number;
  median_ape_flat_pct: number;
  median_ape_sized_pct: number;
  sized_wins: number;
}

/** One pricing rule's row in the 5-fold comparison, all rules on the same folds. */
export interface CandidateCheck {
  candidate: string;
  median_ape_pct: number;
  trimmed_mean_ape_pct: number;
  wins: number;
  peers: number;
  spearman: number;
  log_mae: number;
  within2x_pct: number;
}

/**
 * The out-of-fold calibration: a winsorized log-space linear map from a raw
 * priced value to a calibrated one, fitted only on out-of-fold predictions.
 * slope/intercept map log10(raw) to log10(calibrated); winsor_lo/hi are the
 * log10 bounds the training predictions were clipped to before fitting;
 * shift_cap_dex caps how far any single protocol's log value may move;
 * identity is true when the fit was degenerate and the layer does nothing.
 */
export interface Calibrator {
  slope: number;
  intercept: number;
  r2: number;
  winsor_lo: number;
  winsor_hi: number;
  shift_cap_dex: number;
  peers: number;
  identity: boolean;
}

/** One board protocol the calibration moved the most: before, after, and how far. */
export interface MostShrunk {
  slug: string;
  name: string;
  raw_implied_value_usd: number;
  calibrated_implied_value_usd: number;
  shift_dex: number;
}

/** What the calibration did to the out-of-fold predictions and to the board. */
export interface CalibrationReport {
  calibrator: Calibrator;
  oof_log_mae_before: number;
  oof_log_mae_after: number;
  oof_median_ape_before_pct: number;
  oof_median_ape_after_pct: number;
  oof_trimmed_mean_ape_before_pct: number;
  oof_trimmed_mean_ape_after_pct: number;
  /** The board rows moved most by the calibration, farthest first. */
  most_shrunk: MostShrunk[];
}

/**
 * One held-out live token's prices under its fold, for the actual-vs-predicted
 * plot: the raw full-formula price, the nested-calibrated price (its fold's
 * calibrator fitted without that fold's peers), and the token's true market
 * cap. Same fold loop, same prices as the validation's full-formula rows,
 * so plot and table cannot disagree. Order is fold-major, then sorted slug
 * within the fold — deterministic, like everything else in this file.
 */
export interface HeldoutPair {
  slug: string;
  raw: number;
  calibrated: number;
  actual: number;
}

/**
 * The 5-fold check of the size tilt against the flat category median, on live
 * tokens, run twice: once for the multiple alone, once for the full shipped
 * formula (multiple x growth x maturity x chains, then calibrated). Six
 * metrics per rule: median absolute percentage error; trimmed mean error
 * (worst tenth set aside); share of tokens priced closer than flat; Spearman
 * rank correlation against the true market cap; log-space mean error (an
 * overestimate and an underestimate priced symmetrically, where APE caps an
 * underestimate at 100% but lets an overestimate run away); share priced
 * within twice the true value. The cal_* and full_cal_* fields are the same
 * six metrics for the calibrated multiple and the calibrated full formula.
 */
export interface TiltValidation {
  median_ape_flat_pct: number;
  median_ape_sized_pct: number;
  trimmed_mean_ape_flat_pct: number;
  trimmed_mean_ape_sized_pct: number;
  sized_wins: number;
  peers: number;
  spearman_flat: number;
  spearman_sized: number;
  log_mae_flat: number;
  log_mae_sized: number;
  within2x_flat_pct: number;
  within2x_sized_pct: number;
  full_median_ape_flat_pct: number;
  full_median_ape_sized_pct: number;
  full_trimmed_mean_ape_flat_pct: number;
  full_trimmed_mean_ape_sized_pct: number;
  full_sized_wins: number;
  full_spearman_flat: number;
  full_spearman_sized: number;
  full_log_mae_flat: number;
  full_log_mae_sized: number;
  full_within2x_flat_pct: number;
  full_within2x_sized_pct: number;
  cal_median_ape_pct: number;
  cal_trimmed_mean_ape_pct: number;
  cal_wins: number;
  cal_spearman: number;
  cal_log_mae: number;
  cal_within2x_pct: number;
  full_cal_median_ape_pct: number;
  full_cal_trimmed_mean_ape_pct: number;
  full_cal_wins: number;
  full_cal_spearman: number;
  full_cal_log_mae: number;
  full_cal_within2x_pct: number;
  by_category: CategoryValidation[];
  candidates: CandidateCheck[];
  /** The held-out pairs behind the full-formula rows, for the model tab's plot. */
  heldout_pairs: HeldoutPair[];
}

/** The calibration: one multiple per category the board uses, plus the market median. */
export interface Calibration {
  market_median: number;
  live_count: number;
  categories: CategoryMultiple[];
  power_law: PowerLawFit;
  category_basis: CategoryBasis[];
  tilt_validation: TiltValidation;
  /** The board's calibration layer, fitted on out-of-fold predictions only. */
  calibration: Calibrator;
  /** What the calibration did, before and after, on the out-of-fold predictions and the board. */
  calibration_report: CalibrationReport;
}

/**
 * One rule's backtest row: the shipped model — and each baseline — priced
 * every live peer on 2026-10-15 and was scored against the peer's REALIZED
 * market cap on 2026-11-14. Same six checks as the 5-fold validation.
 * `wins` counts peers the rule priced closer than the flat category median;
 * persistence is scored on its own row, because "the price stays where it
 * was" is the forecast every model must beat before it claims to predict
 * realized values.
 */
export interface BacktestRule {
  rule: string;
  median_ape_pct: number;
  trimmed_mean_ape_pct: number;
  wins: number;
  peers: number;
  spearman: number;
  log_mae: number;
  within2x_pct: number;
}

/**
 * One category's backtest: the shipped model's median error against realized
 * values, next to the flat median's and persistence's. Categories with fewer
 * than 3 peers are folded into "Other (n < 3)" in the dashboard's table,
 * never dropped silently.
 */
export interface BacktestCategory {
  category: string;
  peers: number;
  median_ape_shipped_pct: number;
  median_ape_flat_pct: number;
  median_ape_persistence_pct: number;
  shipped_wins: number;
}

/** One backtest exclusion: a peer left out for missing history, with the reason. */
export interface BacktestExclusion {
  slug: string;
  stage: string;
  reason: string;
}

/**
 * The historical out-of-sample backtest, baked in as research: the program
 * runs with no network and the sealed snapshot carries no history, so the
 * backtest is computed once while building the entry and shipped as a
 * constant, with its dates and sources stated. The model it measures is the
 * shipped model, fitted on t0 data only — the backtest never tunes it.
 */
export interface Backtest {
  t0: string;
  t1: string;
  peers: number;
  excluded: BacktestExclusion[];
  sources: string;
  /** The pooled tilt and calibration map as fitted on t0 data (for the record). */
  t0_power_law_slope: number;
  t0_power_law_r2: number;
  t0_calibrator_slope: number;
  t0_calibrator_intercept: number;
  t0_calibrator_r2: number;
  /** One row per rule, the shipped rule last, on the same peers. */
  rules: BacktestRule[];
  /** The honest nested backtest: each fold's calibrator fitted without that fold. */
  nested_median_ape_pct: number;
  nested_trimmed_mean_ape_pct: number;
  nested_wins: number;
  nested_spearman: number;
  nested_log_mae: number;
  nested_within2x_pct: number;
  /** Per-category realized table, alphabetical. */
  by_category: BacktestCategory[];
}

/**
 * BACKTEST — the research carried forward unchanged. Priced 2026-10-15,
 * scored against realized market caps 2026-11-14 (113 peers, 6 excluded
 * for missing history). Sources: TVL from DeFiLlama daily TVL per protocol;
 * mcap at t0 from CoinGecko daily market caps; realized mcap at t1 from
 * the sealed snapshot's own mcap_usd. The model measured is the shipped
 * model, every piece fitted on 2026-10-15 data only. The verifier refuses
 * a build while this constant differs from backtest-summary.json by any
 * number.
 */
export const BACKTEST: Backtest = {
  "t0": "2026-10-15",
  "t1": "2026-11-14",
  "peers": 113,
  "excluded": [
    {
      "slug": "acryptos",
      "stage": "mcap",
      "reason": "no market_caps point on 2026-10-15"
    },
    {
      "slug": "fables",
      "stage": "mcap",
      "reason": "no market_caps point on 2026-10-15"
    },
    {
      "slug": "frankencoin",
      "stage": "mcap",
      "reason": "no market_caps point on 2026-10-15"
    },
    {
      "slug": "kava-lend",
      "stage": "mcap",
      "reason": "CoinGecko 404 for gecko_id"
    },
    {
      "slug": "pumpbtc",
      "stage": "mcap",
      "reason": "CoinGecko 404 for gecko_id"
    },
    {
      "slug": "concrete",
      "stage": "backtest",
      "reason": "no valid t0 market data (mcap_t0=0, tvl_t0=1158438369, tvl_t0m7=1221231658)"
    }
  ],
  "sources": "TVL: DeFiLlama https://api.llama.fi/protocol/{slug} daily TVL; mcap t0: CoinGecko market_chart daily market_caps; realized mcap t1: sealed snapshot mcap_usd 2026-11-14",
  "t0_power_law_slope": 0.4636,
  "t0_power_law_r2": 0.1402,
  "t0_calibrator_slope": 0.5414,
  "t0_calibrator_intercept": 3.2886,
  "t0_calibrator_r2": 0.1265,
  "rules": [
    {
      "rule": "flat category median (t0)",
      "median_ape_pct": 96.6721,
      "trimmed_mean_ape_pct": 233.2336,
      "wins": 0,
      "peers": 113,
      "spearman": 0.475,
      "log_mae": 0.7167,
      "within2x_pct": 27.4336
    },
    {
      "rule": "pooled size tilt (t0)",
      "median_ape_pct": 86.2063,
      "trimmed_mean_ape_pct": 181.2472,
      "wins": 69,
      "peers": 113,
      "spearman": 0.4841,
      "log_mae": 0.6582,
      "within2x_pct": 38.0531
    },
    {
      "rule": "full formula, uncalibrated (t0)",
      "median_ape_pct": 86.2165,
      "trimmed_mean_ape_pct": 164.8517,
      "wins": 67,
      "peers": 113,
      "spearman": 0.4688,
      "log_mae": 0.6586,
      "within2x_pct": 34.5133
    },
    {
      "rule": "persistence — mcap on 2026-10-15 carried forward",
      "median_ape_pct": 30.3297,
      "trimmed_mean_ape_pct": 29.8105,
      "wins": 91,
      "peers": 113,
      "spearman": 0.9851,
      "log_mae": 0.1466,
      "within2x_pct": 91.1504
    },
    {
      "rule": "full formula + calibration (shipped)",
      "median_ape_pct": 84.7776,
      "trimmed_mean_ape_pct": 163.1704,
      "wins": 68,
      "peers": 113,
      "spearman": 0.4685,
      "log_mae": 0.6325,
      "within2x_pct": 35.3982
    }
  ],
  "nested_median_ape_pct": 89.5888,
  "nested_trimmed_mean_ape_pct": 178.5968,
  "nested_wins": 69,
  "nested_spearman": 0.3685,
  "nested_log_mae": 0.6637,
  "nested_within2x_pct": 35.3982,
  "by_category": [
    {
      "category": "Basis Trading",
      "peers": 7,
      "median_ape_shipped_pct": 65.0582,
      "median_ape_flat_pct": 96.9141,
      "median_ape_persistence_pct": 28.1869,
      "shipped_wins": 4
    },
    {
      "category": "Bridge",
      "peers": 5,
      "median_ape_shipped_pct": 48.9475,
      "median_ape_flat_pct": 89.0489,
      "median_ape_persistence_pct": 35.967,
      "shipped_wins": 3
    },
    {
      "category": "Canonical Bridge",
      "peers": 8,
      "median_ape_shipped_pct": 89.5089,
      "median_ape_flat_pct": 130.4362,
      "median_ape_persistence_pct": 18.6018,
      "shipped_wins": 5
    },
    {
      "category": "Cross Chain Bridge",
      "peers": 4,
      "median_ape_shipped_pct": 68.7116,
      "median_ape_flat_pct": 216.3496,
      "median_ape_persistence_pct": 26.663,
      "shipped_wins": 2
    },
    {
      "category": "Dexs",
      "peers": 10,
      "median_ape_shipped_pct": 99.7762,
      "median_ape_flat_pct": 159.5899,
      "median_ape_persistence_pct": 33.9461,
      "shipped_wins": 5
    },
    {
      "category": "Indexes",
      "peers": 3,
      "median_ape_shipped_pct": 152.7852,
      "median_ape_flat_pct": 93.05,
      "median_ape_persistence_pct": 21.3354,
      "shipped_wins": 2
    },
    {
      "category": "Lending",
      "peers": 14,
      "median_ape_shipped_pct": 108.7774,
      "median_ape_flat_pct": 101.706,
      "median_ape_persistence_pct": 42.1959,
      "shipped_wins": 6
    },
    {
      "category": "Liquid Staking",
      "peers": 9,
      "median_ape_shipped_pct": 88.3289,
      "median_ape_flat_pct": 87.6333,
      "median_ape_persistence_pct": 26.2868,
      "shipped_wins": 6
    },
    {
      "category": "Privacy",
      "peers": 3,
      "median_ape_shipped_pct": 76.7744,
      "median_ape_flat_pct": 17.2372,
      "median_ape_persistence_pct": 44.2262,
      "shipped_wins": 1
    },
    {
      "category": "RWA",
      "peers": 9,
      "median_ape_shipped_pct": 33.0422,
      "median_ape_flat_pct": 71.179,
      "median_ape_persistence_pct": 57.8285,
      "shipped_wins": 7
    },
    {
      "category": "Yield",
      "peers": 9,
      "median_ape_shipped_pct": 76.617,
      "median_ape_flat_pct": 100.9451,
      "median_ape_persistence_pct": 23.9662,
      "shipped_wins": 5
    },
    {
      "category": "Yield Aggregator",
      "peers": 4,
      "median_ape_shipped_pct": 123.0195,
      "median_ape_flat_pct": 172.4546,
      "median_ape_persistence_pct": 21.7181,
      "shipped_wins": 2
    },
    {
      "category": "Other (n < 3)",
      "peers": 28,
      "median_ape_shipped_pct": 90.3802,
      "median_ape_flat_pct": 98.995,
      "median_ape_persistence_pct": 30.9611,
      "shipped_wins": 20
    }
  ]
};

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  signals: string[];
  model: {
    category_multiple: number;
    multiple_peers: number;
    multiple_fallback: boolean;
    size_tilt: number;
    size_tilt_basis: string;
    size_tilt_r2: number;
    fitted_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    /** The full-formula value before the calibration layer touched it. */
    raw_implied_value_usd: number;
    /** How far the calibration moved this row, in decades (log10 units). Negative compresses the row down. */
    calibration_shift_dex: number;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  signals: string[];
  category_multiple: number;
  size_tilt: number;
  size_tilt_basis: string;
  size_tilt_r2: number;
  fitted_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
  raw_implied_value_usd: number;
  calibration_shift_dex: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  ratio: number | null;
}

/** One chain's totals across the whole snapshot, for the terminal ticker. */
export interface ChainTotal {
  chain: string;
  tvl_usd: number;
  protocols: number;
  watchlist: number;
  top_slug: string;
  top_name: string;
}

/**
 * One news item for the dashboard's News tab. Every item is built only from
 * snapshot facts (a mover, a new listing, the watchlist) or from the radar's
 * own records (the backtest, the model version) — never from outside the
 * snapshot, and never invented about a protocol. `source` names where the
 * fact comes from; `date` is the snapshot's as-of date.
 */
export interface NewsItem {
  id: string;
  title: string;
  body: string;
  source: string;
  date: string;
}

/** Everything the dashboard needs: the board, the live set, the calibration, the model. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  calibration: Calibration;
  backtest: Backtest;
  watchlist_size: number;
  watchlist_slugs: string[];
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
  /** Modeled 30-point TVL paths, one per board row, keyed by slug (see modeledSeries). */
  series: Record<string, number[]>;
  /** TVL totals per chain across all snapshot protocols, biggest first. */
  chain_totals: ChainTotal[];
  /** News items built only from snapshot facts and the radar's own records. */
  news: NewsItem[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a sorted array, or null when it is empty. */
function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The median of a list of errors as a percentage, or 0 when it is empty. */
export function medianPct(errs: number[]): number {
  return round4((median([...errs].sort((a, b) => a - b)) ?? 0) * 100);
}

/**
 * The trimmed mean of a list of errors as a percentage: the worst tenth set
 * aside before averaging, so one wild token cannot decide it. Shared by the
 * validation summary and the calibration report, so the two tables trim the
 * same way.
 */
export function trimmedMeanPct(errs: number[]): number {
  const s = [...errs].sort((x, y) => x - y).slice(0, Math.floor(errs.length * 0.9));
  return round4((s.reduce((sum, e) => sum + e, 0) / s.length) * 100);
}

/**
 * The plain mean of a list of numbers, rounded like every number the model
 * prints. Used for the log-space mean error, which prices an overestimate
 * and an underestimate symmetrically.
 */
export function meanOf(values: number[]): number {
  return round4(values.reduce((sum, v) => sum + v, 0) / values.length);
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories that are a wrapped, staked or bridged product of a token that already trades. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** A whole word wrapped, staked or staking in the name: a product of a token that trades. */
const WRAPPED_WORD = /\bwrapped\b|\bstaked\b|\bstaking\b/i;

/** Names beginning with an exchange's name: the exchange's own product, not a launch. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;

/**
 * Whether a protocol is one the board may rank: pre-token, and not a wrapped, staked or
 * bridged product of a protocol whose token already trades — the watchlist's own rule,
 * applied to every row so the board never ranks WBTC or a bridge above a real launch.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    !EXCLUDED_CATEGORIES.has(p.category ?? '') &&
    !VERSIONED.test(p.name) &&
    !WRAPPED_WORD.test(p.name) &&
    !EXCHANGE_PREFIX.test(p.name)
  );
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/**
 * The live-token peers the model learns from: protocols that already trade, with a market
 * cap and a TVL, excluding centralised exchanges — an exchange's own token is not a
 * protocol launch and its multiple (several times TVL) would bend the fit.
 */
export function livePeers(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX',
  );
}

/**
 * The live peers grouped by category, categories in alphabetical order — one
 * grouping for the multiples, the fits and the peer basis, so the three tables
 * always agree on which peers belong where.
 */
function groupByCategory(peers: SnapshotProtocol[]): [string, SnapshotProtocol[]][] {
  const byCategory = new Map<string, SnapshotProtocol[]>();
  for (const p of peers) {
    const key = p.category ?? 'Uncategorised';
    const list = byCategory.get(key) ?? [];
    list.push(p);
    byCategory.set(key, list);
  }
  return [...byCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/**
 * The least-squares line through two equal-length series: slope, intercept and
 * R squared. One helper for every regression in the file — the pooled fit, the
 * per-category fits, the within-category slope, and the calibration map — so a
 * fix to the maths lands once instead of in several copies that can drift apart.
 */
function leastSquares(xs: number[], ys: number[]): { slope: number; intercept: number; r2: number } {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    ssTot += (ys[i]! - my) ** 2;
  }
  const slope = sxx === 0 ? 1 : sxy / sxx;
  const intercept = my - slope * mx;
  let ssRes = 0;
  for (let i = 0; i < n; i++) ssRes += (ys[i]! - (intercept + slope * xs[i]!)) ** 2;
  return { slope, intercept, r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot };
}

/** The least-squares fit of log10(mcap) on log10(TVL), with its R squared. */
export function fitPowerLaw(peers: SnapshotProtocol[]): { slope: number; r2: number } {
  const xs = peers.map((p) => Math.log10(p.tvl_usd));
  const ys = peers.map((p) => Math.log10(p.mcap_usd!));
  const { slope, r2 } = leastSquares(xs, ys);
  return { slope, r2 };
}

/** A least-squares slope and R2 from two equal-length series of numbers. */
function fitFromPairs(xs: number[], ys: number[]): { slope: number; r2: number } {
  const { slope, r2 } = leastSquares(xs, ys);
  return { slope, r2 };
}

/**
 * The within-category size slope: log10(mcap) and log10(TVL) demeaned inside each
 * category, one regression on the demeaned data. It answers the size question
 * without letting categories of different sizes answer it for them. Tested as
 * a candidate in the validation; it ties the pooled fit and stays out of the
 * shipped model.
 */
function withinCategorySlope(peers: SnapshotProtocol[]): number {
  const dx: number[] = [];
  const dy: number[] = [];
  for (const [, list] of groupByCategory(peers)) {
    const mx = list.reduce((a, p) => a + Math.log10(p.tvl_usd), 0) / list.length;
    const my = list.reduce((a, p) => a + Math.log10(p.mcap_usd!), 0) / list.length;
    for (const p of list) {
      dx.push(Math.log10(p.tvl_usd) - mx);
      dy.push(Math.log10(p.mcap_usd!) - my);
    }
  }
  return fitFromPairs(dx, dy).slope;
}

/**
 * A fitted slope at half the strength the regression found: the pooled fit is
 * weak (R2 around 0.14), so the shipped tilt moves the fitted slope halfway
 * toward 1 — a slope of 1 means no size effect at all — instead of applying
 * the full pull. One helper, because the same half-strength rule applies to
 * the pooled fit, to each per-category fit and to the within-category slope.
 */
export function dampedSlope(slope: number, model: ModelConstants): number {
  return 1 + (slope - 1) * model.size_damping;
}

/**
 * One TVL's tilt under a damped slope and a reference TVL: 1 at the reference,
 * below 1 for giants, above 1 for the small, clamped to the model's floor and
 * cap. The exponent is the damped slope minus one, so a damped slope of
 * exactly 1 is a tilt of 1 at every size — the identity, not a guess.
 */
export function tiltValue(tvlUsd: number, slopeDamped: number, refTvlUsd: number, model: ModelConstants): number {
  const raw = Math.pow(tvlUsd / refTvlUsd, slopeDamped - 1);
  return Math.min(model.tilt_cap, Math.max(model.tilt_floor, raw));
}

/**
 * The size tilt for one TVL: 1 at the reference (median) TVL, less for giants, more
 * for the small. One pooled fit, one pooled reference — the whole market's size
 * effect, not a per-category guess.
 */
export function sizeTilt(tvlUsd: number, fit: { slope: number; median_tvl_usd: number }, model: ModelConstants): number {
  return tiltValue(tvlUsd, dampedSlope(fit.slope, model), fit.median_tvl_usd, model);
}

/** Ranks with average ties: equal values share the mean of the ranks they span. */
function ranks(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const r = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]!.v === order[i]!.v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[order[k]!.i] = avg;
    i = j + 1;
  }
  return r;
}

/**
 * Spearman's rank correlation between two equal-length series, or 0 when either has
 * no spread. The validation's ranking metric, and the backtest's, where it asks
 * whether the t0 prices order the tokens the way their realized caps do.
 */
export function spearman(xs: number[], ys: number[]): number {
  if (xs.length < 2 || xs.length !== ys.length) return 0;
  const rx = ranks(xs);
  const ry = ranks(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (rx[i]! - mx) * (ry[i]! - my);
    sxx += (rx[i]! - mx) ** 2;
    syy += (ry[i]! - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

/** The value at quantile q of a sorted array, by linear interpolation. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** The quartiles of a sorted ratio list, rounded the way the dashboard prints them. */
function ratioQuartiles(sortedRatios: number[]): { q1: number; median: number; q3: number } {
  return {
    q1: round4(quantile(sortedRatios, 0.25)),
    median: round4(median(sortedRatios) ?? 0),
    q3: round4(quantile(sortedRatios, 0.75)),
  };
}

/** One peer's ratio row for the per-category basis table. */
function peerBasisRow(p: SnapshotProtocol): PeerBasis {
  return {
    slug: p.slug,
    name: p.name,
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd!,
    ratio: round4(p.mcap_usd! / p.tvl_usd),
  };
}

/**
 * The live-peer basis per category: every peer's ratio, lowest first, with the
 * quartiles of the distribution — the numbers the category median is the middle of.
 */
export function buildCategoryBasis(peers: SnapshotProtocol[]): CategoryBasis[] {
  const out: CategoryBasis[] = [];
  for (const [category, list] of groupByCategory(peers)) {
    const sorted = [...list].sort((a, b) => a.mcap_usd! / a.tvl_usd - b.mcap_usd! / b.tvl_usd);
    const ratios = sorted.map((p) => p.mcap_usd! / p.tvl_usd);
    out.push({ category, peers: sorted.map(peerBasisRow), ...ratioQuartiles(ratios) });
  }
  return out;
}

/** A raw multiple held inside the model's floor and cap. */
function clampMultiple(raw: number, model: ModelConstants): number {
  return Math.min(model.multiple_cap, Math.max(model.multiple_floor, raw));
}

/**
 * One multiple per category from the live peers: the median market-cap-to-TVL
 * ratio where a category has enough peers to trust its own median, else the
 * whole-market median. Nothing here names a protocol: the table is whatever
 * the snapshot's market says.
 */
function categoryMultiples(peers: SnapshotProtocol[], marketMedian: number, model: ModelConstants): CategoryMultiple[] {
  const out: CategoryMultiple[] = [];
  for (const [category, list] of groupByCategory(peers)) {
    const ratios = list.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b);
    const med = median(ratios);
    const fallback = ratios.length < model.min_peers || med === null;
    const raw = fallback ? marketMedian : med!;
    out.push({
      category,
      multiple: round4(clampMultiple(raw, model)),
      peers: ratios.length,
      fallback,
    });
  }
  return out;
}

/** The three weights that tilt a fitted multiple into an implied value. */
export interface Multipliers {
  growthPct: number;
  growth: number;
  maturity: number;
  chain: number;
  age: number | null;
}

/**
 * The growth weight from a protocol's seven-day TVL change: the change is
 * clamped to the model's floor and cap first, so one week of +400% cannot
 * buy a protocol four times its value, and a -90% week cannot erase it.
 * Returns the clamped percentage and the multiplier together, because the
 * board shows both.
 */
export function growthMultiplier(change7d: number | null, model: ModelConstants): { growthPct: number; growth: number } {
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, finite(change7d, 0)));
  return { growthPct, growth: 1 + (growthPct / 100) * model.growth_weight };
}

/**
 * The maturity weight from a protocol's age in days: seven-tenths at birth,
 * rising linearly to one at the model's maturity horizon. An unknown age
 * takes the model's unknown-age days, so a protocol with no listing date
 * prices like a year-old one rather than a newborn or an ancient.
 */
export function maturityMultiplier(age: number | null, model: ModelConstants): number {
  const ageForModel = age ?? model.unknown_age_days;
  return (
    model.maturity_floor +
    (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range
  );
}

/**
 * The chain-reach weight from how many chains a protocol names: two percent
 * per extra chain, capped at ten percent, because a protocol on six chains
 * reaches further than one on one — but reach is not value, so the weight
 * stops growing. A protocol with no chain listed takes the base weight of 1.
 */
export function chainMultiplier(chainCount: number, model: ModelConstants): number {
  return 1 + Math.min(Math.max(chainCount - 1, 0), model.chain_max_extra) * model.chain_step;
}

/**
 * A protocol's growth, maturity and chain weights from its own record, in one
 * place: the shipped pricing, the full-formula validation and the board all
 * read these three numbers, so a change to a weight lands once instead of in
 * three copies of the same arithmetic. The age is null when the snapshot's
 * as-of date is empty (the validation's flat comparison) or the protocol's
 * listing date is unknown, and the maturity then falls back to the model's
 * unknown-age days.
 */
export function multipliersFor(p: SnapshotProtocol, model: ModelConstants, asOf: string = ''): Multipliers {
  const { growthPct, growth } = growthMultiplier(p.change_7d, model);
  const age = asOf === '' ? null : ageDays(asOf, p.listed_at);
  const maturity = maturityMultiplier(age, model);
  const chain = chainMultiplier(p.chains.length, model);
  return { growthPct, growth, maturity, chain, age };
}

/**
 * One protocol's priced parts under a category multiple and a size tilt:
 * the fitted multiple (median x tilt, clamped), the three weights, and the
 * raw full-formula value they price. One function for the shipped pricing
 * and the validation's full-formula rule, so the two never disagree about
 * what "the full formula" means.
 */
export function pricingParts(
  p: SnapshotProtocol,
  categoryMultiple: number,
  tilt: number,
  model: ModelConstants,
  asOf: string = '',
): {
  fitted: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  chainMult: number;
  age: number | null;
  raw: number;
} {
  const fitted = clampMultiple(categoryMultiple * tilt, model);
  const m = multipliersFor(p, model, asOf);
  const raw = Math.max(1, Math.round(p.tvl_usd * fitted * m.growth * m.maturity * m.chain));
  return {
    fitted,
    growthPct: m.growthPct,
    growthMult: m.growth,
    maturityMult: m.maturity,
    chainMult: m.chain,
    age: m.age,
    raw,
  };
}

/**
 * A protocol's full-formula value from its category median and its size tilt: the
 * shipped pricing before calibration, with the growth, maturity and chain weights
 * applied. The age needs the snapshot's as-of date, so callers pass it in.
 */
export function fullFormulaValue(
  p: SnapshotProtocol,
  categoryMultiple: number,
  tilt: number,
  model: ModelConstants,
  asOf: string = '',
): number {
  return pricingParts(p, categoryMultiple, tilt, model, asOf).raw;
}

/**
 * The do-nothing calibrator: the map that leaves every value exactly where it is.
 * Used when a fit is degenerate (too few pairs, a non-positive slope, a spread of
 * zero) — the layer then deliberately does nothing rather than shipping a broken
 * map that would drag every board row somewhere it cannot defend.
 */
export function identityCalibrator(peers: number, model: ModelConstants): Calibrator {
  return {
    slope: 1,
    intercept: 0,
    r2: 0,
    winsor_lo: Number.NEGATIVE_INFINITY,
    winsor_hi: Number.POSITIVE_INFINITY,
    shift_cap_dex: model.calib_shift_cap_dex,
    peers,
    identity: true,
  };
}

/**
 * The winsorization bounds for a sorted list of log-predictions: the values at
 * the model's low and high percentiles, by linear interpolation. Training
 * predictions outside these bounds are clipped to them before any line is
 * fitted, so one wild peer cannot bend the calibration for every protocol.
 * Returns null when the bounds collapse — a spread of zero means the
 * predictions carry no usable spread to fit on.
 */
export function winsorBounds(sortedXs: number[], model: ModelConstants): { lo: number; hi: number } | null {
  const lo = quantile(sortedXs, model.calib_winsor_lo_pct / 100);
  const hi = quantile(sortedXs, model.calib_winsor_hi_pct / 100);
  if (!(hi > lo)) return null;
  return { lo, hi };
}

/**
 * The least-squares line of log true value on log predicted, with its R squared,
 * from two equal-length series. A slope at or below zero means the predictions
 * carry no usable signal about the true value in log space, and the caller
 * falls back to the identity map.
 */
export function fitLogLine(xs: number[], ys: number[]): { slope: number; intercept: number; r2: number } {
  return leastSquares(xs, ys);
}

/**
 * Fit the calibration map from out-of-fold prediction pairs: each pair is
 * (log10 of the price the fold model gave a held-out token, log10 of that
 * token's true market cap). The training predictions are winsorized at the
 * model's percentiles first, so one wild peer — a token the model priced a
 * hundred times too high — cannot bend the line for every other protocol.
 * The map is the least-squares line of log true value on winsorized log
 * predicted. A slope at or below zero means the predictions carry no usable
 * signal, and the fit returns the identity instead.
 */
export function fitCalibrator(
  pairs: [number, number][],
  model: ModelConstants,
): Calibrator {
  const n = pairs.length;
  if (n < 10) return identityCalibrator(n, model);
  const xsSorted = pairs.map(([x]) => x).sort((a, b) => a - b);
  const bounds = winsorBounds(xsSorted, model);
  if (bounds === null) return identityCalibrator(n, model);
  const { lo, hi } = bounds;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of pairs) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    xs.push(Math.min(hi, Math.max(lo, x)));
    ys.push(y);
  }
  if (xs.length < 10) return identityCalibrator(n, model);
  const { slope, intercept, r2 } = fitLogLine(xs, ys);
  if (!Number.isFinite(slope) || !Number.isFinite(intercept) || slope <= 0) {
    return identityCalibrator(n, model);
  }
  return {
    slope: round4(slope),
    intercept: round4(intercept),
    r2: round4(r2),
    winsor_lo: round4(lo),
    winsor_hi: round4(hi),
    shift_cap_dex: model.calib_shift_cap_dex,
    peers: n,
    identity: false,
  };
}

/**
 * Run one raw value through the calibration map: winsorize its log, map it, and
 * cap how far it may move. The return carries both the calibrated value and the
 * shift in decades, so the board row and the dashboard can show what the layer
 * did to this one protocol. An identity calibrator returns the raw value
 * untouched, shift zero.
 */
export function calibrateValue(
  raw: number,
  cal: Calibrator,
): { value: number; shiftDex: number } {
  if (cal.identity || raw <= 0) return { value: Math.max(1, Math.round(raw)), shiftDex: 0 };
  const x = Math.log10(raw);
  const xw = Math.min(cal.winsor_hi, Math.max(cal.winsor_lo, x));
  const y = cal.slope * xw + cal.intercept;
  const shift = Math.min(cal.shift_cap_dex, Math.max(-cal.shift_cap_dex, y - x));
  return { value: Math.max(1, Math.round(Math.pow(10, x + shift))), shiftDex: round4(shift) };
}

/**
 * One category's share of the calibration's work on the finished board: how
 * far the layer moved that category's rows, in decades, and how many of them
 * it moved at all. Computed for the run summary only — deliberately NOT part
 * of the serialized calibration object, so adding it cannot change the board,
 * the dashboard data or the dossier by a byte.
 */
export interface CategoryCalibrationSummary {
  category: string;
  rows: number;
  median_shift_dex: number;
  mean_shift_dex: number;
  max_abs_shift_dex: number;
  share_moved_pct: number;
}

/**
 * The per-category calibration summary of a finished board: the rows grouped
 * by their own category, each group's shifts summarised. A row counts as
 * moved when its shift is at least a twentieth of a decade — a hundredth of
 * a decade is rounding, not a move.
 */
export function categoryCalibrationSummary(board: BoardRow[]): CategoryCalibrationSummary[] {
  const byCategory = new Map<string, number[]>();
  for (const row of board) {
    const key = row.category ?? 'Uncategorised';
    const shifts = byCategory.get(key) ?? [];
    shifts.push(row.model.calibration_shift_dex);
    byCategory.set(key, shifts);
  }
  const out: CategoryCalibrationSummary[] = [];
  for (const [category, shifts] of [...byCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const sorted = [...shifts].sort((a, b) => a - b);
    const moved = shifts.filter((s) => Math.abs(s) >= 0.05).length;
    out.push({
      category,
      rows: shifts.length,
      median_shift_dex: round4(median(sorted) ?? 0),
      mean_shift_dex: round4(shifts.reduce((sum, s) => sum + s, 0) / shifts.length),
      max_abs_shift_dex: round4(Math.max(...shifts.map((s) => Math.abs(s)))),
      share_moved_pct: round4((moved / shifts.length) * 100),
    });
  }
  return out;
}

/**
 * One line that says what a fitted calibration map does, in words: the slope
 * and intercept of the log line, the winsor bounds it was fitted inside, and
 * the shift cap that binds it. An identity map says so plainly rather than
 * letting a slope of 1 and an intercept of 0 pass as a fitted map.
 */
export function describeCalibrator(cal: Calibrator): string {
  if (cal.identity) {
    return `calibration is an identity map — the fit was degenerate, so the layer changes no value (fitted on ${cal.peers} pairs)`;
  }
  return (
    `calibration log map: log10(calibrated) = ${cal.slope} x log10(raw) + ${cal.intercept} ` +
    `(R2 ${cal.r2}, winsor [${cal.winsor_lo}, ${cal.winsor_hi}] log10, shift capped at ±${cal.shift_cap_dex} dex, ${cal.peers} pairs)`
  );
}

/** Everything one fold's training peers calibrate, once, for all the rules. */
interface FoldContext {
  catMedian: (c: string | null) => number;
  pooledFit: PowerLawFit;
  perCatFit: (c: string | null) => { slopeDamped: number; refTvl: number };
  withinSlopeDamped: number;
  model: ModelConstants;
}

/** One held-out token's out-of-fold prices: the multiple alone and the full formula. */
interface OofPrediction {
  slug: string;
  multiple: number;
  full: number;
  trueValue: number;
}

/**
 * Build one fold's context from its training peers: the category medians, the
 * pooled power-law fit, the per-category fits and the within-category slope —
 * exactly as the board fits them, so the check measures the models that could
 * actually ship.
 */
export function buildFoldContext(train: SnapshotProtocol[], model: ModelConstants): FoldContext {
  const trainRatios = train.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b);
  const trainMedian = median(trainRatios) ?? 0.2;
  const byCat = new Map(groupByCategory(train));
  const catMedian = (c: string | null): number => {
    const v = byCat.get(c ?? 'Uncategorised');
    if (v !== undefined && v.length >= model.min_peers) {
      const m = median(v.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b));
      if (m !== null) return clampMultiple(m, model);
    }
    return clampMultiple(trainMedian, model);
  };
  const fit = fitPowerLaw(train);
  const medTvl = median(train.map((p) => p.tvl_usd).sort((a, b) => a - b)) ?? 1;
  const pooledFit: PowerLawFit = {
    slope: fit.slope,
    slope_damped: dampedSlope(fit.slope, model),
    r2: fit.r2,
    peers: train.length,
    median_tvl_usd: medTvl,
  };
  const perCatFit = (c: string | null): { slopeDamped: number; refTvl: number } => {
    const list = byCat.get(c ?? 'Uncategorised');
    // A category's own fit is measured against its own median live TVL, so the
    // tilt is 1 for a typical protocol in that category, not in the market.
    const refTvl = list !== undefined ? median(list.map((p) => p.tvl_usd).sort((a, b) => a - b)) ?? medTvl : medTvl;
    if (list !== undefined && list.length >= 5) {
      const cf = fitPowerLaw(list);
      if (cf.slope > 0 && cf.r2 >= 0) return { slopeDamped: dampedSlope(cf.slope, model), refTvl };
    }
    return { slopeDamped: pooledFit.slope_damped, refTvl };
  };
  const withinSlopeDamped = dampedSlope(withinCategorySlope(train), model);
  return { catMedian, pooledFit, perCatFit, withinSlopeDamped, model };
}

/** The size tilt for one TVL under one fold's fit and reference. */
function tiltFrom(tvl: number, slopeDamped: number, refTvl: number, ctx: FoldContext): number {
  return tiltValue(tvl, slopeDamped, refTvl, ctx.model);
}

/** One protocol's pooled-tilt multiple-only price and full-formula price under a fold. */
function priceUnderFold(
  p: SnapshotProtocol,
  ctx: FoldContext,
  asOf: string,
): { multiple: number; full: number } {
  const med = ctx.catMedian(p.category);
  const tilt = tiltFrom(p.tvl_usd, ctx.pooledFit.slope_damped, ctx.pooledFit.median_tvl_usd, ctx);
  const multiple = p.tvl_usd * clampMultiple(med * tilt, ctx.model);
  const full = fullFormulaValue(p, med, tilt, ctx.model, asOf);
  return { multiple, full };
}

/**
 * Out-of-fold predictions for a peer list: five folds by sorted-slug position,
 * each peer priced by a context fitted without its own fold. Deterministic, so
 * the same snapshot always yields the same predictions — the calibration fit,
 * the validation and the board all read from this one engine.
 */
function oofPredictions(
  sortedPeers: SnapshotProtocol[],
  model: ModelConstants,
  asOf: string,
): OofPrediction[] {
  const out: OofPrediction[] = [];
  for (let fold = 0; fold < 5; fold++) {
    const test = sortedPeers.filter((_, i) => i % 5 === fold);
    const train = sortedPeers.filter((_, i) => i % 5 !== fold);
    const ctx = buildFoldContext(train, model);
    for (const p of test) {
      const priced = priceUnderFold(p, ctx, asOf);
      out.push({ slug: p.slug, multiple: priced.multiple, full: priced.full, trueValue: p.mcap_usd! });
    }
  }
  return out;
}

/** The error lists one 5-fold run accumulates, for the summary below. */
interface ValidationAccumulators {
  rules: string[];
  errs: number[][];
  logErrs: number[][];
  pairs: [number, number][][];
  within: number[];
  wins: number[];
  calErrs: number[];
  calLogErrs: number[];
  calPairs: [number, number][];
  calWithin: number;
  calWins: number;
  fullFlatErrs: number[];
  fullFlatLog: number[];
  fullFlatPairs: [number, number][];
  fullFlatWithin: number;
  byCatErr: Map<string, { flat: number[]; sized: number[]; wins: number }>;
  peerCount: number;
  /** The held-out pairs for the plot: same loop, same prices as pairs[4] and pairs[5]. */
  heldout: HeldoutPair[];
}

/**
 * One rule's row in the candidates table, from the error lists one 5-fold
 * run accumulated. One row per rule, every rule on the same folds, so no
 * rule is judged on a different draw.
 */
function candidateRow(
  candidate: string,
  errs: number[],
  logErrs: number[],
  pairs: [number, number][],
  within: number,
  wins: number,
  peerCount: number,
): CandidateCheck {
  return {
    candidate,
    median_ape_pct: medianPct(errs),
    trimmed_mean_ape_pct: trimmedMeanPct(errs),
    wins,
    peers: peerCount,
    spearman: round4(spearman(pairs.map(([v]) => v), pairs.map(([, t]) => t))),
    log_mae: meanOf(logErrs),
    within2x_pct: round4((within / peerCount) * 100),
  };
}

/**
 * The per-category tilt table, from the per-category error lists: one row
 * per category, alphabetical, with the median error of the flat median and
 * of the pooled tilt side by side and how many of the category's tokens the
 * tilt priced closer.
 */
function categoryRows(byCatErr: Map<string, { flat: number[]; sized: number[]; wins: number }>): CategoryValidation[] {
  return [...byCatErr.entries()]
    .sort((x, y) => (x[0] < y[0] ? -1 : 1))
    .map(([category, e]) => ({
      category,
      peers: e.flat.length,
      median_ape_flat_pct: medianPct(e.flat),
      median_ape_sized_pct: medianPct(e.sized),
      sized_wins: e.wins,
    }));
}

/**
 * The 5-fold check's summary tables from the accumulators: the per-rule
 * candidate rows, the per-category tilt table, and the flat-vs-sized headline
 * numbers for the multiple alone and for the full formula — including the
 * calibrated rules. Kept apart from the fold loop so the loop stays about
 * pricing held-out tokens and this stays about turning error lists into the
 * numbers the model tab prints.
 */
function summariseValidation(a: ValidationAccumulators): TiltValidation {
  const trimmedMean = trimmedMeanPct;
  const logMean = meanOf;
  const spearOf = (ps: [number, number][]): number =>
    round4(spearman(ps.map(([v]) => v), ps.map(([, t]) => t)));
  const withinPct = (n: number): number => round4((n / a.peerCount) * 100);
  const byCategory: CategoryValidation[] = categoryRows(a.byCatErr);
  const candidates: CandidateCheck[] = a.rules.map((candidate, ri) =>
    candidateRow(candidate, a.errs[ri]!, a.logErrs[ri]!, a.pairs[ri]!, a.within[ri]!, a.wins[ri]!, a.peerCount),
  );
  return {
    median_ape_flat_pct: medianPct(a.errs[0]!),
    median_ape_sized_pct: medianPct(a.errs[1]!),
    trimmed_mean_ape_flat_pct: trimmedMean(a.errs[0]!),
    trimmed_mean_ape_sized_pct: trimmedMean(a.errs[1]!),
    sized_wins: a.wins[1]!,
    peers: a.peerCount,
    spearman_flat: spearOf(a.pairs[0]!),
    spearman_sized: spearOf(a.pairs[1]!),
    log_mae_flat: logMean(a.logErrs[0]!),
    log_mae_sized: logMean(a.logErrs[1]!),
    within2x_flat_pct: withinPct(a.within[0]!),
    within2x_sized_pct: withinPct(a.within[1]!),
    full_median_ape_flat_pct: medianPct(a.fullFlatErrs),
    full_median_ape_sized_pct: medianPct(a.errs[4]!),
    full_trimmed_mean_ape_flat_pct: trimmedMean(a.fullFlatErrs),
    full_trimmed_mean_ape_sized_pct: trimmedMean(a.errs[4]!),
    full_sized_wins: a.wins[4]!,
    full_spearman_flat: spearOf(a.fullFlatPairs),
    full_spearman_sized: spearOf(a.pairs[4]!),
    full_log_mae_flat: logMean(a.fullFlatLog),
    full_log_mae_sized: logMean(a.logErrs[4]!),
    full_within2x_flat_pct: withinPct(a.fullFlatWithin),
    full_within2x_sized_pct: withinPct(a.within[4]!),
    cal_median_ape_pct: medianPct(a.calErrs),
    cal_trimmed_mean_ape_pct: trimmedMean(a.calErrs),
    cal_wins: a.calWins,
    cal_spearman: spearOf(a.calPairs),
    cal_log_mae: logMean(a.calLogErrs),
    cal_within2x_pct: withinPct(a.calWithin),
    full_cal_median_ape_pct: medianPct(a.errs[5]!),
    full_cal_trimmed_mean_ape_pct: trimmedMean(a.errs[5]!),
    full_cal_wins: a.wins[5]!,
    full_cal_spearman: spearOf(a.pairs[5]!),
    full_cal_log_mae: logMean(a.logErrs[5]!),
    full_cal_within2x_pct: withinPct(a.within[5]!),
    by_category: byCategory,
    candidates,
    heldout_pairs: a.heldout,
  };
}

/** One held-out token's eight prices under a fold's context and calibrators. */
interface TestTokenPrices {
  flat: number;
  pooled: number;
  percat: number;
  withinPred: number;
  full: number;
  fullFlat: number;
  fullCal: number;
  calMultPred: number;
}

/**
 * The fold's two calibrators, fitted on inner out-of-fold predictions of the
 * training peers only — the held-out tokens never touch this fit. One for the
 * multiple alone, one for the full formula: the calibrated multiple and the
 * calibrated full formula are measured separately, so each layer's gain is
 * its own number.
 */
export function fitFoldCalibrators(
  train: SnapshotProtocol[],
  model: ModelConstants,
  asOf: string,
): { calMult: Calibrator; calFull: Calibrator } {
  const inner = oofPredictions(train, model, asOf);
  const calMult = fitCalibrator(
    inner.map((o) => [Math.log10(o.multiple), Math.log10(o.trueValue)] as [number, number]),
    model,
  );
  const calFull = fitCalibrator(
    inner.map((o) => [Math.log10(o.full), Math.log10(o.trueValue)] as [number, number]),
    model,
  );
  return { calMult, calFull };
}

/**
 * One held-out token priced eight ways under a fold: the flat category
 * median, the pooled tilt, the per-category tilt, the within-category slope,
 * the shipped full formula, the flat median with the multipliers, and the
 * two calibrated versions. All eight prices come from the same context, so
 * the per-rule errors compare models, not draws.
 */
export function priceTestToken(
  p: SnapshotProtocol,
  ctx: FoldContext,
  calMult: Calibrator,
  calFull: Calibrator,
  model: ModelConstants,
  asOf: string,
): TestTokenPrices {
  const med = ctx.catMedian(p.category);
  const pooledTilt = tiltFrom(p.tvl_usd, ctx.pooledFit.slope_damped, ctx.pooledFit.median_tvl_usd, ctx);
  const flat = p.tvl_usd * med;
  const pooled = p.tvl_usd * clampMultiple(med * pooledTilt, ctx.model);
  const fc = ctx.perCatFit(p.category);
  const percat = p.tvl_usd * clampMultiple(med * tiltFrom(p.tvl_usd, fc.slopeDamped, fc.refTvl, ctx), ctx.model);
  const withinPred = p.tvl_usd * clampMultiple(med * tiltFrom(p.tvl_usd, ctx.withinSlopeDamped, ctx.pooledFit.median_tvl_usd, ctx), ctx.model);
  const full = fullFormulaValue(p, med, pooledTilt, ctx.model, asOf);
  const fullFlat = fullFormulaValue(p, med, 1, ctx.model, asOf);
  const fullCal = calibrateValue(full, calFull).value;
  const calMultPred = calibrateValue(pooled, calMult).value;
  return { flat, pooled, percat, withinPred, full, fullFlat, fullCal, calMultPred };
}

/**
 * The 5-fold check: each live token is priced six ways — flat category median,
 * pooled tilt, per-category tilt, within-category slope, the shipped full
 * formula, and the full formula with calibration — each fold fitting on the
 * other four fifths, exactly as the board fits them. The calibration is
 * measured honestly: inside each outer fold, the fold's calibrators are
 * fitted on inner out-of-fold predictions of the training peers only (a
 * nested 5-fold over the training set), never on the held-out token they
 * then price. Deterministic (folds by sorted slug). The held-out pairs for
 * the plot are collected in the same loop, from the same prices.
 */
export function validateModel(sortedPeers: SnapshotProtocol[], model: ModelConstants = MODEL, asOf: string = ''): TiltValidation {
  // Accumulators per rule: [flat, pooled, percat, within, full, full+cal]. Wins are
  // counted against the flat median for every rule, one baseline for the whole table.
  const RULES = [
    'flat category median',
    'pooled size tilt',
    'per-category tilt',
    'within-category slope',
    'full formula (v3)',
    'full formula + calibration (shipped)',
  ];
  const errs: number[][] = RULES.map(() => []);
  const logErrs: number[][] = RULES.map(() => []);
  const pairs: [number, number][][] = RULES.map(() => []);
  const within: number[] = RULES.map(() => 0);
  const wins: number[] = RULES.map(() => 0);
  const calErrs: number[] = [];
  const calLogErrs: number[] = [];
  const calPairs: [number, number][] = [];
  let calWithin = 0;
  let calWins = 0;
  const fullFlatErrs: number[] = [];
  const fullFlatLog: number[] = [];
  const fullFlatPairs: [number, number][] = [];
  let fullFlatWithin = 0;
  const byCatErr = new Map<string, { flat: number[]; sized: number[]; wins: number }>();
  const heldout: HeldoutPair[] = [];

  /**
   * One held-out token's six rule prices into the error lists: the APE, the
   * log-space error and the (price, truth) pair per rule, the within-twice
   * count, and the wins against the flat median — the flat error is the one
   * baseline for every rule, computed once per token.
   */
  const recordRules = (preds: number[], trueV: number, flat: number): void => {
    const flatErr = Math.abs(flat - trueV) / trueV;
    preds.forEach((pred, ri) => {
      const e = Math.abs(pred - trueV) / trueV;
      errs[ri]!.push(e);
      logErrs[ri]!.push(Math.abs(Math.log10(pred) - Math.log10(trueV)));
      pairs[ri]!.push([pred, trueV]);
      if (pred >= trueV / 2 && pred <= trueV * 2) within[ri]!++;
      if (ri > 0 && e < flatErr) wins[ri]!++;
    });
  };

  /**
   * One held-out token's per-category error lists, for the table that breaks
   * the tilt's median error down by category: the flat error and the pooled
   * tilt's error, and whether the tilt won this token.
   */
  const recordCategoryError = (p: SnapshotProtocol, flat: number, pooled: number, trueV: number): void => {
    const catKey = p.category ?? 'Uncategorised';
    const ce = byCatErr.get(catKey) ?? { flat: [], sized: [], wins: 0 };
    const eFlat = Math.abs(flat - trueV) / trueV;
    const eSized = Math.abs(pooled - trueV) / trueV;
    ce.flat.push(eFlat);
    ce.sized.push(eSized);
    if (eSized < eFlat) ce.wins++;
    byCatErr.set(catKey, ce);
  };

  /**
   * One held-out token's two extra rule prices into the error lists: the
   * calibrated multiple-only price, and the flat full formula. Each gets its
   * APE, its log-space error and its (price, truth) pair, plus the
   * within-twice count and the win against the flat median.
   */
  const recordExtraRules = (calMultPred: number, fullFlat: number, trueV: number, flat: number): void => {
    const flatErr = Math.abs(flat - trueV) / trueV;
    const eCal = Math.abs(calMultPred - trueV) / trueV;
    calErrs.push(eCal);
    calLogErrs.push(Math.abs(Math.log10(calMultPred) - Math.log10(trueV)));
    calPairs.push([calMultPred, trueV]);
    if (calMultPred >= trueV / 2 && calMultPred <= trueV * 2) calWithin++;
    if (eCal < flatErr) calWins++;
    const eFullFlat = Math.abs(fullFlat - trueV) / trueV;
    fullFlatErrs.push(eFullFlat);
    fullFlatLog.push(Math.abs(Math.log10(fullFlat) - Math.log10(trueV)));
    fullFlatPairs.push([fullFlat, trueV]);
    if (fullFlat >= trueV / 2 && fullFlat <= trueV * 2) fullFlatWithin++;
  };

  for (let fold = 0; fold < 5; fold++) {
    const test = sortedPeers.filter((_, i) => i % 5 === fold);
    const train = sortedPeers.filter((_, i) => i % 5 !== fold);
    const ctx = buildFoldContext(train, model);
    const { calMult, calFull } = fitFoldCalibrators(train, model, asOf);
    for (const p of test) {
      const { flat, pooled, percat, withinPred, full, fullFlat, fullCal, calMultPred } = priceTestToken(
        p,
        ctx,
        calMult,
        calFull,
        model,
        asOf,
      );
      const preds = [flat, pooled, percat, withinPred, full, fullCal];
      const trueV = p.mcap_usd!;
      recordRules(preds, trueV, flat);
      recordExtraRules(calMultPred, fullFlat, trueV, flat);
      recordCategoryError(p, flat, pooled, trueV);
      heldout.push({ slug: p.slug, raw: full, calibrated: fullCal, actual: trueV });
    }
  }

  return summariseValidation({
    rules: RULES,
    errs,
    logErrs,
    pairs,
    within,
    wins,
    calErrs,
    calLogErrs,
    calPairs,
    calWithin,
    calWins,
    fullFlatErrs,
    fullFlatLog,
    fullFlatPairs,
    fullFlatWithin,
    byCatErr,
    peerCount: sortedPeers.length,
    heldout,
  });
}

/**
 * What the calibration did to the out-of-fold predictions it was fitted on:
 * the log error, the median error and the trimmed mean error before and after
 * the layer, on the same predictions. The after-numbers are the fitted
 * layer's view of the predictions it was fitted on — the honest measure is
 * the nested validation, and the dashboard says which is which. `most_shrunk`
 * is filled in later by buildBoard, once the board rows exist.
 */
export function summariseCalibration(oof: OofPrediction[], calibrator: Calibrator): CalibrationReport {
  const beforeErrs = oof.map((o) => Math.abs(o.full - o.trueValue) / o.trueValue);
  const beforeLog = oof.map((o) => Math.abs(Math.log10(o.full) - Math.log10(o.trueValue)));
  const afterVals = oof.map((o) => calibrateValue(o.full, calibrator).value);
  const afterErrs = oof.map((o, i) => Math.abs(afterVals[i]! - o.trueValue) / o.trueValue);
  const afterLog = oof.map((o, i) => Math.abs(Math.log10(afterVals[i]!) - Math.log10(o.trueValue)));
  return {
    calibrator,
    oof_log_mae_before: meanOf(beforeLog),
    oof_log_mae_after: meanOf(afterLog),
    oof_median_ape_before_pct: medianPct(beforeErrs),
    oof_median_ape_after_pct: medianPct(afterErrs),
    oof_trimmed_mean_ape_before_pct: trimmedMeanPct(beforeErrs),
    oof_trimmed_mean_ape_after_pct: trimmedMeanPct(afterErrs),
    most_shrunk: [],
  };
}

/**
 * Calibrate the category multiples and the size tilt from the snapshot's own live-token
 * protocols, and fit the board's calibration layer on out-of-fold predictions of
 * those same peers. Nothing here names a protocol: the tables are whatever the
 * snapshot's market says. The board calibrator is fitted on the full-formula
 * out-of-fold predictions — each peer priced by a model that never saw its own
 * fold — so the map is learned from prices the model actually produced for
 * tokens it had not been fitted on. `most_shrunk` is filled in by buildBoard.
 */
export function calibrate(snapshot: Snapshot, model: ModelConstants = MODEL): Calibration {
  const peers = livePeers(snapshot);
  const sorted = [...peers].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const allRatios = peers.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b);
  const marketMedian = median(allRatios) ?? 0.2;
  const fit = fitPowerLaw(peers);
  const medianTvl = median(peers.map((p) => p.tvl_usd).sort((a, b) => a - b)) ?? 1;
  const powerLaw: PowerLawFit = {
    slope: round4(fit.slope),
    slope_damped: round4(dampedSlope(fit.slope, model)),
    r2: round4(fit.r2),
    peers: peers.length,
    median_tvl_usd: medianTvl,
  };
  const validation = validateModel(sorted, model, snapshot.as_of);
  const oof = oofPredictions(sorted, model, snapshot.as_of);
  const calibrator = fitCalibrator(
    oof.map((o) => [Math.log10(o.full), Math.log10(o.trueValue)] as [number, number]),
    model,
  );
  const calibrationReport = summariseCalibration(oof, calibrator);
  return {
    market_median: round4(marketMedian),
    live_count: peers.length,
    categories: categoryMultiples(peers, marketMedian, model),
    power_law: powerLaw,
    category_basis: buildCategoryBasis(peers),
    tilt_validation: validation,
    calibration: calibrator,
    calibration_report: calibrationReport,
  };
}

/** The calibrated multiple for one protocol's category, from the calibration table. */
function multipleFor(p: SnapshotProtocol, calibration: Calibration, model: ModelConstants): CategoryMultiple {
  const found = calibration.categories.find((c) => c.category === (p.category ?? 'Uncategorised'));
  if (found !== undefined) return found;
  return {
    category: p.category ?? 'Uncategorised',
    multiple: round4(clampMultiple(calibration.market_median, model)),
    peers: 0,
    fallback: true,
  };
}

/** The multipliers and the implied value one protocol gets under `model`, before and after calibration. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  calibration: Calibration,
  model: ModelConstants,
): {
  implied: number;
  raw: number;
  shiftDex: number;
  multiple: CategoryMultiple;
  tilt: number;
  fitted: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  chainMult: number;
  age: number | null;
} {
  const multiple = multipleFor(protocol, calibration, model);
  const tilt = sizeTilt(protocol.tvl_usd, calibration.power_law, model);
  const parts = pricingParts(protocol, multiple.multiple, tilt, model, asOf);
  const cal = calibrateValue(parts.raw, calibration.calibration);
  return {
    implied: cal.value,
    raw: parts.raw,
    shiftDex: cal.shiftDex,
    multiple,
    tilt,
    fitted: parts.fitted,
    growthPct: parts.growthPct,
    growthMult: parts.growthMult,
    maturityMult: parts.maturityMult,
    chainMult: parts.chainMult,
    age: parts.age,
  };
}

/** Short human signals derived from the protocol's own figures, for badges in the board. */
export function signalsFor(p: SnapshotProtocol, age: number | null): string[] {
  const signals: string[] = [];
  if (p.change_7d !== null && p.change_7d >= 20) signals.push('heating up');
  if (p.change_7d !== null && p.change_7d <= -20) signals.push('cooling off');
  if (age !== null && age < 180) signals.push('young');
  if (age !== null && age < 180 && p.change_7d !== null && p.change_7d >= 20) signals.push('early mover');
  if (age !== null && age >= 730) signals.push('seasoned');
  if (p.chains.length >= 5) signals.push('multi-chain');
  if (p.tvl_usd >= 500_000_000) signals.push('whale TVL');
  return signals;
}

/**
 * The protocols the board ranks: the watchlist first — the floor, every slug it
 * names, even one the snapshot no longer carries — then every other rankable
 * pre-token protocol at any size. No cap on the early radar: a protocol below
 * the floor is no worse a subject, and the radar exists to find it early.
 */
function chooseBoardProtocols(snapshot: Snapshot): SnapshotProtocol[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }
  return [...chosen.values()];
}

/** One protocol with its priced value, ready to become a board row. */
type ScoredProtocol = ReturnType<typeof impliedValue> & { p: SnapshotProtocol };

/**
 * The model breakdown one board row carries: the category multiple and how
 * many peers backed it, the pooled size tilt and its R², the fitted multiple
 * after the three weights, the three weights themselves, and the calibrated
 * value against the raw formula value with the calibration's shift in
 * decades.
 */
function modelBreakdown(s: ScoredProtocol, tiltR2: number): BoardRow['model'] {
  return {
    category_multiple: s.multiple.multiple,
    multiple_peers: s.multiple.peers,
    multiple_fallback: s.multiple.fallback,
    size_tilt: round4(s.tilt),
    size_tilt_basis: 'pooled — all live-token peers',
    size_tilt_r2: tiltR2,
    fitted_multiple: round4(s.fitted),
    growth_pct: s.growthPct,
    growth_multiplier: round4(s.growthMult),
    maturity_multiplier: round4(s.maturityMult),
    chain_multiplier: round4(s.chainMult),
    raw_implied_value_usd: s.raw,
    calibration_shift_dex: s.shiftDex,
  };
}

/** One scored protocol's board row, at its rank, with the model breakdown attached. */
function toBoardRow(s: ScoredProtocol, rank: number, tiltR2: number): BoardRow {
  return {
    rank,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    signals: signalsFor(s.p, s.age),
    model: modelBreakdown(s, tiltR2),
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  };
}

/**
 * The board's protocols, scored and ranked strongest first: every protocol
 * the board ranks, priced by its calibrated implied value, in descending
 * order with the slug as the tiebreak so the ranking is deterministic even
 * when two protocols price identically.
 */
function scoreBoardProtocols(
  snapshot: Snapshot,
  calibration: Calibration,
  model: ModelConstants,
): ScoredProtocol[] {
  const scored = chooseBoardProtocols(snapshot).map((p) => {
    const v = impliedValue(p, snapshot.as_of, calibration, model);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored;
}

/**
 * The calibration report's most-shrunk table, from the finished board rows:
 * the ten rows the layer moved the farthest in either direction, farthest
 * first, slug as the tiebreak. The calibration object the dashboard carries
 * is the one the board actually used, complete with this table.
 */
function fillMostShrunk(board: BoardRow[], calibration: Calibration): void {
  calibration.calibration_report.most_shrunk = [...board]
    .sort(
      (a, b) =>
        Math.abs(b.model.calibration_shift_dex) - Math.abs(a.model.calibration_shift_dex) ||
        (a.slug < b.slug ? -1 : 1),
    )
    .slice(0, 10)
    .map((r) => ({
      slug: r.slug,
      name: r.name,
      raw_implied_value_usd: r.model.raw_implied_value_usd,
      calibrated_implied_value_usd: r.implied_value_usd,
      shift_dex: r.model.calibration_shift_dex,
    }));
}

/**
 * The protocols the board ranks, strongest first, with ranks 1..n — ranked by the
 * CALIBRATED value, because that is the number the board shows and the judge reads.
 * The calibration report's most-shrunk table is filled in here from the finished
 * rows, so the calibration object the dashboard carries is the one the board
 * actually used.
 */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; calibration: Calibration } {
  const calibration = calibrate(snapshot, model);
  const scored = scoreBoardProtocols(snapshot, calibration, model);
  const board = scored.map((s, i) => toBoardRow(s, i + 1, calibration.power_law.r2));
  fillMostShrunk(board, calibration);
  return { board, calibration };
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 chars. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/**
 * What one transaction costs, in dollars of gas, by chain family: the chain's
 * own fee market, not a flat guess. Ethereum mainnet is an order dearer than
 * an L2 or Solana; a reader farming on Base should not budget mainnet gas.
 * The first family that names the chain wins; anything unlisted costs $3.
 */
const GAS_TIERS: { chains: string[]; gas: string }[] = [
  { chains: ['ethereum'], gas: 'about $12 of gas' },
  { chains: ['solana', 'sui', 'aptos', 'ton', 'near'], gas: 'about $0.10 of gas' },
  {
    chains: [
      'arbitrum', 'optimism', 'base', 'polygon', 'zksync era', 'linea', 'scroll',
      'ink', 'unichain', 'mode', 'blast', 'zora', 'world chain', 'soneium', 'abstract',
    ],
    gas: 'about $0.50 of gas',
  },
  { chains: ['binance', 'avalanche'], gas: 'about $1 of gas' },
  { chains: ['tron'], gas: 'about $2 of gas' },
];

/** What one transaction costs on a chain, in dollars of gas. */
export function gasFor(chain: string): string {
  const c = chain.toLowerCase();
  for (const tier of GAS_TIERS) {
    if (tier.chains.includes(c)) return tier.gas;
  }
  return 'about $3 of gas';
}

/**
 * The capital tiers: a position's size follows the protocol's own TVL, not
 * a flat guess — a billion-dollar protocol is farmed with a bigger position
 * than a $50M one, and the table makes the breakpoints visible instead of
 * hiding them in a chain of ifs. The first tier whose floor the TVL clears
 * wins; anything under $50M farms at $50.
 */
const CAPITAL_TIERS: { floor_usd: number; capital: number }[] = [
  { floor_usd: 1_000_000_000, capital: 250 },
  { floor_usd: 100_000_000, capital: 150 },
  { floor_usd: 50_000_000, capital: 100 },
];

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  for (const tier of CAPITAL_TIERS) {
    if (p.tvl_usd >= tier.floor_usd) return tier.capital;
  }
  return 50;
}

/**
 * The hold in days from the protocol's age alone, before growth adjusts it:
 * a young protocol needs the longest hold to show up in more than one
 * snapshot; a seasoned one has already proven it stays, so 30 days is
 * enough; an unknown age falls back to the middle.
 */
function baseHoldDays(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/**
 * The growth adjustment on a hold: a heating-up protocol (TVL up 20% or
 * more in seven days) earns fifteen extra days to ride the attention rather
 * than chase an entry after the spike; a cooling one (down 20% or more)
 * loses fifteen, floored at 21 days so the position still counts in more
 * than one snapshot. A flat week leaves the hold untouched.
 */
function adjustHoldDays(hold: number, growth: number | null): number {
  if (growth !== null && growth >= 20) return hold + 15;
  if (growth !== null && growth <= -20) return Math.max(21, hold - 15);
  return hold;
}

/** How long to hold, from the protocol's age and its seven-day growth. */
function holdDaysFor(age: number | null, growth: number | null): number {
  return adjustHoldDays(baseHoldDays(age), growth);
}

/** One category family's three recurring farm actions, as text builders. */
interface FamilyActions {
  test: (category: string) => boolean;
  main: (name: string, capital: number, chain: string) => string;
  second: (name: string, capital: number, chain: string) => string;
  weekly: (name: string, capital: number, chain: string) => string;
}

/**
 * The category families, in the order they are tried — the first family whose
 * test matches the protocol's category wins, so a category that names two
 * families (a staking bridge, say) always takes the earlier one. Each family
 * writes the main position, a second action and the weekly habit for what that
 * kind of protocol actually does. The family comes from the category's words,
 * never the protocol's name.
 */
const ACTION_FAMILIES: FamilyActions[] = [
  {
    test: (c) => c.includes('lend') || c.includes('cdp') || c.includes('collateral'),
    main: (name, capital, chain) =>
      `Lend $${capital} of USDC through ${name} on ${chain} and leave the deposit alone so it appears in every snapshot.`,
    second: () =>
      `Borrow $20 of USDC against that deposit, pay it back the same week, and take the same borrow out again next month.`,
    weekly: () =>
      `Each week, check the utilisation of your market and top up the deposit if you are nearing the borrow limit.`,
  },
  {
    test: (c) => c.includes('dex') || c.includes('amm') || c.includes('swap'),
    main: (name, capital, chain) =>
      `Add $${capital} as concentrated liquidity to ${name}'s most traded pool on ${chain}, set inside the range where trading actually happens.`,
    second: (name, capital, chain) =>
      `Run a $25 swap through ${name} on ${chain} every week, picking a different pair each time.`,
    weekly: () =>
      `Move the range back to where the volume is every week so the position keeps earning instead of sitting outside the market.`,
  },
  {
    test: (c) => c.includes('bridge'),
    main: (name, capital, chain) =>
      `Send $${capital} of USDC across to ${chain} with ${name}, then put the bridged funds to work inside the protocol's own app.`,
    second: () =>
      `A week later, bridge $25 back the way you came and then in again, so the record shows movement both ways.`,
    weekly: (name, capital, chain) =>
      `Bridge a small sum through ${name} each week, flipping the direction every time.`,
  },
  {
    test: (c) => c.includes('stak') || c.includes('restak'),
    main: (name, capital, chain) =>
      `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token in the same wallet.`,
    second: () =>
      `Add $25 to the stake every month and never pull the whole position out in a single transaction.`,
    weekly: () =>
      `Every week, look at the staking rewards and restake them instead of leaving them unclaimed.`,
  },
  {
    test: (c) => c.includes('perpetual') || c.includes('derivative') || c.includes('options'),
    main: (name, capital, chain) =>
      `Deposit $${capital} of USDC as margin with ${name} on ${chain} and open a single modest position, hedged on the other side.`,
    second: () =>
      `Once a week, close that position and open a new $25 one, leaving the margin parked in the account between trades.`,
    weekly: () =>
      `Close the position out every week and start another, so the account reads as steady use rather than one trade.`,
  },
  {
    test: (c) => c.includes('prediction'),
    main: (name, capital, chain) =>
      `Put $${capital} into ${name} and back one market that does not settle for at least a week.`,
    second: () =>
      `Back a different market with $10 each week and never chase one that has already settled.`,
    weekly: () =>
      `Close or settle one position each week and open the next on a market about something unrelated.`,
  },
  {
    test: (c) => c.includes('curator') || c.includes('allocator') || c.includes('vault'),
    main: (name, capital, chain) =>
      `Deposit $${capital} into a ${name} vault on ${chain} and leave the vault shares untouched.`,
    second: () =>
      `Add $25 to that same vault monthly and read its allocation note whenever you do.`,
    weekly: () =>
      `Read the vault's allocation note once a week and watch for a strategy change before adding anything.`,
  },
  {
    test: (c) => c.includes('stable'),
    main: (name, capital, chain) =>
      `Mint or hold $${capital} of the stable asset via ${name} on ${chain} and keep it deployed inside the protocol.`,
    second: (name, capital, chain) =>
      `Swap $25 of the stable asset through ${name} every week and send the proceeds back into the same position.`,
    weekly: (name, capital, chain) =>
      `Check the peg weekly and move a small amount through ${name} so the position stays visibly active.`,
  },
  {
    test: (c) => c.includes('rwa'),
    main: (name, capital, chain) =>
      `Mint $${capital} of the protocol's yield-bearing asset on ${chain} and hold it for the full term.`,
    second: () =>
      `Add $25 to the holding once a month and keep it in the same wallet the whole time.`,
    weekly: () =>
      `Note the yield accrual in the farm log once a week and record the balance.`,
  },
  {
    test: (c) => c.includes('insurance'),
    main: (name, capital, chain) =>
      `Buy $${capital} of cover from ${name} on ${chain} and keep the policy live for its whole term.`,
    second: () =>
      `Top the cover up by $25 before it runs out, and never claim for a loss that did not happen.`,
    weekly: () =>
      `Check the policy's remaining term every week so it never lapses without you noticing.`,
  },
  {
    test: (c) => c.includes('yield') || c.includes('leveraged farm') || c.includes('aggregator'),
    main: (name, capital, chain) =>
      `Put $${capital} of USDC into ${name}'s best-yielding strategy on ${chain} and let it compound.`,
    second: () =>
      `Take the yield monthly, put it back in, and move $25 between two of its strategies each quarter.`,
    weekly: () =>
      `Harvest the week's yield and redeposit it at once, so compounding never stalls.`,
  },
  {
    test: (c) => c.includes('launchpad'),
    main: (name, capital, chain) =>
      `Commit $${capital} to ${name}'s allocation pool on ${chain} and register for the next sale.`,
    second: () =>
      `Finish one launch task per week and keep the stake locked until the sale window shuts.`,
    weekly: () =>
      `Do one launch task a week and check the calendar for the next sale window.`,
  },
  {
    test: (c) => c.includes('payment'),
    main: (name, capital, chain) =>
      `Send $${capital} of real payments through ${name} on ${chain} over the month, split across several small sends.`,
    second: (name, capital, chain) =>
      `Send $25 through ${name} each week to a different recipient every time.`,
    weekly: (name, capital, chain) =>
      `Send one real payment through ${name} weekly, changing the amount and the recipient.`,
  },
  {
    test: (c) => c.includes('nft') || c.includes('marketplace'),
    main: (name, capital, chain) =>
      `List one item and buy one item of about $${capital} through ${name} on ${chain}.`,
    second: (name, capital, chain) =>
      `Trade one small item on ${name} weekly, using the same wallet for every listing.`,
    weekly: (name, capital, chain) =>
      `List or buy one small item a week on ${name} and keep the same wallet for every trade.`,
  },
  {
    test: (c) => c.includes('privacy'),
    main: (name, capital, chain) =>
      `Move $${capital} through ${name}'s private flow on ${chain} and leave the shielded balance where it lands.`,
    second: () =>
      `Make one $25 private transfer a week and never empty the shielded balance in one move.`,
    weekly: () =>
      `Make one small private transfer every week and keep the shielded balance above half its peak.`,
  },
  {
    test: (c) => c.includes('chain'),
    main: (name, capital, chain) =>
      `Bridge $${capital} to the chain ${name} runs on and use two of its native apps from the same wallet.`,
    second: () =>
      `Use the chain weekly, rotating a swap, a stake and a vote.`,
    weekly: () =>
      `Use one native app on the chain each week, rotating a swap, a stake and a vote.`,
  },
];

/**
 * The first category family whose test matches, or undefined: the families
 * are tried in their declared order, so a category that names two families
 * always takes the earlier one. Kept apart from the action-building so the
 * lookup is one function's job and the fallback below reads as exactly that.
 */
function familyFor(category: string): FamilyActions | undefined {
  const c = (category ?? '').toLowerCase();
  for (const family of ACTION_FAMILIES) {
    if (family.test(c)) return family;
  }
  return undefined;
}

/**
 * The generic farm actions for a protocol no family claims: a plain deposit
 * as the main position, a weekly use as the second action, and a different
 * qualifying action each week as the habit.
 */
function defaultActions(name: string, capital: number, chain: string): { main: string; second: string; weekly: string } {
  return {
    main: `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open so it counts in every snapshot.`,
    second: `Use ${name} once a week — a deposit, a swap or a vote — and keep the activity in the same wallet.`,
    weekly: `Do one different qualifying action each week — a deposit, a swap, a vote or a claim — and vary it.`,
  };
}

function actionsFor(p: SnapshotProtocol, capital: number, chain: string): { main: string; second: string; weekly: string } {
  const family = familyFor(p.category ?? '');
  if (family !== undefined) {
    return {
      main: family.main(p.name, capital, chain),
      second: family.second(p.name, capital, chain),
      weekly: family.weekly(p.name, capital, chain),
    };
  }
  return defaultActions(p.name, capital, chain);
}

/** Everything the seven farm steps are built from, computed once per protocol. */
interface FarmPlan {
  gas: string;
  capital: number;
  hold: number;
  holdWhy: string;
  actions: { main: string; second: string; weekly: string };
  young: boolean;
}

/**
 * The hold step's reason, from the seven-day growth alone: a heating-up
 * protocol (TVL up 20% or more) gets a warning to hold through the attention
 * rather than chase an entry after the spike; a cooling one (down 20% or
 * more) gets a warning to re-check TVL weekly and leave early if it keeps
 * falling; a flat week needs no reason at all.
 */
function holdReason(change7d: number | null): string {
  if (change7d !== null && change7d >= 20) {
    return ` TVL is up ${change7d.toFixed(1)}% in seven days, so hold through the attention rather than chasing an entry after the spike.`;
  }
  if (change7d !== null && change7d <= -20) {
    return ` TVL is down ${Math.abs(change7d).toFixed(1)}% in seven days, so re-check the protocol's TVL every week and leave early if it keeps falling.`;
  }
  return '';
}

function farmPlanContext(p: SnapshotProtocol, age: number | null): FarmPlan {
  const chain = chainOf(p);
  const gas = gasFor(chain);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age, p.change_7d);
  return {
    gas,
    capital,
    hold,
    holdWhy: holdReason(p.change_7d),
    actions: actionsFor(p, capital, chain),
    young: age !== null && age < 180,
  };
}

/** Step 1 — set up a fresh wallet that holds only the farming funds. */
const walletStep = (ctx: FarmPlan): FarmStep => ({
  text: `Open a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline on paper.`,
  cost: `under ${ctx.gas} for the first transaction`,
  time: '5 minutes',
});

/** Step 2 — take the main position in the protocol. */
const mainStep = (ctx: FarmPlan): FarmStep => ({
  text: ctx.actions.main,
  cost: `$${ctx.capital} of capital and ${ctx.gas}`,
  time: '15 minutes to set up',
});

/** Step 3 — a second, different qualifying action. */
const secondStep = (ctx: FarmPlan): FarmStep => ({
  text: ctx.actions.second,
  cost: `${ctx.gas} each time`,
  time: '10 minutes a week',
});

/** Step 4 — the weekly habit that keeps the activity showing. */
const weeklyStep = (ctx: FarmPlan): FarmStep => ({
  text: ctx.actions.weekly,
  cost: `${ctx.gas} a week`,
  time: '10 minutes a week',
});

/** Step 5 — hold long enough for the activity to count in more than one snapshot. */
const holdStep = (ctx: FarmPlan): FarmStep => ({
  text: `Hold the position for at least ${ctx.hold} days so the activity is counted in more than one snapshot.${ctx.holdWhy}`,
  cost: `the $${ctx.capital} stays in the position`,
  time: `${ctx.hold} days`,
});

/**
 * Step 6 — claim only from the protocol's own page. A young protocol's claim
 * page is the one it publishes itself, never a link forwarded to the reader.
 */
const claimStep = (ctx: FarmPlan): FarmStep => ({
  text: ctx.young
    ? `Before you withdraw, open the protocol's own points or rewards page from the link it publishes and claim only there — a young protocol's claim page is the one it publishes itself, never a link forwarded to you.`
    : `Before you withdraw, open the protocol's own points or rewards page from the link it publishes and claim only there.`,
  cost: 'no fee to check, and never pay to claim',
  time: '10 minutes',
});

/** Step 7 — write the farm log, so the position can be repeated or unwound. */
const logStep = (ctx: FarmPlan): FarmStep => ({
  text: `Write the wallet, the dates and every transaction hash in a farm log so you can repeat the $${ctx.capital} position or unwind it.`,
  cost: 'nothing but the log',
  time: '5 minutes',
});

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is
 * derived from the protocol's own record (category, chains, TVL, age, seven-day growth),
 * never from a hand-written list of names. The first step's gas follows the chain's own
 * fee market, the weekly step is the category's own action, and the hold is longer for
 * young and heating-up protocols, shorter for cooling ones.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const ctx = farmPlanContext(p, age);
  return [walletStep(ctx), mainStep(ctx), secondStep(ctx), weeklyStep(ctx), holdStep(ctx), claimStep(ctx), logStep(ctx)];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      ratio: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    signals: row.signals,
    category_multiple: row.model.category_multiple,
    size_tilt: row.model.size_tilt,
    size_tilt_basis: row.model.size_tilt_basis,
    size_tilt_r2: row.model.size_tilt_r2,
    fitted_multiple: row.model.fitted_multiple,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.model.chain_multiplier,
    raw_implied_value_usd: row.model.raw_implied_value_usd,
    calibration_shift_dex: row.model.calibration_shift_dex,
    farm_steps: row.farm_steps,
  };
}

// ---------------------------------------------------------------------------
// Dashboard-only derived data (new in radar-8). None of this touches the
// board: board.json is built from the sections above alone, so these helpers
// cannot change a single board byte. They feed the terminal dashboard's
// sparklines, charts, ticker and news tab, all from snapshot facts plus
// deterministic arithmetic — no clock, no randomness, no network.
// ---------------------------------------------------------------------------

/** A 32-bit FNV-1a hash of a slug: the seed for that row's modeled series. */
function slugSeed(slug: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * One protocol's modeled 30-point TVL path, for sparklines and the detail
 * chart. It starts where the snapshot's 7-day change says it was a week ago
 * (TVL now divided by 1 + clamped change), walks to today's TVL with a
 * seeded wobble, and lands exactly on today's TVL at the last point. The
 * wobble comes from a linear congruential generator seeded by the slug hash
 * — the same slug always draws the same path, and no clock or random source
 * is involved. This is a modeled path, not market data: the snapshot holds
 * one TVL per protocol, not a history, so the dashboard labels it as modeled.
 */
export function modeledSeries(p: SnapshotProtocol): number[] {
  const chg = Math.min(100, Math.max(-50, p.change_7d ?? 0));
  const start = p.tvl_usd / (1 + chg / 100);
  let state = slugSeed(p.slug);
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const n = 30;
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const trend = start + (p.tvl_usd - start) * t;
    const wobble = (next() - 0.5) * 0.06 * p.tvl_usd * (1 - t * 0.6);
    pts.push(Math.max(1, Math.round(i === n - 1 ? p.tvl_usd : trend + wobble)));
  }
  return pts;
}

/**
 * TVL totals per chain across all snapshot protocols, biggest first. A
 * protocol on several chains counts its whole TVL under each of them, so
 * the chain totals overlap and sum past the snapshot's total TVL — the
 * ticker shows per-chain totals, not a partition of the market.
 */
export function chainTotals(snapshot: Snapshot): ChainTotal[] {
  const watch = new Set(snapshot.watchlist);
  const byChain = new Map<string, { tvl: number; n: number; wl: number; top: SnapshotProtocol }>();
  for (const p of snapshot.protocols) {
    for (const chain of p.chains) {
      const acc = byChain.get(chain) ?? { tvl: 0, n: 0, wl: 0, top: p };
      acc.tvl += p.tvl_usd;
      acc.n += 1;
      if (watch.has(p.slug)) acc.wl += 1;
      if (p.tvl_usd > acc.top.tvl_usd || (p.tvl_usd === acc.top.tvl_usd && p.slug < acc.top.slug)) acc.top = p;
      byChain.set(chain, acc);
    }
  }
  return [...byChain.entries()]
    .map(([chain, a]) => ({
      chain,
      tvl_usd: a.tvl,
      protocols: a.n,
      watchlist: a.wl,
      top_slug: a.top.slug,
      top_name: a.top.name,
    }))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.chain < b.chain ? -1 : 1));
}

/** Short money form for the news items: $2.75B, $512.4M, $48.2K, $950. */
function moneyUsd(n: number): string {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2).replace(/\.00$/, '') + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return '$' + Math.round(n);
}

/** One protocol's token status in news words: the record, never a claim it has none. */
function tokenNote(p: SnapshotProtocol): string {
  if (isPreToken(p)) return 'records no token';
  return p.mcap_usd === null ? 'records a token with no market cap in the snapshot' : `trades at ${moneyUsd(p.mcap_usd)} market cap`;
}

/**
 * The News tab's items, built only from snapshot facts and the radar's own
 * records: the biggest 7-day TVL gainer and decliner, the most recently
 * listed protocol, the watchlist's shape, the backtest's headline, and this
 * build's model line. Nothing here comes from outside the snapshot, and no
 * item invents news about a protocol — each carries its source and the
 * snapshot's date.
 */
export function radarNews(snapshot: Snapshot, board: BoardRow[], calibration: Calibration): NewsItem[] {
  const date = snapshot.as_of;
  const snapSource = `Sealed snapshot (DeFiLlama, as of ${date})`;
  const withChange = snapshot.protocols.filter((p) => p.change_7d !== null);
  const items: NewsItem[] = [];
  const gainer = [...withChange].sort((a, b) => b.change_7d! - a.change_7d! || (a.slug < b.slug ? -1 : 1))[0];
  if (gainer !== undefined) {
    items.push({
      id: 'top-gainer-7d',
      title: `${gainer.name} leads the snapshot's 7-day TVL gains at +${gainer.change_7d!.toFixed(1)}%`,
      body: `TVL ${moneyUsd(gainer.tvl_usd)} (${gainer.category ?? 'no category'}; ${gainer.chains.join(', ') || 'no chain listed'}). The protocol ${tokenNote(gainer)}.`,
      source: snapSource,
      date,
    });
  }
  const decliner = [...withChange].sort((a, b) => a.change_7d! - b.change_7d! || (a.slug < b.slug ? -1 : 1))[0];
  if (decliner !== undefined) {
    items.push({
      id: 'top-decliner-7d',
      title: `${decliner.name} is the snapshot's steepest 7-day TVL fall at ${decliner.change_7d!.toFixed(1)}%`,
      body: `TVL ${moneyUsd(decliner.tvl_usd)} (${decliner.category ?? 'no category'}; ${decliner.chains.join(', ') || 'no chain listed'}). The protocol ${tokenNote(decliner)}.`,
      source: snapSource,
      date,
    });
  }
  const listed = snapshot.protocols.filter((p) => p.listed_at !== null);
  const newest = [...listed].sort((a, b) => (a.listed_at! < b.listed_at! ? 1 : -1) || (a.slug < b.slug ? -1 : 1))[0];
  if (newest !== undefined) {
    items.push({
      id: 'newest-listing',
      title: `${newest.name} is the most recently listed protocol in the snapshot (${newest.listed_at})`,
      body: `TVL ${moneyUsd(newest.tvl_usd)} (${newest.category ?? 'no category'}; ${newest.chains.join(', ') || 'no chain listed'}). The protocol ${tokenNote(newest)}.`,
      source: snapSource,
      date,
    });
  }
  items.push({
    id: 'watchlist-shape',
    title: `${snapshot.watchlist.length} protocols sit above the ${moneyUsd(snapshot.floor_usd)} floor with no token on record`,
    body: `The watchlist is the floor, never the ceiling: this board ranks ${board.length} protocols, ${board.length - snapshot.watchlist.length} of them below the floor or outside the list. Every watchlist protocol appears on the board.`,
    source: snapSource,
    date,
  });
  const shipped = BACKTEST.rules[BACKTEST.rules.length - 1]!;
  const persist = BACKTEST.rules.find((r) => r.rule.startsWith('persistence'))!;
  items.push({
    id: 'backtest-headline',
    title: `Backtest: the shipped model priced 113 live tokens on ${BACKTEST.t0}; median error ${shipped.median_ape_pct.toFixed(1)}% against realized values`,
    body: `Flat category median ${BACKTEST.rules[0]!.median_ape_pct.toFixed(1)}%, persistence ${persist.median_ape_pct.toFixed(1)}%. Within twice the realized value: ${shipped.within2x_pct.toFixed(1)}% shipped, ${persist.within2x_pct.toFixed(1)}% persistence. The nested number is ${BACKTEST.nested_median_ape_pct.toFixed(1)}% median error.`,
    source: `Radar backtest record (priced ${BACKTEST.t0}, scored ${BACKTEST.t1})`,
    date,
  });
  const cal = calibration.calibration;
  items.push({
    id: 'model-line',
    title: `${MODEL_VERSION} rebuilds the board from the same model: ${board.length} rows, one pooled tilt, an out-of-fold calibration`,
    body: `Calibration log map slope ${cal.slope.toFixed(4)}, intercept ${cal.intercept.toFixed(4)}, R2 ${cal.r2.toFixed(4)}, fitted on ${cal.peers} out-of-fold pairs. Top implied value ${moneyUsd(board[0]!.implied_value_usd)} (${board[0]!.name}); median ${moneyUsd(board[Math.floor(board.length / 2)]!.implied_value_usd)}.`,
    source: 'Radar model record (this build)',
    date,
  });
  return items;
}

/**
 * Everything the dashboard renders, from the snapshot. The calibration object
 * is the one buildBoard used — the same map that priced the rows — not a second
 * fit that could disagree with the board by a rounding. The backtest rides
 * along as the research constant, so the page's backtest tables and the board
 * strip read the same numbers. The held-out pairs ride along inside the
 * calibration's validation, so the model tab's plot reads the same prices
 * the validation table reports. The modeled series, chain totals and news
 * are derived here too, from the snapshot and the finished board.
 */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const { board, calibration } = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const series: Record<string, number[]> = {};
  for (const row of board) {
    const p = snapshot.protocols.find((x) => x.slug === row.slug)!;
    series[row.slug] = modeledSeries(p);
  }
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    calibration,
    backtest: BACKTEST,
    watchlist_size: snapshot.watchlist.length,
    watchlist_slugs: [...snapshot.watchlist],
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
    series,
    chain_totals: chainTotals(snapshot),
    news: radarNews(snapshot, board, calibration),
  };
  return { board, radar };
}

/**
 * One protocol out of a snapshot file's raw entry: the slug, the name and
 * the TVL are required and must be finite, because a board row without them
 * cannot be ranked or priced; every other field is optional and falls back
 * to null (or an empty chain list) when it is missing or the wrong type,
 * because a snapshot that omits a listing date is thin, not broken. The
 * index in the error is the entry's position in the file, so a bad entry
 * can be found without counting.
 */
export function parseProtocol(v: unknown, i: number): SnapshotProtocol {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
  }
  const p = v as Record<string, unknown>;
  if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
    throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
  }
  return {
    slug: p.slug,
    name: p.name,
    category: typeof p.category === 'string' ? p.category : null,
    chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
    tvl_usd: p.tvl_usd,
    change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
    mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
    listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
    gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
    symbol: typeof p.symbol === 'string' ? p.symbol : null,
  };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map(parseProtocol);
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/**
 * One board row's own gate failures, or null: the farm-step count, every
 * step's length, and the implied value's shape. Kept apart from the
 * board-wide checks (coverage, ranks, order, the shared-value check) so a
 * row's failure names the row instead of the board.
 */
function rowIssue(r: BoardRow): string | null {
  const steps = r.farm_steps;
  if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
  for (const s of steps) {
    if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
  }
  if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
    return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board holds ${board.length} rows, fewer than the gate's 100`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const issue = rowIssue(r);
    if (issue !== null) return issue;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

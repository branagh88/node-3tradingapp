// prediction-repository.js — Phase B: persistence + prospective outcome tracking.
//
// Backend is swappable via constructor injection. Default backend adapts the
// EXISTING storage.collection('prediction-records') from storage.js — zero
// direct browser-storage access here (only storage.js touches it).
//
// Immutability rules (§5 of the plan):
//  - prediction / marketState / methodology / id / ticker / createdAt are
//    write-once at creation and never mutated afterwards.
//  - recordPredictionOutcome writes ONLY to outcomes.<h> (+ lifecycleStatus,
//    updatedAt). Resolved leaves and terminal records are final.
//  - getPrediction/list/getPending return deep clones.

import { storage } from './storage.js';
import {
  PREDICTION_RECORD_SCHEMA_VERSION,
  RECORD_LIFECYCLE,
  OUTCOME_STATUS,
  RECORD_HORIZONS,
  computeRecordIdentity,
  isValidPredictionContract,
  buildPredictionRecord,
  validatePredictionRecord,
  computeOutcomeLeaf,
} from './prediction-record.js';

function localCollectionBackend() {
  const col = storage.collection('prediction-records');
  return {
    getAll: () => col.getAll(),
    get: (id) => col.get(id),
    put: (record) => col.put(record),
    count: () => col.count(),
  };
}

export function inMemoryBackend() {
  const map = new Map();
  return {
    getAll: () => Array.from(map.values()),
    get: (id) => map.get(id),
    put: (record) => { map.set(record.id, record); return record; },
    count: () => map.size,
  };
}

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

export class PredictionRepository {
  constructor({ backend = localCollectionBackend(), now = Date.now } = {}) {
    this.backend = backend;
    this._now = typeof now === 'function' ? now : Date.now;
  }

  /**
   * Create a prediction record from a valid Phase A contract. Idempotent:
   * a record for the same identity is returned unchanged. Returns null when
   * the contract fails the validity gate or entryClose is not positive-finite.
   */
  createPrediction(contract, { entryClose } = {}) {
    if (!isValidPredictionContract(contract)) return null;
    if (!(typeof entryClose === 'number' && Number.isFinite(entryClose) && entryClose > 0)) return null;
    const id = computeRecordIdentity(contract.ticker, contract.conditionTime);
    const existing = this.backend.get(id);
    if (existing) return clone(existing); // duplicate protection — never overwrite
    const now = this._now();
    const record = buildPredictionRecord(contract, entryClose, now);
    const check = validatePredictionRecord(record);
    if (!check.ok) {
      // Defensive: never persist a malformed record.
      return null;
    }
    this.backend.put(clone(record));
    return clone(this.backend.get(id));
  }

  /** Deep-cloned fetch; undefined when unknown. */
  getPrediction(id) {
    const rec = this.backend.get(id);
    return rec ? clone(rec) : undefined;
  }

  listPredictions({ ticker, lifecycleStatus } = {}) {
    const t = ticker ? String(ticker).toUpperCase().trim() : null;
    let out = this.backend.getAll().filter((r) => r && r.id);
    if (t) out = out.filter((r) => String(r.ticker).toUpperCase() === t);
    if (lifecycleStatus) out = out.filter((r) => r.lifecycleStatus === lifecycleStatus);
    out.sort((a, b) => {
      const ca = a.prediction ? a.prediction.conditionTime : 0;
      const cb = b.prediction ? b.prediction.conditionTime : 0;
      if (cb !== ca) return cb - ca;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    return out.map(clone);
  }

  getPendingPredictions({ ticker } = {}) {
    return this.listPredictions({ ticker, lifecycleStatus: RECORD_LIFECYCLE.PENDING });
  }

  count() {
    return this.backend.count();
  }

  /**
   * Evaluate outcomes against the deduped chronological daily series `bars`
   * (the SAME series the engine consumed). Bar-offset horizon semantics:
   * outcome of horizon h = bars[condIdx + h].c vs entry close — exactly the
   * arithmetic of pattern-engine's computeMatchedForwardOutcomes.
   *
   * Terminal or unknown ids return null. Terminal-but-known returns the stored
   * record untouched (no updatedAt bump) when called via the API layer.
   */
  recordPredictionOutcome(id, bars, { now } = {}) {
    const rec = this.backend.get(id);
    if (!rec) return null;
    if (rec.lifecycleStatus !== RECORD_LIFECYCLE.PENDING) return null; // terminal frozen
    if (!Array.isArray(bars) || bars.length === 0) return null;

    const condIdx = bars.findIndex((b) => b && b.t === rec.marketState.conditionBarTime);
    if (condIdx < 0) return null;
    const locatedClose = bars[condIdx] ? bars[condIdx].c : null;
    if (!(locatedClose === rec.marketState.entryClose)) {
      // Never rewrite history on a series mismatch — leave untouched.
      return null;
    }
    const ts = Number.isFinite(now) ? now : this._now();

    let changed = false;
    const next = clone(rec);
    for (const h of RECORD_HORIZONS) {
      const key = String(h);
      const row = next.prediction.horizons[key];
      const predictedDirection = row ? row.direction : null;
      if (!predictedDirection) continue; // never fabricate an ungated outcome
      const leaf = next.outcomes[key];
      if (leaf && leaf.status === OUTCOME_STATUS.RESOLVED) continue; // FINAL
      next.outcomes[key] = computeOutcomeLeaf({
        bars, condIdx, horizonDays: h, predictedDirection,
        entryClose: next.marketState.entryClose, recordedAt: ts,
      });
      changed = true;
    }
    if (!changed) return null;

    const allResolved = RECORD_HORIZONS.every((h) => {
      const leaf = next.outcomes[String(h)];
      return !next.prediction.horizons[String(h)]?.direction
        || (leaf && leaf.status === OUTCOME_STATUS.RESOLVED);
    });
    if (allResolved) next.lifecycleStatus = RECORD_LIFECYCLE.RESOLVED;
    next.updatedAt = ts;
    this.backend.put(next);
    return clone(this.backend.get(id));
  }

  /** Terminal transition pending → insufficient_outcome_data. */
  finalizeAsInsufficientOutcomeData(id, { now } = {}) {
    const rec = this.backend.get(id);
    if (!rec) return null;
    if (rec.lifecycleStatus !== RECORD_LIFECYCLE.PENDING) return null; // terminal frozen
    const ts = Number.isFinite(now) ? now : this._now();
    const next = clone(rec);
    for (const h of RECORD_HORIZONS) {
      const key = String(h);
      const row = next.prediction.horizons[key];
      if (!row || !row.direction) continue;
      const leaf = next.outcomes[key];
      if (leaf && leaf.status === OUTCOME_STATUS.RESOLVED) continue;
      next.outcomes[key] = {
        status: OUTCOME_STATUS.INSUFFICIENT,
        horizonDays: h,
        targetBarTime: null,
        outcomeClose: null,
        returnPct: null,
        outcomeDirection: null,
        predictedDirection: row.direction,
        correct: null,
        recordedAt: ts,
      };
    }
    next.lifecycleStatus = RECORD_LIFECYCLE.INSUFFICIENT;
    next.updatedAt = ts;
    this.backend.put(next);
    return clone(this.backend.get(id));
  }
}

// ---------------------------------------------------------------------------
// Pure HTML renderer (prediction-history UI, minimal per plan §8)
// ---------------------------------------------------------------------------

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmt(v, digits = 2) {
  return v == null || !Number.isFinite(Number(v))
    ? '—'
    : Number(v).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function fmtDate(ms) {
  return ms == null || !Number.isFinite(Number(ms)) ? '—' : new Date(Number(ms)).toISOString().slice(0, 10);
}

/**
 * Render prediction records with clearly separated PREDICTION vs ACTUAL
 * OUTCOME columns. Individual ✓/✗ indicators only — no aggregate accuracy.
 * @param {object[]} records
 * @returns {string}
 */
export function renderPredictionRecordsHtml(records) {
  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  if (!list.length) {
    return '<div class="hint">No persisted prediction records yet.</div>';
  }
  const parts = [];
  for (const r of list) {
    const badgeCls = r.lifecycleStatus === 'resolved' ? 'badge--ok' : 'badge--unavailable';
    parts.push(`<div style="margin-top:12px;">`
      + `<span class="badge ${badgeCls}">${escHtml(r.lifecycleStatus)}</span>`
      + ` <strong>${escHtml(r.ticker)}</strong>`
      + ` <span class="hint">condition ${escHtml(fmtDate(r.prediction && r.prediction.conditionTime))}`
      + ` · prediction price ${escHtml(fmt(r.marketState && r.marketState.entryClose))}</span></div>`);

    const rows = [];
    for (const h of RECORD_HORIZONS) {
      const key = String(h);
      const pred = (r.prediction && r.prediction.horizons && r.prediction.horizons[key]) || null;
      const leaf = (r.outcomes && r.outcomes[key]) || null;
      const predCell = pred && pred.direction
        ? `${escHtml(String(pred.direction).toUpperCase())} @ ${escHtml(fmt(pred.probabilityPct))}%`
        : '—';
      let outcomeCell = '<span title="pending future data">—</span>';
      let hitCell = '—';
      if (leaf && leaf.status === OUTCOME_STATUS.RESOLVED) {
        outcomeCell = `${escHtml(String(leaf.outcomeDirection).toUpperCase())}, `
          + `${Number(leaf.returnPct) >= 0 ? '+' : ''}${escHtml(fmt(leaf.returnPct))}% `
          + `on ${escHtml(fmtDate(leaf.targetBarTime))} @ ${escHtml(fmt(leaf.outcomeClose))}`;
        hitCell = leaf.correct ? '✓' : '✗';
      } else if (leaf && leaf.status === OUTCOME_STATUS.INSUFFICIENT) {
        outcomeCell = escHtml('insufficient_outcome_data');
      }
      rows.push(`<tr><td>${escHtml(h)}D</td><td>${predCell}</td><td>${outcomeCell}</td><td>${hitCell}</td></tr>`);
    }

    parts.push(`<table style="width:100%;margin-top:6px;">`
      + `<thead><tr><th>Horizon</th><th>Predicted</th><th>Actual outcome</th><th>Hit?</th></tr></thead>`
      + `<tbody>${rows.join('')}</tbody></table>`);

    if (r.prediction && r.prediction.disclaimer) {
      parts.push(`<div class="hint">${escHtml(r.prediction.disclaimer)}</div>`);
    }
  }
  return parts.join('\n');
}

export {
  PREDICTION_RECORD_SCHEMA_VERSION,
  RECORD_LIFECYCLE,
  OUTCOME_STATUS,
  RECORD_HORIZONS,
  computeRecordIdentity,
  isValidPredictionContract,
  buildPredictionRecord,
  validatePredictionRecord,
};

export default PredictionRepository;

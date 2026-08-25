// prediction-record.js — Phase B: canonical prediction-record schema helpers.
//
// PURE functions only: no DOM, no browser-storage, no `node:` imports. Safe to
// import from both the browser repository and server.mjs.
//
// Guarantees:
//  - Deterministic identity (no randomness): identityKey is derived from
//    (ticker, condition-bar UTC date, schemaVersion).
//  - Deep-clone every input; no shared references between contract and record.
//  - Persist only valid Phase A `OK` contracts; nothing is fabricated.

import { LIVE_PREDICTION_SCHEMA_VERSION } from './live-prediction.js';

export const PREDICTION_RECORD_SCHEMA_VERSION = 1;
export const RECORD_LIFECYCLE = {
  PENDING: 'pending',
  RESOLVED: 'resolved',
  INSUFFICIENT: 'insufficient_outcome_data',
};
export const OUTCOME_STATUS = {
  RESOLVED: 'resolved',
  INSUFFICIENT: 'insufficient_outcome_data',
};
// Horizons come verbatim from the live-prediction defaults (Phase A); no new
// horizons are invented here.
export const RECORD_HORIZONS = [1, 3, 5, 10];

/**
 * Deterministic identity key for a prediction record.
 * @param {string} ticker
 * @param {number} conditionTime epoch ms of the condition bar
 * @returns {string|null}
 */
export function computeRecordIdentity(ticker, conditionTime) {
  const sym = String(ticker || '').toUpperCase().trim();
  if (!sym) return null;
  if (!Number.isFinite(conditionTime)) return null;
  const day = new Date(conditionTime).toISOString().slice(0, 10);
  return `${sym}|${day}|v${PREDICTION_RECORD_SCHEMA_VERSION}`;
}

function deepClone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

/**
 * Validity gate — persist only valid Phase A `OK` contracts.
 * @param {object} contract
 * @returns {boolean}
 */
export function isValidPredictionContract(contract) {
  if (!contract || typeof contract !== 'object') return false;
  if (contract.schemaVersion !== LIVE_PREDICTION_SCHEMA_VERSION) return false;
  if (contract.status !== 'OK') return false;
  const ticker = String(contract.ticker || '').toUpperCase().trim();
  if (!ticker) return false;
  if (typeof contract.conditionTime !== 'number' || !Number.isFinite(contract.conditionTime)) return false;
  const rows = contract.horizons && typeof contract.horizons === 'object'
    ? Object.values(contract.horizons) : [];
  const anyGated = rows.some((r) => r
    && (r.direction === 'up' || r.direction === 'down')
    && typeof r.probabilityPct === 'number' && Number.isFinite(r.probabilityPct));
  if (!anyGated) return false;
  return true;
}

/**
 * Build the canonical prediction record from a valid contract.
 * The prediction / marketState / methodology sections are FROZEN AT CREATION.
 * All outcome leaves start as null.
 *
 * @param {object} contract valid OK contract (buildPredictionContract output)
 * @param {number} entryClose close price of the condition bar
 * @param {number} createdAtMs epoch ms
 * @returns {object} record
 */
export function buildPredictionRecord(contract, entryClose, createdAtMs) {
  const c = deepClone(contract);
  const id = computeRecordIdentity(c.ticker, c.conditionTime);
  const outcomes = {};
  for (const h of RECORD_HORIZONS) outcomes[String(h)] = null;

  const record = {
    id,
    schemaVersion: PREDICTION_RECORD_SCHEMA_VERSION,
    ticker: String(c.ticker || '').toUpperCase().trim(),
    lifecycleStatus: RECORD_LIFECYCLE.PENDING,
    createdAt: createdAtMs,
    updatedAt: createdAtMs,
    prediction: {
      generatedAt: c.generatedAt,
      contractStatus: c.status,
      dataset: {
        status: c.dataset ? c.dataset.status : null,
        candles: c.dataset ? c.dataset.candles : null,
        coverageYears: c.dataset ? c.dataset.coverageYears : null,
        dateRange: c.dataset ? c.dataset.dateRange : null,
        stoppedReason: c.dataset ? c.dataset.stoppedReason : null,
        depth: c.dataset ? c.dataset.depth : null,
      },
      conditionTime: c.conditionTime,
      condition: deepClone(c.condition),
      analysis: deepClone(c.analysis),
      horizons: deepClone(c.horizons),
      disclaimer: c.disclaimer,
    },
    marketState: {
      depth: c.dataset ? c.dataset.depth : null,
      entryClose,
      conditionBarTime: c.conditionTime,
    },
    methodology: {
      engine: 'pattern-engine',
      liveEngineSchemaVersion: LIVE_PREDICTION_SCHEMA_VERSION,
      horizons: RECORD_HORIZONS.slice(),
      matchMode: c.analysis ? c.analysis.matchMode : null,
      kUsed: c.analysis ? c.analysis.kUsed : null,
      percentileCutoff: c.analysis ? c.analysis.percentileCutoff : null,
      maxMatchDistance: c.analysis ? c.analysis.maxMatchDistance : null,
      compositeSignature: c.analysis ? c.analysis.compositeSignature : null,
      compositeRelaxed: c.analysis ? !!c.analysis.compositeRelaxed : false,
      sampleClassification: c.analysis ? c.analysis.sampleClassification : null,
    },
    outcomes,
  };
  return record;
}

/**
 * Shape validator for a stored record.
 * @param {object} record
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validatePredictionRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object') {
    return { ok: false, errors: ['record must be an object'] };
  }
  if (record.schemaVersion !== PREDICTION_RECORD_SCHEMA_VERSION) {
    errors.push('schemaVersion mismatch');
  }
  if (!record.id || typeof record.id !== 'string') errors.push('id missing');
  const expectedId = computeRecordIdentity(record.ticker, record.prediction && record.prediction.conditionTime);
  if (record.id !== expectedId) errors.push('id does not match computed identity');
  if (!record.ticker || typeof record.ticker !== 'string') errors.push('ticker missing');
  if (!Object.values(RECORD_LIFECYCLE).includes(record.lifecycleStatus)) errors.push('invalid lifecycleStatus');
  if (!Number.isFinite(record.createdAt)) errors.push('createdAt missing');
  if (!Number.isFinite(record.updatedAt)) errors.push('updatedAt missing');
  const p = record.prediction || {};
  if (p.contractStatus !== 'OK') errors.push('prediction.contractStatus must be OK');
  if (!Number.isFinite(p.conditionTime)) errors.push('prediction.conditionTime missing');
  const ms = record.marketState || {};
  if (!(typeof ms.entryClose === 'number' && Number.isFinite(ms.entryClose) && ms.entryClose > 0)) {
    errors.push('marketState.entryClose invalid');
  }
  if (ms.conditionBarTime !== p.conditionTime) errors.push('conditionBarTime mismatch');
  if (!record.methodology || record.methodology.engine !== 'pattern-engine') errors.push('methodology.engine invalid');
  if (!record.outcomes || typeof record.outcomes !== 'object') errors.push('outcomes section missing');
  else {
    for (const h of RECORD_HORIZONS) {
      const leaf = record.outcomes[String(h)];
      if (leaf === null) continue;
      if (typeof leaf !== 'object') { errors.push(`outcomes.${h} malformed`); continue; }
      if (![OUTCOME_STATUS.RESOLVED, OUTCOME_STATUS.INSUFFICIENT].includes(leaf.status)) {
        errors.push(`outcomes.${h}.status invalid`);
      }
      if (leaf.status === OUTCOME_STATUS.RESOLVED) {
        if (!Number.isFinite(leaf.targetBarTime)) errors.push(`outcomes.${h}.targetBarTime missing`);
        if (!(Number.isFinite(leaf.outcomeClose) && leaf.outcomeClose > 0)) errors.push(`outcomes.${h}.outcomeClose invalid`);
        if (!Number.isFinite(leaf.returnPct)) errors.push(`outcomes.${h}.returnPct missing`);
        if (!['up', 'down', 'flat'].includes(leaf.outcomeDirection)) errors.push(`outcomes.${h}.outcomeDirection invalid`);
        if (typeof leaf.correct !== 'boolean') errors.push(`outcomes.${h}.correct missing`);
        if (leaf.predictedDirection !== (p.horizons[String(h)] || {}).direction) {
          errors.push(`outcomes.${h}.predictedDirection mismatch`);
        }
      } else if (leaf.status === OUTCOME_STATUS.INSUFFICIENT) {
        if (!(leaf.targetBarTime == null && leaf.outcomeClose == null
          && leaf.returnPct == null && leaf.outcomeDirection == null && leaf.correct == null)) {
          errors.push(`outcomes.${h} insufficient leaf carries value fields`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Compute a single outcome leaf per §5 rules (pure helper used by repository
 * and server alike).
 */
export function computeOutcomeLeaf({ bars, condIdx, horizonDays, predictedDirection, entryClose, recordedAt }) {
  const h = horizonDays;
  const target = condIdx + h < bars.length ? bars[condIdx + h] : null;
  const entry = Number.isFinite(entryClose) && entryClose > 0 ? entryClose : bars[condIdx].c;
  if (!target || !(target.c > 0)) {
    return {
      status: OUTCOME_STATUS.INSUFFICIENT,
      horizonDays: h,
      targetBarTime: null,
      outcomeClose: null,
      returnPct: null,
      outcomeDirection: null,
      predictedDirection,
      correct: null,
      recordedAt,
    };
  }
  const ret = Number((((target.c / entry) - 1) * 100).toFixed(2));
  const dir = ret > 0 ? 'up' : ret < 0 ? 'down' : 'flat';
  return {
    status: OUTCOME_STATUS.RESOLVED,
    horizonDays: h,
    targetBarTime: target.t,
    outcomeClose: target.c,
    returnPct: ret,
    outcomeDirection: dir,
    predictedDirection,
    correct: dir === predictedDirection,
    recordedAt,
  };
}

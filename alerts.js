// alerts.js — Phase 2 interface stub (specs/phase1.md B2.10, B13).
// DO NOT implement alert behavior in Phase 1. Signatures only.

export const alerts = {
  // createAlert(alert) → Promise<{id, ok}>
  async createAlert(_alert) {
    // TODO Phase 2: price/percentage/technical/volume/volatility/pattern/AI alerts
    throw new Error('alerts.createAlert is not implemented in Phase 1 (Phase 2)');
  },
  // checkAlerts() → Promise<Array>
  async checkAlerts() {
    // TODO Phase 2
    return [];
  },
  // listAlerts() → Promise<Array>
  async listAlerts() {
    // TODO Phase 2
    return [];
  },
  // removeAlert(id) → Promise<boolean>
  async removeAlert(_id) {
    // TODO Phase 2
    return false;
  },
};

export default alerts;
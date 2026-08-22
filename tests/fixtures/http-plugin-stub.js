// tests/fixtures/http-plugin-stub.js — offline stand-in for www/vendor/
// http-plugin.js so Vitest can transform api.js outside the Android native
// runtime. The real plugin is only dynamically imported when
// Capacitor.isNativePlatform() is true; tests never take that branch.
export const Http = {
  async request() {
    throw new Error('http-plugin-stub: native HTTP not available under test');
  },
};
export default Http;

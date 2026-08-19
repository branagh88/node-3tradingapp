package com.getcapacitor;

/**
 * Minimal desktop stub for capacitor core's com.getcapacitor.JSArray — exists
 * only to let the REAL CapacitorHttpUrlConnection / JSValue sources compile.
 * Never instantiated by the native probe (GET has no request body).
 */
public class JSArray {
    public JSArray() {}

    public JSArray(String json) {
        // Permissive desktop stand-in: never throws, keeps the raw payload.
        this.raw = json;
    }

    private String raw = null;

    public int length() { return raw == null ? 0 : 1; }

    public String getString(int index) { return raw; }

    @Override
    public String toString() { return raw == null ? "[]" : raw; }
}
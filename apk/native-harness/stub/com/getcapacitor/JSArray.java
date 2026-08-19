package com.getcapacitor;

/**
 * Minimal desktop stub for capacitor core's com.getcapacitor.JSArray — exists
 * only to let the REAL CapacitorHttpUrlConnection / JSValue sources compile.
 * Never instantiated by the native probe (GET has no request body).
 */
public class JSArray {
    public JSArray() {}

    public JSArray(String json) {
        throw new UnsupportedOperationException("JSArray(String) not needed by native probe");
    }
}
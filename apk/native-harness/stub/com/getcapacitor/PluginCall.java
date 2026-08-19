package com.getcapacitor;

/**
 * Minimal desktop stub for capacitor core's com.getcapacitor.PluginCall —
 * only the accessors referenced by the REAL JSValue source need to exist.
 * The native probe never constructs a PluginCall; it drives the
 * CapacitorHttpUrlConnection directly (mirroring HttpRequestHandler.request
 * for a GET with no body).
 */
public class PluginCall {
    public JSArray getArray(String name, JSArray fallback) { return fallback; }
    public JSObject getObject(String name, JSObject fallback) { return fallback; }
    public JSObject getObject(String name) { return null; }
    public String getString(String name, String fallback) { return fallback; }
    public String getString(String name) { return null; }
    public JSObject getData() { return new JSObject(); }
}
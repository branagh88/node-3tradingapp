package com.getcapacitor;

import java.util.HashMap;
import java.util.Map;

/**
 * Minimal desktop stub for capacitor core's com.getcapacitor.PluginCall.
 * This is a CONFIGURABLE fake: values are set with setValue(name, value) and
 * the accessors mirror the REAL capacitor-core PluginCall semantics used by
 * HttpRequestHandler.request(): getObject(name) returns null when the key is
 * absent, getString(name, fallback) returns fallback when absent, getInt /
 * getBoolean return null when absent, getArray(name, fallback) returns
 * fallback when absent. getData() returns a JSObject view of the whole call.
 *
 * This lets the probe drive the REAL com.getcapacitor.plugin.http.HttpRequestHandler
 * source with exactly the shape the native bridge delivers from JS
 * (undefined properties are dropped by JSON serialization, absent keys are
 * simply absent).
 */
public class PluginCall {
    private final Map<String, Object> data = new HashMap<>();

    public void setValue(String name, Object value) {
        data.put(name, value);
    }

    public JSArray getArray(String name, JSArray fallback) {
        Object v = data.get(name);
        return (v instanceof JSArray) ? (JSArray) v : fallback;
    }

    public JSArray getArray(String name) {
        return getArray(name, null);
    }

    public JSObject getObject(String name, JSObject fallback) {
        Object v = data.get(name);
        return (v instanceof JSObject) ? (JSObject) v : fallback;
    }

    public JSObject getObject(String name) {
        return getObject(name, null);
    }

    public String getString(String name, String fallback) {
        Object v = data.get(name);
        return v == null ? fallback : String.valueOf(v);
    }

    public String getString(String name) {
        return getString(name, null);
    }

    public Integer getInt(String name) {
        Object v = data.get(name);
        if (v == null) return null;
        if (v instanceof Integer) return (Integer) v;
        try {
            return Integer.parseInt(String.valueOf(v));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    public Boolean getBoolean(String name) {
        Object v = data.get(name);
        if (v == null) return null;
        if (v instanceof Boolean) return (Boolean) v;
        return Boolean.valueOf(String.valueOf(v));
    }

    public Boolean getBoolean(String name, boolean fallback) {
        Boolean v = getBoolean(name);
        return v == null ? fallback : v;
    }

    public JSObject getData() {
        JSObject out = new JSObject();
        for (Map.Entry<String, Object> e : data.entrySet()) {
            out.put(e.getKey(), e.getValue());
        }
        return out;
    }
}
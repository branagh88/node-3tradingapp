package com.getcapacitor;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;

/**
 * Minimal desktop stub for capacitor core's com.getcapacitor.JSObject, used
 * so the REAL com.getcapacitor.plugin.http.* source compiles and runs on a
 * desktop JVM. Backed by a LinkedHashMap. getJSONArray throws JSONException
 * (mirroring org.json.JSONObject) so HttpURLConnectionBuilder.setUrlParams
 * takes the string-value branch — the same behavior the real JSObject has
 * when the value is not an array.
 */
public class JSObject {
    private final Map<String, Object> map = new LinkedHashMap<>();

    public JSObject() {}

    public JSObject(String json) throws JSONException {
        // Permissive desktop stand-in for org.json-backed JSObject(String).
        // Keeps the raw payload so diagnostics can show what the server sent.
        if (json != null) map.put("_raw", json);
    }

    public JSObject put(String key, Object value) {
        map.put(key, value);
        return this;
    }

    public Object get(String key) throws JSONException {
        return map.get(key);
    }

    public String getString(String key) {
        Object v = map.get(key);
        return v == null ? null : String.valueOf(v);
    }

    public JSONArray getJSONArray(String key) throws JSONException {
        throw new JSONException("not an array");
    }

    public Integer getInt(String key) {
        Object v = map.get(key);
        if (v == null) return null;
        if (v instanceof Integer) return (Integer) v;
        try { return Integer.parseInt(String.valueOf(v)); } catch (NumberFormatException e) { return null; }
    }

    public Object opt(String key) {
        return map.get(key);
    }

    public Iterator<String> keys() {
        return map.keySet().iterator();
    }

    @Override
    public String toString() {
        return map.toString();
    }
}
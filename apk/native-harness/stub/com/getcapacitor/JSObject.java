package com.getcapacitor;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONException;

/**
 * Minimal desktop stub for capacitor core's com.getcapacitor.JSObject, used
 * only so the REAL com.getcapacitor.plugin.http.CapacitorHttpUrlConnection
 * source compiles and its REAL setRequestHeaders(JSObject) can be exercised
 * on a desktop JVM. Backed by a LinkedHashMap — fully functional for the
 * header key/value loop the plugin performs. get() throws JSONException to
 * match the real org.json-backed signature expected by FormUploader.
 */
public class JSObject {
    private final Map<String, Object> map = new LinkedHashMap<>();

    public JSObject() {}

    public JSObject(String json) {
        // Only used by HttpRequestHandler.parseJSON (not exercised in harness).
        throw new UnsupportedOperationException("JSObject(String) not needed by native probe");
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
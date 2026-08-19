package org.json;

/**
 * Real, minimal org.json.JSONObject for the desktop harness (android.jar ships
 * stub classes whose methods throw RuntimeException("Stub!")). Only the API
 * surface the real plugin sources touch at COMPILE time and the paths this
 * harness executes at RUNTIME are implemented; everything else stays absent.
 */
public class JSONObject {

    /** org.json sentinel for an explicit JSON null value. */
    public static final Object NULL = new Null();

    private static final class Null {
        @Override
        public boolean equals(Object o) {
            return o == null || o == this;
        }

        @Override
        public String toString() {
            return "null";
        }
    }

    private final java.util.Map<String, Object> map = new java.util.LinkedHashMap<>();

    public JSONObject() {}

    public JSONObject(String json) throws JSONException {
        // Not used by the harness paths; keep it non-throwing for safety.
        if (json != null) map.put("_raw", json);
    }

    public JSONObject put(String key, Object value) throws JSONException {
        map.put(key, value);
        return this;
    }

    public Object get(String key) throws JSONException {
        if (!map.containsKey(key)) throw new JSONException("No value for " + key);
        return map.get(key);
    }

    public String getString(String key) throws JSONException {
        Object v = get(key);
        return v == null ? null : String.valueOf(v);
    }

    public Integer getInt(String key) throws JSONException {
        Object v = get(key);
        if (v == null) return null;
        if (v instanceof Integer) return (Integer) v;
        try {
            return Integer.parseInt(String.valueOf(v));
        } catch (NumberFormatException e) {
            throw new JSONException("Not an int: " + key, e);
        }
    }

    public Object opt(String key) {
        return map.get(key);
    }

    public boolean has(String key) {
        return map.containsKey(key);
    }

    public java.util.Iterator<String> keys() {
        return map.keySet().iterator();
    }

    @Override
    public String toString() {
        return map.toString();
    }
}